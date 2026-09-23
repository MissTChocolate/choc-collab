/**
 * Plans the removal of duplicate category / design rows.
 *
 * Duplicates come from the fresh-browser seeding race fixed in seedGate.ts:
 * each affected browser inserted another copy of every default. This module
 * works out, for each group of copies, which one to keep and what to delete.
 * It is pure — no database access — so every rule is unit-tested; applying the
 * plan lives in dedupe.ts.
 *
 * Grouping follows how the rest of the app links to each table, and uses the
 * EXACT value, never a looser match. Two rows only count as duplicates if
 * anything pointing at one would equally find the other:
 *
 *   productCategories     products.productCategoryId → id   (grouped by name)
 *   fillingCategories     fillings.category          → name
 *   ingredientCategories  ingredients.category       → name
 *   decorationCategories  decorationMaterials.type   → slug
 *   shellDesigns          ShellDesignStep.technique  → name
 *
 * productCategories is the only table linked by id, so it's the only one whose
 * references need moving; for the others, keeping one row per name/slug keeps
 * every link intact.
 *
 * Safety rules:
 *   - If copies disagree on a real setting (colour, shelf-stable, shell range,
 *     archived, …) the group is reported as a conflict and left untouched.
 *   - If a setting is blank on the kept copy but set (identically) on another,
 *     the kept copy is filled in, so nothing a user entered is lost.
 *   - ids, timestamps and Dexie Cloud bookkeeping fields are ignored.
 */

export const DEDUPE_TABLES = [
  "productCategories",
  "fillingCategories",
  "ingredientCategories",
  "decorationCategories",
  "shellDesigns",
] as const;
export type DedupeTable = (typeof DEDUPE_TABLES)[number];

export const TABLE_LABELS: Record<DedupeTable, string> = {
  productCategories: "Product categories",
  fillingCategories: "Filling categories",
  ingredientCategories: "Ingredient categories",
  decorationCategories: "Decoration categories",
  shellDesigns: "Shell designs",
};

/** The field other records link through — what defines "the same row". */
const LINK_KEY: Record<DedupeTable, string> = {
  productCategories: "name",
  fillingCategories: "name",
  ingredientCategories: "name",
  decorationCategories: "slug",
  shellDesigns: "name",
};

export type Row = { id?: string } & Record<string, unknown>;

export interface DedupeSnapshot {
  productCategories: Row[];
  fillingCategories: Row[];
  ingredientCategories: Row[];
  decorationCategories: Row[];
  shellDesigns: Row[];
  products: { id?: string; productCategoryId?: string }[];
}

export interface GroupPlan {
  table: DedupeTable;
  /** The shared link value (name, or slug for decoration categories). */
  key: string;
  /** Display name for the group. */
  label: string;
  copies: number;
  keepId: string;
  deleteIds: string[];
  /** Blank fields on the kept row, filled from identical values on the copies. */
  fill: Record<string, unknown>;
  /** Products that point at a deleted copy and will be moved to the kept one. */
  repointProductIds: string[];
}

export interface Conflict {
  table: DedupeTable;
  key: string;
  label: string;
  copies: number;
  field: string;
  values: unknown[];
}

export interface TableSummary {
  table: DedupeTable;
  rows: number;
  duplicateGroups: number;
  toDelete: number;
  conflicts: number;
}

export interface DedupePlan {
  groups: GroupPlan[];
  conflicts: Conflict[];
  summary: TableSummary[];
  totalToDelete: number;
  totalRepoints: number;
}

/** Never compared, never filled. */
function isIgnoredField(field: string): boolean {
  return (
    field === "id" ||
    field === "createdAt" ||
    field === "updatedAt" ||
    field === "owner" ||
    field === "realmId" ||
    field.startsWith("$") ||
    field.startsWith("_")
  );
}

