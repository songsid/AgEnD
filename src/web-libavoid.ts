/**
 * #2182: libavoid for the org canvas's traffic lines — libavoid-js (Adaptagrams' libavoid compiled to WebAssembly,
 * LGPL-2.1-or-later), an exact-pinned npm dependency. AgEnD does not copy or change it: npm installs the package as
 * published (its LICENSE with it), and the dashboard serves that package's own two files, unmodified, as separate
 * files at a versioned path — the browser build of the glue and the .wasm — so it stays a separately replaceable
 * library. The worker that runs it (src/ui/fleet-route-worker.js) imports LIBAVOID_PREFIX + "libavoid.js"; the page
 * fetches LIBAVOID_PREFIX + "libavoid.wasm" (src/ui/fleet-route.js).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The version package.json pins; a different one installed is not served (the canvas keeps its lane routes). */
export const LIBAVOID_VERSION = "0.4.5";
export const LIBAVOID_PREFIX = `/ui/vendor/libavoid-${LIBAVOID_VERSION}/`;
export const LIBAVOID_PATHS: readonly string[] = [`${LIBAVOID_PREFIX}libavoid.js`, `${LIBAVOID_PREFIX}libavoid.wasm`];

/** The package a resolved directory holds is the one AgEnD pins: by name and exact version. */
export function isPinnedLibavoid(pkg: { name?: unknown; version?: unknown } | null | undefined): boolean {
  return !!pkg && pkg.name === "libavoid-js" && pkg.version === LIBAVOID_VERSION;
}

let dist: string | null | undefined;
/** The installed package's dist/ directory — null when it is missing or another version. Looked up once. */
function distDir(): string | null {
  if (dist !== undefined) return dist;
  try {
    const d = dirname(createRequire(import.meta.url).resolve("libavoid-js"));
    const pkg = JSON.parse(readFileSync(join(d, "..", "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    dist = isPinnedLibavoid(pkg) ? d : null;
  } catch {
    dist = null;
  }
  return dist;
}

/** The file a request path names, if it is one of LIBAVOID_PATHS (and the package is installed): its path and type. */
export function libavoidFile(path: string): { file: string; type: string } | null {
  if (!LIBAVOID_PATHS.includes(path)) return null;
  const d = distDir();
  if (!d) return null;
  return path.endsWith(".wasm")
    ? { file: join(d, "libavoid.wasm"), type: "application/wasm" }
    : { file: join(d, "index.js"), type: "application/javascript; charset=utf-8" };
}
