/**
 * #2676: an ordinary message (not a steer) to a busy kiro TUI goes into the busy composer, the way claude-code and
 * codex take one into their queues — on a launch whose busy composer AgEnD drives (KIRO_STEER_VERIFIED), by the steer
 * path's own gates and proof (#1405): the composer reads empty "steer" or "queue" on the gate, the pre-write re-check
 * and the last capture; the box holds this paste before the one Enter (its first line, or a collapsed paste's line
 * count) and is the empty placeholder again after it. No second Enter, no Ctrl+S, never re-pasted. The legacy UI drops
 * an Enter typed during a turn (tests/kiro-delivery-enter-drop.test.ts): it keeps waiting for the idle prompt.
 *
 * Real kiro panes: tests/fixtures/kiro-2.34.0-busy-insert-2676 (2.34.0 TUI on its mock agent, offline). The delivery
 * tests run a real Daemon, DeliveryOutbox and KiroBackend (production buildCommand) on a stub tmux.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { KiroBackend, readKiroCollapsedPasteLines, readKiroComposerText, readKiroSteerComposer, type KiroCliCompatibility } from "../src/backend/kiro.js";

const FX = join(import.meta.dirname, "fixtures", "kiro-2.34.0-busy-insert-2676");
const fx = (name: string) => readFileSync(join(FX, `${name}.pane.txt`), "utf8");

describe("2.34.0's busy composer, read off real panes", () => {
  it("the empty busy composer in either mode; the tray after the Enter leaves it empty again", () => {
    expect(readKiroSteerComposer(fx("tui-busy-steer"))).toBe("steer");
    expect(readKiroSteerComposer(fx("tui-busy-queue"))).toBe("queue");
    for (const f of ["tui-steer-tray", "tui-multiline-tray", "tui-collapsed-tray", "tui-two-in-tray"]) expect(readKiroSteerComposer(fx(f)), f).toBe("steer");
    expect(readKiroSteerComposer(fx("tui-queue-tray"))).toBe("queue");
    expect(fx("tui-steer-tray")).toContain("◇ 1 message queued · ctrl+x expand");
    expect(fx("tui-two-in-tray")).toContain("◇ 2 messages queued · ctrl+x expand");
  });

  it("a paste in the box is typed text, its first line on the `›` row", () => {
    expect(readKiroComposerText(fx("tui-steer-in-box"))).toBe("[agend-delivery-id:11111111-2222-3333-4444-555555555555] hello from agend (steer mode)");
    expect(readKiroComposerText(fx("tui-queue-in-box"))).toBe("[agend-delivery-id:66666666-2222-3333-4444-555555555555] hello from agend (queue mode)");
    expect(readKiroComposerText(fx("tui-multiline-in-box"))).toBe("[agend-delivery-id:77777777-2222-3333-4444-555555555555]");
    // a first line wider than the box: its start, cut at a word, the rest on indented rows
    expect(readKiroComposerText(fx("tui-wrapped-first-line-in-box")))
      .toBe("[user:jeff via discord, id:123456789012345678] please look at the failing build on main and tell me which commit broke");
  });

  it("a long paste is a chip naming its lines (more than one) or its characters (one line: 1)", () => {
    const chip = (f: string) => readKiroCollapsedPasteLines(readKiroComposerText(fx(f))!);
    expect(readKiroSteerComposer(fx("tui-collapsed-lines-in-box"))).toBe("text");
    expect(chip("tui-collapsed-lines-in-box")).toBe(42);
    expect(chip("tui-collapsed-3-lines-in-box")).toBe(3);
    expect(chip("tui-collapsed-chars-in-box")).toBe(1);
    // typed text is never a chip, even text that names one after other words
    expect(readKiroCollapsedPasteLines("[agend-delivery-id:x] hello")).toBeNull();
    expect(readKiroCollapsedPasteLines("see 42 lines ▸   Press Tab to expand")).toBeNull();
    expect(readKiroCollapsedPasteLines("42 lines ▸")).toBe(42);
  });

  it("queue mode sends the tray as the next turn once, the marker on its user row", () => {
    const sent = fx("tui-queue-sent");
    expect(sent.match(/\[agend-delivery-id:66666666-2222-3333-4444-555555555555\]/g)).toHaveLength(1);
    expect(sent).toMatch(/^ {2}› \[agend-delivery-id:66666666/m);
    expect(sent).not.toContain("message queued");
  });
});

describe("is it this paste? (Daemon.steerPasteIsOurs on a kiro TUI backend)", () => {
  const ours = (pane: string, payload: string) => {
    const backend = new KiroBackend("/nonexistent", { version: "kiro-cli 2.34.0", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
      agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true, supportsInstanceAgent: false, source: "version" });
    (backend as any).activeUi = "tui";
    return (Daemon.prototype as any).steerPasteIsOurs.call({ backend }, pane, payload);
  };
  const WIDE = fx("tui-wrapped-first-line-in-box");
  const first = "[user:jeff via discord, id:123456789012345678] please look at the failing build on main and tell me which commit broke it, then check whether the windows installer change is related to the network timeout we saw yesterday afternoon";
  it("a first line wider than the box: its start, cut at a word, is this paste", () => {
    expect(ours(WIDE, `${first}\n(message_id: 1234 | chat: 999)`)).toBe(true);
  });
  it("…but not a payload the row only starts like, nor one cut inside a word", () => {
    expect(ours(WIDE, `${first.replace("broke it", "brokenness")}\n(m)`)).toBe(false);   // the row ends mid-word of this one
    expect(ours(WIDE, "[user:jeff via discord, id:123456789012345678] please look at the failing build on main and tell me which commit fixed it\n(m)")).toBe(false);
  });
  it("a collapsed chip is this paste only for exactly its line count, and never a one-line chars chip", () => {
    const lines = Array.from({ length: 42 }, (_, i) => `l${i}`).join("\n");
    expect(ours(fx("tui-collapsed-lines-in-box"), lines)).toBe(true);
    expect(ours(fx("tui-collapsed-lines-in-box"), `${lines}\nmore`)).toBe(false);
    expect(ours(fx("tui-collapsed-chars-in-box"), "x".repeat(657))).toBe(false);
  });
  it("…counted as kiro counts: tmux pastes LF as CR, so each CRLF is two breaks (12 CRLF lines are 23)", () => {
    const crlf = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\r\n");
    const chip = (n: number) => fx("tui-collapsed-lines-in-box").replace("42 lines", `${n} lines`);
    expect(ours(chip(23), crlf)).toBe(true);
    expect(ours(chip(12), crlf)).toBe(false);
  });
});

// ── delivery ───────────────────────────────────────────────────────────────────────────────────────────────────────

const BUSY = fx("tui-busy-steer");
const COMPOSER = "›  Kiro is working · 2s · Type to steer · Ctrl+S to queue";
const composer = (row: string) => BUSY.replace(COMPOSER, row);
const QUEUE = composer("›  Kiro is working · 2s · Type to queue · Ctrl+S to steer");
const DRAFT = composer("› a draft the user is typing");
let HOLDING = composer("›  (nothing pasted yet)");
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

/** Verified for the busy composer in KIRO_STEER_VERIFIED; the pane above is 2.34.0's, whose composer rows are the same. */
const COMPAT: KiroCliCompatibility = {
  version: "kiro-cli 2.27.1", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
  agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true, supportsInstanceAgent: false, source: "version",
};

