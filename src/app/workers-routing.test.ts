import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Fork-specific guard: Cloudflare WORKERS routing hazards.
 *
 * This fork deploys on Cloudflare Workers static assets, not Pages. On Workers,
 * `_redirects` rules are "always followed, regardless of whether or not an
 * asset matches the incoming request", so a literal page that sits beside a
 * dynamic `[id]` route gets shadowed by the `/<section>/:id` catch-all and is
 * served the `_spa` shell instead. Upstream guards this with self-referential
 * `200` pass-throughs, which work on Pages and silently fail on Workers.
 *
 * Symptom when this is violated: the page hangs on "Loading…" and React
 * throws minified error #418. See choc-collab/app#168.
 *
 * Fix pattern: move the literal page OUT of the section (e.g. /production/new
 * -> /new-batch, /labels/new -> /new-label) and 301 the old URL.
 *
 * If these tests fail after merging upstream, upstream added a new page of
 * this shape. Apply the same fix before deploying.
 */

const SRC_APP = join(import.meta.dirname, ".");
const REDIRECTS = join(import.meta.dirname, "..", "..", "public", "_redirects");

/** Directories under src/app that contain a dynamic `[param]` child. */
function sectionsWithDynamicChild(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
  if (entries.some((e) => /^\[[^\]]+\]$/.test(e))) out.push(dir);
  for (const e of entries) out.push(...sectionsWithDynamicChild(join(dir, e)));
  return out;
}

describe("Cloudflare Workers routing hazards", () => {
  it("no static page sits beside a dynamic [id] route", () => {
    const offenders: string[] = [];
    for (const section of sectionsWithDynamicChild(SRC_APP)) {
      for (const child of readdirSync(section)) {
        const abs = join(section, child);
        if (!statSync(abs).isDirectory()) continue;
        if (/^\[[^\]]+\]$/.test(child)) continue; // the dynamic route itself
        if (child.startsWith("(")) continue; // route groups add no URL segment
        // A sibling is only a hazard if it is itself a page. Path prefixes
        // with no page of their own (e.g. categories/) are real rewrites.
        if (existsSync(join(abs, "page.tsx"))) {
          offenders.push(relative(SRC_APP, abs));
        }
      }
    }
    expect(
      offenders,
      "Static page(s) beside a dynamic [id] route will be shadowed on Workers. " +
        "Move them out of the section and 301 the old URL (see the comment at " +
        "the top of this file).",
    ).toEqual([]);
  });

  it("_redirects has no self-referential 200 pass-throughs", () => {
    const offenders: string[] = [];
    for (const raw of readFileSync(REDIRECTS, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const [from, to, status] = line.split(/\s+/);
      if (status !== "200") continue;
      const norm = (p: string) => p.replace(/\/:splat$/, "/*").replace(/\/$/, "");
      if (norm(from) === norm(to)) offenders.push(line);
    }
    expect(
      offenders,
      "Self-referential 200 rules are a Pages-only pattern and do not protect " +
        "the page on Workers.",
    ).toEqual([]);
  });
});
