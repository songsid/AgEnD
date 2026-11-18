/**
 * M-3314 (measured in M-3312): the web app's files under a version, cached for good, and its module graph preloaded.
 *
 * Over a slow link every file was a round trip (`no-store`), and the app's ES modules arrived in about fourteen waves —
 * each one learnt only from the one before. Now:
 *
 * - **A version in the path.** `/assets/v-<V>/<name>` and `/ui/js/v-<V>/<name>` serve exactly what the plain paths serve,
 *   through the same gates (the request is rewritten to the plain path before anything routes it), but with
 *   `max-age=31536000, immutable` — `public` for /assets (served to anyone), `private` for /ui/js (a session's). <V> is
 *   a hash of every file of the ui directory, so an update or a rollback is a new <V>: nothing cached is reused across.
 *   The plain paths stay as they were (`no-store`) for every page that names them.
 * - **Never mixed versions.** A tab opened on an older <V> that loads a module later asks for that older <V>: it gets a
 *   module that throws a SyntaxError (a stylesheet: 404), which is what the stale-tab prompt (#3822) already recognises
 *   — "this tab is older than AgEnD" with Reload — instead of a new file linked into old ones.
 * - **One import map** in the app shell maps `/assets/` and `/ui/js/` to the versioned paths, so the 800-odd absolute
 *   and relative imports in the modules need no change; it maps the versioned prefixes to themselves, so a module's
 *   relative import (already versioned by its own URL) is not versioned twice.
 * - **modulepreload.** The server reads the modules' static imports once (buildModuleGraph); the shell names the whole
 *   static closure of what this load opens, so the browser asks for all of it at once (one wave, not fourteen). The
 *   panels loaded later (Settings, Fleet…) are warmed the same way from the graph the shell carries (module-warm.js).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

/** The ui directory beside this module (src/ui in tests, dist/ui when installed) — the one the file routes read. */
export const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "ui");

/** A versioned path: the area (`assets` or `ui/js`), the version, the rest (the plain path's name). */
export const VERSIONED_ASSET_PATH = /^\/(assets|ui\/js)\/v-([0-9a-f]{12})\/([^/?#]+)$/;
export const IMMUTABLE_PUBLIC = "public, max-age=31536000, immutable";
export const IMMUTABLE_PRIVATE = "private, max-age=31536000, immutable";
/** What an older tab's module request gets: the stale-tab prompt's SyntaxError, never a newer file. */
export const STALE_MODULE_BODY = "throw new SyntaxError(\"AgEnD was updated: this tab is older than the server. Reload it.\");\n";

function filesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** <V>: the first 12 hex of a SHA-256 over every file of `uiDir` (its path and bytes), in a fixed order. */
export function computeAssetVersion(uiDir: string = UI_DIR): string {
  const h = createHash("sha256");
  for (const f of filesUnder(uiDir).sort()) { h.update(f); h.update("\0"); h.update(readFileSync(join(uiDir, f))); h.update("\0"); }
  return h.digest("hex").slice(0, 12);
}

let memo: { dir: string; v: string } | null = null;
/** This process's <V>, computed once (an update restarts the process, and with it the version). */
export function assetVersion(uiDir: string = UI_DIR): string {
  if (!memo || memo.dir !== uiDir) memo = { dir: uiDir, v: computeAssetVersion(uiDir) };
  return memo.v;
}
/** Tests and smokes: forget the computed version, or pin it (what an update looks like to an open tab). */
export function resetAssetVersion(pin?: string): void { memo = pin ? { dir: UI_DIR, v: pin } : null; }

const marks = new WeakMap<IncomingMessage, { current: boolean; version: string }>();

/**
 * Before anything routes the request (the public link's route list, the session gate, the handlers): a versioned path
 * is rewritten to its plain path, and the request remembers it was versioned and whether that is this process's <V>.
 * Anything else is left as it is. Once per request (the public link's gateway and the listener both call it).
 */
export function takeAssetVersion(req: IncomingMessage, current: () => string = () => assetVersion()): void {
  if (marks.has(req)) return;
  const raw = req.url ?? "/";
  const q = raw.search(/[?#]/);
  const path = q < 0 ? raw : raw.slice(0, q);
  const m = VERSIONED_ASSET_PATH.exec(path);
  if (!m) return;
  req.url = `/${m[1]}/${m[3]}${q < 0 ? "" : raw.slice(q)}`;
  marks.set(req, { current: m[2] === current(), version: m[2] });
}

/** The version mark takeAssetVersion left (undefined: a plain path). */
export function assetVersionMark(req: IncomingMessage): { current: boolean; version: string } | undefined { return marks.get(req); }

/** A request for an older (or another) <V>: a module that throws the stale-tab SyntaxError; anything else 404. */
export function answerStaleAsset(res: ServerResponse, path: string): void {
  if (path.endsWith(".js")) {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(STALE_MODULE_BODY);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: "not found" }));
}

/** A stylesheet served under <V>: its own `url("/assets/…")` (fonts, @import) under the same <V>. */
export function versionCss(css: string, version: string): string {
  return css.split('url("/assets/').join(`url("/assets/v-${version}/`);
}

export type ModuleGraph = ReadonlyMap<string, readonly string[]>;

const STATIC_IMPORT = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']/g;

/** The static imports of a module's source (side-effect imports and re-exports included; dynamic `import()` not). */
export function staticImportsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(STATIC_IMPORT)) out.push(m[1]);
  for (const m of source.matchAll(/(?:import|export)\{[^}]*\}from"([^"]+)"/g)) out.push(m[1]);   // minified vendor files
  for (const m of source.matchAll(/import\s*\w+\s*from"([^"]+)"/g)) out.push(m[1]);
  return [...new Set(out)];
}

