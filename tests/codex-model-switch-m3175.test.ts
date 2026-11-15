/**
 * M-3175: codex's in-session `/model [NAME] --reasoning=LEVEL` instead of a restart, for a running codex 0.164.0 or later.
 * Real captures: tests/fixtures/codex-0169-model-switch (rig.sh + model-switch.mts on codex 0.169.0 and 0.163.0, a local mock API,
 * no account). The real Daemon and CodexBackend run against a stub pane; the fleet side against a stub IPC client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  CODEX_INLINE_MODEL_MIN, codexAppliedFromRollout, codexModelCommand, codexRunningVersion, codexSupportsInlineModel, codexSwitchAnswerCount, codexSwitchFromPane,
} from "../src/backend/codex-model-switch.js";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";

const fixture = (name: string) => readFileSync(join(process.cwd(), "tests", "fixtures", "codex-0169-model-switch", name), "utf8");
const PANE_169 = fixture("0.169.0-pane-after-switches.txt");
const PANE_163 = fixture("0.163.0-pane-line-sent-as-prompt.txt");
const ROLLOUT = fixture("0.169.0-rollout-switch-lines.jsonl");
/** The 0.169 pane cut just after its newest success line (the newest entry is then that success, not the refusal under it). */
const PANE_ON_SUCCESS = (() => {
  const rows = PANE_169.split("\n"), last = rows.map((r, i) => [r, i] as const).filter(([r]) => r.startsWith("• Model changed to")).at(-1)![1];
  const composer = rows.length - 1 - [...rows].reverse().findIndex(r => /^\s*›/.test(r));
  return [...rows.slice(0, last + 1), "", ...rows.slice(composer)].join("\n");
})();

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-3175-")); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); setLocale("en"); });

describe("M-3175: the codex switch, read and written as codex 0.164+ takes it", () => {
  it("is for a running codex 0.164.0 or later only (0.163.0 sends the line to the model: the rig's 0.163 pane)", () => {
    expect(CODEX_INLINE_MODEL_MIN).toBe("0.164.0");
    for (const v of ["0.164.0", "codex-cli 0.169.0", "0.170.2"]) expect(codexSupportsInlineModel(v), v).toBe(true);
    for (const v of ["0.163.0", "codex-cli 0.163.0", "0.99.9", null, undefined, "", "who knows"]) expect(codexSupportsInlineModel(v), String(v)).toBe(false);
    expect(PANE_163).toMatch(/^› \/model gpt-6\.1-sol --reasoning=high$/m);   // typed as a prompt …
    expect(PANE_163).toMatch(/^• ok$/m);                                       // … and answered by the (mock) model
    expect(codexSwitchAnswerCount(PANE_163)).toBe(0);
  });
  it("one line, every part one token: model and effort, the effort alone, the model alone; nothing a shell or the TUI would split", () => {
    expect(codexModelCommand("gpt-6.1-sol", "high")).toBe("/model gpt-6.1-sol --reasoning=high");
    expect(codexModelCommand(null, "low")).toBe("/model --reasoning=low");
    expect(codexModelCommand("gpt-6-astra", null)).toBe("/model gpt-6-astra");
    for (const [m, e] of [[null, null], ["gpt 6", "high"], ["gpt;rm", "high"], ["gpt\n6", "high"], ["-x", "high"], ["gpt-6", "bogus"], ["gpt-6", "high extra"]] as const) {
      expect(codexModelCommand(m, e), `${m}/${e}`).toBeNull();
    }
  });
  it("codex's answer on the pane: the newest entry above the composer, a success or a refusal; counted, so an older one is not ours", () => {
    expect(codexSwitchFromPane(PANE_169)).toEqual({ kind: "refused", text: "Model 'nosuch-model' is unavailable. Use /model to see available models." });
    expect(codexSwitchFromPane(PANE_ON_SUCCESS)).toEqual({ kind: "switched", model: "gpt-6.1-sol", effort: "xhigh" });
    expect(codexSwitchAnswerCount(PANE_169)).toBe(10);
    // A fast tier after the effort is still the same answer.
    expect(codexSwitchFromPane(PANE_ON_SUCCESS.replace("gpt-6.1-sol xhigh for", "gpt-6.1-sol xhigh fast for"))).toEqual({ kind: "switched", model: "gpt-6.1-sol", effort: "xhigh" });
    // Codex working (no composer entry above the answer) or another entry last: not an answer.
    expect(codexSwitchFromPane(PANE_ON_SUCCESS.replace(/^(• Model changed to gpt-6\.1-sol xhigh for this session only)$/m, "$1\n• ok"))).toBeNull();
    expect(codexSwitchFromPane("")).toBeNull();
  });
  it("the rollout's own record: the last thread_settings_applied, its model and effort; a torn last line is skipped", () => {
    expect(codexAppliedFromRollout(ROLLOUT)).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
    expect(codexAppliedFromRollout(`${ROLLOUT}{"type":"event_msg","payload":{"type":"thread_settings_appl`)).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
    expect(codexAppliedFromRollout(ROLLOUT.split("\n").filter(l => !l.includes("thread_settings_applied")).join("\n"))).toBeNull();
    expect(JSON.parse(ROLLOUT.split("\n")[0]!).payload.cli_version).toBe("0.169.0");
  });
});

