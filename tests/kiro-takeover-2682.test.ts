/**
 * #2682: while another program owns a kiro pane — an editor or pager kiro started (/editor, /reply, /transcript), a `!`
 * command, a focused /kvim — no delivery keystroke goes into it, on any engine. Held as a runtime dialog (hold notice,
 * input_blocked, never keyed) when kiro's own rows (or the program's own bottom rows) say so; and fail closed: an idle
 * delivery needs kiro's own input row read positively, and a busy hand-off (#2676) one whose turn is seen to be the
 * agent's. Real 2.34.0 panes, captured offline: tests/fixtures/kiro-2.34.0-takeover-2682 (tui, V3 and legacy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { KiroBackend, kiroBusyTurnTakesInput, kiroTakeoverActive, type KiroCliCompatibility } from "../src/backend/kiro.js";

const FIX = join(import.meta.dirname, "fixtures");
const FX = join(FIX, "kiro-2.34.0-takeover-2682");
const fx = (name: string) => readFileSync(join(FX, `${name}.pane.txt`), "utf8");
const at = (dir: string, name: string) => readFileSync(join(FIX, dir, `${name}.pane.txt`), "utf8");
const uiOf = (name: string) => (name.startsWith("legacy") ? "legacy" : name.startsWith("v3") ? "v3" : "tui") as "legacy" | "tui" | "v3";

const TAKEOVER = new Set([
  "tui-editor-vi", "v3-editor-vi", "tui-editor-nano", "tui-transcript-less", "v3-transcript-less", "tui-transcript-more",
  "tui-bang-running", "v3-bang-running", "tui-bang-paste-went-to-command", "tui-bang-cat-running",
  "tui-bang-less-scrolled", "tui-bang-vi-ruler", "tui-bang-vi-insert", "tui-kvim-focused", "tui-kvim-focused-paste-went-to-nvim",
  "legacy-editor-vi", "legacy-reply-vi", "legacy-notrust-editor-vi", "legacy-bang-running", "legacy-notrust-bang-running", "legacy-bang-vi",
]);
const NOT = new Set([
  "tui-kvim-unfocused", "tui-kvim-unfocused-paste-in-composer", "tui-fullscreen", "tui-fullscreen-delivery", "tui-bang-done",
  "v3-bang-done", "tui-idle-after-transcript", "v3-idle-after-editor", "tui-reply-unrecognized",
  "legacy-idle", "legacy-notrust-idle", "legacy-notrust-idle-after-editor", "legacy-bang-paste-went-to-command",
  "legacy-bang-done-typeahead-stranded",
  // the first frame of a full-screen `!less`: only its file name on the last row — no signal to name it by; held by the
  // composer gate instead (below)
  "tui-bang-less",
]);

describe("which 2.34.0 screens are a takeover (kiroTakeoverActive)", () => {
  const names = readdirSync(FX).filter(f => f.endsWith(".pane.txt")).map(f => f.replace(/\.pane\.txt$/, ""));
  it("every captured frame is classified, as its README says", () => {
    expect(names.filter(n => !TAKEOVER.has(n) && !NOT.has(n))).toEqual([]);
    for (const n of names) expect(kiroTakeoverActive(fx(n), uiOf(n)), n).toBe(TAKEOVER.has(n));
  });
  it("kiro's own temp file names it when the program's rows do not (a pager's first page shows only the file)", () => {
    const pagerFirstPage = fx("tui-transcript-less").replace(/ \(END\)$/m, "").replace(/^~$/gm, "");
    expect(pagerFirstPage).toMatch(/kiro-raw-[A-Za-z0-9]{6}\/conversation\.md$/m);
    expect(kiroTakeoverActive(pagerFirstPage, "tui")).toBe(true);
    // legacy's /editor and /reply file, its status row without vi's ruler (another editor, or a narrow pane)
    const legacyEditor = fx("legacy-editor-vi").replace(/(q_prompt_[0-9a-f-]{36}\.md").*$/m, "$1").replace(/^~$/gm, "");
    expect(kiroTakeoverActive(legacyEditor, "legacy")).toBe(true);
    expect(kiroTakeoverActive(legacyEditor.replace(/q_prompt_/, "notes_"), "legacy")).toBe(false);   // the control
  });

  it("each program's own bottom row, where kiro's input row is not on screen", () => {
    const screen = (last: string, above = "some text") => `${above}\n${above}\n${last}\n`;
    for (const last of [":", "conversation.md (END)", "--More--(75%)", "-- INSERT --", "-- VISUAL LINE --", "\"f.txt\" 2L, 18B      1,1           All"])
      for (const ui of ["tui", "legacy"] as const) expect(kiroTakeoverActive(screen(last), ui), `${ui} ${last}`).toBe(true);
    expect(kiroTakeoverActive("a\n~\n~\n~\n\"x\" 0L, 0B\n", "legacy")).toBe(true);                              // vi's empty lines
    expect(kiroTakeoverActive("  GNU nano 6.2   x\n\n^G Help  ^O Write Out\n^X Exit  ^R Read File\n", "legacy")).toBe(true);
    expect(kiroTakeoverActive(screen("just some output"), "legacy")).toBe(false);                                   // the control
    expect(kiroTakeoverActive("  GNU nano 6.2   x\n\n^G Help\n", "legacy")).toBe(false);                             // no ^X Exit row
  });

  it("agent turns, the idle composer and kiro's other screens are never one, on any engine", () => {
    for (const [dir, n] of [
      ["kiro-steer-1405", "2.27.1-tui-steer-pending"], ["kiro-steer-1405", "2.27.1-tui-busy-steer"], ["kiro-steer-1405", "2.27.1-v3-steer-pending"],
      ["kiro-steer-1405", "2.28.0-tui-busy-queue"], ["kiro-reply-guard", "tui-busy"], ["kiro-reply-guard", "tui-idle"],
      ["kiro-2.34.0-busy-insert-2676", "tui-busy-steer"], ["kiro-2.34.0-busy-insert-2676", "tui-two-in-tray"],
      ["kiro-2.34.0-busy-insert-2676", "tui-collapsed-lines-in-box"], ["kiro-2.34.0-busy-insert-2676", "tui-queue-sent"],
      // real 2.34.0 (D5), trimmed to the footer: the turn cannot be seen — not called a takeover (no false notice)
      ["kiro-2.34.0-tui-d5", "busy-steer"], ["kiro-2.34.0-tui-d5", "steer-pending"], ["kiro-2.34.0-tui-d5", "queue-pending"],
    ] as const) expect(kiroTakeoverActive(at(dir, n), "tui"), `${dir}/${n}`).toBe(false);
    for (const n of ["legacy-busy", "legacy-idle"]) expect(kiroTakeoverActive(at("kiro-reply-guard", n), "legacy"), n).toBe(false);
  });
});

describe("a busy composer's input reaches the agent's turn only when that turn is seen (kiroBusyTurnTakesInput)", () => {
  it("agent turns: yes; a running `!` command: no; a turn above the visible pane (trimmed D5): no", () => {
    expect(kiroBusyTurnTakesInput(at("kiro-steer-1405", "2.27.1-tui-steer-pending"))).toBe(true);
    expect(kiroBusyTurnTakesInput(at("kiro-reply-guard", "tui-busy"))).toBe(true);
    expect(kiroBusyTurnTakesInput(at("kiro-2.34.0-busy-insert-2676", "tui-busy-steer"))).toBe(true);
    expect(kiroBusyTurnTakesInput(fx("tui-fullscreen-delivery"))).toBe(true);
    for (const n of ["tui-bang-running", "v3-bang-running", "tui-bang-cat-running", "tui-bang-paste-went-to-command"]) expect(kiroBusyTurnTakesInput(fx(n)), n).toBe(false);
    expect(kiroBusyTurnTakesInput(at("kiro-2.34.0-tui-d5", "busy-steer"))).toBe(false);
  });
  it("kiro's own row of the turn is enough when the user's row has scrolled away; a `!` with a tray above it is still one", () => {
    const noUserRow = at("kiro-steer-1405", "2.27.1-tui-steer-pending").replace(/^ {2}› .*$/gm, "");
    expect(noUserRow).toContain("• Shell sleep 20");
    expect(kiroBusyTurnTakesInput(noUserRow)).toBe(true);
    const spinnerOnly = at("kiro-2.34.0-busy-insert-2676", "tui-busy-steer").replace(/^ {2}› .*$/gm, "");
    expect(spinnerOnly).toMatch(/^\S Thinking\.\.\. \(esc to cancel\)$/m);
    expect(kiroBusyTurnTakesInput(spinnerOnly)).toBe(true);                                   // kiro's spinner row
    const bangWithTray = fx("tui-bang-running").replace(/^• Running\.\.\.$/m, "• Running...\n ◇ 1 message queued · ctrl+x expand");
    expect(kiroBusyTurnTakesInput(bangWithTray)).toBe(false);
    expect(kiroTakeoverActive(bangWithTray, "tui")).toBe(true);
  });
});

const COMPAT: KiroCliCompatibility = {
  version: "kiro-cli 2.34.0", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
  agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true, supportsInstanceAgent: false, source: "version",
};
const roots: string[] = [];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { AGEND_HOME: process.env.AGEND_HOME, KIRO_HOME: process.env.KIRO_HOME };
  const home = mkdtempSync(join(tmpdir(), "agend-2682-home-")); roots.push(home);
  process.env.AGEND_HOME = join(home, "agend");
  process.env.KIRO_HOME = join(home, "kiro");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

function launched(root: string, kiroUi: "tui" | "legacy", skipPermissions = true): KiroBackend {
  const instanceDir = join(root, "instances", "worker");
  mkdirSync(join(root, "work"), { recursive: true });
  const b = new KiroBackend(instanceDir, COMPAT);
  b.buildCommand({ workingDirectory: join(root, "work"), instanceDir, instanceName: "worker", mcpServers: {}, kiroUi, skipPermissions } as any);
  return b;
}

describe("#2685 review: layouts that wrap", () => {
  const wrapFooter = (pane: string) => pane.replace(/^ Trust All Tools active, confirmations are off · \/quit to exit$/m,
    " Trust All Tools active, confirmations are off\n · /quit to exit");
  it("a footer note wrapped onto two rows is passed over: a running `!` is still one, an agent turn still the agent's", () => {
    const bang = wrapFooter(fx("tui-bang-running"));
    expect(bang).toContain(" · /quit to exit\n");
    expect(kiroBusyTurnTakesInput(bang)).toBe(false);
    expect(kiroTakeoverActive(bang, "tui")).toBe(true);
    const agent = wrapFooter(at("kiro-2.34.0-busy-insert-2676", "tui-busy-steer"));
    expect(agent).toContain(" · /quit to exit\n");
    expect(kiroBusyTurnTakesInput(agent)).toBe(true);
    expect(kiroTakeoverActive(agent, "tui")).toBe(false);
  });
  it("no footer divider within reach of the composer is unknown — never a walk from an arbitrary row (r2)", () => {
    // a `!cat` just above, an older agent bullet further up, no divider in the 8 rows over the composer
    const pane = ["• an older answer", "  › !cat", ...Array.from({ length: 9 }, (_, i) => `  output ${i}`),
      "›  Kiro is working · 3s · Type to steer · Ctrl+S to queue"].join("\n");
    expect(kiroBusyTurnTakesInput(pane)).toBe(false);
    expect(kiroBusyTurnTakesInput(pane.replace("  › !cat", "  › hello"))).toBe(false);          // unknown either way
  });

  it("dividers and footer rows are never evidence of the agent's turn: only output up to the top stays unknown", () => {
    const onlyChrome = "─".repeat(40) + "\n  some output\n" + "─".repeat(40) + "\n Trust All Tools active\n" + "─".repeat(40)
      + "\nMock Model\n~/work\n›  Kiro is working · 3s · Type to steer · Ctrl+S to queue\n";
    expect(kiroBusyTurnTakesInput(onlyChrome)).toBe(false);
    expect(kiroTakeoverActive(onlyChrome, "tui")).toBe(false);
  });
  it("a whole known placeholder wrapped onto two rows reads as itself; an unknown, goal or tray one stays unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2682-")); roots.push(root);
    const tui = launched(root, "tui");
    const idle = fx("tui-idle-after-transcript");
    const row = "›  ask a question or describe a task ↵";
    expect(idle).toContain(row);
    const with_ = (r: string) => idle.replace(row, r);
    expect(tui.idleComposerReady(with_("›  ask a question or describe a task ↵ · exit plan mode: shift+tab"))).toBe(true);   // the control
    expect(tui.idleComposerReady(with_("›  ask a question or describe a task ↵ · exit plan mode:\n  shift+tab"))).toBe(true);
    expect(tui.idleComposerReady(with_("›  ask a question or describe a\n  task ↵"))).toBe(true);
    expect(tui.readSteerComposer(with_("›  Kiro is working · 3s · Type to steer ·\n  Ctrl+S to queue"))).toBe("steer");
    for (const r of ["›  ask a question or describe a task ↵ · exit plan mode:\n  something else", "›  Goal Paused: tidy up\n  the docs",
      "›  Editing queued message 1\n  of 2", "›  Kiro is working · 3s\n  · Type to steer"]) expect(tui.idleComposerReady(with_(r)), r).toBe(false);
    expect(tui.readSteerComposer(with_("› a draft that\n  wraps"))).toBe("text");                                          // typed text
  });
});

describe("the backend's hold and its idle input gate", () => {
  it("the takeover hold is the last runtime dialog: holds deliveries, blocks input, never keyed; read for this launch's engine", () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2682-")); roots.push(root);
    const tui = launched(root, "tui").getRuntimeDialogs();
    const hold = tui[tui.length - 1]!;
    expect([hold.keys, hold.blocksDelivery, hold.holdOnly, hold.inputBlocked]).toEqual([[], true, true, true]);
    expect(hold.description).toContain("in use by another program");
    expect(hold.isActive!(fx("tui-editor-vi"))).toBe(true);
    expect(hold.isActive!(fx("tui-idle-after-transcript"))).toBe(false);
    // the focused panel's other header: the agent is waiting on an answer typed into Neovim
    const waiting = fx("tui-kvim-focused").replace(/Neovim · focused · Ctrl\+\\ to chat · :q to close/, "Neovim · the agent is waiting on you: Ctrl+\\ to answer");
    expect(waiting).toContain("the agent is waiting on you");
    expect(hold.isActive!(waiting)).toBe(true);
    const legacy = launched(root, "legacy").getRuntimeDialogs();
    expect(legacy[legacy.length - 1]!.isActive!(fx("legacy-bang-running"))).toBe(true);
    expect(legacy[legacy.length - 1]!.isActive!(fx("legacy-idle"))).toBe(false);
  });

  it("an idle delivery needs kiro's own input row: tui/V3 composer idle or a draft; legacy's prompt row at the bottom, not running `!`", () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2682-")); roots.push(root);
    const tui = launched(root, "tui");
    for (const n of ["tui-idle-after-transcript", "v3-idle-after-editor", "tui-fullscreen", "tui-kvim-unfocused-paste-in-composer"]) expect(tui.idleComposerReady(fx(n)), n).toBe(true);
    for (const n of ["tui-editor-vi", "tui-bang-less", "tui-bang-running", "tui-transcript-more"]) expect(tui.idleComposerReady(fx(n)), n).toBe(false);
    expect(tui.idleComposerReady("")).toBe(false);                                   // a blank frame
    expect(tui.idleComposerReady(at("kiro-reply-guard", "tui-busy"))).toBe(false);
    for (const [skip, idle] of [[true, "legacy-idle"], [false, "legacy-notrust-idle"]] as const) {
      const legacy = launched(root, "legacy", skip);
      expect(legacy.idleComposerReady(fx(idle)), idle).toBe(true);
      expect(legacy.idleComposerReady(fx("legacy-bang-done-typeahead-stranded"))).toBe(true);   // a draft on the prompt
      for (const n of ["legacy-editor-vi", "legacy-bang-running", "legacy-notrust-bang-running", "legacy-bang-paste-went-to-command"]) expect(legacy.idleComposerReady(fx(n)), n).toBe(false);
    }
  });
});

// ── the daemon ─────────────────────────────────────────────────────────────────────────────────────────────────────

function daemonOn(root: string, backend: KiroBackend, pane: () => string) {
  const instanceDir = join(root, "instances", "worker");
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: "kiro",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, backend as any,
  { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => true, waitUntilIdle: vi.fn(async () => true) } as any, logger);
  const tmux = {
    capturePane: vi.fn(async () => pane()),
    pasteBuffer: vi.fn(async () => true), sendSpecialKey: vi.fn(async () => true),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  vi.spyOn(daemon, "isPaneIdleForDelivery").mockReturnValue(true);
  vi.spyOn(daemon, "probeInputTransient").mockResolvedValue({ state: "clear" });
  vi.spyOn(daemon, "needsStartupInputProof").mockReturnValue(false);
  return { daemon, tmux };
}

describe("the delivery gate (Daemon.paneReadinessForDelivery) on a quiet pane", () => {
  it("a recognised takeover is the hold (a dialog), on every engine", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2682-")); roots.push(root);
    for (const [ui, n] of [["tui", "tui-editor-vi"], ["tui", "tui-transcript-less"], ["tui", "tui-kvim-focused"], ["tui", "tui-bang-running"],
      ["legacy", "legacy-reply-vi"], ["legacy", "legacy-bang-running"]] as const) {
      const { daemon } = daemonOn(root, launched(root, ui), () => fx(n));
      const r = await daemon.paneReadinessForDelivery("@worker");
      expect(r, n).toBe("dialog");
    }
  });
  it("a screen without kiro's input row that nothing names is not ready either (fail closed), on tui and on legacy without trust-all", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2682-")); roots.push(root);
    for (const [ui, skip, pane] of [["tui", true, fx("tui-bang-less")], ["tui", true, ""], ["tui", true, "some program\nits own screen"],
      ["legacy", false, "some program\nits own screen"], ["legacy", false, fx("legacy-bang-paste-went-to-command")]] as const) {
      const { daemon } = daemonOn(root, launched(root, ui, skip), () => pane);
      expect(await daemon.paneReadinessForDelivery("@worker"), `${ui} ${pane.slice(0, 20)}`).toBe("busy");
    }
  });
  it("…while kiro's idle input row is ready — the control — and, when the program exits, deliveries go on", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2682-")); roots.push(root);
    let pane = fx("tui-editor-vi");
    const { daemon } = daemonOn(root, launched(root, "tui"), () => pane);
    expect(await daemon.paneReadinessForDelivery("@worker")).toBe("dialog");
    pane = fx("tui-idle-after-transcript");
    expect(await daemon.paneReadinessForDelivery("@worker")).toBe("ready");
    for (const [skip, n] of [[true, "legacy-idle"], [false, "legacy-notrust-idle"]] as const) {
      const { daemon: d } = daemonOn(root, launched(root, "legacy", skip), () => fx(n));
      expect(await d.paneReadinessForDelivery("@worker"), n).toBe("ready");
    }
  });
});

describe("the busy insert (#2676) never types into a `!` command", () => {
  it("a busy composer whose turn is a `!` command is not admitted; the agent's turn is (the control)", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2682-")); roots.push(root);
    let pane = fx("tui-bang-running");
    const { daemon } = daemonOn(root, launched(root, "tui"), () => pane);
    expect(await daemon.steerComposerAdmits(false, false)).toBe(false);
    expect(await daemon.steerComposerAdmits(false, true)).toBe(false);
    pane = at("kiro-2.34.0-busy-insert-2676", "tui-busy-steer");
    expect(await daemon.steerComposerAdmits(false, false)).toBe(true);
  });

  it("…and the last capture before the paste refuses it too (the busy-input reading on the baseline)", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2682-")); roots.push(root);
    const { daemon } = daemonOn(root, launched(root, "tui"), () => fx("tui-bang-running"));
    const sig = daemon.submissionSignature("hello", "id-1", false);
    const look = await daemon.capturePaneEvidence(sig);
    expect([look.steerComposer, look.busyInputReachesTurn]).toEqual(["steer", false]);
    const { daemon: d2 } = daemonOn(root, launched(root, "tui"), () => at("kiro-2.34.0-busy-insert-2676", "tui-busy-steer"));
    expect((await d2.capturePaneEvidence(sig)).busyInputReachesTurn).toBe(true);
  });

  it("a `!` command started after the gate and the pre-write re-check: the last capture refuses the paste", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "agend-2682-")); roots.push(root);
    let captures = 0;
    // gate: dialog probe (1), composer (2); under the lock: dialog probe (3), composer (4); then the last capture (5…)
    const { daemon, tmux } = daemonOn(root, launched(root, "tui"),
      () => (++captures <= 4 ? at("kiro-2.34.0-busy-insert-2676", "tui-busy-steer") : fx("tui-bang-running").replace(/^• Running\.\.\.$/m, "")));
    const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
    daemon.setDeliveryOutboxPort(outbox);
    vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
    vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
    vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
    vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(false);
    const dialog = vi.spyOn(daemon, "probeBlockingDialog");
    daemon.pushChannelMessage("hello", { user: "u", user_id: "1", message_id: "m-2682b", chat_id: "", thread_id: "", ts: new Date().toISOString() });
    await vi.runAllTimersAsync();
    expect(captures).toBeGreaterThanOrEqual(5);
    expect(dialog).toHaveBeenCalled();
    expect(tmux.pasteBuffer).not.toHaveBeenCalled();
    expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
    outbox.close();
  });

  it("a whole ordinary delivery to a busy pane running `!`: never pasted, it waits for the idle prompt", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "agend-2682-")); roots.push(root);
    const backend = launched(root, "tui");
    expect(backend.supportsSteer()).toBe(true);                                       // 2.34.0 tui: the busy insert's launch
    const { daemon, tmux } = daemonOn(root, backend, () => fx("tui-bang-running"));
    const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
    daemon.setDeliveryOutboxPort(outbox);
    const row = outbox.admit({
      operationId: "op", sourceKey: "s:op:w:fleet_inbound", sourceInstance: "source", sourceDaemonBootId: "sb",
      targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "hello", meta: {} },
    }).delivery;
    const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
    vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
    vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
    vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
    const waitIdle = vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(false);
    daemon.pushChannelMessage("hello", {
      delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
      user: "instance:source", user_id: "instance:source", message_id: "m-2682", chat_id: "", thread_id: "", ts: new Date().toISOString(),
    });
    await vi.runAllTimersAsync();
    expect(waitIdle).toHaveBeenCalled();
    expect(tmux.pasteBuffer).not.toHaveBeenCalled();
    expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
    outbox.close();
  });
});
