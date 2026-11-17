/**
 * M-3287: the UI gate finds its smokes on its own — a `// ui-gate: {"name", "hp"}` line in the smoke's own file
 * (scripts/ci/ui-gate-smokes.mjs), one "UI gate smokes" step in ci.yml — so adding a smoke never touches the workflow.
 * - Every smoke the gate ran as a hand-added step before is found, on the same port.
 * - ci.yml: one step runs them (after the fonts, even when a gate before it failed, before the cache save); no step
 *   also runs a found smoke by hand; no step's own port is one a found smoke uses.
 * - Fails closed: a bad marker, an unknown key, a missing name or port, a port used twice, no smoke at all.
 * - The runner: each in turn with HP set, every one even after a failure; the run fails if any did; a summary.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { discover } from "../scripts/ci/ui-gate-smokes.mjs";

const RUNNER = resolve("scripts/ci/ui-gate-smokes.mjs");
// The 21 smokes ci.yml listed step by step before M-3287, each on the port its step gave it.
const BEFORE: Record<string, number> = {
  "smoke-phone-kb-steady.mts": 19661, "smoke-phone-drawer-avatars-m3209.mts": 19662, "smoke-phone-drawer-telegram-m3211.mts": 19663,
  "smoke-lightbox-swipe-m3210.mts": 19664, "smoke-phone-drawer-width-m3212.mts": 19665, "smoke-hub-member-drawer-m3217.mts": 19666,
  "smoke-phone-composer-drawer-m3222.mts": 19667, "smoke-hub-switch-names-m3235.mts": 19668, "smoke-connect-dialogs-m3238.mts": 19669,
  "smoke-usage-group-modes-m3241.mts": 19670, "smoke-phone-ime-keyboard-m3244.mts": 19671, "smoke-phone-nav-icons-m3245.mts": 19672,
  "smoke-usage-no-agents-m3248.mts": 19673, "smoke-signin-phone-help-m3251.mts": 19674, "smoke-density-split-m3252.mts": 19675,
  "smoke-compact-name-m3269.mts": 19676, "smoke-guest-sidebar-m3280.mts": 19677, "smoke-phone-typing-steady-m3265.mts": 19681,
  "smoke-chat-pins-m3271.mts": 19691, "smoke-m3286-office-stay-in-area.mts": 19693, "smoke-chat-scrollback-m3272.mts": 19701,
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
/** A scratch checkout with these smoke files (name → content). */
function root(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "ui-gate-3287-")); dirs.push(d);
  mkdirSync(join(d, "scripts/manual/smoke"), { recursive: true });
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, "scripts/manual/smoke", n), c);
  return d;
}
const mark = (m: unknown) => `// a smoke\n// ui-gate: ${typeof m === "string" ? m : JSON.stringify(m)}\nconsole.log("ran");\n`;

describe("the repo's smokes", () => {
  const found = discover();
  it("every smoke that was a hand-added step is found, on the same port", () => {
    const byFile = Object.fromEntries(found.map((s: any) => [s.file.split("/").pop(), s.hp]));
    for (const [f, hp] of Object.entries(BEFORE)) expect(byFile[f], f).toBe(hp);
    expect(found.length).toBeGreaterThanOrEqual(Object.keys(BEFORE).length);
    expect(new Set(found.map((s: any) => s.hp)).size).toBe(found.length);
  });
  const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const steps: any[] = ci.jobs["ui-gate"].steps;
  it("ci.yml: one step runs them — after the fonts, even after a failed gate, before the cache is saved", () => {
    const i = steps.findIndex((s) => s.name === "UI gate smokes"), step = steps[i];
    expect(step.run).toBe('PW_DIR="$GITHUB_WORKSPACE" REPO="$GITHUB_WORKSPACE" node scripts/ci/ui-gate-smokes.mjs');
    expect(step.if).toBe("(success() || failure()) && needs.detect-changes.outputs.text-only != 'true'");
    expect(step.env).toEqual({ OUT: "${{ runner.temp }}/ui-gate", FONTCONFIG_FILE: "${{ steps.cjk-fonts.outputs.fontconfig }}" });
    expect(i).toBeGreaterThan(steps.findIndex((s) => s.id === "cjk-fonts"));
    expect(i).toBeLessThan(steps.findIndex((s) => String(s.uses).startsWith("actions/cache/save")));
    expect(ci.jobs["ui-gate"]["timeout-minutes"]).toBe(15);
  });
  it("ci.yml: no step also runs a found smoke by hand, and no step's own port is a found smoke's", () => {
    const names = found.map((s: any) => s.file.split("/").pop());
    for (const s of steps) for (const n of names) expect(String(s.run ?? ""), `${s.name} runs ${n}`).not.toContain(n);
    const ports = new Set(found.map((s: any) => String(s.hp)));
    for (const s of steps) for (const k of ["HP", "PORT", "GATE_PORT"]) if (s.env?.[k]) expect(ports.has(String(s.env[k])), `${s.name} ${k}`).toBe(false);
  });
});

