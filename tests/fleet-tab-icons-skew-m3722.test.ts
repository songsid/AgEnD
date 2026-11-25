/**
 * #4453 review (Prism, P2): module skew. A browser tab can still hold the PREVIOUS ui-icons.js (cached by URL) when Fleet's
 * new phone header arrives; its Icon draws nothing for a name it does not know, and a phone's tab — its name hidden — would be
 * blank. So the three new tab icons (Cache → database, Usage → gauge, Host health → pulse) are drawn by fleet-tab-icons.js
 * itself, whichever ui-icons.js the tab holds.
 * Node's real ESM linker, in a child process, on the product's own bytes: fleet-tab-icons.js and the RETAINED base
 * ui-icons.js (tests/fixtures/skew/ui-icons.base-34caa085a.js: the file at release 34caa085a, which has no such icons),
 * with app-html.js a tiny tagged template that returns the markup as a string.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const UI = join(__dirname, "..", "src", "ui");
const BASE_ICONS = join(__dirname, "fixtures", "skew", "ui-icons.base-34caa085a.js");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// The markup as a string (components are not called: TabIcon only calls Icon for the other tabs).
const HTML = `export const html = (s, ...v) => s.reduce((a, x, i) => a + x + (i < v.length ? (Array.isArray(v[i]) ? v[i].join("") : typeof v[i] === "function" ? "" : String(v[i] ?? "")) : ""), "");`;
function run(probe: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), "agend-skew-3722-")); dirs.push(dir);
  writeFileSync(join(dir, "app-html.js"), HTML);
  writeFileSync(join(dir, "ui-icons.js"), readFileSync(BASE_ICONS, "utf8").replace(/(["'])\/assets\//g, "$1./"));
  writeFileSync(join(dir, "fleet-tab-icons.js"), readFileSync(join(UI, "fleet-tab-icons.js"), "utf8").replace(/(["'])\/assets\//g, "$1./"));
  const script = `const t = await import(${JSON.stringify(pathToFileURL(join(dir, "fleet-tab-icons.js")).href)}); const i = await import(${JSON.stringify(pathToFileURL(join(dir, "ui-icons.js")).href)}); ${probe}`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", cwd: dir }));
}
const drawn = (svg: string) => /<(path|ellipse|circle|rect|line|polyline)\b/.test(svg);

describe("#4453 review: Fleet's new tab icons draw whichever ui-icons.js the tab holds", () => {
  it("with the RETAINED base ui-icons.js, Cache, Usage and Host health each draw their own icon", () => {
    const out = run(`console.log(JSON.stringify(["database", "gauge", "pulse"].map((name) => t.TabIcon({ name, size: 16 }))));`) as string[];
    expect(out.map(drawn)).toEqual([true, true, true]);
    expect(new Set(out).size).toBe(3);
  });
  it("the control: the retained Icon itself draws nothing for those names (what a phone's tab would have shown), and draws a name it knows", () => {
    const out = run(`console.log(JSON.stringify([...["database", "gauge", "pulse"].map((name) => i.Icon({ name })), i.Icon({ name: "chart" })]));`) as string[];
    expect(out.map(drawn)).toEqual([false, false, false, true]);
  });
  it("the shared ui-icons.js is unchanged: the three are not added there (one place draws them)", () => {
    const shared = readFileSync(join(UI, "shared", "ui-icons.js"), "utf8");
    expect(shared).not.toMatch(/\b(database|gauge|pulse):/);
    expect(readFileSync(join(UI, "panel-fleet.js"), "utf8")).toMatch(/<\$\{TabIcon\} name=\$\{ICONS\[k\]\}/);
  });
});
