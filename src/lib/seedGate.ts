/**
 * Gate for startup seeding when Dexie Cloud sync is in play.
 *
 * Every default-seeding function (ensureDefaultProductCategories and its
 * siblings, seedIfNeeded) works the same way: read the LOCAL table, work out
 * which defaults are missing by name, insert those. That is idempotent only
 * if the local table already reflects the cloud.
 *
 * On a fresh browser profile it doesn't. IndexedDB starts empty and fills in
 * only once the initial sync lands, so a check that runs first sees every
 * default as missing, inserts a complete new set with fresh ids, and pushes it
 * up alongside the real rows. Result: one duplicate set per fresh profile
 * (incognito window, new device, cleared site data). Rows that happened to
 * arrive before the check get skipped, so the duplicate counts come out
 * uneven — the signature of this race.
 *
 * Wrapping read + insert in one transaction (see ensureDefaultShellDesigns)
 * stops two invocations racing inside ONE client. It cannot stop this one:
 * the transaction faithfully reads a local table that is empty because the
 * data hasn't been downloaded yet.
 *
 * So with Dexie Cloud configured, seeding waits until all three hold:
 *   - a user is logged in (requireAuth: true — nothing syncs before login)
 *   - the addon has finished its initial sync for this database
 *   - this client is currently in sync
 * Local-only mode has no remote to wait for and passes immediately.
 *
 * If the gate never opens (offline, sync error, expired licence), seeding is
 * skipped for that session. That's deliberate: an established browser already
 * has its rows, and a fresh one can't have anything to seed against until it
 * syncs. Skipping is always safe; guessing is what caused the duplicates.
 *
 * Written against plain observable-like sources rather than `db.cloud`
 * directly so it can be unit-tested without IndexedDB.
 */

/** The subset of an RxJS BehaviorSubject this module needs. */
export interface ObservableValue<T> {
  readonly value: T;
  subscribe(listener: (value: T) => void): { unsubscribe(): void };
}

export interface SeedGateSources {
  cloudConfigured: boolean;
  currentUser: ObservableValue<{ isLoggedIn?: boolean } | undefined>;
  syncState: ObservableValue<{ phase?: string } | undefined>;
  persistedSyncState: ObservableValue<{ initiallySynced?: boolean } | undefined>;
}

/** True when default rows can be seeded without risking duplicates. */
export function isSafeToSeed(s: SeedGateSources): boolean {
  if (!s.cloudConfigured) return true;
  return (
    s.currentUser.value?.isLoggedIn === true &&
    s.persistedSyncState.value?.initiallySynced === true &&
    s.syncState.value?.phase === "in-sync"
  );
}

/**
 * Resolves `true` once it is safe to seed, or `false` if `signal` aborts
 * first. Never rejects, and never resolves `true` early.
 */
export function waitUntilSafeToSeed(
  s: SeedGateSources,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!s.cloudConfigured) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const subscriptions: { unsubscribe(): void }[] = [];
    let settled = false;

    const settle = (safe: boolean) => {
      if (settled) return;
      settled = true;
      for (const sub of subscriptions) sub.unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      resolve(safe);
    };
    const onAbort = () => settle(false);
    const check = () => {
      if (isSafeToSeed(s)) settle(true);
    };

    signal?.addEventListener("abort", onAbort);

    // BehaviorSubjects call the listener synchronously on subscribe, so the
    // gate can open mid-loop. A subscription made after that point would be
    // missed by settle()'s cleanup — hence the checks either side.
    for (const source of [s.currentUser, s.syncState, s.persistedSyncState]) {
      if (settled) break;
      const sub = source.subscribe(check);
      if (settled) sub.unsubscribe();
      else subscriptions.push(sub);
    }
  });
}