const roots: string[] = [];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { AGEND_HOME: process.env.AGEND_HOME, KIRO_HOME: process.env.KIRO_HOME };
  const home = mkdtempSync(join(tmpdir(), "agend-2676-home-")); roots.push(home);
  process.env.AGEND_HOME = join(home, "agend");
  process.env.KIRO_HOME = join(home, "kiro");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** As 2.34.0 paints a paste (tui.js): over 10 lines or 500 characters a chip, else the first line on the `›` row. */
function painted(text: string): string {
  const t = text.replace(/\r\n?/g, "\n");
  const lines = t.split("\n");
  if (lines.length > 10 || t.length > 500) return composer(`›  ${lines.length > 1 ? `${lines.length} lines` : `${t.length} chars`} ▸   Press Tab to expand`);
  const shown = lines.filter(l => l.trim() !== "");
  // a row holds 116 characters; a longer line is word-wrapped onto indented rows (as the wrapped fixture shows)
  const wrap = (l: string): string[] => {
    if (l.length <= 116) return [l];
    const cut = l.lastIndexOf(" ", 116);
    return [l.slice(0, cut), ...wrap(l.slice(cut + 1))];
  };
  const rows = shown.flatMap(wrap);
  return composer([`› ${rows[0] ?? ""}`, ...rows.slice(1).map(l => `  ${l}`)].join("\n"));
}

