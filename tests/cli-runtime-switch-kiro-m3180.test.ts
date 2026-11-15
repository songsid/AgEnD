/**
 * M-3180 (S-157): kiro's in-session `/model ID` and `/effort LEVEL` on the TUI (v2 engine), through CLI_RUNTIME_SWITCH. Fixtures are
 * the offline rig's (scripts/manual/kiro-switch-audit/switch.sh; kiro 3.3.0 and 2.30.0, KIRO_TEST_MODE's model list, no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { CLI_RUNTIME_SWITCH, KIRO_RUNTIME_SWITCH, cliSwitchAllowed, kiroPaneSession, kiroRecorded, kiroTuiFooter } from "../src/backend/cli-runtime-switch.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";
import { installKiroCompatibilityFixture } from "./helpers/kiro-process-stub.js";

installKiroCompatibilityFixture();

const FIX = join(process.cwd(), "tests", "fixtures", "kiro-330-model-switch");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");
const IDLE = fixture("3.3.0-0-idle.pane.txt");                 // kiro_default · Claude Opus 4.7 · xhigh
const MODEL = fixture("3.3.0-1-model.pane.txt");               // /model claude-sonnet-4.6 → • Model changed to Claude Sonnet 4.6, · high ·
const EFFORT = fixture("3.3.0-2-effort.pane.txt");             // /effort low → • Effort set to low, · low ·
const BOGUS = fixture("3.3.0-3-effort-bogus.pane.txt");        // • invalid effort level 'bogus'; …
const UNKNOWN = fixture("3.3.0-4-model-unknown.pane.txt");     // • Model 'nosuch-model' not found. …
const OLD_MODEL = fixture("2.30.0-1-model.pane.txt");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-3180k-")); setLocale("en"); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const record = (name: string) => { const p = join(dir, `${name}.json`); copyFileSync(join(FIX, name), p); return p; };

describe("M-3180: kiro's switch, read and written as the rig's kiro takes it", () => {
  it("the footer: agent, the model's NAME, and its effort when it has one", () => {
    expect([kiroTuiFooter(IDLE), kiroTuiFooter(MODEL), kiroTuiFooter(EFFORT), kiroTuiFooter(OLD_MODEL)]).toEqual([
      { agent: "kiro_default", model: "Claude Opus 4.7", effort: "xhigh" }, { agent: "kiro_default", model: "Claude Sonnet 4.6", effort: "high" },
      { agent: "kiro_default", model: "Claude Sonnet 4.6", effort: "low" }, { agent: "kiro_default", model: "Claude Sonnet 4.6", effort: "high" }]);
    expect(kiroTuiFooter("kiro_default · ◔ 3%      /w")).toBeNull();   // no model yet (a V3 `Default · ◔ 1%` row is no v2 footer either)
  });
  it("the session record: the model id, and the effort override", async () => {
    expect(await kiroRecorded(record("3.3.0-session-1-model.json"))).toEqual({ model: "claude-sonnet-4.6", effort: "high" });
    expect(await kiroRecorded(record("3.3.0-session-2-effort.json"))).toEqual({ model: "claude-sonnet-4.6", effort: "low" });
    expect(await kiroRecorded(join(dir, "missing.json"))).toBeNull();
  });
  it("one command a step (model, then the effort); from 2.30.0 (the oldest binary checked)", () => {
    const e = KIRO_RUNTIME_SWITCH;
    expect(e.steps({ model: "m", effort: "high" })).toEqual([{ model: "m", effort: null }, { model: null, effort: "high" }]);
    expect([e.command({ model: "claude-sonnet-4.6", effort: null }), e.command({ model: null, effort: "low" })]).toEqual(["/model claude-sonnet-4.6", "/effort low"]);
    expect([e.command({ model: "a b", effort: null }), e.command({ model: null, effort: "minimal" }), e.command({ model: "a", effort: "low" })]).toEqual([null, null, null]);
    expect([cliSwitchAllowed(e, { model: "m", effort: null }, "2.30.0"), cliSwitchAllowed(e, { model: null, effort: "low" }, "2.29.0"), cliSwitchAllowed(e, { model: "m", effort: null }, "3.3.0")]).toEqual([true, false, true]);
    expect(CLI_RUNTIME_SWITCH["kiro-cli"]).toBe(KIRO_RUNTIME_SWITCH);
  });
  it("model: switched when the session's record names it (the footer only shows a name); no record → nothing confirms it", async () => {
    const v = (before: string, now: string, rec?: string) => KIRO_RUNTIME_SWITCH.verify({ model: "claude-sonnet-4.6", effort: null }, { pane: before, ...(rec ? { record: rec } : {}) }, { pane: now });
    expect(await v(IDLE, MODEL, record("3.3.0-session-1-model.json"))).toEqual({ outcome: "switched", shown: "claude-sonnet-4.6 high" });
    expect(await v(IDLE, MODEL)).toBeNull();
    const other = join(dir, "other.json");
    writeFileSync(other, fixture("3.3.0-session-1-model.json").replace(/claude-sonnet-4\.6/g, "claude-opus-4.7"));
    expect(await v(IDLE, IDLE, other)).toBeNull();                                  // not (yet) the model asked for
  });
  it("effort: the record's override AND the footer; a NEW refusal is a mismatch, an older one is not", async () => {
    const v = (effort: string, before: string, now: string, rec: string) => KIRO_RUNTIME_SWITCH.verify({ model: null, effort }, { pane: before, record: rec }, { pane: now });
    expect(await v("low", MODEL, EFFORT, record("3.3.0-session-2-effort.json"))).toEqual({ outcome: "switched", shown: "claude-sonnet-4.6 low" });
    expect(await v("low", MODEL, EFFORT, record("3.3.0-session-1-model.json"))).toBeNull();   // record not there yet
    expect(await v("low", MODEL, MODEL, record("3.3.0-session-2-effort.json"))).toBeNull();   // footer not there yet
    expect(await v("bogus", EFFORT, BOGUS, record("3.3.0-session-2-effort.json"))).toEqual({ outcome: "mismatch", shown: "invalid effort level 'bogus'; must be one of: low, medium, high, xhigh, max" });
    expect(await KIRO_RUNTIME_SWITCH.verify({ model: "nosuch-model", effort: null }, { pane: BOGUS, record: record("3.3.0-session-2-effort.json") }, { pane: UNKNOWN }))
      .toMatchObject({ outcome: "mismatch", shown: expect.stringMatching(/^Model 'nosuch-model' not found/) });
    // kiro's notices replace each other (one overlay row): the same refusal still on screen is not a new one.
    expect(await KIRO_RUNTIME_SWITCH.verify({ model: null, effort: "bogus" }, { pane: BOGUS, record: record("3.3.0-session-2-effort.json") }, { pane: BOGUS })).toBeNull();
  });
  it("the running binary: 2.x's kiro-cli-chat (not its kiro-cli launcher); 3.x's one kiro-cli", () => {
    mkdirSync(join(dir, "v2")); mkdirSync(join(dir, "v3"));
    for (const f of ["v2/kiro-cli", "v2/kiro-cli-chat", "v3/kiro-cli"]) writeFileSync(join(dir, f), "");
    expect([join(dir, "v2/kiro-cli-chat"), join(dir, "v2/kiro-cli"), join(dir, "v3/kiro-cli"), join(dir, "v3/kiro")].map(KIRO_RUNTIME_SWITCH.matchExe)).toEqual([true, false, true, false]);
  });
});

describe("M-3180: the session file a pane's kiro writes (its lock names a process of the pane)", () => {
  function proc(children: Array<{ pid: number; ppid: number }>) {
    const root = mkdtempSync(join(dir, "proc-"));
    for (const c of [{ pid: 100, ppid: 1 }, ...children]) {
      mkdirSync(join(root, String(c.pid)), { recursive: true });
      writeFileSync(join(root, String(c.pid), "status"), `Name:\tx\nPPid:\t${c.ppid}\n`);
    }
    return root;
  }
  const lock = (sessions: string, id: string, pid: number) => { writeFileSync(join(sessions, `${id}.lock`), JSON.stringify({ pid, started_at: "x" })); };
  it("the lock whose pid is under the pane; none, or two, or another pane's → null", async () => {
    const sessions = join(dir, "sessions"); mkdirSync(sessions);
    const root = proc([{ pid: 101, ppid: 100 }, { pid: 102, ppid: 101 }, { pid: 103, ppid: 102 }, { pid: 900, ppid: 1 }]);
    lock(sessions, "aaaaaaaa-1111", 900);
    expect(await kiroPaneSession(100, { sessionsDir: sessions, procRoot: root })).toBeNull();
    lock(sessions, "bbbbbbbb-2222", 103);
    expect(await kiroPaneSession(100, { sessionsDir: sessions, procRoot: root })).toBe(join(sessions, "bbbbbbbb-2222.json"));
    lock(sessions, "cccccccc-3333", 102);
    expect(await kiroPaneSession(100, { sessionsDir: sessions, procRoot: root })).toBeNull();
  });
});

describe("M-3180: /model and /effort on a kiro instance — the TUI (v2) switches in place; classic and V3 keep the restart", () => {
  let prevHome: string | undefined;
  beforeEach(() => { prevHome = process.env.AGEND_HOME; process.env.AGEND_HOME = join(dir, "agend"); mkdirSync(process.env.AGEND_HOME, { recursive: true }); });
  afterEach(() => { if (prevHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = prevHome; });
  function fleet(ui: "tui" | "legacy" | "v3" | null, answers: unknown[]) {
    if (ui) writeFileSync(join(process.env.AGEND_HOME!, "kiro-engine-ledger.json"), JSON.stringify({ ki: {
      workingDirectory: dir, credentialProfile: null, firstSeen: "2026-11-15T00:00:00.000Z",
      lastLaunch: { at: "2026-11-15T00:00:00.000Z", kiroVersion: "3.3.0", agendVersion: "x", ui, flags: [] }, history: [] } }));
    const dataDir = mkdtempSync(join(tmpdir(), "agend-3180k-fm-"));
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, yaml.dump({ defaults: {}, instances: { ki: { backend: "kiro-cli", working_directory: dataDir, model: "claude-opus-4.7", effort: "high" } } }));
    const fm: any = new FleetManager(dataDir);
    fm.loadConfig(configPath);
    const queue = [...answers];
    const send = vi.fn((m: any) => { if (m.runtime_switch) { const a = queue.shift(); queueMicrotask(() => fm.runtimeSwitchWaiters.get(m.runtime_switch.id)?.(a)); } return true; });
    fm.instanceIpcClients.set("ki", { connected: true, send } as never);
    const restart = vi.fn(async () => {});
    fm.restartSingleInstance = restart;
    const saved = () => (yaml.load(readFileSync(configPath, "utf-8")) as any).instances.ki;
    return { fm, send, restart, saved, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
  }
  it("a TUI instance: `/model ID` typed with the kiro spec; confirmed → no restart; saved", async () => {
    const f = fleet("tui", [{ outcome: "switched", confirmed: true, shown: "claude-sonnet-4.6 high" }, { outcome: "switched", confirmed: true, shown: "claude-sonnet-4.6 high" }]);
    try {
      expect(await f.fm.applyModel("ki", "claude-sonnet-4.6")).toMatch(/Switched ki to `claude-sonnet-4\.6` in its running session \(no restart\)/);
      expect(f.send.mock.calls[0]![0]).toMatchObject({ content: "/model claude-sonnet-4.6", runtime_switch: { cli: { backend: "kiro-cli", model: "claude-sonnet-4.6", effort: null } } });
      expect([f.restart.mock.calls.length, f.saved().model]).toEqual([0, "claude-sonnet-4.6"]);
    } finally { f.cleanup(); }
  });
  it("a model switch carries the configured effort as its own step (kiro's /model puts the model's default); the first step not switched ends it", async () => {
    const f = fleet("tui", [{ outcome: "switched", confirmed: true, shown: "claude-sonnet-4.6 xhigh" }, { outcome: "switched", confirmed: true, shown: "claude-sonnet-4.6 high" }]);
    try {
      expect(await f.fm.applyModel("ki", "claude-sonnet-4.6")).toMatch(/Switched ki to `claude-sonnet-4\.6` in its running session/);
      expect(f.send.mock.calls.map((c: any[]) => c[0].content)).toEqual(["/model claude-sonnet-4.6", "/effort high"]);
    } finally { f.cleanup(); }
    const g = fleet("tui", [{ outcome: "switched", confirmed: true, shown: "claude-sonnet-4.6 xhigh" }, { outcome: "not_confirmed" }]);
    try {
      expect(await g.fm.applyModel("ki", "claude-sonnet-4.6")).toMatch(/Set ki to `claude-sonnet-4\.6` and restarted: Kiro did not confirm/);
      expect([g.send.mock.calls.length, g.restart.mock.calls.length]).toEqual([2, 1]);
    } finally { g.cleanup(); }
  });
  it("a TUI instance's /effort: typed and verified; not confirmed → restart naming why; saved either way", async () => {
    const ok = fleet("tui", [{ outcome: "switched", confirmed: true, shown: "claude-opus-4.7 low" }]);
    try {
      expect(await ok.fm.applyEffort("ki", "low")).toMatch(/Set ki effort to `low` in its running session \(no restart\)/);
      expect(ok.send.mock.calls[0]![0]).toMatchObject({ content: "/effort low", runtime_switch: { cli: { backend: "kiro-cli", model: null, effort: "low" } } });
      expect([ok.restart.mock.calls.length, ok.saved().effort]).toEqual([0, "low"]);
    } finally { ok.cleanup(); }
    const old = fleet("tui", [{ outcome: "not_sent", reason: "version", version: "2.28.0" }]);
    try {
      expect(await old.fm.applyEffort("ki", "medium")).toMatch(/Set ki effort to `medium` and restarted: its Kiro \(2\.28\.0\) cannot switch in place \(needs 2\.30\.0 or later\)/);
      expect([old.restart.mock.calls.length, old.saved().effort]).toEqual([1, "medium"]);
    } finally { old.cleanup(); }
  });
  it.each(["legacy", "v3", null] as const)("a %s kiro instance (classic, V3, or no launch record): nothing typed, the restart as before", async ui => {
    const f = fleet(ui, []);
    try {
      await f.fm.applyModel("ki", "claude-sonnet-4.6");
      await f.fm.applyEffort("ki", "low");
      expect([f.send.mock.calls.filter((c: any[]) => c[0].runtime_switch).length, f.restart.mock.calls.length, f.saved().model, f.saved().effort]).toEqual([0, 2, "claude-sonnet-4.6", "low"]);
    } finally { f.cleanup(); }
  });
});
