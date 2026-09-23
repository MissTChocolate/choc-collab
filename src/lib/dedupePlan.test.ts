import { describe, it, expect } from "vitest";
import { planDedupe, danglingProductCategoryRefs, type DedupeSnapshot, type Row } from "./dedupePlan";

const d = (iso: string) => new Date(iso);

function snapshot(partial: Partial<DedupeSnapshot>): DedupeSnapshot {
  return {
    productCategories: [],
    fillingCategories: [],
    ingredientCategories: [],
    decorationCategories: [],
    shellDesigns: [],
    products: [],
    ...partial,
  };
}

const productCat = (id: string, name: string, extra: Partial<Row> = {}): Row => ({
  id,
  name,
  shellPercentMin: 15,
  shellPercentMax: 50,
  defaultShellPercent: 37,
  shopKind: "moulded",
  createdAt: d("2026-04-28"),
  updatedAt: d("2026-07-10"),
  ...extra,
});

const fillingCat = (id: string, name: string, extra: Partial<Row> = {}): Row => ({
  id,
  name,
  shelfStable: false,
  color: "#0072B2",
  createdAt: d("2026-05-03"),
  updatedAt: d("2026-07-10"),
  ...extra,
});

describe("planDedupe — the production case", () => {
  // Modelled on what was seen: 3 copies of "moulded", the 8 products on a copy
  // that is NOT the oldest, and one older copy missing the backfilled shopKind.
  const snap = snapshot({
    productCategories: [
      productCat("m-old", "moulded", { createdAt: d("2026-04-28"), shopKind: undefined }),
      productCat("m-used", "moulded", { createdAt: d("2026-05-04") }),
      productCat("m-new", "moulded", { createdAt: d("2026-07-10") }),
      productCat("e1", "enrobed", { shellPercentMin: 0, shellPercentMax: 100, defaultShellPercent: 20, shopKind: "enrobed", createdAt: d("2026-04-27") }),
      productCat("e2", "enrobed", { shellPercentMin: 0, shellPercentMax: 100, defaultShellPercent: 20, shopKind: "enrobed", createdAt: d("2026-04-30") }),
      productCat("e3", "enrobed", { shellPercentMin: 0, shellPercentMax: 100, defaultShellPercent: 20, shopKind: "enrobed", createdAt: d("2026-05-04") }),
      productCat("e4", "enrobed", { shellPercentMin: 0, shellPercentMax: 100, defaultShellPercent: 20, shopKind: "enrobed", createdAt: d("2026-07-10") }),
      productCat("e5", "enrobed", { shellPercentMin: 0, shellPercentMax: 100, defaultShellPercent: 20, shopKind: "enrobed", createdAt: d("2026-07-10") }),
    ],
    fillingCategories: [
      fillingCat("g1", "Ganaches (Emulsions)", { createdAt: d("2026-05-03") }),
      fillingCat("g2", "Ganaches (Emulsions)", { createdAt: d("2026-07-10") }),
      fillingCat("g3", "Ganaches (Emulsions)", { createdAt: d("2026-07-10") }),
    ],
    products: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, productCategoryId: "m-used" })),
  });
  const plan = planDedupe(snap);
  const moulded = plan.groups.find((g) => g.key === "moulded")!;

  it("keeps the product category the products actually use, not the oldest", () => {
    expect(moulded.keepId).toBe("m-used");
    expect(moulded.deleteIds.sort()).toEqual(["m-new", "m-old"]);
    expect(moulded.repointProductIds).toEqual([]); // nothing points at a deleted copy
  });

  it("does not treat a missing backfilled field as a conflict", () => {
    expect(plan.conflicts).toEqual([]);
    expect(moulded.fill).toEqual({}); // the kept copy already has shopKind
  });

  it("removes all but one of every duplicated group", () => {
    const enrobed = plan.groups.find((g) => g.key === "enrobed")!;
    expect(enrobed.copies).toBe(5);
    expect(enrobed.keepId).toBe("e1"); // unreferenced: oldest wins
    expect(enrobed.deleteIds).toHaveLength(4);
    expect(plan.groups.find((g) => g.key === "Ganaches (Emulsions)")!.keepId).toBe("g1");
    expect(plan.totalToDelete).toBe(2 + 4 + 2);
  });

  it("summarises per table", () => {
    const pc = plan.summary.find((s) => s.table === "productCategories")!;
    expect(pc).toMatchObject({ rows: 8, duplicateGroups: 2, toDelete: 6, conflicts: 0 });
  });
});

describe("planDedupe — keeping references intact", () => {
  it("moves products off deleted copies when they're split across copies", () => {
    const plan = planDedupe(
      snapshot({
        productCategories: [productCat("a", "bar"), productCat("b", "bar"), productCat("c", "bar")],
        products: [
          { id: "p1", productCategoryId: "b" },
          { id: "p2", productCategoryId: "b" },
          { id: "p3", productCategoryId: "c" },
        ],
      }),
    );
    const g = plan.groups[0];
    expect(g.keepId).toBe("b"); // most-referenced
    expect(g.repointProductIds).toEqual(["p3"]);
    expect(plan.totalRepoints).toBe(1);
  });

  it("fills a blank setting on the kept copy from an identical value elsewhere", () => {
    const plan = planDedupe(
      snapshot({
        productCategories: [
          productCat("keep", "snack bar", { shopKind: undefined }),
          productCat("dup", "snack bar", { shopKind: "snack-bar", createdAt: d("2026-07-10") }),
        ],
        products: [{ id: "p1", productCategoryId: "keep" }],
      }),
    );
    expect(plan.groups[0]).toMatchObject({ keepId: "keep", fill: { shopKind: "snack-bar" } });
  });
});

