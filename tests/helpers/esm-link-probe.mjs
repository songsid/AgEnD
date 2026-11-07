// #3321: a real ES module LINK of the web app's modules, the way a browser links them — V8's own linker through vm.SourceTextModule (run with
// `node --experimental-vm-modules`), nothing evaluated. A named import of an export the module at that address does not have fails here exactly as it
// does in a tab ("The requested module … does not provide an export named …").
//
// The app's modules import each other by the URLs the server serves them at: /assets/<name> is src/ui/shared/<name> and /ui/js/<name> is
// src/ui/<name> (the server's fixed asset map; vitest.config.ts resolves them the same). `overrides` serves another file at a module's address, which is
// how a tab that opened before an upgrade is stood in for: it still holds the module it loaded then.
//
// argv[2] is JSON: { repo, root?, inline?, overrides? }
//   repo       the checkout whose src/ui is served
//   root       the module to link (a URL as the app imports it, e.g. "/ui/js/panel-settings.js")
//   inline     instead of root: the source of a one-off module, linked as if it sat in src/ui
//   overrides  { "/assets/usage-dialog.js": "<file whose source is served there>" }
// Prints one JSON line: { ok: true, modules: <how many were linked> } or { ok: false, message }.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import vm from "node:vm";

const cfg = JSON.parse(process.argv[2]);
const SRC = join(cfg.repo, "src", "ui");
const context = vm.createContext({});
const modules = new Map();

function resolveSpecifier(specifier, parentPath) {
  let m;
  if ((m = /^\/assets\/([a-z0-9._-]+)$/.exec(specifier))) return join(SRC, "shared", m[1]);
  if ((m = /^\/ui\/js\/([a-z0-9_-]+\.js)(\?retry=\d+)?$/.exec(specifier))) return join(SRC, m[1]);
  if (specifier.startsWith("./") || specifier.startsWith("../")) return resolve(dirname(parentPath), specifier.split("?")[0]);
  throw new Error(`cannot resolve ${specifier} from ${parentPath}`);
}
const overrideFor = (path) => {
  for (const [url, file] of Object.entries(cfg.overrides ?? {})) if (resolveSpecifier(url, join(SRC, "x.js")) === path) return file;
  return null;
};
function load(path, source) {
  if (modules.has(path)) return modules.get(path);
  // The identifier stays the real path, so the relative imports of a stand-in resolve from where the original sat.
  const mod = new vm.SourceTextModule(source ?? readFileSync(overrideFor(path) ?? path, "utf8"), { identifier: path, context });
  modules.set(path, mod);
  return mod;
}
const linker = (specifier, referencing) => load(resolveSpecifier(specifier, referencing.identifier));

try {
  const root = cfg.inline !== undefined ? load(join(SRC, "__probe__.js"), cfg.inline) : load(resolveSpecifier(cfg.root, join(SRC, "x.js")));
  await root.link(linker);
  console.log(JSON.stringify({ ok: true, modules: modules.size }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, message: String((e && e.message) || e) }));
}
