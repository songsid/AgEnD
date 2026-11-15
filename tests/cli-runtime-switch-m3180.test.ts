/**
 * M-3180 (S-156): muse's in-session `/model ID` and `/effort LEVEL`, through the shared CLI_RUNTIME_SWITCH table. Pane fixtures are
 * the offline rig's (scripts/manual/muse-version-audit/switch.sh; muse 1.4.20 and 1.4.4 on a mock provider, no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { CLI_RUNTIME_SWITCH, MUSE_RUNTIME_SWITCH, cliRunningVersion, cliSwitchAllowed, museFooter } from "../src/backend/cli-runtime-switch.js";
import { MuseBackend } from "../src/backend/muse.js";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";

const fixture = (name: string) => readFileSync(join(process.cwd(), "tests", "fixtures", "muse-1420-model-switch", name), "utf8");
const IDLE = fixture("1.4.20-switch-0-idle.pane.txt");            // mock-model · high
const MODEL = fixture("1.4.20-switch-1-model.pane.txt");          // /model mock-alt → Model set to mock-alt …, footer mock-alt · high
const BOGUS = fixture("1.4.20-switch-3-effort-bogus.pane.txt");   // /effort bogus → ◆ unsupported reasoning effort …
const UNKNOWN = fixture("1.4.20-switch-4-model-unknown.pane.txt"); // /model nosuch-model is taken (muse takes any id)
const BACK = fixture("1.4.20-switch-6-back.pane.txt");            // /model mock-model, /effort low → footer mock-model · low
const OLD = fixture("1.4.4-switch-1-model.pane.txt");             // 1.4.4: /model mock-alt → ◆ model catalog has no visible models
const REQUESTS = fixture("1.4.20-mock-requests.log");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-3180-")); setLocale("en"); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe("M-3180: muse's switch, read and written as the rig's muse takes it", () => {
  it("the rig's evidence: the switched model and effort are what the next turn's request carried", () => {
    const first = REQUESTS.split("\n").filter(l => / tools=\['muse'\]/.test(l));
    expect(first[0]).toMatch(/model=nosuch-model reasoning=\{"effort": "high"/);   // after /model nosuch-model (effort kept: high)
    expect(REQUESTS).toMatch(/model=mock-model reasoning=\{"effort": "low", "summary": "auto"\} tools=\['muse'\] bytes=163880/); // after mock-model + low
  });
  it("model from 1.4.6, effort alone from 1.4.4; an unknown running version is neither", () => {
    const e = MUSE_RUNTIME_SWITCH, model = { model: "m", effort: null }, effort = { model: null, effort: "low" };
    expect([cliSwitchAllowed(e, model, "1.4.6"), cliSwitchAllowed(e, model, "1.4.5"), cliSwitchAllowed(e, model, "1.4.20-R8619.1")]).toEqual([true, false, true]);
    expect([cliSwitchAllowed(e, effort, "1.4.4"), cliSwitchAllowed(e, effort, "1.4.3"), cliSwitchAllowed(e, effort, null)]).toEqual([true, false, false]);
  });
  it("one command a step: a model and an effort are two; nothing a shell or the TUI would split, no level muse refuses", () => {
    const e = MUSE_RUNTIME_SWITCH;
    expect(e.steps({ model: "a", effort: "high" })).toEqual([{ model: "a", effort: null }, { model: null, effort: "high" }]);
    expect(e.steps({ model: null, effort: "low" })).toEqual([{ model: null, effort: "low" }]);
    expect([e.command({ model: "mock-alt", effort: null }), e.command({ model: null, effort: "xhigh" })]).toEqual(["/model mock-alt", "/effort xhigh"]);
    expect([e.command({ model: "a b", effort: null }), e.command({ model: "-x", effort: null }), e.command({ model: null, effort: "bogus" }), e.command({ model: "a", effort: "low" })]).toEqual([null, null, null, null]);
  });
  it("the footer: the last `MODEL · EFFORT · …` row", () => {
    expect([museFooter(IDLE), museFooter(MODEL), museFooter(BACK), museFooter("no footer")]).toEqual([
      { model: "mock-model", effort: "high" }, { model: "mock-alt", effort: "high" }, { model: "mock-model", effort: "low" }, null]);
  });
  it("model: switched only on a NEW `Model set to` naming it AND the footer on it; an older answer is not this switch", () => {
    const v = (step: { model: string | null; effort: string | null }, before: string, now: string) => MUSE_RUNTIME_SWITCH.verify(step, { pane: before }, { pane: now });
    expect(v({ model: "mock-alt", effort: null }, IDLE, MODEL)).toEqual({ outcome: "switched", shown: "mock-alt high" });
    expect(v({ model: "mock-alt", effort: null }, IDLE, IDLE)).toBeNull();                       // nothing yet
    expect(v({ model: "mock-alt", effort: null }, MODEL, MODEL)).toBeNull();                     // the answer was already there
    expect(v({ model: "mock-alt", effort: null }, BOGUS, UNKNOWN)).toEqual({ outcome: "mismatch", shown: "nosuch-model" }); // a new answer naming another
    expect(v({ model: "mock-alt", effort: null }, IDLE, MODEL.replace("mock-alt · high", "mock-model · high"))).toBeNull(); // footer not on it yet
    expect(v({ model: "mock-alt", effort: null }, IDLE, OLD)).toEqual({ outcome: "mismatch", shown: "model catalog has no visible models" });
  });
  it("effort: the footer's level (no answer line); a NEW refusal is a mismatch, an older one is not", () => {
    const v = (effort: string, before: string, now: string) => MUSE_RUNTIME_SWITCH.verify({ model: null, effort }, { pane: before }, { pane: now });
    expect(v("low", UNKNOWN, BACK)).toEqual({ outcome: "switched", shown: "mock-model low" });
    expect(v("low", IDLE, IDLE)).toBeNull();
    expect(v("bogus", MODEL, BOGUS)).toEqual({ outcome: "mismatch", shown: "unsupported reasoning effort `bogus`; expected minimal|low|medium|high|xhigh|max|ultra" });
    expect(v("low", BOGUS, BACK)).toEqual({ outcome: "switched", shown: "mock-model low" });   // the refusal was there before
  });
  it("is the table's muse entry; the running file `muse-bin-<version>` carries the version", () => {
    expect(CLI_RUNTIME_SWITCH.muse).toBe(MUSE_RUNTIME_SWITCH);
    expect([MUSE_RUNTIME_SWITCH.matchExe("/h/.local/share/muse/bin/muse-bin-1.4.20-R8619.1"), MUSE_RUNTIME_SWITCH.matchExe("/usr/bin/muse"), MUSE_RUNTIME_SWITCH.matchExe("/x/muse-bin-1.4.20/node")]).toEqual([true, false, false]);
    expect(MUSE_RUNTIME_SWITCH.versionFromExe!("/h/muse-bin-1.4.20-R8619.1")).toBe("1.4.20-R8619.1");
  });
});

describe("M-3180: the RUNNING CLI's version (cliRunningVersion)", () => {
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
  const spec = { backend: "muse", matchExe: MUSE_RUNTIME_SWITCH.matchExe, versionFromExe: MUSE_RUNTIME_SWITCH.versionFromExe };
  it("from the running file's own name when it carries one (nothing run); else the backend probe on that file", async () => {
    const muse = binary("a/muse-bin-1.4.20-R8619.1"), probe = vi.fn(async () => "9.9.9");
    expect(await cliRunningVersion(100, spec, { procRoot: proc([{ pid: 101, ppid: 100, exe: binary("a/bash") }, { pid: 102, ppid: 101, exe: muse }]), probe })).toBe("1.4.20-R8619.1");
    expect(probe).not.toHaveBeenCalled();
    const plain = binary("b/agy");
    const p2 = vi.fn(async () => "agy 1.5.9");
    expect(await cliRunningVersion(100, { backend: "antigravity", matchExe: (e: string) => e.endsWith("/agy") }, { procRoot: proc([{ pid: 101, ppid: 100, exe: plain }]), probe: p2 })).toBe("1.5.9");
    expect(p2).toHaveBeenCalledWith("antigravity", plain);
  });
  it("the pane's own process when tmux exec'd the CLI itself (the pane pid IS the CLI)", async () => {
    const muse = binary("d/muse-bin-1.4.6");
    const root = proc([]);
    rmSync(join(root, "100", "status")); writeFileSync(join(root, "100", "status"), "Name:\tmuse-bin\nPPid:\t1\n");
    symlinkSync(muse, join(root, "100", "exe"));
    expect(await cliRunningVersion(100, spec, { procRoot: root })).toBe("1.4.6");
  });
  it("a binary replaced during the async version probe is unknown, even if the new file meets the floor", async () => {
    const exe = binary("race/agy");
    const procRoot = proc([{ pid: 101, ppid: 100, exe }]);
    const result = await cliRunningVersion(100, { backend: "antigravity", matchExe: e => e.endsWith("/agy") }, {
      procRoot,
      probe: async () => {
        const old = `${exe}.running`;
        renameSync(exe, old);
        unlinkSync(join(procRoot, "101/exe")); symlinkSync(old, join(procRoot, "101/exe"));
        writeFileSync(exe, "new version on disk");
        return "1.5.9";
      },
    });
    expect(result).toBeNull();
  });
  it("unknown (null) when it cannot be proven: none, replaced on disk, two different files, no version", async () => {
    const a = binary("a/muse-bin-1.4.20"), b = binary("b/muse-bin-1.4.6");
    expect(await cliRunningVersion(100, spec, { procRoot: proc([{ pid: 101, ppid: 100, exe: binary("n/node") }]) })).toBeNull();
    expect(await cliRunningVersion(100, spec, { procRoot: proc([{ pid: 101, ppid: 100, exe: `${a} (deleted)` }]) })).toBeNull();
    expect(await cliRunningVersion(100, spec, { procRoot: proc([{ pid: 101, ppid: 100, exe: a }, { pid: 102, ppid: 100, exe: b }]) })).toBeNull();
    expect(await cliRunningVersion(100, { backend: "x", matchExe: () => true }, { procRoot: proc([{ pid: 101, ppid: 100, exe: a }]), probe: async () => null })).toBeNull();
  });
});

function museDaemon(screen: { text: string }) {
  mkdirSync(join(dir, "inst"), { recursive: true });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
  const d: any = new Daemon("m", {
    working_directory: dir, backend: "muse", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, join(dir, "inst"), false, new MuseBackend(join(dir, "inst")), undefined, logger);
  d.tmux = {
    isWindowAlive: async () => true, capturePane: async () => screen.text, capturePaneWithHistory: async () => screen.text,
    getWindowId: () => "@1", getPanePid: async () => 4242, sendSpecialKey: async () => true, sendKeys: async () => true, pasteText: async () => true,
  };
  return d;
}

describe("M-3180: the daemon types a step only past its gate, and reports muse's verdict", () => {
  it("verdict against the scrollback BEFORE the command: a new answer → switched; nothing new in time → not confirmed", async () => {
    const screen = { text: IDLE };
    const d = museDaemon(screen);
    setTimeout(() => { screen.text = MODEL; }, 300);
    expect(await d.verifyCliSwitch({ backend: "muse", model: "mock-alt", effort: null }, { pane: IDLE })).toEqual({ outcome: "switched", confirmed: true, shown: "mock-alt high" });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 4_000));
    expect(await d.verifyCliSwitch({ backend: "muse", model: "mock-alt", effort: null }, { pane: MODEL })).toEqual({ outcome: "not_confirmed" });
    vi.restoreAllMocks();
    screen.text = BOGUS;
    expect(await d.verifyCliSwitch({ backend: "muse", model: null, effort: "bogus" }, { pane: MODEL })).toMatchObject({ outcome: "mismatch", answered: true });
  });
  it("the gate: busy; the running version under the step's minimum or unknown; past it, the scrollback before", async () => {
    const d = museDaemon({ text: IDLE });
    d.waitForAuthoritativePaneIdle = async () => false;
    expect(await d.cliSwitchGate({ backend: "muse", model: "mock-alt", effort: null })).toEqual({ blocked: "busy" });
    d.waitForAuthoritativePaneIdle = async () => true;
    d.tmux.getPanePid = async () => null;
    expect(await d.cliSwitchGate({ backend: "muse", model: null, effort: "low" })).toEqual({ blocked: "version", version: null });
  });
  function routed(gate: unknown) {
    const d = museDaemon({ text: IDLE });
    const broadcast: any[] = [], typed: string[] = [];
    d.ipcServer = { broadcast: (m: unknown) => broadcast.push(m), send: () => {} };
    d.wake = async () => {};
    d.cliSwitchGate = vi.fn(async () => gate);
    d.deliverMessage = async (text: string, _x: unknown, opts: any) => { typed.push(text); opts.verdict.reached = true; opts.verdict.paneWriteStarted = true; opts.onPaneWritten?.(); return true; };
    d.verifyCliSwitch = vi.fn(async () => ({ outcome: "switched", confirmed: true, shown: "mock-alt high" }));
    return { d, broadcast, typed };
  }
  const msg = (cli: unknown) => ({ type: "raw_paste", content: "/model mock-alt", runtime_switch: { id: "sw-m1", kind: "model", requested: "mock-alt", cli } });
  it("a blocked gate: nothing typed, `not_sent` with why; a passed one: typed, then the verdict against the gate's capture", async () => {
    const old = routed({ blocked: "version", version: "1.4.4" });
    old.d.handleRawPasteIpcMessage(msg({ backend: "muse", model: "mock-alt", effort: null })); await old.d.pasteLock;
    expect([old.typed, old.broadcast]).toEqual([[], [{ type: "runtime_switch_result", id: "sw-m1", outcome: "not_sent", reason: "version", version: "1.4.4" }]]);
    const ok = routed({ pane: IDLE });
    ok.d.handleRawPasteIpcMessage(msg({ backend: "muse", model: "mock-alt", effort: null })); await ok.d.pasteLock;
    expect(ok.typed).toEqual(["/model mock-alt"]);
    expect(ok.d.verifyCliSwitch).toHaveBeenCalledWith({ backend: "muse", model: "mock-alt", effort: null }, { pane: IDLE });
    expect(ok.broadcast).toEqual([{ type: "runtime_switch_result", id: "sw-m1", outcome: "switched", confirmed: true, shown: "mock-alt high" }]);
  });
  it("a malformed or unrepresentable cli spec is refused without downgrading to raw paste", async () => {
    const bad = [{ backend: "nope", model: "m", effort: null }, { backend: "muse", model: "m", effort: "low" }, { backend: "muse", model: null, effort: null },
      { backend: "muse", model: 5, effort: null }, { backend: "muse", model: "m" }, "muse"];
    for (const cli of bad) {
      const r = routed({ pane: IDLE });
      r.d.handleRawPasteIpcMessage(msg(cli)); await r.d.pasteLock;
      expect([r.broadcast, r.typed, r.d.cliSwitchGate.mock.calls.length], JSON.stringify(cli)).toEqual([[{ type: "runtime_switch_result", id: "sw-m1", outcome: "not_sent", reason: "command" }], [], 0]);
    }
    const both = routed({ pane: IDLE });
    both.d.handleRawPasteIpcMessage({ ...msg({ backend: "muse", model: "m", effort: null }), runtime_switch: { id: "x", kind: "model", requested: "m", cli: { backend: "muse", model: "m", effort: null }, codex: { model: "m", effort: null } } });
    await both.d.pasteLock;
    expect(both.broadcast).toEqual([{ type: "runtime_switch_result", id: "x", outcome: "not_sent", reason: "command" }]);
    expect(both.typed).toEqual([]);
  });
});

describe("M-3180: /model and /effort on a muse instance — in place when muse takes it, else the restart; saved either way", () => {
  let prevData: string | undefined;
  beforeEach(() => {
    prevData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(dir, "data");
    mkdirSync(join(dir, "data", "muse", "model-catalog"), { recursive: true });
    writeFileSync(join(dir, "data", "muse", "model-catalog", "a.json"), JSON.stringify({ rows: ["mock-model", "mock-alt"].map(id => ({ model_id: id, visibility: "visible", context_limit: 1000 })) }));
  });
  afterEach(() => { if (prevData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevData; });
  function fleet(answers: unknown[]) {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-3180-fm-"));
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, yaml.dump({ defaults: {}, instances: { mu: { backend: "muse", working_directory: dataDir, model: "mock-model", effort: "high" } } }));
    const fm: any = new FleetManager(dataDir);
    fm.loadConfig(configPath);
    const queue = [...answers];
    const send = vi.fn((m: any) => { if (m.runtime_switch) { const a = queue.shift(); queueMicrotask(() => fm.runtimeSwitchWaiters.get(m.runtime_switch.id)?.(a)); } return true; });
    fm.instanceIpcClients.set("mu", { connected: true, send } as never);
    const restart = vi.fn(async () => {});
    fm.restartSingleInstance = restart;
    const saved = () => (yaml.load(readFileSync(configPath, "utf-8")) as any).instances.mu;
    return { fm, send, restart, saved, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
  }
  it("a model muse lists, confirmed: `/model ID` with the muse spec, no restart, saved", async () => {
    const f = fleet([{ outcome: "switched", confirmed: true, shown: "mock-alt high" }]);
    try {
      expect(await f.fm.applyModel("mu", "mock-alt")).toMatch(/Switched mu to `mock-alt` in its running session \(no restart\)/);
      expect(f.send.mock.calls[0]![0]).toMatchObject({ type: "raw_paste", content: "/model mock-alt", runtime_switch: { cli: { backend: "muse", model: "mock-alt", effort: null } } });
      expect([f.restart.mock.calls.length, f.saved().model]).toEqual([0, "mock-alt"]);
    } finally { f.cleanup(); }
  });
  it("a model muse's catalog does not list (muse would take any name): not typed; restarted as before, saved, said why", async () => {
    const f = fleet([]);
    try {
      const reply = await f.fm.applyModel("mu", "nosuch-model");
      expect(reply).toMatch(/Set mu to `nosuch-model` and restarted: Muse's model list does not show `nosuch-model`/);
      expect([f.send.mock.calls.length, f.restart.mock.calls.length, f.saved().model]).toEqual([0, 1, "nosuch-model"]);
    } finally { f.cleanup(); }
  });
  it("no cached catalog: cannot tell, so not typed (restart)", async () => {
    rmSync(join(dir, "data", "muse", "model-catalog"), { recursive: true, force: true });
    const f = fleet([]);
    try {
      await f.fm.applyModel("mu", "mock-alt");
      expect([f.send.mock.calls.length, f.restart.mock.calls.length]).toEqual([0, 1]);
    } finally { f.cleanup(); }
  });
  it.each([
    [{ outcome: "not_sent", reason: "version", version: "1.4.4" }, /its Muse \(1\.4\.4\) cannot switch in place \(needs 1\.4\.6 or later\)/],
    [{ outcome: "not_sent", reason: "busy" }, /stayed busy/],
    [{ outcome: "mismatch", shown: "model catalog has no visible models", answered: true }, /Muse did not take it in place \(model catalog has no visible models\)/],
    [{ outcome: "not_confirmed" }, /Muse did not confirm/],
  ] as const)("model %j → restart, saved first, and said why", async (answer, why) => {
    const f = fleet([answer]);
    try {
      const reply = await f.fm.applyModel("mu", "mock-alt");
      expect(reply).toMatch(/Set mu to `mock-alt` and restarted: /);
      expect(reply).toMatch(why);
      expect([f.restart.mock.calls.length, f.saved().model]).toEqual([1, "mock-alt"]);
    } finally { f.cleanup(); }
  });
  it("/effort: `/effort LEVEL` verified (no longer pasted blind); confirmed → no restart; not → restart naming 1.4.4; saved either way", async () => {
    const ok = fleet([{ outcome: "switched", confirmed: true, shown: "mock-model low" }]);
    try {
      expect(await ok.fm.applyEffort("mu", "low")).toMatch(/Set mu effort to `low` in its running session \(no restart\)/);
      expect(ok.send.mock.calls).toHaveLength(1);
      expect(ok.send.mock.calls[0]![0]).toMatchObject({ content: "/effort low", runtime_switch: { cli: { backend: "muse", model: null, effort: "low" } } });
      expect([ok.restart.mock.calls.length, ok.saved().effort]).toEqual([0, "low"]);
    } finally { ok.cleanup(); }
    const old = fleet([{ outcome: "not_sent", reason: "version", version: "1.4.3" }]);
    try {
      expect(await old.fm.applyEffort("mu", "medium")).toMatch(/Set mu effort to `medium` and restarted: .*needs 1\.4\.4 or later/);
      expect([old.restart.mock.calls.length, old.saved().effort]).toEqual([1, "medium"]);
    } finally { old.cleanup(); }
  });
  it("a model and an effort at once: two steps in order; the first that does not switch ends it (the effort is not typed)", async () => {
    const ok = fleet([{ outcome: "switched", confirmed: true, shown: "mock-alt high" }, { outcome: "switched", confirmed: true, shown: "mock-alt low" }]);
    try {
      expect((await ok.fm.runCliRuntimeSwitch("mu", "muse", { model: "mock-alt", effort: "low" })).result.outcome).toBe("switched");
      expect(ok.send.mock.calls.map((c: any[]) => c[0].content)).toEqual(["/model mock-alt", "/effort low"]);
    } finally { ok.cleanup(); }
    const no = fleet([{ outcome: "not_confirmed" }]);
    try {
      expect(await no.fm.runCliRuntimeSwitch("mu", "muse", { model: "mock-alt", effort: "low" })).toEqual({ result: { outcome: "not_confirmed" }, step: { model: "mock-alt", effort: null } });
      expect(no.send.mock.calls.map((c: any[]) => c[0].content)).toEqual(["/model mock-alt"]);
    } finally { no.cleanup(); }
  });
  it("a muse instance that is not running: saved and restarted as before, nothing typed", async () => {
    const f = fleet([]);
    f.fm.instanceIpcClients.delete("mu");
    try {
      await f.fm.applyModel("mu", "mock-alt");
      expect([f.send.mock.calls.length, f.restart.mock.calls.length, f.saved().model]).toEqual([0, 1, "mock-alt"]);
    } finally { f.cleanup(); }
  });
});
