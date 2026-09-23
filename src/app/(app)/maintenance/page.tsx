"use client";

/**
 * Maintenance: remove duplicate categories and shell designs.
 *
 * Duplicates were created by the fresh-browser seeding race (see
 * src/lib/seedGate.ts). This page previews exactly what will change, stays
 * locked until the browser is fully synced, downloads a recovery file, then
 * applies the plan through the app's own database layer so the changes sync.
 * Not linked from the navigation — open /maintenance directly.
 */

import { useEffect, useState } from "react";
import { useLiveQuery, useObservable } from "dexie-react-hooks";
import { db, isCloudConfigured } from "@/lib/db";
import { isSafeToSeed } from "@/lib/seedGate";
import { planDedupe, TABLE_LABELS, type DedupeTable } from "@/lib/dedupePlan";
import { applyDedupe, readDedupeSnapshot, type DedupeResult } from "@/lib/dedupe";
import { PageHeader } from "@/components/page-header";

/** Product category names are stored lowercase and shown capitalised elsewhere. */
const nameClass = (table: DedupeTable) => (table === "productCategories" ? "capitalize" : "");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function MaintenancePage() {
  // Re-render as sign-in and sync state change; the values are read below.
  useObservable(db.cloud.currentUser);
  useObservable(db.cloud.syncState);
  useObservable(db.cloud.persistedSyncState);
  const syncReady = isSafeToSeed({
    cloudConfigured: isCloudConfigured,
    currentUser: db.cloud.currentUser,
    syncState: db.cloud.syncState,
    persistedSyncState: db.cloud.persistedSyncState,
  });

  const plan = useLiveQuery(async () => planDedupe(await readDedupeSnapshot()));

  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DedupeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setConfirming(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  async function run() {
    if (!plan) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await applyDedupe(plan));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setConfirming(false);
    }
  }

  return (
    <div className="pb-16">
      <PageHeader
        title="Maintenance"
        description="Remove duplicate categories and shell designs. Nothing changes until you confirm, and a recovery file downloads first."
      />

      <div className="px-4 space-y-6 max-w-3xl">
        <p
          data-testid="sync-status"
          className={`text-sm rounded-lg px-3 py-2 ${syncReady ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}
        >
          {syncReady
            ? isCloudConfigured
              ? "This browser is fully synced."
              : "Local-only mode."
            : "Waiting for this browser to finish syncing. The cleanup stays locked until then, so it can't miss anything that hasn't downloaded yet."}
        </p>

        {!plan ? (
          <p className="text-sm text-muted-foreground">Checking…</p>
        ) : (
          <>
            <table className="w-full text-sm" data-testid="summary">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 font-medium">Table</th>
                  <th className="py-2 font-medium text-right">Rows</th>
                  <th className="py-2 font-medium text-right">Will remove</th>
                  <th className="py-2 font-medium text-right">Needs a decision</th>
                </tr>
              </thead>
              <tbody>
                {plan.summary.map((s) => (
                  <tr key={s.table} className="border-t border-border" data-testid={`summary-${s.table}`}>
                    <td className="py-2">{TABLE_LABELS[s.table]}</td>
                    <td className="py-2 text-right tabular-nums">{s.rows}</td>
                    <td className="py-2 text-right tabular-nums" data-testid="will-remove">{s.toDelete}</td>
                    <td className="py-2 text-right tabular-nums">{s.conflicts}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {plan.groups.length > 0 && (
              <section>
                <h2 className="text-sm font-medium mb-2">What will change</h2>
                <ul className="text-sm space-y-1.5" data-testid="groups">
                  {plan.groups.map((g) => (
                    <li key={`${g.table}:${g.key}`}>
                      <span className={`font-medium ${nameClass(g.table)}`}>{g.label}</span>
                      <span className="text-muted-foreground">
                        {" "}— {TABLE_LABELS[g.table].toLowerCase()}: {g.copies} copies, keep 1, remove {g.deleteIds.length}
                        {g.repointProductIds.length > 0 && `, move ${plural(g.repointProductIds.length, "product")} to the kept copy`}
                        {Object.keys(g.fill).length > 0 &&
                          `, fill in ${Object.entries(g.fill).map(([k, v]) => `${k} = ${String(v)}`).join(", ")}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {plan.conflicts.length > 0 && (
              <section>
                <h2 className="text-sm font-medium mb-1">Left untouched — needs a decision</h2>
                <p className="text-xs text-muted-foreground mb-2">
                  These copies differ in a setting, so the tool won&apos;t guess which to keep. Open each one and make them
                  match (or archive the one you don&apos;t want), then come back.
                </p>
                <ul className="text-sm space-y-1.5" data-testid="conflicts">
                  {plan.conflicts.map((c) => (
                    <li key={`${c.table}:${c.key}`}>
                      <span className={`font-medium ${nameClass(c.table)}`}>{c.label}</span>
                      <span className="text-muted-foreground">
                        {" "}— {TABLE_LABELS[c.table].toLowerCase()}: {c.copies} copies differ in <code>{c.field}</code> (
                        {c.values.map((v) => String(v)).join(" / ")})
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {!result && (
              <section className="pt-2">
                {plan.totalToDelete === 0 ? (
                  <p className="text-sm" data-testid="nothing-to-do">No duplicates to remove.</p>
                ) : !confirming ? (
                  <button
                    type="button"
                    data-testid="remove"
                    disabled={!syncReady || running}
                    onClick={() => setConfirming(true)}
                    className="btn-primary px-4 py-2 text-sm disabled:opacity-50"
                  >
                    Remove {plural(plan.totalToDelete, "duplicate")}…
                  </button>
                ) : (
                  <div className="rounded-lg border border-border p-3 space-y-3" data-testid="confirm-panel">
                    <p className="text-sm">
                      This permanently removes {plural(plan.totalToDelete, "row")}
                      {plan.totalRepoints > 0 && ` and moves ${plural(plan.totalRepoints, "product")} to the kept copies`}.
                      A recovery file downloads first.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        data-testid="confirm"
                        disabled={!syncReady || running}
                        onClick={run}
                        className="btn-primary px-4 py-2 text-sm disabled:opacity-50"
                      >
                        {running ? "Removing…" : "Confirm and remove"}
                      </button>
                      <button
                        type="button"
                        disabled={running}
                        onClick={() => setConfirming(false)}
                        className="px-4 py-2 text-sm rounded-full border border-border"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </>
        )}

        {error && (
          <p className="text-sm rounded-lg px-3 py-2 bg-red-50 text-red-900" data-testid="error">
            {error}
          </p>
        )}

        {result && (
          <div className="text-sm rounded-lg px-3 py-2 bg-emerald-50 text-emerald-900 space-y-1" data-testid="result">
            <p>
              Removed {plural(result.removed, "duplicate")}
              {result.repointed > 0 && `, moved ${plural(result.repointed, "product")}`}.
            </p>
            <p>
              Check after cleanup:{" "}
              {result.remainingDuplicates === 0 ? "no duplicates remain" : `${result.remainingDuplicates} still found`};{" "}
              {result.danglingProducts.length === 0
                ? "every product's category exists."
                : `${plural(result.danglingProducts.length, "product")} point at a missing category — restore the recovery file.`}
            </p>
            {isCloudConfigured && (
              <p>{syncReady ? "Synced to your other devices." : "Syncing to your other devices…"}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