describe("M-3175: the RUNNING codex's version, from the pane's processes", () => {
  /** A fake /proc: pane shell 100 → children; each child's exe a symlink (" (deleted)" kept in its text). */
  function proc(children: Array<{ pid: number; ppid: number; exe: string | null }>) {
    const root = mkdtempSync(join(dir, "proc-"));
    mkdirSync(join(root, "100"), { recursive: true });
    writeFileSync(join(root, "100", "status"), "Name:\tbash\nPPid:\t1\n");
    for (const c of children) {
      mkdirSync(join(root, String(c.pid)), { recursive: true });
      writeFileSync(join(root, String(c.pid), "status"), `Name:\tx\nPPid:\t${c.ppid}\n`);
      if (c.exe) symlinkSync(c.exe, join(root, String(c.pid), "exe"));
    }
    return root;
  }
  const binary = (name: string) => { const p = join(dir, name); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "#!/bin/true\n"); return p; };
  it("the codex under the pane, asked for its --version", async () => {
    const codex = binary("a/bin/codex");
    const printVersion = vi.fn(async () => "codex-cli 0.169.0\n");
    expect(await codexRunningVersion(100, { procRoot: proc([{ pid: 101, ppid: 100, exe: codex }, { pid: 102, ppid: 101, exe: codex }]), printVersion })).toBe("0.169.0");
    expect(printVersion).toHaveBeenCalledWith(codex);
  });
  it("unknown (null) when it cannot be proven: no codex, a replaced binary, two different binaries, no version", async () => {
    const a = binary("a/bin/codex"), b = binary("b/bin/codex"), node = binary("n/bin/node");
    const v = async () => "codex-cli 0.169.0";
    expect(await codexRunningVersion(100, { procRoot: proc([{ pid: 101, ppid: 100, exe: node }]), printVersion: v })).toBeNull();
    expect(await codexRunningVersion(100, { procRoot: proc([{ pid: 101, ppid: 100, exe: `${a} (deleted)` }]), printVersion: v })).toBeNull();
    expect(await codexRunningVersion(100, { procRoot: proc([{ pid: 101, ppid: 100, exe: a }, { pid: 102, ppid: 100, exe: b }]), printVersion: v })).toBeNull();
    expect(await codexRunningVersion(100, { procRoot: proc([{ pid: 101, ppid: 100, exe: a }]), printVersion: async () => "codex-cli" })).toBeNull();
    expect(await codexRunningVersion(100, { procRoot: proc([]), printVersion: v })).toBeNull();
  });
});