interface Opts {
  kiroUi?: "tui" | "legacy";
  version?: string;
  content?: string;
  pane?: (s: { pasted: boolean; entered: boolean; captures: number }) => string;
  /** What the box shows once the paste is in (default: as kiro paints this payload). */
  holding?: (text: string) => string;
}

async function deliver(opts: Opts = {}) {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-2676-")); roots.push(root);
  const instanceDir = join(root, "instances", "worker");
  mkdirSync(join(root, "work"), { recursive: true });
  const backend = new KiroBackend(instanceDir, { ...COMPAT, version: opts.version ?? COMPAT.version });
  backend.buildCommand({ workingDirectory: join(root, "work"), instanceDir, instanceName: "worker", mcpServers: {}, kiroUi: opts.kiroUi ?? "tui" });
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: "kiro",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, backend as any,
  { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => false, waitUntilIdle: vi.fn(async () => true) } as any, logger);
  daemon.setDeliveryOutboxPort(outbox);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const content = opts.content ?? "hello";
  const row = outbox.admit({
    operationId: "op", sourceKey: "s:op:w:fleet_inbound", sourceInstance: "source", sourceDaemonBootId: "sb",
    targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content, meta: {} },
  }).delivery;
  const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
  const s = { pasted: false, entered: false, captures: 0 };
  const pane = opts.pane ?? (({ pasted, entered }) => (entered ? BUSY : pasted ? HOLDING : BUSY));
  const tmux = {
    capturePane: vi.fn(async () => { s.captures++; return pane(s); }),
    pasteBuffer: vi.fn(async (text: string) => { s.pasted = true; HOLDING = (opts.holding ?? painted)(text); return true; }),
    sendSpecialKey: vi.fn(async () => { s.entered = true; return true; }),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
  const waitIdle = vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(false);
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  const admits = vi.spyOn(daemon, "steerComposerAdmits");
  daemon.pushChannelMessage(content, {
    delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
    user: "instance:source", user_id: "instance:source", message_id: "message-2676", chat_id: "", thread_id: "", ts: new Date().toISOString(),
  });
  await vi.runAllTimersAsync();
  const db = (outbox as any).db;
  return {
    outbox, tmux, waitIdle,
    /** Each composer admission: [allowIdle, steerOnly, answer]. */
    admitted: await Promise.all(admits.mock.calls.map(async (args, i) => [args[0], args[1], await admits.mock.results[i]!.value])),
    delivery: outbox.get(row.deliveryId)!,
    attempt: db.prepare("SELECT * FROM delivery_attempts WHERE delivery_id=?").get(row.deliveryId),
  };
}

