/**
 * AGEND-144 (Prism on #3537, P2-2): the registry / install-module mix. Settings → Runtime's `runtime-cli-install.js` reads the registry's generated `cli-caps.js` (which CLIs a Runtime
 * can install, and their names). A tab or cache may hold the release tip's copy of either beside this PR's copy of the other: they must still LINK (ES modules fail the whole page with
 * "does not provide an export named …" when a static named import has no export), and the page must still say something true.
 *
 * A language-level LINK check in plain Node (the browser matrix is the PR's evidence): the real sources, their other imports replaced by inert stubs, imported by a child `node` so Node's
 * own linker answers. The older copies are the release tip's own files (tests/fixtures/ui-skew-144). Both directions of the mix, current/current, and the facts the mix turns on.
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


const names = (text: string) => [...text.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(m => m[1]!);
describe("the registry (cli-caps.js) and the install module (runtime-cli-install.js) from different releases still link", () => {
  it("control: the probe fails when a named import has no export", () => {
    const r = link({ "cli-caps.js": src("cli-caps.js"), "probe.js": `import { NO_SUCH_EXPORT } from "./cli-caps.js";\nexport const x = NO_SUCH_EXPORT;\n` }, "probe.js");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("does not provide an export named 'NO_SUCH_EXPORT'");
  });
  it("this PR's runtime-cli-install.js + the release tip's cli-caps.js (an older registry) links", () => {
    const r = link({ "runtime-cli-install.js": src("runtime-cli-install.js"), "cli-caps.js": old("cli-caps.release.js") }, "runtime-cli-install.js");
    expect(r.error).toBe("");
    expect(r.ok).toBe(true);
    expect(r.exports).toEqual(expect.arrayContaining(["CliInstall", "INSTALL_CLIS", "OFFICIAL_COMMANDS"]));
  });
  it("the release tip's runtime-cli-install.js + this PR's cli-caps.js (an older install module) links", () => {
    const r = link({ "runtime-cli-install.js": old("runtime-cli-install.release.js"), "cli-caps.js": src("cli-caps.js") }, "runtime-cli-install.js");
    expect(r.error).toBe("");
    expect(r.ok).toBe(true);
    expect(r.exports).toEqual(expect.arrayContaining(["CliInstall", "INSTALL_CLIS", "OFFICIAL_COMMANDS"]));
  });
  it("current + current links", () => {
    const r = link({ "runtime-cli-install.js": src("runtime-cli-install.js"), "cli-caps.js": src("cli-caps.js") }, "runtime-cli-install.js");
    expect(r.error).toBe("");
    expect(r.ok).toBe(true);
  });
  it("every export the release tip's runtime-cli-install.js had is still exported (a neighbour holding the old module imports nothing that vanished)", () => {
    const now = names(src("runtime-cli-install.js"));
    for (const x of names(old("runtime-cli-install.release.js"))) expect(now, x).toContain(x);
    const caps = names(src("cli-caps.js"));
    for (const x of names(old("cli-caps.release.js"))) expect(caps, x).toContain(x);
  });
  it("what the mix turns on: the registry says which CLIs a Runtime installs, the install module lists the rest with their reasons — so an older registry shows no OpenCode row, and an older install module lists no Muse", () => {
    expect(old("cli-caps.release.js")).toMatch(/"opencode": Object\.freeze\(\{[^}]*runtimeInstall: false/);
    expect(src("cli-caps.js")).toMatch(/"opencode": Object\.freeze\(\{[^}]*runtimeInstall: true/);
    expect(old("runtime-cli-install.release.js")).not.toContain('id: "muse"');
    expect(src("runtime-cli-install.js")).toContain('id: "muse"');
  });
});