/** A Daemon running CodexBackend on a stub pane (served text; pasted text recorded). */
function codexDaemon(screen: { text: string }) {
  mkdirSync(join(dir, "inst"), { recursive: true });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
  const d: any = new Daemon("c", {
    working_directory: dir, backend: "codex", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, join(dir, "inst"), false, new CodexBackend(join(dir, "inst")), undefined, logger);
  d.tmux = {
    isWindowAlive: async () => true, capturePane: async () => screen.text, capturePaneWithHistory: async () => screen.text,
    getWindowId: () => "@1", getPanePid: async () => 4242, sendSpecialKey: async () => true, sendKeys: async () => true, pasteText: async () => true,
  };
  return d;
}

describe("M-3175: the daemon types it only past its gate, and reports what codex recorded", () => {
  it("verdict from the rollout written after our checkpoint: what was asked → switched; another model or effort → mismatch", async () => {
    const d = codexDaemon({ text: PANE_169 });
    const path = join(dir, "rollout.jsonl"); writeFileSync(path, ROLLOUT);
    const before = { rollout: { path, offset: ROLLOUT.length }, answers: codexSwitchAnswerCount(PANE_169), version: "0.169.0" };
    const applied = (model: string, effort: string) => JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model, reasoning_effort: effort } } }) + "\n";
    setTimeout(() => appendFileSync(path, applied("gpt-6-astra", "high")), 300);
    expect(await d.verifyCodexSwitch({ model: "gpt-6-astra", effort: "high" }, before)).toEqual({ outcome: "switched", confirmed: true, shown: "gpt-6-astra high" });
    const later = { ...before, rollout: { path, offset: readFileSync(path, "utf8").length } };
    setTimeout(() => appendFileSync(path, applied("gpt-6-astra", "medium")), 300);
    expect(await d.verifyCodexSwitch({ model: null, effort: "low" }, later)).toEqual({ outcome: "mismatch", shown: "gpt-6-astra medium", answered: true });
  });
  it("no rollout yet: codex's NEW answer on the pane; an older answer already counted is not ours; a refusal is a mismatch", async () => {
    const screen = { text: PANE_ON_SUCCESS };
    const d = codexDaemon(screen);
    const before = { rollout: null, answers: codexSwitchAnswerCount(PANE_ON_SUCCESS), version: "0.169.0" };
    setTimeout(() => { screen.text = PANE_ON_SUCCESS.replace(/^(• Model changed to gpt-6\.1-sol xhigh for this session only)$/m, "$1\n\n• Model changed to gpt-6-astra low for this session only"); }, 300);
    expect(await d.verifyCodexSwitch({ model: "gpt-6-astra", effort: "low" }, before)).toEqual({ outcome: "switched", confirmed: true, shown: "gpt-6-astra low" });
    screen.text = PANE_ON_SUCCESS;
    setTimeout(() => { screen.text = PANE_169; }, 300);   // codex's answer: ■ Model 'nosuch-model' is unavailable…
    expect(await d.verifyCodexSwitch({ model: "nosuch-model", effort: "high" }, before)).toMatchObject({ outcome: "mismatch", shown: expect.stringContaining("nosuch-model") });
  });
  it("nothing new in time: not confirmed (the success already on screen is an older one)", async () => {
    vi.useFakeTimers();
    const d = codexDaemon({ text: PANE_ON_SUCCESS });
    const pending = d.verifyCodexSwitch({ model: "gpt-6.1-sol", effort: "xhigh" }, { rollout: null, answers: codexSwitchAnswerCount(PANE_ON_SUCCESS), version: "0.169.0" });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await pending).toEqual({ outcome: "not_confirmed" });
  });
  it("the gate: busy (never idle in time) and an unknown or older running codex are not typed", async () => {
    const d = codexDaemon({ text: PANE_169 });
    d.waitForAuthoritativePaneIdle = async () => false;
    expect(await d.codexSwitchGate()).toEqual({ blocked: "busy" });
    d.waitForAuthoritativePaneIdle = async () => true;
    d.tmux.getPanePid = async () => null;
    expect(await d.codexSwitchGate()).toEqual({ blocked: "version", version: null });
  });
  function routed(gate: unknown) {
    const d = codexDaemon({ text: PANE_169 });
    const broadcast: any[] = [], typed: string[] = [];
    d.ipcServer = { broadcast: (m: unknown) => broadcast.push(m), send: () => {} };
    d.wake = async () => {};
    d.codexSwitchGate = async () => gate;
    d.deliverMessage = async (text: string, _x: unknown, opts: any) => { typed.push(text); opts.verdict.reached = true; opts.verdict.paneWriteStarted = true; opts.onPaneWritten?.(); return true; };
    d.verifyCodexSwitch = vi.fn(async () => ({ outcome: "switched", confirmed: true, shown: "gpt-6-astra high" }));
    return { d, broadcast, typed };
  }
  it("a blocked gate: nothing typed, `not_sent` with why; a passed one: the line typed, then codex's verdict with its id", async () => {
    const msg = { type: "raw_paste", content: "/model gpt-6-astra --reasoning=high", runtime_switch: { id: "sw-c1", kind: "model", requested: "gpt-6-astra", codex: { model: "gpt-6-astra", effort: "high" } } };
    const old = routed({ blocked: "version", version: "0.163.0" });
    old.d.handleRawPasteIpcMessage(msg); await old.d.pasteLock;
    expect([old.typed, old.broadcast]).toEqual([[], [{ type: "runtime_switch_result", id: "sw-c1", outcome: "not_sent", reason: "version", version: "0.163.0" }]]);
    const ok = routed({ rollout: null, answers: 10, version: "0.169.0" });
    ok.d.handleRawPasteIpcMessage(msg); await ok.d.pasteLock;
    expect(ok.typed).toEqual(["/model gpt-6-astra --reasoning=high"]);
    expect(ok.d.verifyCodexSwitch).toHaveBeenCalledWith({ model: "gpt-6-astra", effort: "high" }, { rollout: null, answers: 10, version: "0.169.0" });
    expect(ok.broadcast).toEqual([{ type: "runtime_switch_result", id: "sw-c1", outcome: "switched", confirmed: true, shown: "gpt-6-astra high" }]);
  });
  it("a malformed codex spec (both parts left alone, or a part of the wrong type) is no switch at all", async () => {
    for (const codex of [{ model: null, effort: null }, { model: 5, effort: "high" }, { model: "m" }]) {
      const r = routed({ rollout: null, answers: 0, version: "0.169.0" });
      r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/model m", runtime_switch: { id: "sw-x", kind: "model", requested: "m", codex } });
      await r.d.pasteLock;
      expect(r.broadcast, JSON.stringify(codex)).toEqual([]);
    }
  });
});

