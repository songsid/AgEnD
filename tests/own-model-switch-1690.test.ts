/**
 * #1690 (the user's choice A): AgEnD's own runtime `/model` answers claude 2.1.296's "Switch model?" — Yes when the
 * dialog names the model asked for, on a verified cursor; No (Escape) when it names another, reported — and holds
 * every delivery meanwhile. A name claude cannot know is refused before anything is typed. A "Switch model?" AgEnD did
 * not ask for is held and parked for a human, never answered.
 *
 * Real panes: tests/fixtures/claude-2.1.296-switch-model-*.pane.txt (the #1690 audit rig: real claude 2.1.296, AgEnD's
 * production launch, a local mock API, no account). The real Daemon and ClaudeCodeBackend run against a stub tmux
 * that serves those panes and records keys. Nothing starts a CLI, a fleet or a tmux server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, OWN_SWITCH_WAIT_MS } from "../src/daemon.js";
import { ClaudeCodeBackend, claudeSwitchDialog, claudeSwitchTargetMatches } from "../src/backend/claude-code.js";
import { presentationState } from "../src/interaction-observation.js";
import { setLocale } from "../src/locale.js";
import { FleetManager, RUNTIME_SWITCH_RESULT_MS } from "../src/fleet-manager.js";

const fixture = (name: string) => readFileSync(join(process.cwd(), "tests", "fixtures", `claude-2.1.296-${name}.pane.txt`), "utf8");
const SWITCH = fixture("switch-model-opus");                       // ❯ 1. Yes, switch to Opus 5.5
const SWITCH_ON_NO = SWITCH.replace("   ❯ 1. Yes, switch to Opus 5.5", "     1. Yes, switch to Opus 5.5").replace("     2. No, go back", "   ❯ 2. No, go back");
const SWITCH_TO_HAIKU = SWITCH.replaceAll("Opus 5.5", "Haiku 5.5");
const AT_PROMPT = fixture("after-turn");
/** What the pane shows after the command, with no dialog: claude's own result line under the echo. */
const SET_DIRECT = AT_PROMPT.replace(/^❯[ \t ]*$/m, "❯ /model opus\n  ⎿  Set model to Opus 5.5 and saved as your default for new sessions\n\n❯ ");
const AFTER_YES = AT_PROMPT.replace(/^❯[ \t ]*$/m, "❯ /model opus\n  ⎿  Set model to Opus 5.5 and saved as your default for new sessions\n\n❯ ");
const AFTER_NO = AT_PROMPT.replace(/^❯[ \t ]*$/m, "❯ /model sonnet\n  ⎿  Kept model as Sonnet 5.5\n\n❯ ");

let dir: string;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-1690-")); mkdirSync(join(dir, "inst")); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); setLocale("en"); });