describe("an ordinary message to a busy kiro TUI on a verified launch", () => {
  it("steer mode: typed into the box, entered once, delivered when the box is empty again", async () => {
    const r = await deliver();
    expect(r.waitIdle).not.toHaveBeenCalled();
    expect(r.admitted.map(a => a.slice(0, 2))).toEqual([[false, false], [true, false]]);   // gate, pre-write: queue allowed
    expect(r.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(r.tmux.sendSpecialKey).toHaveBeenCalledOnce();                  // no defensive second Enter, no Ctrl+S
    expect(r.tmux.sendSpecialKey.mock.calls.flat()).not.toContain("C-s");
    expect(r.delivery.state).toBe("delivered");
    expect(r.attempt.submission_mode).toBe("native_queue_handoff");
    expect(r.attempt.evidence).toBe("composer-handoff-accepted; composer emptied (steer)");
    r.outbox.close();
  });

  it("queue mode (the user's choice): typed in too — held for the turn's end — and never toggled", async () => {
    const r = await deliver({ pane: ({ pasted, entered }) => (entered ? QUEUE : pasted ? HOLDING : QUEUE) });
    expect(r.waitIdle).not.toHaveBeenCalled();
    expect(r.delivery.state).toBe("delivered");
    expect(r.attempt.evidence).toBe("composer-handoff-accepted; composer emptied (queue)");
    expect(r.tmux.sendSpecialKey.mock.calls.flat()).not.toContain("C-s");
    r.outbox.close();
  });

  it("a long message collapses to a chip: delivered when the chip names exactly its line count", async () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const r = await deliver({ content });
    const pasted = r.tmux.pasteBuffer.mock.calls[0]![0] as string;
    expect(HOLDING).toContain(`›  ${pasted.split("\n").length} lines ▸`);
    expect(r.delivery.state).toBe("delivered");
    expect(r.tmux.sendSpecialKey).toHaveBeenCalledOnce();
    r.outbox.close();
  });

  it("…a chip naming another count is not this paste: no Enter, not delivered", async () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const r = await deliver({ content, holding: (text) => composer(`›  ${text.split("\n").length + 1} lines ▸   Press Tab to expand`) });
    expect(r.tmux.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.delivery.state).not.toBe("delivered");
    expect(r.attempt.evidence).toBe("steer-paste:box-not-this-paste");
    r.outbox.close();
  });

  it("the box still holding the text after the Enter is uncertain — never pasted or entered again", async () => {
    const r = await deliver({ pane: ({ pasted }) => (pasted ? HOLDING : BUSY) });
    expect(r.delivery.state).toBe("uncertain");
    expect(r.attempt.evidence).toBe("steer-proof:composer-not-emptied");
    expect(r.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(r.tmux.sendSpecialKey).toHaveBeenCalledOnce();
    r.outbox.close();
  });
});

describe("not typed into the busy box: it waits for the idle prompt, as before", () => {
  it("the legacy UI (it drops an Enter typed during a turn)", async () => {
    const r = await deliver({ kiroUi: "legacy" });
    expect(r.waitIdle).toHaveBeenCalled();
    expect(r.admitted).toEqual([]);
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    r.outbox.close();
  });

  it("a version whose busy composer is not verified", async () => {
    const r = await deliver({ version: "kiro-cli 2.31.0" });
    expect(r.waitIdle).toHaveBeenCalled();
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    r.outbox.close();
  });

  it("text already in the box (a draft)", async () => {
    const r = await deliver({ pane: () => DRAFT });
    expect(r.admitted).toEqual([[false, false, false]]);
    expect(r.waitIdle).toHaveBeenCalled();
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    r.outbox.close();
  });

  it("a draft arriving on the last capture before the paste: not written", async () => {
    const r = await deliver({ pane: ({ captures }) => (captures <= 2 ? BUSY : DRAFT) });
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    expect(r.delivery.state).not.toBe("delivered");
    r.outbox.close();
  });

  it("one line long enough to collapse to a character count, which proves nothing (kiro widens tabs)", () => {
    const can = (text: string) => (Daemon.prototype as any).composerCanShowPaste.call({}, text);
    expect(can("x".repeat(500))).toBe(true);
    expect(can("x".repeat(501))).toBe(false);
    expect(can(`${"x".repeat(600)}\nsecond line`)).toBe(true);                // a line count proves it
    expect(can(`${"x".repeat(600)}\r\n`)).toBe(true);
    expect(can(`a${"\t".repeat(250)}`)).toBe(false);                            // 251 raw, 501 once kiro widens the tabs
    expect(can(`a${"\t".repeat(249)}`)).toBe(true);
  });
});
