/**
 * AGEND-144 (Prism on #3539, P2-5): the retained-module path. ES modules LINK before they run: a static named import of a name the other module does not export fails the whole
 * module with "does not provide an export named …" — so a tab (or cache) that still holds an older copy of one page module, beside a newer copy of its neighbour, must still link.
 * #3539's accounts-view.js imported `VersionLine` from host-install.js; #3536's host-install.js does not export it.
 *
 * This is a language-level LINK check in plain Node (the page's modules run in a browser; nothing here claims a browser SKEW run — the browser matrix is the PR's evidence): the real
 * module sources, their other imports replaced by inert stubs, imported by a child `node` so Node's own linker answers. The older copies are #3536's own files at its merged commit
 * (tests/fixtures/ui-skew-144), both directions of the mix, plus current/current, plus a control that the probe does fail on the old import.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agend-144-link-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const src = (name: string) => readFileSync(new URL(`../src/ui/${name}`, import.meta.url), "utf8");
const old = (name: string) => readFileSync(new URL(`./fixtures/ui-skew-144/${name}`, import.meta.url), "utf8");

/** Every `import … from "x"` of a module (one per line in these files): [source, named imports]. */
function importsOf(text: string): Array<{ from: string; names: string[]; star: boolean; line: string }> {
  const out: Array<{ from: string; names: string[]; star: boolean; line: string }> = [];
  for (const m of text.matchAll(/^import\s+(?:\*\s+as\s+\w+|\{([^}]*)\})\s+from\s+"([^"]+)";?.*$/gm)) {
    out.push({ from: m[2]!, names: (m[1] ?? "").split(",").map(s => s.trim().split(/\s+as\s+/)[0]!).filter(Boolean), star: m[1] === undefined, line: m[0] });
  }
  return out;
}

let n = 0;
/** Link `entry` (a module name in `modules`) with every module not in `modules` replaced by a stub; the verdict of Node's own linker. */
function link(modules: Record<string, string>, entry: string): { ok: boolean; error: string; exports: string[] } {
  const dir = join(root, `case-${++n}`); mkdirSync(join(dir, "stub"), { recursive: true });
  const stubNames = new Map<string, Set<string>>();
  const rewritten: Record<string, string> = {};
  const stubFile = (from: string) => `stub/${from.replace(/[^A-Za-z0-9]+/g, "_")}.js`;
  for (const [name, text] of Object.entries(modules)) {
    let body = text;
    for (const imp of importsOf(text)) {
      const local = imp.from.startsWith("./") && Object.keys(modules).includes(imp.from.slice(2));
      const target = local ? imp.from : `./${stubFile(imp.from)}`;
      if (!local) { const set = stubNames.get(imp.from) ?? new Set<string>(); imp.names.forEach(x => set.add(x)); stubNames.set(imp.from, set); }
      body = body.replace(imp.line, imp.line.replace(`"${imp.from}"`, `"${target}"`));
    }
    rewritten[name] = body;
  }
  writeFileSync(join(dir, "stub/base.js"), `export const fn = () => () => null;
export const createStore = (initial = {}) => { let state = initial; return { get: () => state, set: (patch) => { state = { ...state, ...patch }; }, subscribe: () => () => {} }; };
export const html = () => null; export const register = () => {}; export const t = (key) => key;\n`);
  for (const [from, names] of stubNames) {
    writeFileSync(join(dir, stubFile(from)), `import * as base from "./base.js";\n` + [...names].map(x => `export const ${x} = ${["createStore", "html", "register", "t"].includes(x) ? `base.${x}` : "base.fn()"};`).join("\n") + "\n");
  }
  for (const [name, text] of Object.entries(rewritten)) writeFileSync(join(dir, name), text);
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e",
      `import(${JSON.stringify(pathToFileURL(join(dir, entry)).href)}).then(m => console.log(JSON.stringify({ ok: true, exports: Object.keys(m) })), e => console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })));`],
      { encoding: "utf8", timeout: 30_000 });
    const verdict = JSON.parse(out.trim().split("\n").pop()!);
    return { ok: verdict.ok, error: verdict.error ?? "", exports: verdict.exports ?? [] };
  } catch (e) { return { ok: false, error: String(e), exports: [] }; }
}

describe("a page that kept an older module still links (both directions of the mix)", () => {
  it("control: a static named import of the new `VersionLine` fails to link against #3536's host-install.js (the reviewer's reproduction)", () => {
    const probe = `import { VersionLine } from "./host-install.js";\nexport const x = VersionLine;\n`;
    const r = link({ "host-install.js": old("host-install.3536.js"), "probe.js": probe }, "probe.js");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("does not provide an export named 'VersionLine'");
  });
  it("control: #3536's host-install.js really has no VersionLine, and the current one has it", () => {
    expect(old("host-install.3536.js")).not.toMatch(/export (?:function|const) VersionLine/);
    expect(src("host-install.js")).toMatch(/export function VersionLine/);
  });
  it("the current accounts-view.js + #3536's host-install.js (a retained older module) links: no VersionLine, the row simply has no version line", () => {
    const r = link({ "accounts-view.js": src("accounts-view.js"), "host-install.js": old("host-install.3536.js") }, "accounts-view.js");
    expect(r.error).toBe("");
    expect(r.ok).toBe(true);
    expect(r.exports).toEqual(expect.arrayContaining(["AccountsView", "accountsStore", "refreshAccounts"]));
  });
  it("#3536's accounts-view.js + the current host-install.js links (everything the old page imports is still exported)", () => {
    const r = link({ "accounts-view.js": old("accounts-view.3536.js"), "host-install.js": src("host-install.js") }, "accounts-view.js");
    expect(r.error).toBe("");
    expect(r.ok).toBe(true);
    expect(r.exports).toEqual(expect.arrayContaining(["AccountsView"]));
  });
  it("current + current links", () => {
    const r = link({ "accounts-view.js": src("accounts-view.js"), "host-install.js": src("host-install.js") }, "accounts-view.js");
    expect(r.error).toBe("");
    expect(r.ok).toBe(true);
  });
});
