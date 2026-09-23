"use client";

import { useEffect } from "react";
import { db, isCloudConfigured } from "@/lib/db";
import { seedIfNeeded } from "@/lib/seed";
import { waitUntilSafeToSeed } from "@/lib/seedGate";
import { ensureDefaultProductCategories, ensureDefaultDecorationCategories, ensureDefaultShellDesigns, ensureDefaultFillingCategories, ensureDefaultIngredientCategories } from "@/lib/hooks";

export function SeedLoader() {
  useEffect(() => {
    // With Dexie Cloud, a fresh browser's local tables are empty until the
    // initial sync lands. Seeding before then inserts a duplicate set of every
    // default. Wait until the local data reflects the cloud — see seedGate.ts.
    const controller = new AbortController();

    waitUntilSafeToSeed(
      {
        cloudConfigured: isCloudConfigured,
        currentUser: db.cloud.currentUser,
        syncState: db.cloud.syncState,
        persistedSyncState: db.cloud.persistedSyncState,
      },
      controller.signal,
    ).then((safe) => {
      if (!safe || controller.signal.aborted) return;

      // Idempotent — only inserts the defaults missing by name. Runs on every
      // app load so fresh users (who skip the v4 upgrade hook) still get the
      // seeded values.
      ensureDefaultProductCategories().catch((e) => console.error("ensureDefaultProductCategories failed:", e));
      ensureDefaultDecorationCategories().catch((e) => console.error("ensureDefaultDecorationCategories failed:", e));
      ensureDefaultShellDesigns().catch((e) => console.error("ensureDefaultShellDesigns failed:", e));
      ensureDefaultFillingCategories().catch((e) => console.error("ensureDefaultFillingCategories failed:", e));
      ensureDefaultIngredientCategories().catch((e) => console.error("ensureDefaultIngredientCategories failed:", e));
      seedIfNeeded();
    });

    return () => controller.abort();
  }, []);

  return null;
}
