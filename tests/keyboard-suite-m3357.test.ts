/**
 * M-3357: the iPhone keyboard regression suite (scripts/ci/keyboard-suite.mjs; docs/dev/iphone-keyboard-suite.md).
 * On every PR (this file runs in the unit shards): the manifest still matches the tree — each case's test titles are in
 * their files, each smoke exists, each revert's text is in its file exactly once (a fix that moved must have its revert
 * moved with it) — and every past keyboard card is in it. CI: the keyboard-suite job runs the cases, the reverts and the
 * WebKit smokes for a change to the keyboard's code, and build counts its result.
 * The reverts themselves (each fix undone turns its own tests red) run in that job, not here: ~4 min of vitest runs.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { CASES, SMOKES, check, touches } from "../scripts/ci/keyboard-suite.mjs";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("M-3357: the manifest", () => {
  it("matches the tree: every test title, smoke and revert text found (a revert's text exactly once)", () => {
    expect(check()).toEqual([]);
  });
  it("every past iPhone keyboard fix is a case, each with a card or PR, a test and a revert", () => {
    const refs = new Set(CASES.flatMap((c) => c.refs));
    for (const r of ["#2478", "#2517", "M-3111", "#3900", "#4011", "M-3206", "#4026", "M-3244", "#4057", "M-3265", "#4089", "M-3327", "#4171", "M-3356", "#4208"]) expect(refs, r).toContain(r);
    for (const c of CASES) {
      expect(Object.values(c.tests).flat().length, c.id).toBeGreaterThan(0);
      expect(c.revert.from, c.id).not.toBe(c.revert.to);
    }
    // M-3327's three: open, close, a tap on a box that already had the focus.
    expect(CASES.map((c) => c.id)).toEqual(expect.arrayContaining(["open-header-drop", "close-midair", "tap-focused-box", "selection-reads-composing"]));
  });
  it("the human view (docs/dev/iphone-keyboard-suite.md) has a row for every case", () => {
    const doc = readFileSync("docs/dev/iphone-keyboard-suite.md", "utf8");
    for (const c of CASES) expect(doc, c.id).toContain(`| \`${c.id}\` |`);
  });
  it("drift fails closed: a test renamed, or the fix's code moved, is named", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-manifest-")); dirs.push(root);
    const files = new Set([...CASES.flatMap((c) => [...Object.keys(c.tests), c.revert.file]), ...SMOKES.map((s) => `scripts/manual/smoke/${s.file}`)]);
    for (const f of files) { mkdirSync(join(root, dirname(f)), { recursive: true }); cpSync(f, join(root, f)); }
    expect(check(root)).toEqual([]);
    const shell = join(root, "src/ui/shared/app-shell.js");
    writeFileSync(shell, readFileSync(shell, "utf8").replace("const NUDGE_PX = 12;", "const NUDGE_PX = Math.round(12);"));
    const t = join(root, "tests/web-keyboard-fit-3111.test.ts");
    writeFileSync(t, readFileSync(t, "utf8").replace("M-3327: a tap on a box that already had the focus", "a tap"));
    const errors = check(root).join("\n");
    expect(errors).toContain("zhuyin-per-key-nudge: its revert's text is found 0 times in src/ui/shared/app-shell.js");
    expect(errors).toContain("tap-focused-box: no test \"M-3327: a tap on a box that already had the focus");
  });
});

describe("M-3357: which changes run it", () => {
  it("the keyboard's code and the suite itself: yes; elsewhere: no", () => {
    for (const f of ["src/ui/shared/app-shell.js", "src/ui/shared/app.css", "src/ui/shared/chat-composer.js", "src/ui/panel-chat.js", "src/ui/hub-room-composer.js",
      "src/ui/shared/text-undo.js", "src/ui/shared/chat-quote.js", "src/ui/app.html", "scripts/ci/keyboard-suite.mjs", "tests/web-keyboard-fit-3111.test.ts",
      "scripts/manual/smoke/smoke-phone-keyboard-motion-m3327.mts", "scripts/manual/smoke-fixture/index.mts", ".github/workflows/ci.yml"]) expect(touches([f]), f).toBe(true);
    for (const f of ["src/hub/rooms/schema.ts", "src/ui/panel-settings.js", "docs/dev/iphone-keyboard-suite.md", "changes/1-x.md"]) expect(touches([f]), f).toBe(false);
  });
  it("--touches: no diff to judge (a push, a tag, a manual run) runs it", () => {
    const run = (env: Record<string, string>) => execFileSync(process.execPath, ["scripts/ci/keyboard-suite.mjs", "--touches"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } }).trim();
    expect(run({ EVENT_NAME: "push" })).toBe("true");
    expect(run({ EVENT_NAME: "pull_request" })).toBe("true");                       // no SHAs: fail closed
    expect(execFileSync(process.execPath, ["scripts/ci/keyboard-suite.mjs", "--touches", "docs/x.md"], { encoding: "utf8" }).trim()).toBe("false");
  });
});

describe("M-3357: CI", () => {
  type Step = { name?: string; run?: string; if?: string; uses?: string; env?: Record<string, string> };
  const ci = yaml.load(readFileSync(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, { needs?: string[]; steps: Step[] }> };
  it("the keyboard-suite job: judged by the diff, then the cases, the reverts and the WebKit smokes from a digest-pinned image", () => {
    const job = ci.jobs["keyboard-suite"]!;
    expect(job.needs).toContain("detect-changes");
    const runs = job.steps.map((s) => s.run ?? "").join("\n");
    for (const m of ["--touches", "--unit", "--reverts", "--smokes"]) expect(runs).toContain(`keyboard-suite.mjs ${m}`);
    for (const s of job.steps.filter((s) => /--unit|--reverts|--smokes|npm ci/.test(s.run ?? ""))) expect(s.if, s.name).toBe("steps.touches.outputs.run == 'true'");
    const smokes = job.steps.find((s) => /--smokes/.test(s.run ?? ""))!;
    expect(smokes.env?.IMAGE).toMatch(/^mcr\.microsoft\.com\/playwright:v[\d.]+-noble@sha256:[0-9a-f]{64}$/);
    expect(smokes.env?.IMAGE).toContain(`:v${JSON.parse(readFileSync("package.json", "utf8")).devDependencies["playwright-core"]}-`);
    expect(smokes.run).toContain("PW_ENGINE=webkit");
    expect(smokes.run).not.toMatch(/--privileged|--network[ =]host/);
  });
  it("build waits for it and counts its result", () => {
    expect(ci.jobs.build!.needs).toContain("keyboard-suite");
    const gate = ci.jobs.build!.steps.find((s) => s.name === "Check all jobs succeeded")!;
    expect(gate.run).toContain('"keyboard-suite:$KEYBOARD"');
    const env = { PATH: process.env.PATH ?? "", CHANGELOG: "success", ACTIONS_PINNED: "success", SETUP: "success", SHARD: "success", INTEGRATION: "success", PWSH: "success",
      HUB_DIRECTORY: "success", DOCS_TESTS: "success", UI_GATE: "success", SMOKE: "success", ROLLBACK: "success", PROFILE_PRIVACY: "skipped", PROFILE_PRIVACY_REQUIRED: "false" };
    const aggregate = (k: string) => execFileSync("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", gate.run!], { encoding: "utf8", stdio: "pipe", env: { ...env, KEYBOARD: k } });
    expect(aggregate("success")).toContain("All jobs succeeded");
    for (const k of ["failure", "cancelled", "skipped", ""]) expect(() => aggregate(k), k).toThrow();
  });
});
