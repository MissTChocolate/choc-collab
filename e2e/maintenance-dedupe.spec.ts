import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * /maintenance — duplicate category cleanup, end to end.
 *
 * Runs in local-only mode (no Dexie Cloud). Duplicates are planted straight
 * into IndexedDB to recreate what the fresh-browser seeding race left behind;
 * the cleanup itself runs through the app's own database layer. The
 * sync-readiness lock needs a Dexie Cloud server and is covered by the unit
 * tests in src/lib/seedGate.test.ts.
 */

type Rows = Record<string, unknown>[];

async function dbName(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const found = (await indexedDB.databases()).map((d) => d.name).find((n) => n?.startsWith("ChocolatierDB"));
    if (!found) throw new Error("app database not found");
    return found;
  });
}

async function readAll(page: Page, store: string): Promise<Rows> {
  const name = await dbName(page);
  return page.evaluate(
    ({ name, store }) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction(store).objectStore(store).getAll();
          all.onsuccess = () => {
            req.result.close();
            resolve(all.result);
          };
          all.onerror = () => reject(all.error);
        };
      }),
    { name, store },
  );
}

async function plant(page: Page, data: Record<string, Rows>) {
  const name = await dbName(page);
  await page.evaluate(
    ({ name, data }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction(Object.keys(data), "readwrite");
          for (const [store, rows] of Object.entries(data)) for (const row of rows) tx.objectStore(store).put(row);
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { name, data },
  );
}

/** Open /maintenance and wait until the default rows have been seeded. */
async function openSeeded(page: Page) {
  await page.goto("/maintenance");
  await expect(page.getByTestId("summary")).toBeVisible();
  await expect
    .poll(async () => {
      const [pc, fc, dc, sd] = await Promise.all(
        ["productCategories", "fillingCategories", "decorationCategories", "shellDesigns"].map((s) => readAll(page, s)),
      );
      return pc.length >= 4 && fc.length > 0 && dc.length > 0 && sd.length > 0;
    })
    .toBe(true);
}

const willRemove = (page: Page, table: string) =>
  page.getByTestId(`summary-${table}`).getByTestId("will-remove");

const product = (id: string, productCategoryId: string) => ({
  id,
  name: `Probe ${id}`,
  productCategoryId,
  createdAt: new Date("2026-05-01"),
  updatedAt: new Date("2026-05-01"),
});

test.describe("Maintenance — remove duplicate categories", () => {
  test("removes duplicates, keeps the rows things point at, and verifies", async ({ page }) => {
    await openSeeded(page);

    const productCats = await readAll(page, "productCategories");
    const seededMoulded = productCats.find((c) => c.name === "moulded")!;
    const seededEnrobed = productCats.find((c) => c.name === "enrobed")!;
    const filling = (await readAll(page, "fillingCategories"))[0];
    const decoration = (await readAll(page, "decorationCategories"))[0];
    const design = (await readAll(page, "shellDesigns")).find((d) => d.defaultApplyAt !== undefined)!;
    const { id: _f, ...fillingFields } = filling;
    const { id: _d, ...decorationFields } = decoration;
    const { id: _s, defaultApplyAt, ...designFields } = design;

    await plant(page, {
      productCategories: [
        // moulded: products use a copy that is neither the oldest nor the newest,
        // and the oldest is missing the backfilled shopKind.
        { ...seededMoulded, id: "pc-m-old", shopKind: undefined, createdAt: new Date("2026-04-28") },
        { ...seededMoulded, id: "pc-m-used", createdAt: new Date("2026-05-04") },
        // enrobed: products split across two copies — the minority must move.
        { ...seededEnrobed, id: "pc-e-2", createdAt: new Date("2026-04-30") },
        { ...seededEnrobed, id: "pc-e-3", createdAt: new Date("2026-07-10") },
      ],
      products: [
        product("p1", "pc-m-used"),
        product("p2", "pc-m-used"),
        product("p3", "pc-m-used"),
        product("p4", "pc-e-2"),
        product("p5", "pc-e-2"),
        product("p6", "pc-e-3"),
      ],
      fillingCategories: [
        { ...fillingFields, id: "fc-2", createdAt: new Date("2030-01-01") },
        { ...fillingFields, id: "fc-3", createdAt: new Date("2030-01-02") },
      ],
      decorationCategories: [{ ...decorationFields, id: "dc-2", createdAt: new Date("2030-01-01") }],
      // Oldest copy is missing defaultApplyAt; the seeded copy has it.
      shellDesigns: [{ ...designFields, id: "sd-old", createdAt: new Date("2020-01-01") }],
      // Copies that disagree must be left alone.
      ingredientCategories: [
        { id: "ic-z1", name: "Zeta Test", archived: true, createdAt: new Date("2026-05-01"), updatedAt: new Date("2026-05-01") },
        { id: "ic-z2", name: "Zeta Test", createdAt: new Date("2026-05-02"), updatedAt: new Date("2026-05-02") },
      ],
    });

    await page.reload();
    await expect(willRemove(page, "productCategories")).toHaveText("4");
    await expect(willRemove(page, "fillingCategories")).toHaveText("2");
    await expect(willRemove(page, "decorationCategories")).toHaveText("1");
    await expect(willRemove(page, "shellDesigns")).toHaveText("1");
    await expect(willRemove(page, "ingredientCategories")).toHaveText("0");
    await expect(page.getByTestId("conflicts")).toContainText("Zeta Test");
    await expect(page.getByTestId("conflicts")).toContainText("archived");

    // Two-step confirmation; Escape backs out.
    await page.getByTestId("remove").click();
    await expect(page.getByTestId("confirm-panel")).toContainText("permanently removes 8 rows and moves 1 product");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("confirm-panel")).toBeHidden();
    await page.getByTestId("remove").click();

    // A recovery file downloads before anything is removed.
    const download = page.waitForEvent("download");
    await page.getByTestId("confirm").click();
    expect((await download).suggestedFilename()).toMatch(/^choc-collab-before-duplicate-cleanup-.*\.json$/);

    const result = page.getByTestId("result");
    await expect(result).toContainText("Removed 8 duplicates, moved 1 product");
    await expect(result).toContainText("no duplicates remain");
    await expect(result).toContainText("every product's category exists");

    // Verify the database directly.
    const pcAfter = await readAll(page, "productCategories");
    expect(pcAfter.filter((c) => c.name === "moulded").map((c) => c.id)).toEqual(["pc-m-used"]);
    expect(pcAfter.filter((c) => c.name === "enrobed").map((c) => c.id)).toEqual(["pc-e-2"]);

    const products = await readAll(page, "products");
    const byId = Object.fromEntries(products.map((p) => [p.id, p.productCategoryId]));
    expect(byId).toMatchObject({ p1: "pc-m-used", p2: "pc-m-used", p3: "pc-m-used", p4: "pc-e-2", p5: "pc-e-2", p6: "pc-e-2" });
    const catIds = new Set(pcAfter.map((c) => c.id));
    expect(products.filter((p) => p.productCategoryId && !catIds.has(p.productCategoryId as string))).toEqual([]);

    expect((await readAll(page, "fillingCategories")).filter((c) => c.name === filling.name)).toHaveLength(1);
    expect((await readAll(page, "decorationCategories")).filter((c) => c.slug === decoration.slug)).toHaveLength(1);

    const designs = (await readAll(page, "shellDesigns")).filter((d) => d.name === design.name);
    expect(designs).toHaveLength(1);
    expect(designs[0]).toMatchObject({ id: "sd-old", defaultApplyAt }); // gap filled from the deleted copy

    expect((await readAll(page, "ingredientCategories")).filter((c) => c.name === "Zeta Test")).toHaveLength(2);

    // A fresh look finds nothing left to do.
    await page.reload();
    await expect(page.getByTestId("nothing-to-do")).toBeVisible();
    await expect(page.getByTestId("conflicts")).toContainText("Zeta Test");
  });

  test("changes nothing if the data changed after the preview", async ({ page }) => {
    await openSeeded(page);
    const moulded = (await readAll(page, "productCategories")).find((c) => c.name === "moulded")!;

    await plant(page, { productCategories: [{ ...moulded, id: "pc-extra-1", createdAt: new Date("2030-01-01") }] });
    await page.reload();
    await expect(willRemove(page, "productCategories")).toHaveText("1");

    // Another copy arrives behind the preview's back (e.g. a sync landing).
    await plant(page, { productCategories: [{ ...moulded, id: "pc-extra-2", createdAt: new Date("2030-01-02") }] });

    await page.getByTestId("remove").click();
    const download = page.waitForEvent("download");
    await page.getByTestId("confirm").click();
    await download;

    await expect(page.getByTestId("error")).toContainText("The data changed since the preview was shown");
    expect((await readAll(page, "productCategories")).filter((c) => c.name === "moulded")).toHaveLength(3);
  });

  test("shows nothing to do on a clean database", async ({ page }) => {
    await openSeeded(page);
    await expect(page.getByTestId("nothing-to-do")).toBeVisible();
    await expect(page.getByTestId("remove")).toHaveCount(0);
  });
});