describe("M-3175: /model and /effort on a codex instance — in place when codex takes it, else today's restart; saved either way", () => {
  function fleet(answer: unknown, opts: { effort?: string; levels?: string[] } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-3175-fm-"));
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, yaml.dump({ defaults: {}, instances: { cx: { backend: "codex", working_directory: dataDir, model: "gpt-6.1-sol", ...(opts.effort ? { effort: opts.effort } : {}) } } }));
    const fm: any = new FleetManager(dataDir);
    fm.loadConfig(configPath);
    fm.instanceEffortMetadata = () => ({ strategy: "restart", levels: opts.levels ?? ["low", "medium", "high", "xhigh", "max"] });
    const send = vi.fn((msg: any) => { if (msg.runtime_switch) queueMicrotask(() => fm.runtimeSwitchWaiters.get(msg.runtime_switch.id)?.(answer)); return true; });
    fm.instanceIpcClients.set("cx", { connected: true, send } as never);
    const restart = vi.fn(async () => {});
    fm.restartSingleInstance = restart;
    const saved = () => (yaml.load(readFileSync(configPath, "utf-8")) as any).instances.cx;
    return { fm, send, restart, saved, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
  }
  it("a model, confirmed by codex: no restart; typed with the effort a restart would launch with; saved", async () => {
    const f = fleet({ outcome: "switched", confirmed: true, shown: "gpt-6-astra high" }, { effort: "high" });
    try {
      expect(await f.fm.applyModel("cx", "gpt-6-astra")).toMatch(/Switched cx to `gpt-6-astra` in its running session \(no restart\)/);
      expect(f.send.mock.calls[0]![0]).toMatchObject({ content: "/model gpt-6-astra --reasoning=high", runtime_switch: { codex: { model: "gpt-6-astra", effort: "high" } } });
      expect(f.restart).not.toHaveBeenCalled();
      expect(f.saved().model).toBe("gpt-6-astra");
    } finally { f.cleanup(); }
  });
  it("no configured effort, or one that model does not list: the model alone (codex: its default, as a launch without one)", async () => {
    for (const opts of [{}, { effort: "max", levels: ["low", "medium", "high"] }]) {
      const f = fleet({ outcome: "switched", confirmed: true, shown: "gpt-6-astra medium" }, opts);
      try {
        await f.fm.applyModel("cx", "gpt-6-astra");
        expect(f.send.mock.calls[0]![0].content, JSON.stringify(opts)).toBe("/model gpt-6-astra");
      } finally { f.cleanup(); }
    }
  });
  it.each([
    [{ outcome: "not_sent", reason: "version", version: "0.163.0" }, /can.t switch in place|cannot switch in place \(needs 0\.164\.0 or later\)/],
    [{ outcome: "not_sent", reason: "busy" }, /stayed busy/],
    [{ outcome: "mismatch", shown: "Model 'x' is unavailable.", answered: true }, /did not take it in place \(Model 'x' is unavailable\.\)/],
    [{ outcome: "not_confirmed" }, /did not confirm/],
  ] as const)("%j → today's restart, saved first, and said why", async (answer, why) => {
    const f = fleet(answer, { effort: "high" });
    try {
      const reply = await f.fm.applyModel("cx", "gpt-6-astra");
      expect(reply).toMatch(/Set cx to `gpt-6-astra` and restarted: /);
      expect(reply).toMatch(why);
      expect(f.restart).toHaveBeenCalledTimes(1);
      expect(f.saved().model).toBe("gpt-6-astra");
    } finally { f.cleanup(); }
  });
  it("/effort: the configured model named, the level typed; confirmed → no restart; not → restart; saved either way", async () => {
    const ok = fleet({ outcome: "switched", confirmed: true, shown: "gpt-6.1-sol low" }, { effort: "high" });
    try {
      expect(await ok.fm.applyEffort("cx", "low")).toMatch(/Set cx effort to `low` in its running session \(no restart\)/);
      expect(ok.send.mock.calls[0]![0]).toMatchObject({ content: "/model gpt-6.1-sol --reasoning=low", runtime_switch: { codex: { model: "gpt-6.1-sol", effort: "low" } } });
      expect([ok.restart.mock.calls.length, ok.saved().effort]).toEqual([0, "low"]);
    } finally { ok.cleanup(); }
    const old = fleet({ outcome: "not_sent", reason: "version", version: "0.163.0" }, { effort: "high" });
    try {
      expect(await old.fm.applyEffort("cx", "medium")).toMatch(/Set cx effort to `medium` and restarted: .*0\.164\.0/);
      expect([old.restart.mock.calls.length, old.saved().effort]).toEqual([1, "medium"]);
    } finally { old.cleanup(); }
  });
  it("a codex instance that is not running is saved and restarted as before (nothing typed)", async () => {
    const f = fleet({ outcome: "switched", confirmed: true });
    f.fm.instanceIpcClients.delete("cx");
    try {
      await f.fm.applyModel("cx", "gpt-6-astra");
      expect([f.send.mock.calls.length, f.restart.mock.calls.length, f.saved().model]).toEqual([0, 1, "gpt-6-astra"]);
    } finally { f.cleanup(); }
  });
});