/** Values that mean the same thing are compared as the same value. */
function normalise(field: string, value: unknown): unknown {
  if (field === "archived") return value === true; // undefined ≡ false
  return value;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function time(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const t = new Date(value).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return Number.POSITIVE_INFINITY; // unknown age sorts last
}

function displayName(row: Row): string {
  const name = row.name;
  return typeof name === "string" && name.length > 0 ? name : String(row[LINK_KEY.decorationCategories] ?? "");
}

function planTable(
  table: DedupeTable,
  rows: Row[],
  refCount: Map<string, number>,
  productsByCategory: Map<string, string[]>,
): { groups: GroupPlan[]; conflicts: Conflict[] } {
  const keyField = LINK_KEY[table];
  const byKey = new Map<string, Row[]>();
  for (const row of rows) {
    const key = row[keyField];
    if (typeof row.id !== "string" || typeof key !== "string") continue;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }

  const groups: GroupPlan[] = [];
  const conflicts: Conflict[] = [];

  for (const [key, copies] of byKey) {
    if (copies.length < 2) continue;
    const label = displayName(copies[0]);

    // Refuse to merge copies that disagree on any real setting.
    const fields = new Set<string>();
    for (const row of copies) for (const f of Object.keys(row)) if (!isIgnoredField(f)) fields.add(f);

    const distinctDefined = new Map<string, unknown[]>();
    let conflict: Conflict | undefined;
    for (const field of [...fields].sort()) {
      const values: unknown[] = [];
      for (const row of copies) {
        const v = normalise(field, row[field]);
        if (v === undefined) continue;
        if (!values.some((existing) => same(existing, v))) values.push(v);
      }
      if (values.length > 1) {
        conflict = { table, key, label, copies: copies.length, field, values };
        break;
      }
      distinctDefined.set(field, values);
    }
    if (conflict) {
      conflicts.push(conflict);
      continue;
    }

    // Keep: most-referenced (product categories), then active, then oldest, then id.
    const ranked = [...copies].sort((a, b) => {
      const refs = (refCount.get(b.id as string) ?? 0) - (refCount.get(a.id as string) ?? 0);
      if (refs !== 0) return refs;
      const arch = Number(a.archived === true) - Number(b.archived === true);
      if (arch !== 0) return arch;
      const age = time(a.createdAt) - time(b.createdAt);
      if (age !== 0) return age;
      return (a.id as string) < (b.id as string) ? -1 : 1;
    });
    const keep = ranked[0];
    const deleteIds = ranked.slice(1).map((r) => r.id as string);

    const fill: Record<string, unknown> = {};
    for (const [field, values] of distinctDefined) {
      if (field === "archived") continue; // normalised; never a gap
      if (keep[field] === undefined && values.length === 1) fill[field] = values[0];
    }

    const repointProductIds =
      table === "productCategories" ? deleteIds.flatMap((id) => productsByCategory.get(id) ?? []) : [];

    groups.push({
      table,
      key,
      label,
      copies: copies.length,
      keepId: keep.id as string,
      deleteIds,
      fill,
      repointProductIds,
    });
  }

  groups.sort((a, b) => a.label.localeCompare(b.label));
  conflicts.sort((a, b) => a.label.localeCompare(b.label));
  return { groups, conflicts };
}

export function planDedupe(snapshot: DedupeSnapshot): DedupePlan {
  const refCount = new Map<string, number>();
  const productsByCategory = new Map<string, string[]>();
  for (const p of snapshot.products) {
    if (typeof p.id !== "string" || typeof p.productCategoryId !== "string") continue;
    refCount.set(p.productCategoryId, (refCount.get(p.productCategoryId) ?? 0) + 1);
    const list = productsByCategory.get(p.productCategoryId);
    if (list) list.push(p.id);
    else productsByCategory.set(p.productCategoryId, [p.id]);
  }

  const groups: GroupPlan[] = [];
  const conflicts: Conflict[] = [];
  const summary: TableSummary[] = [];

  for (const table of DEDUPE_TABLES) {
    const rows = snapshot[table];
    const planned = planTable(table, rows, refCount, productsByCategory);
    groups.push(...planned.groups);
    conflicts.push(...planned.conflicts);
    summary.push({
      table,
      rows: rows.length,
      duplicateGroups: planned.groups.length,
      toDelete: planned.groups.reduce((n, g) => n + g.deleteIds.length, 0),
      conflicts: planned.conflicts.length,
    });
  }

  return {
    groups,
    conflicts,
    summary,
    totalToDelete: summary.reduce((n, s) => n + s.toDelete, 0),
    totalRepoints: groups.reduce((n, g) => n + g.repointProductIds.length, 0),
  };
}

/** Products whose productCategoryId points at a category that doesn't exist. */
export function danglingProductCategoryRefs(snapshot: DedupeSnapshot): string[] {
  const ids = new Set(snapshot.productCategories.map((c) => c.id).filter((id): id is string => typeof id === "string"));
  return snapshot.products
    .filter((p) => typeof p.productCategoryId === "string" && !ids.has(p.productCategoryId))
    .map((p) => p.id)
    .filter((id): id is string => typeof id === "string");
}
