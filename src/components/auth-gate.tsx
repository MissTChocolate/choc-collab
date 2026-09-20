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
