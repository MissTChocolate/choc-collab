import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSafeToSeed,
  waitUntilSafeToSeed,
  type ObservableValue,
  type SeedGateSources,
} from "./seedGate";

/** Minimal BehaviorSubject: emits current value on subscribe, then on change. */
class Subject<T> implements ObservableValue<T> {
  private listeners = new Set<(v: T) => void>();
  constructor(private current: T) {}
  get value() {
    return this.current;
  }
  next(v: T) {
    this.current = v;
    for (const l of [...this.listeners]) l(v);
  }
  subscribe(listener: (v: T) => void) {
    this.listeners.add(listener);
    listener(this.current);
    return { unsubscribe: () => void this.listeners.delete(listener) };
  }
  get listenerCount() {
    return this.listeners.size;
  }
}

function makeSources(opts: {
  cloud?: boolean;
  loggedIn?: boolean;
  initiallySynced?: boolean;
  phase?: string;
} = {}) {
  const currentUser = new Subject<{ isLoggedIn?: boolean } | undefined>({ isLoggedIn: opts.loggedIn ?? false });
  const syncState = new Subject<{ phase?: string } | undefined>({ phase: opts.phase ?? "initial" });
  const persistedSyncState = new Subject<{ initiallySynced?: boolean } | undefined>(
    opts.initiallySynced === undefined ? undefined : { initiallySynced: opts.initiallySynced },
  );
  const sources: SeedGateSources = {
    cloudConfigured: opts.cloud ?? true,
    currentUser,
    syncState,
    persistedSyncState,
  };
  return { sources, currentUser, syncState, persistedSyncState };
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("isSafeToSeed", () => {
  it("is always safe in local-only mode", () => {
    expect(isSafeToSeed(makeSources({ cloud: false }).sources)).toBe(true);
  });

  it("requires login, initial sync and in-sync — all three", () => {
    const all = { loggedIn: true, initiallySynced: true, phase: "in-sync" };
    expect(isSafeToSeed(makeSources(all).sources)).toBe(true);
    expect(isSafeToSeed(makeSources({ ...all, loggedIn: false }).sources)).toBe(false);
    expect(isSafeToSeed(makeSources({ ...all, initiallySynced: false }).sources)).toBe(false);
    expect(isSafeToSeed(makeSources({ ...all, initiallySynced: undefined }).sources)).toBe(false);
    for (const phase of ["initial", "not-in-sync", "pushing", "pulling", "error", "offline"]) {
      expect(isSafeToSeed(makeSources({ ...all, phase }).sources), phase).toBe(false);
    }
  });
});

describe("waitUntilSafeToSeed", () => {
  it("resolves immediately in local-only mode", async () => {
    await expect(waitUntilSafeToSeed(makeSources({ cloud: false }).sources)).resolves.toBe(true);
  });

  it("waits through login and the initial sync, then opens", async () => {
    const s = makeSources();
    let result: boolean | undefined;
    void waitUntilSafeToSeed(s.sources).then((r) => (result = r));

    s.currentUser.next({ isLoggedIn: true });
    s.syncState.next({ phase: "pulling" });
    await flush();
    expect(result).toBeUndefined();

    // The initial sync has landed, but the client hasn't settled yet.
    s.persistedSyncState.next({ initiallySynced: true });
    await flush();
    expect(result).toBeUndefined();

    s.syncState.next({ phase: "in-sync" });
    await flush();
    expect(result).toBe(true);
  });

  it("never opens while logged out, even if a sync state says in-sync", async () => {
    const s = makeSources({ initiallySynced: true, phase: "in-sync" });
    let result: boolean | undefined;
    void waitUntilSafeToSeed(s.sources).then((r) => (result = r));
    await flush();
    expect(result).toBeUndefined();
  });

  it("opens synchronously when already safe, without leaking subscriptions", async () => {
    const s = makeSources({ loggedIn: true, initiallySynced: true, phase: "in-sync" });
    await expect(waitUntilSafeToSeed(s.sources)).resolves.toBe(true);
    expect(s.currentUser.listenerCount).toBe(0);
    expect(s.syncState.listenerCount).toBe(0);
    expect(s.persistedSyncState.listenerCount).toBe(0);
  });

  it("unsubscribes everything once it opens", async () => {
    const s = makeSources();
    const p = waitUntilSafeToSeed(s.sources);
    s.currentUser.next({ isLoggedIn: true });
    s.persistedSyncState.next({ initiallySynced: true });
    s.syncState.next({ phase: "in-sync" });
    await expect(p).resolves.toBe(true);
    expect(s.currentUser.listenerCount + s.syncState.listenerCount + s.persistedSyncState.listenerCount).toBe(0);
  });

  it("resolves false and cleans up when aborted", async () => {
    const s = makeSources();
    const controller = new AbortController();
    const p = waitUntilSafeToSeed(s.sources, controller.signal);
    controller.abort();
    await expect(p).resolves.toBe(false);
    expect(s.currentUser.listenerCount + s.syncState.listenerCount + s.persistedSyncState.listenerCount).toBe(0);
  });

  it("resolves false for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitUntilSafeToSeed(makeSources().sources, controller.signal)).resolves.toBe(false);
  });
});

/**
 * Scenario tests: the race itself.
 *
 * These model the seeding algorithm used by every ensureDefault* function —
 * read the local table, insert defaults missing by name — against an
 * in-memory "cloud" and "local" table. They don't run real Dexie; they pin
 * down the ordering problem, and show the gate removes it.
 */