describe("planDedupe — refuses to guess", () => {
  it("leaves copies that differ in a real setting untouched and reports them", () => {
    const plan = planDedupe(
      snapshot({
        fillingCategories: [
          fillingCat("g1", "Ganaches (Emulsions)", { color: "#0072B2" }),
          fillingCat("g2", "Ganaches (Emulsions)", { color: "#FF0000" }),
        ],
      }),
    );
    expect(plan.groups).toEqual([]);
    expect(plan.totalToDelete).toBe(0);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ table: "fillingCategories", field: "color", values: ["#0072B2", "#FF0000"] }),
    ]);
  });

  it("treats archived vs active copies as a decision, not a duplicate", () => {
    const plan = planDedupe(
      snapshot({ productCategories: [productCat("a", "bar", { archived: true }), productCat("b", "bar")] }),
    );
    expect(plan.groups).toEqual([]);
    expect(plan.conflicts[0].field).toBe("archived");
  });

  it("treats archived: undefined and archived: false as the same", () => {
    const plan = planDedupe(
      snapshot({ productCategories: [productCat("a", "bar", { archived: false }), productCat("b", "bar")] }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.groups).toHaveLength(1);
  });

  it("detects conflicts in product category shell ranges", () => {
    const plan = planDedupe(
      snapshot({ productCategories: [productCat("a", "moulded"), productCat("b", "moulded", { defaultShellPercent: 40 })] }),
    );
    expect(plan.conflicts[0]).toMatchObject({ field: "defaultShellPercent", values: [37, 40] });
  });
});

describe("planDedupe — grouping follows the link key exactly", () => {
  it("never merges names that differ only in case or spacing", () => {
    const plan = planDedupe(
      snapshot({
        fillingCategories: [fillingCat("a", "Ganache"), fillingCat("b", "ganache"), fillingCat("c", "Ganache ")],
      }),
    );
    expect(plan.groups).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("groups decoration categories by slug, and flags a same-slug name mismatch", () => {
    const same = planDedupe(
      snapshot({
        decorationCategories: [
          { id: "a", name: "Cocoa Butter", slug: "cocoa_butter", createdAt: d("2026-04-01") },
          { id: "b", name: "Cocoa Butter", slug: "cocoa_butter", createdAt: d("2026-05-01") },
        ],
      }),
    );
    expect(same.groups[0]).toMatchObject({ key: "cocoa_butter", keepId: "a", deleteIds: ["b"] });

    const renamed = planDedupe(
      snapshot({
        decorationCategories: [
          { id: "a", name: "Cocoa Butter", slug: "cocoa_butter" },
          { id: "b", name: "Coloured Cocoa Butter", slug: "cocoa_butter" },
        ],
      }),
    );
    expect(renamed.groups).toEqual([]);
    expect(renamed.conflicts[0].field).toBe("name");
  });

  it("ignores ids, timestamps and Dexie Cloud bookkeeping when comparing", () => {
    const plan = planDedupe(
      snapshot({
        shellDesigns: [
          { id: "a", name: "Airbrushing", defaultApplyAt: "on_mould", owner: "u1", realmId: "rlm-1", $ts: 1, createdAt: d("2026-04-01") },
          { id: "b", name: "Airbrushing", defaultApplyAt: "on_mould", owner: "u1", realmId: "rlm-2", $ts: 9, createdAt: d("2026-07-10") },
        ],
      }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.groups[0]).toMatchObject({ keepId: "a", deleteIds: ["b"] });
  });

  it("prefers an active copy over an archived one when neither is referenced", () => {
    // Only reachable when archived matches across copies; with all archived the oldest wins.
    const plan = planDedupe(
      snapshot({
        ingredientCategories: [
          { id: "a", name: "Nuts", archived: true, createdAt: d("2026-04-01") },
          { id: "b", name: "Nuts", archived: true, createdAt: d("2026-03-01") },
        ],
      }),
    );
    expect(plan.groups[0].keepId).toBe("b");
  });
});

describe("planDedupe — edge cases", () => {
  it("returns an empty plan when nothing is duplicated", () => {
    const plan = planDedupe(
      snapshot({ productCategories: [productCat("a", "moulded"), productCat("b", "bar")] }),
    );
    expect(plan).toMatchObject({ groups: [], conflicts: [], totalToDelete: 0, totalRepoints: 0 });
  });

  it("skips rows without an id or link key rather than guessing", () => {
    const plan = planDedupe(
      snapshot({ fillingCategories: [fillingCat("a", "Pralines"), { name: "Pralines" }, { id: "c" }] }),
    );
    expect(plan.groups).toEqual([]);
  });

  it("is deterministic when copies are indistinguishable", () => {
    const rows = [productCat("zz", "bar"), productCat("aa", "bar"), productCat("mm", "bar")];
    const a = planDedupe(snapshot({ productCategories: rows }));
    const b = planDedupe(snapshot({ productCategories: [...rows].reverse() }));
    expect(a.groups[0].keepId).toBe("aa");
    expect(b.groups[0].keepId).toBe("aa");
  });
});

describe("danglingProductCategoryRefs", () => {
  it("lists products pointing at a category that doesn't exist", () => {
    const snap = snapshot({
      productCategories: [productCat("a", "bar")],
      products: [
        { id: "ok", productCategoryId: "a" },
        { id: "gone", productCategoryId: "deleted" },
        { id: "none" },
      ],
    });
    expect(danglingProductCategoryRefs(snap)).toEqual(["gone"]);
  });
});
