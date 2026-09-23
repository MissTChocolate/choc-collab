"use client";

import { useEffect, useState } from "react";
import { useObservable } from "dexie-react-hooks";
import { db, isCloudConfigured } from "@/lib/db";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const currentUser = useObservable(db.cloud.currentUser);

  // Hydration guard: the static export is pre-rendered with no Dexie Cloud
  // session, so the server always emits `null` here. In the browser,
  // `currentUser` can resolve synchronously on the very first render, which
  // made the client emit the sign-in UI (or children) while the server HTML
  // was empty — a hydration mismatch that React 19's production build reports
  // as minified error #418. Inside the `<Suspense fallback={null}>` on
  // /production/new that mismatch is unrecoverable and leaves the page stuck
  // on its fallback forever.
  //
  // Rendering `null` until after mount makes the first client render identical
  // to the server HTML; the real UI appears on the effect-driven re-render a
  // tick later. See AGENT.md → "Static-export hydration gotchas".
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);

    // `db.cloud.currentUser` starts as a placeholder "unauthorized" user and
    // only reflects a saved session once the database has opened — Dexie Cloud
    // loads it in its ready hook. Dexie opens lazily on first access, and this
    // gate hides every page (and so every query) until the user is signed in,
    // so without an explicit open nothing ever loads the session: a returning
    // user is shown "Sign in" on every page load. This used to work only
    // because SeedLoader touched the database on mount; now that seeding waits
    // for sign-in (see seedGate.ts), the dependency has to be explicit.
    //
    // Safe when signed out: with requireAuth, open() simply stays pending until
    // login completes, exactly as it did when SeedLoader triggered it.
    db.open().catch((e) => console.error("Failed to open database:", e));
  }, []);

  if (!isCloudConfigured) return <>{children}</>;
  if (!mounted) return null;
  if (currentUser === undefined) return null;
  if (currentUser.isLoggedIn) return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="max-w-sm w-full space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-3xl text-primary" style={{ fontFamily: "var(--font-display)" }}>
            Choc-collab
          </h1>
          <p className="text-sm text-muted-foreground">
            Sign in to sync your chocolate-making data across devices.
          </p>
        </div>
        <button
          onClick={() => db.cloud.login()}
          className="w-full rounded-full bg-primary text-primary-foreground py-3 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Sign in to continue
        </button>
        <p className="text-xs text-muted-foreground">
          We&apos;ll email you a one-time code — no password needed.
        </p>
      </div>
    </div>
  );
}