describe("fresh-browser seeding race", () => {
  const DEFAULTS = ["moulded", "enrobed", "snack bar", "bar"];
  type Row = { id: string; name: string };
  let nextId = 0;
  const newId = () => `local-${++nextId}`;

  /** Mirrors ensureDefaultProductCategories: insert whatever's missing by name. */
  function seedMissing(local: Row[]) {
    const have = new Set(local.map((r) => r.name.toLowerCase()));
    for (const name of DEFAULTS) {
      if (!have.has(name)) local.push({ id: newId(), name });
    }
  }

  /** Initial sync: download cloud rows, then flip the addon's state. */
  function sync(local: Row[], cloud: Row[], s: ReturnType<typeof makeSources>, rows = cloud) {
    for (const row of rows) if (!local.some((r) => r.id === row.id)) local.push({ ...row });
    s.persistedSyncState.next({ initiallySynced: true });
    s.syncState.next({ phase: "in-sync" });
  }

  const counts = (rows: Row[]) =>
    Object.fromEntries(DEFAULTS.map((n) => [n, rows.filter((r) => r.name === n).length]));

  const existingCloud = (): Row[] => DEFAULTS.map((name, i) => ({ id: `cloud-${i}`, name }));

  it("WITHOUT the gate: a fresh browser duplicates every default (the bug)", () => {
    const cloud = existingCloud();
    const local: Row[] = []; // fresh profile: IndexedDB is empty
    const s = makeSources();

    seedMissing(local); // SeedLoader fires on mount, before anything syncs
    s.currentUser.next({ isLoggedIn: true });
    sync(local, cloud, s);

    expect(counts(local)).toEqual({ moulded: 2, enrobed: 2, "snack bar": 2, bar: 2 });
  });

  it("WITHOUT the gate: a partial sync produces uneven duplicates", () => {
    // Matches what was seen in production: some categories at 5 copies, others at 3.
    const cloud = existingCloud();
    const local: Row[] = [];
    const s = makeSources();

    // Moulded and bar happen to download before the check runs; the rest don't.
    for (const row of cloud.filter((r) => r.name === "moulded" || r.name === "bar")) local.push({ ...row });
    seedMissing(local);
    sync(local, cloud, s);

    expect(counts(local)).toEqual({ moulded: 1, enrobed: 2, "snack bar": 2, bar: 1 });
  });

  it("WITH the gate: a fresh browser adds nothing", async () => {
    const cloud = existingCloud();
    const local: Row[] = [];
    const s = makeSources();

    const seeded = waitUntilSafeToSeed(s.sources).then((safe) => safe && seedMissing(local));
    await flush();
    expect(local).toEqual([]); // nothing inserted while waiting

    s.currentUser.next({ isLoggedIn: true });
    sync(local, cloud, s);
    await seeded;

    expect(counts(local)).toEqual({ moulded: 1, enrobed: 1, "snack bar": 1, bar: 1 });
    expect(local.every((r) => r.id.startsWith("cloud-"))).toBe(true);
  });

  it("WITH the gate: a genuinely new user still gets exactly one set", async () => {
    const local: Row[] = [];
    const s = makeSources();

    const seeded = waitUntilSafeToSeed(s.sources).then((safe) => safe && seedMissing(local));
    s.currentUser.next({ isLoggedIn: true });
    sync(local, [], s); // empty cloud database
    await seeded;

    expect(counts(local)).toEqual({ moulded: 1, enrobed: 1, "snack bar": 1, bar: 1 });
  });

  it("WITH the gate: many fresh browsers never compound", async () => {
    const cloud = existingCloud();
    for (let visit = 0; visit < 5; visit++) {
      const local: Row[] = [];
      const s = makeSources();
      const seeded = waitUntilSafeToSeed(s.sources).then((safe) => safe && seedMissing(local));
      s.currentUser.next({ isLoggedIn: true });
      sync(local, cloud, s);
      await seeded;
      // Anything a fresh browser inserts would sync back up; it must insert nothing.
      expect(local.filter((r) => !r.id.startsWith("cloud-"))).toEqual([]);
    }
  });
});

/**
 * Tripwire for upstream merges: the loader must never call a seeding function
 * outside the gate. If an upstream change rewrites seed-loader.tsx back to
 * calling them directly on mount, this fails before it reaches production.
 */
describe("SeedLoader wiring", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "components", "seed-loader.tsx"), "utf8");
  const SEEDERS = [
    "ensureDefaultProductCategories(",
    "ensureDefaultDecorationCategories(",
    "ensureDefaultShellDesigns(",
    "ensureDefaultFillingCategories(",
    "ensureDefaultIngredientCategories(",
    "seedIfNeeded(",
  ];

  it("AuthGate opens the database itself", () => {
    // Dexie Cloud only loads a saved session once the database opens, and
    // opening is lazy. SeedLoader used to trigger it on mount; now that it
    // waits for sign-in, nothing else would — and every returning user would
    // be shown "Sign in" on each page load. AuthGate must open it explicitly.
    const gate = readFileSync(join(import.meta.dirname, "..", "components", "auth-gate.tsx"), "utf8");
    expect(gate, "auth-gate.tsx must call db.open() so saved sessions load").toContain("db.open()");
  });

  it("waits for the gate before any seeding call", () => {
    const gateAt = src.indexOf("waitUntilSafeToSeed(");
    expect(gateAt, "seed-loader.tsx must call waitUntilSafeToSeed").toBeGreaterThan(-1);
    for (const call of SEEDERS) {
      const at = src.indexOf(call);
      expect(at, `${call} missing from seed-loader.tsx`).toBeGreaterThan(-1);
      expect(at, `${call} runs before the Dexie Cloud sync gate`).toBeGreaterThan(gateAt);
    }
  });
});
