/**
 * Applies a duplicate-cleanup plan (see dedupePlan.ts) to the live database.
 *
 * Everything goes through the app's own Dexie instance, never raw IndexedDB,
 * so Dexie Cloud records each change and syncs it — deletions made any other
 * way would be undone by the next sync.
 */

import { db } from "@/lib/db";
import { exportBackup } from "@/lib/backup";
import {
  DEDUPE_TABLES,
  danglingProductCategoryRefs,
  planDedupe,
  type DedupePlan,
  type DedupeSnapshot,
  type Row,
} from "@/lib/dedupePlan";

/**
 * Reads everything the planner needs. Products are read from the
 * productCategoryId index only (id + category), never whole rows, so product
 * photos aren't loaded. Products with no category aren't in that index and
 * don't matter to the plan.
 */
export async function readDedupeSnapshot(): Promise<DedupeSnapshot> {
  const [productCategories, fillingCategories, ingredientCategories, decorationCategories, shellDesigns] =
    await Promise.all([
      db.productCategories.toArray(),
      db.fillingCategories.toArray(),
      db.ingredientCategories.toArray(),
      db.decorationCategories.toArray(),
      db.shellDesigns.toArray(),
    ]);

  const products: DedupeSnapshot["products"] = [];
  await db.products.orderBy("productCategoryId").eachKey((key, cursor) => {
    products.push({ id: String(cursor.primaryKey), productCategoryId: String(key) });
  });

  return {
    productCategories: productCategories as unknown as Row[],
    fillingCategories: fillingCategories as unknown as Row[],
    ingredientCategories: ingredientCategories as unknown as Row[],
    decorationCategories: decorationCategories as unknown as Row[],
    shellDesigns: shellDesigns as unknown as Row[],
    products,
  };
}

/** Everything a plan would change, in a stable order, for comparing two plans. */
export function planFingerprint(plan: DedupePlan): string {
  return JSON.stringify(
    plan.groups.map((g) => [
      g.table,
      g.keepId,
      [...g.deleteIds].sort(),
      [...g.repointProductIds].sort(),
      Object.entries(g.fill).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );
}

export class PlanChangedError extends Error {
  constructor() {
    super("The data changed since the preview was shown. Nothing was changed — review the new preview and try again.");
    this.name = "PlanChangedError";
  }
}

export interface DedupeResult {
  removed: number;
  repointed: number;
  /** Duplicates still found after the cleanup — should be 0. */
  remainingDuplicates: number;
  /** Groups left alone because their copies disagree. */
  conflicts: number;
  /** Products pointing at a category that doesn't exist — should be empty. */
  danglingProducts: string[];
}

/**
 * Removes the duplicates in `expected`, which must be the plan the user
 * reviewed. Steps, each of which aborts everything if it fails:
 *   1. download a recovery file (the app's before-destructive-op convention,
 *      but strict: no file, no cleanup)
 *   2. in one transaction, recompute the plan and require it to match the
 *      preview exactly, then move products, fill gaps, and delete copies
 *   3. re-read and verify
 */
export async function applyDedupe(
  expected: DedupePlan,
  options: { snapshot?: boolean } = {},
): Promise<DedupeResult> {
  if (options.snapshot !== false) {
    await exportBackup({ filenamePrefix: "choc-collab-before-duplicate-cleanup" });
  }

  const tables = [db.products, ...DEDUPE_TABLES.map((t) => db.table(t))];
  let removed = 0;
  let repointed = 0;

  await db.transaction("rw", tables, async () => {
    const fresh = planDedupe(await readDedupeSnapshot());
    if (planFingerprint(fresh) !== planFingerprint(expected)) throw new PlanChangedError();

    for (const group of fresh.groups) {
      const table = db.table(group.table);
      for (const productId of group.repointProductIds) {
        await db.products.update(productId, { productCategoryId: group.keepId });
        repointed++;
      }
      if (Object.keys(group.fill).length > 0) await table.update(group.keepId, group.fill);
      await table.bulkDelete(group.deleteIds);
      removed += group.deleteIds.length;
    }
  });

  const after = await readDedupeSnapshot();
  const replanned = planDedupe(after);
  return {
    removed,
    repointed,
    remainingDuplicates: replanned.totalToDelete,
    conflicts: replanned.conflicts.length,
    danglingProducts: danglingProductCategoryRefs(after),
  };
}