/** The pane, and what each key does to it (a script per key; by default nothing changes). */
function rig(start: string, onKey: (key: string, screen: { text: string }) => void = () => {}) {
  const screen = { text: start };
  const keys: string[] = [];
  /** Every key with the pane it was sent on, re-read just before — proof each key was sent on a verified screen. */
  const seenAtKey: string[] = [];
  let lastRead = start;
  const d: any = new Daemon("w", {
    working_directory: dir, backend: "claude-code", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, join(dir, "inst"), false, new ClaudeCodeBackend(join(dir, "inst")), undefined, logger);
  d.tmux = {
    isWindowAlive: async () => true,
    capturePane: async () => { lastRead = screen.text; return screen.text; },
    capturePaneWithHistory: async () => screen.text,
    sendSpecialKey: async (key: string) => { keys.push(key); seenAtKey.push(lastRead); onKey(key, screen); return true; },
    sendKeys: async (key: string) => { keys.push(key); onKey(key, screen); return true; },
    pasteText: async () => true,
    getWindowId: () => "@1",
  };
  return { d, screen, keys, seenAtKey };
}

describe("#1690: the dialog, read from the real 2.1.296 panes", () => {
  it("names the target and the cursor; a transcript without it is not it", () => {
    expect(claudeSwitchDialog(SWITCH)).toEqual({ kind: "model", target: "Opus 5.5", cursor: 1 });
    expect(claudeSwitchDialog(fixture("switch-model-typo"))).toEqual({ kind: "model", target: "opsu", cursor: 1 });
    expect(claudeSwitchDialog(SWITCH_ON_NO)?.cursor).toBe(2);
    expect(claudeSwitchDialog(AT_PROMPT)).toBeNull();
    expect(claudeSwitchDialog(fixture("numbered-output-after-turn"))).toBeNull();
    // The dialog quoted in the transcript (an agent pasting a capture), with claude's own prompt under it: not it.
    const block = SWITCH.slice(SWITCH.indexOf("   Switch model?"), SWITCH.indexOf("     2. No, go back") + "     2. No, go back".length);
    expect(claudeSwitchDialog(AT_PROMPT.replace(/^❯[ \t\u00a0]*$/m, `${block}\n\n❯ `))).toBeNull();
  });
  it("matches by display name: aliases and ids resolve; another family, a raw echo of default, or a mismatched 1M do not", () => {
    for (const [r, s] of [["opus", "Opus 5.5"], ["Opus", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["opus[1m]", "Opus 5.5 (1M context)"], ["default", "Opus 5.5"]] as const) {
      expect(claudeSwitchTargetMatches(r, s), `${r} ~ ${s}`).toBe(true);
    }
    // A dated catalog id is shown by its name (live, 2.1.296: claude-sonnet-4-5-20250929 → "Sonnet 4.5").
    for (const [r, s] of [["claude-sonnet-4-5-20250929", "Sonnet 4.5"], ["claude-haiku-4-5-20251001", "Haiku 4.5"], ["claude-sonnet-4-5-20250929[1m]", "Sonnet 4.5 (1M context)"]] as const) {
      expect(claudeSwitchTargetMatches(r, s), `${r} ~ ${s}`).toBe(true);
    }
    for (const [r, s] of [["sonnet", "Opus 5.5"], ["opus", "Opus 5.5 (1M context)"], ["default", "default"], ["claude-sonnet-5-5", "Haiku 5.5"], ["claude-sonnet-4-5-20250929", "Sonnet 5.5"]] as const) {
      expect(claudeSwitchTargetMatches(r, s), `${r} ≁ ${s}`).toBe(false);
    }
  });
});

describe("#1690: our own switch answers its own dialog", () => {
  it("the dialog names the model asked for → Enter on a verified 'Yes' (one key) → switched, confirmed", async () => {
    const r = rig(SWITCH, (key, s) => { if (key === "Enter") s.text = AFTER_YES; });
    const result = await r.d.answerOwnSwitchDialog({ requested: "opus" });
    expect(result).toEqual({ outcome: "switched", confirmed: true, shown: "Opus 5.5" });
    expect(r.keys).toEqual(["Enter"]);
    expect(claudeSwitchDialog(r.seenAtKey[0]!)?.cursor, "Enter went on a pane read with the cursor on Yes").toBe(1);
  });

  it("the cursor on 'No' (a human moved it) → Up, re-read, then Enter on 'Yes' — each key on a verified screen", async () => {
    const r = rig(SWITCH_ON_NO, (key, s) => { if (key === "Up") s.text = SWITCH; else if (key === "Enter") s.text = AFTER_YES; });
    const result = await r.d.answerOwnSwitchDialog({ requested: "opus" });
    expect(result.outcome).toBe("switched");
    expect(r.keys).toEqual(["Up", "Enter"]);
    expect(r.seenAtKey.map(p => claudeSwitchDialog(p)?.cursor)).toEqual([2, 1]);
  });

  it("the cursor moves off 'Yes' between the read and the Enter → the Enter is not sent", async () => {
    let reads = 0;
    const r = rig(SWITCH);
    r.d.tmux.capturePane = async () => (++reads >= 2 ? SWITCH_ON_NO : SWITCH);   // the re-read under the lock sees row 2
    await r.d.answerOwnSwitchDialog({ requested: "opus" });
    expect(r.keys).not.toContain("Enter");
  });

  it("a cursor that does not move → no Enter, ever; not confirmed, left held for a human", async () => {
    const r = rig(SWITCH_ON_NO);
    const result = await r.d.answerOwnSwitchDialog({ requested: "opus" });
    expect(result.outcome).toBe("not_confirmed");
    expect(r.keys).not.toContain("Enter");
  });

  it("the dialog names another model → Escape only → mismatch reported, nothing confirmed", async () => {
    const r = rig(SWITCH, (key, s) => { if (key === "Escape") s.text = AFTER_NO; });
    const result = await r.d.answerOwnSwitchDialog({ requested: "sonnet" });
    expect(result).toEqual({ outcome: "mismatch", shown: "Opus 5.5", answered: true });
    expect(r.keys).toEqual(["Escape"]);
  });

  it("the dialog changes target between the read and the key → that key is not sent", async () => {
    let reads = 0;
    const r = rig(SWITCH);
    r.d.tmux.capturePane = async () => (++reads >= 2 ? SWITCH_TO_HAIKU : SWITCH);   // the re-read under the lock sees another target
    const result = await r.d.answerOwnSwitchDialog({ requested: "opus" });
    expect(r.keys).toEqual([]);
    expect(result.outcome).not.toBe("switched");
  });

  it("no dialog (no warm cache): claude's 'Set model to …' under our command is the result — no keys", async () => {
    const r = rig(SET_DIRECT);
    expect(await r.d.answerOwnSwitchDialog({ requested: "opus" })).toEqual({ outcome: "switched", confirmed: false });
    expect(r.keys).toEqual([]);
  });

  it("an older identical /model with its result further up is not this one's result (live 2.1.296: switched away and back)", () => {
    const stale = AT_PROMPT.replace(/^❯[ \t\u00a0]*$/m,
      "❯ /model opus\n  ⎿  Set model to Opus 5.5 and saved as your default for new sessions\n\n❯ a turn on opus\n\n● mock reply 3\n\n❯ /model sonnet\n  ⎿  Set model to Sonnet 5.5 and saved as your default for new sessions\n\n❯ a turn on sonnet\n\n● mock reply 4\n\n❯ /model opus\n\n❯ ");
    expect(Daemon.switchResultAfterCommand(stale, "opus"), "the newest /model opus has no result yet").toBe(false);
    expect(Daemon.switchResultAfterCommand(SET_DIRECT, "opus")).toBe(true);
    expect(Daemon.switchResultAfterCommand(SET_DIRECT, "sonnet"), "another model's command").toBe(false);
  });

  it("neither the dialog nor a result within the wait → not confirmed, no keys", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const r = rig(AT_PROMPT);
    const pending = r.d.answerOwnSwitchDialog({ requested: "opus" });
    await vi.advanceTimersByTimeAsync(OWN_SWITCH_WAIT_MS + 1_000);
    expect(await pending).toEqual({ outcome: "not_confirmed" });
    expect(r.keys).toEqual([]);
  });
});

describe("#1690: the raw_paste route carries our switch and reports it back", () => {
  function routed(reached: boolean) {
    const r = rig(AT_PROMPT);
    const broadcast: any[] = [];
    r.d.ipcServer = { broadcast: (m: unknown) => broadcast.push(m), send: () => {} };
    r.d.wake = async () => {};
    const during: unknown[] = [];
    /** What another writer would see right after our write, still before deliverMessage returns (the post-submit wait). */
    const atWrite: string[] = [];
    r.d.deliverMessage = async (_text: string, _x: unknown, opts: any) => {
      opts.verdict.reached = reached; opts.verdict.paneWriteStarted = reached;
      if (reached) { opts.onPaneWritten?.(); atWrite.push((await r.d.probeBlockingDialog()).state); }
      return reached;
    };
    r.d.answerOwnSwitchDialog = async (spec: unknown) => {
      during.push([spec, r.d.ownSwitch?.requested ?? null, (await r.d.probeBlockingDialog()).state]);
      return { outcome: "switched", confirmed: true, shown: "Opus 5.5" };
    };
    return { r, broadcast, during, atWrite };
  }

  it("held from its own write on — before the lock is released, so a steer or /btw cannot slip in before the dialog paints", async () => {
    const { r, atWrite } = routed(true);
    r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/model opus", runtime_switch: { id: "sw-0", kind: "model", requested: "opus" } });
    await r.d.pasteLock;
    expect(atWrite).toEqual(["dialog"]);
  });

  it("held while it is answered; the outcome goes back with its id; released after", async () => {
    const { r, broadcast, during } = routed(true);
    r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/model opus", runtime_switch: { id: "sw-1", kind: "model", requested: "opus" } });
    await r.d.pasteLock;
    expect(during).toEqual([[expect.objectContaining({ requested: "opus" }), "opus", "dialog"]]);
    expect(broadcast).toEqual([{ type: "runtime_switch_result", id: "sw-1", outcome: "switched", confirmed: true, shown: "Opus 5.5" }]);
    expect([r.d.ownSwitch, (await r.d.probeBlockingDialog()).state]).toEqual([null, "clear"]);
  });

  it("a paste that never reached the pane is reported 'not sent', and nothing is answered", async () => {
    const { r, broadcast, during } = routed(false);
    r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/model opus", runtime_switch: { id: "sw-2", kind: "model", requested: "opus" } });
    await r.d.pasteLock;
    expect([during, broadcast]).toEqual([[], [{ type: "runtime_switch_result", id: "sw-2", outcome: "not_sent" }]]);
  });

  it("cancelled while the CLI was being woken: reported 'not sent' at once, nothing answered", async () => {
    const { r, broadcast, during } = routed(true);
    r.d.wake = async () => { r.d.deliveryEpoch++; };   // a user cancel lands during the wake
    r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/model opus", runtime_switch: { id: "sw-3", kind: "model", requested: "opus" } });
    await r.d.pasteLock;
    expect([during, broadcast]).toEqual([[], [{ type: "runtime_switch_result", id: "sw-3", outcome: "not_sent" }]]);
  });

  it("an ordinary raw paste (no switch spec) answers nothing and reports nothing", async () => {
    const { r, broadcast, during } = routed(true);
    r.d.handleRawPasteIpcMessage({ type: "raw_paste", content: "/compact" });
    await r.d.pasteLock;
    expect([during, broadcast]).toEqual([[], []]);
  });
});

describe("#1690: deliveries are held", () => {
  it("while our switch is being answered — even before the dialog paints", async () => {
    const r = rig(AT_PROMPT);
    expect((await r.d.probeBlockingDialog()).state).toBe("clear");
    r.d.ownSwitch = { id: "s1", kind: "model", requested: "opus" };
    expect((await r.d.probeBlockingDialog()).state).toBe("dialog");
    r.d.ownSwitch = null;
    expect((await r.d.probeBlockingDialog()).state).toBe("clear");
  });

  it("whenever the dialog is on screen, ours or not (its default cursor is Yes)", async () => {
    const r = rig(SWITCH);
    expect((await r.d.probeBlockingDialog()).state).toBe("dialog");
  });
});

describe("#1690: a 'Switch model?' AgEnD did not ask for", () => {
  it("is never answered by the runtime scan; it is held, awaiting input, and parked for a human after a minute", async () => {
    vi.useFakeTimers();
    const r = rig(SWITCH);
    const parked: any[] = [];
    r.d.on("dialog_parked", (e: unknown) => parked.push(e));
    r.d.startErrorMonitor();
    try {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(r.keys).toEqual([]);
      expect(parked).toHaveLength(1);
      expect(parked[0].description).toMatch(/model\/effort switch confirmation/);
      expect(parked[0].unrecognised ?? false, "a known dialog, not #1691's catch-all").toBe(false);
      expect(presentationState("idle", r.d.getInteractionSnapshot())).toBe("awaiting_input");
    } finally { clearInterval(r.d.errorMonitorTimer); }
  });

  it("ours, being answered, is not 'awaiting your input' (no Needs-you flash)", async () => {
    const r = rig(SWITCH);
    r.d.ownSwitch = { id: "s1", kind: "model", requested: "opus" };
    expect(r.d.interactionEvidence(SWITCH, r.d.runtimeDialogs ? r.d.runtimeDialogs() : r.d.backend.getRuntimeDialogs())).toBeNull();
    r.d.ownSwitch = null;
    expect(r.d.interactionEvidence(SWITCH, r.d.runtimeDialogs ? r.d.runtimeDialogs() : r.d.backend.getRuntimeDialogs())).not.toBeNull();
  });
});

// ── The fleet side: `/model` (every entry point ends in applyModel) ──────────────────────────────────────────────

describe("#1690: applyModel checks the name, then reports what the switch came to", () => {
  function fleet(answer: unknown | null, catalog: string[] = []) {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-1690-fm-"));
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, yaml.dump({ defaults: {}, instances: { alpha: { backend: "claude-code", working_directory: dataDir, model: "sonnet" } } }));
    const fm = new FleetManager(dataDir);
    fm.loadConfig(configPath);
    (fm as any).readCliEnv = () => (catalog.length ? { apiModels: catalog.map(id => ({ id, label: id })) } : null);
    const send = vi.fn((msg: any) => {
      if (msg.runtime_switch && answer) queueMicrotask(() => (fm as any).runtimeSwitchWaiters.get(msg.runtime_switch.id)?.(answer));
      return true;
    });
    fm.instanceIpcClients.set("alpha", { connected: true, send } as never);
    const savedModel = () => (yaml.load(readFileSync(configPath, "utf-8")) as any).instances.alpha.model;
    return { fm, send, savedModel, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
  }

  it("an unknown name ('opsu', the user's typo) is refused before anything is typed or saved", async () => {
    const f = fleet({ outcome: "switched", confirmed: false });
    try {
      const reply = await f.fm.applyModel("alpha", "opsu");
      expect(reply).toMatch(/Not switched: unknown model “opsu”/);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.savedModel()).toBe("sonnet");
    } finally { f.cleanup(); }
  });

  it("known names pass: aliases (any case, with [1m]), catalog ids and their [1m]; a claude-… id only when no catalog is cached", async () => {
    for (const name of ["opus", "Fable", "sonnet[1m]", "default"]) {
      const f = fleet({ outcome: "switched", confirmed: false });
      try { expect(await f.fm.applyModel("alpha", name), name).toMatch(/Switched/); } finally { f.cleanup(); }
    }
    const withCatalog = fleet({ outcome: "switched", confirmed: false }, ["claude-opus-5-5", "claude-sonnet-5-5"]);
    try {
      expect(await withCatalog.fm.applyModel("alpha", "claude-sonnet-5-5[1m]")).toMatch(/Switched/);
      expect(await withCatalog.fm.applyModel("alpha", "claude-sonet-5-5")).toMatch(/unknown model/);
    } finally { withCatalog.cleanup(); }
    const noCatalog = fleet({ outcome: "switched", confirmed: false });
    try { expect(await noCatalog.fm.applyModel("alpha", "claude-opus-5-5")).toMatch(/Switched/); } finally { noCatalog.cleanup(); }
  });

  it("the dialog named the requested model and was confirmed → success with the re-read note; saved", async () => {
    const f = fleet({ outcome: "switched", confirmed: true, shown: "Opus 5.5" });
    try {
      const reply = await f.fm.applyModel("alpha", "opus");
      expect(reply).toMatch(/Switched alpha to `opus`\. Claude asked to confirm .* re-reads the full history/);
      expect(f.send).toHaveBeenCalledWith({ type: "raw_paste", content: "/model opus", runtime_switch: { id: expect.any(String), kind: "model", requested: "opus" } });
      expect(f.savedModel()).toBe("opus");
    } finally { f.cleanup(); }
  });

  it("the dialog named another model (answered No) → mismatch reported; the configured model is unchanged", async () => {
    const f = fleet({ outcome: "mismatch", shown: "Haiku 5.5", answered: true });
    try {
      const reply = await f.fm.applyModel("alpha", "opus");
      expect(reply).toMatch(/not switched — Claude would switch to “Haiku 5\.5”, not `opus`, so AgEnD answered No/);
      expect(f.savedModel()).toBe("sonnet");
    } finally { f.cleanup(); }
  });

  it("the daemon could not send it (a cancel, a lost pane) → 'not sent, nothing changed'; not saved", async () => {
    const f = fleet({ outcome: "not_sent" });
    try {
      expect(await f.fm.applyModel("alpha", "opus")).toMatch(/`\/model opus` was not sent .* Nothing changed/);
      expect(f.savedModel()).toBe("sonnet");
    } finally { f.cleanup(); }
  });

  it("no word from the daemon in time → 'sent, not confirmed', said so (and saved: the command did go in)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fleet(null);
    try {
      const pending = f.fm.applyModel("alpha", "opus");
      await vi.advanceTimersByTimeAsync(RUNTIME_SWITCH_RESULT_MS + 100);
      expect(await pending).toMatch(/asked for `\/model opus`, but no result came back within 12 s/);
      expect(f.savedModel()).toBe("opus");
    } finally { vi.useRealTimers(); f.cleanup(); }
  });
});