describe("fails closed", () => {
  const bad = (files: Record<string, string>) => { try { discover(root(files)); return null; } catch (e: any) { return String(e.message); } };
  it.each([
    ["not JSON", { "a.mts": mark("{name: 1}") }, 'a.mts: the "// ui-gate:" line is not JSON'],
    ["not an object", { "a.mts": mark("[1]") }, "not an object"],
    ["an unknown key", { "a.mts": mark({ name: "A", hp: 20001, port: 1 }) }, "unknown key(s) port"],
    ["no name", { "a.mts": mark({ hp: 20001 }) }, '"name" must be 1–100 characters'],
    ["a port out of range", { "a.mts": mark({ name: "A", hp: 80 }) }, '"hp" must be a whole port number'],
    ["a port used twice", { "a.mts": mark({ name: "A", hp: 20001 }), "b.mts": mark({ name: "B", hp: 20001 }) }, "both use hp 20001"],
    ["two marker lines", { "a.mts": mark({ name: "A", hp: 20001 }) + `// ui-gate: {"name":"A2","hp":20003}\n` }, 'more than one "// ui-gate:" line'],
    ["no smoke at all", { "a.mts": "// no marker\n" }, "no smoke under scripts/manual/smoke"],
  ])("%s", (_w, files, msg) => { expect(bad(files)).toContain(msg); });
  it("neighbouring ports are fine (they run one after another), and found smokes come by port", () => {
    const d = root({ "z.mts": mark({ name: "Z", hp: 20001 }), "a.mts": mark({ name: "A", hp: 20002 }), "plain.mts": "// not in the gate\n" });
    expect(discover(d).map((s: any) => [s.name, s.hp])).toEqual([["Z", 20001], ["A", 20002]]);
  });
});

describe("the runner", () => {
  const run = (d: string, args: string[] = [], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [RUNNER, ...args], { cwd: d, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "", PW_DIR: "", REPO: "", ...env } });
  const smoke = (name: string, hp: number, code: number) => mark({ name, hp }).replace('console.log("ran");', `console.log("ran ${name} HP=" + process.env.HP + " REPO=" + (process.env.REPO === process.cwd()));\nprocess.exit(${code});`);
  it("each in turn, HP set; one failing fails the run, and the ones after it still run; a summary", () => {
    const d = root({ "smoke-b.mts": smoke("Second", 20003, 0), "smoke-a.mts": smoke("First fails", 20001, 3), "smoke-c.ts": smoke("Third", 20005, 0) });
    const sum = join(d, "summary.md");
    const r = run(d, [], { GITHUB_STEP_SUMMARY: sum });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ran First fails HP=20001 REPO=true[\s\S]*ran Second HP=20003[\s\S]*ran Third HP=20005/);
    expect(r.stdout).toContain("::group::First fails (smoke-a.mts, HP 20001)");
    expect(r.stdout).toContain("::error title=UI gate: First fails::scripts/manual/smoke/smoke-a.mts exited 3");
    expect(r.stdout).toContain("ui-gate smokes: 2/3 passed — failed: First fails");
    const s = readFileSync(sum, "utf8");
    expect(s).toContain("### UI gate smokes: 2/3 passed");
    expect(s).toMatch(/\| ❌ \| First fails \| `smoke-a.mts` \| 20001 \|/);
    expect(s).toMatch(/\| ✅ \| Second \| `smoke-b.mts` \| 20003 \|/);
  });
  it("all pass: exit 0; --list runs nothing; --only picks by file name and refuses an unknown one", () => {
    const d = root({ "smoke-a.mts": smoke("A", 20001, 0), "smoke-b.mts": smoke("B", 20003, 0) });
    expect(run(d).status).toBe(0);
    const l = run(d, ["--list"]);
    expect([l.status, l.stdout.includes("ran ")]).toEqual([0, false]);
    expect(l.stdout).toMatch(/20001\s+A\s+\(scripts\/manual\/smoke\/smoke-a\.mts\)/);
    const o = run(d, ["--only", "smoke-b.mts"]);
    expect([o.status, o.stdout.includes("ran A"), o.stdout.includes("ran B")]).toEqual([0, false, true]);
    expect(run(d, ["--only", "smoke-x.mts"]).status).toBe(2);
    expect(run(d, ["--bogus"]).status).toBe(2);
  });
  it("a bad marker: exit 2 before anything runs, with an annotation", () => {
    const d = root({ "smoke-a.mts": smoke("A", 20001, 0), "smoke-b.mts": mark({ name: "B" }) });
    const r = run(d);
    expect(r.status).toBe(2);
    expect(r.stdout.includes("ran ")).toBe(false);
    expect(r.stderr).toContain("::error title=UI gate smokes::");
  });
});