/**
 * The served modules (every `/assets/<name>.js`, every `/ui/js/<name>.js`) and the served modules each one imports
 * statically, by plain URL. An import that names nothing served (a vendor path, a typo in a comment) is left out, so a
 * preload never asks for a file that is not there.
 */
export function buildModuleGraph(uiDir: string, assets: ReadonlyArray<readonly [string, string]>): ModuleGraph {
  const files = new Map<string, string>();
  for (const [name, file] of assets) if (name.endsWith(".js")) files.set(`/assets/${name}`, join(uiDir, file));
  for (const f of readdirSync(uiDir)) if (/^[a-z0-9_-]+\.js$/.test(f)) files.set(`/ui/js/${f}`, join(uiDir, f));
  const graph = new Map<string, string[]>();
  for (const [url, file] of files) {
    let source: string;
    try { source = readFileSync(file, "utf-8"); } catch { continue; }
    const deps: string[] = [];
    for (const spec of staticImportsOf(source)) {
      if (!spec.startsWith("/") && !spec.startsWith("./") && !spec.startsWith("../")) continue;
      const to = new URL(spec, `http://h${url}`).pathname;
      if (files.has(to) && to !== url && !deps.includes(to)) deps.push(to);
    }
    graph.set(url, deps);
  }
  return graph;
}

/** Every module the entries import statically, directly or not, the entries first (breadth first). */
export function staticClosure(graph: ModuleGraph, entries: readonly string[]): string[] {
  const seen = new Set<string>(), queue = entries.filter(e => graph.has(e));
  for (const e of queue) seen.add(e);
  for (let i = 0; i < queue.length; i++) for (const d of graph.get(queue[i]) ?? []) if (!seen.has(d)) { seen.add(d); queue.push(d); }
  return queue;
}

/**
 * How many waves of requests loading `entries` takes when `preloaded` are asked for at once up front: a module that is
 * not preloaded is asked for only once the module importing it has arrived. 1 = everything in the first wave.
 */
export function loadWaves(graph: ModuleGraph, entries: readonly string[], preloaded: ReadonlySet<string>): number {
  const wave = new Map<string, number>();
  const queue: string[] = [];
  for (const e of entries) if (graph.has(e) && !wave.has(e)) { wave.set(e, 1); queue.push(e); }
  for (const p of preloaded) if (graph.has(p) && !wave.has(p)) { wave.set(p, 1); queue.push(p); }
  // Breadth first by wave: a module's import arrives one wave after it unless it was asked for earlier.
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i], w = wave.get(u)!;
    for (const d of graph.get(u) ?? []) if (!wave.has(d)) { wave.set(d, w + 1); queue.push(d); }
  }
  let max = 0;
  for (const u of staticClosure(graph, entries)) max = Math.max(max, wave.get(u) ?? 0);
  return max;
}

/** A plain module URL under <V>. */
export const versioned = (url: string, version: string): string => url.replace(/^\/(assets|ui\/js)\//, `/$1/v-${version}/`);

/**
 * The app shell under <V>: its own `/assets/` scripts and stylesheets versioned, then — before any of them — the import
 * map and one modulepreload per module of `preload`, and (when given) the module graph module-warm.js reads for the
 * panels opened later. `<script type="importmap">` is the one inline script spelling sendPanelHtml gives the nonce to
 * besides a bare `<script>`; the graph is data (`application/json`), which no policy runs.
 */
export function versionShell(html: string, version: string, preload: readonly string[], graph?: ModuleGraph): string {
  const pre = `/v-${version}/`;
  const map = { imports: { "/assets/": `/assets${pre}`, "/ui/js/": `/ui/js${pre}`, [`/assets${pre}`]: `/assets${pre}`, [`/ui/js${pre}`]: `/ui/js${pre}` } };
  const head = [`<script type="importmap">${JSON.stringify(map)}</script>`,
    ...preload.map(u => `<link rel="modulepreload" href="${versioned(u, version)}">`),
    ...(graph ? [`<script type="application/json" id="agend-modules">${JSON.stringify(Object.fromEntries(graph)).replace(/</g, "\\u003c")}</script>`] : [])].join("\n");
  const body = html.replace(/(src|href)="\/assets\//g, `$1="/assets${pre}`);
  const at = body.search(/<script|<link rel="stylesheet"/);
  return at < 0 ? body : `${body.slice(0, at)}${head}\n${body.slice(at)}`;
}
