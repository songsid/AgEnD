/**
 * #3199: Grok Build's input box, read as a region, so a human receipt can prove
 * delivery the way Claude (#1200) and Codex (bottom-row ready) already can.
 *
 * Empty/busy/dialog panes are live 1.0.52–1.0.70 audit captures and watcher
 * fixtures. `06-after-cancel` is a live draft (`│ ❯ stall forever b`). Transcript
 * `     ❯ <text>` above the box is never input. finishHumanReceipt is unchanged:
 * output-edge / transcript-marker still cannot settle a receipt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { GrokBackend, readGrokInputBox } from "../src/backend/grok.js";
import { nativeHumanOrigin } from "../src/human-delivery-receipts.js";

const FIX = join(import.meta.dirname, "fixtures");
const AUDIT = join(FIX, "grok-1.0.70-audit");
const pane = (...parts: string[]) => readFileSync(join(...parts), "utf8");
const EMPTY = { text: "", collapsedPastes: 0 };

function grokBox(draft = "") {
  const innerWidth = 70;
  const prompt = draft ? ` ❯ ${draft}` : " ❯";
  if (prompt.length > innerWidth) throw new Error(`draft does not fit the box (${prompt.length} > ${innerWidth})`);
  const inner = prompt.padEnd(innerWidth, " ");
  const top = "╭" + "─".repeat(innerWidth) + "╮";
  const mid = "│" + inner + "│";
  const label = " grok-mock · always-approve ─";
  const bot = "╰" + "─".repeat(innerWidth - label.length) + label + "╯";
  return `  ${top}\n  ${mid}\n  ${bot}\n\n  Shift+Tab:mode  │  Ctrl+x:shortcuts\n`;
}

function withDraft(emptyPane: string, text: string): string {
  const replaced = emptyPane.replace(/^(\s*)│ ❯( *)│\s*$/m, (_, indent: string, pad: string) => {
    const old = " ❯" + pad;
    const next = (` ❯ ${text}`).padEnd(old.length, " ");
    if (next.length !== old.length) throw new Error(`draft ${JSON.stringify(text)} does not fit this fixture row`);
    return `${indent}│${next}│`;
  });
  if (replaced === emptyPane) throw new Error("empty boxed ❯ row not found");
  return replaced;
}

describe("readGrokInputBox on live grok captures", () => {
  it.each([
    ["1.0.70-80/02-ready", EMPTY],
    ["1.0.70-80/03-busy-a", EMPTY],
    ["1.0.70-80/04-done", EMPTY],
    ["1.0.70-80/11-new", EMPTY],
    ["1.0.70-80/10-compact", EMPTY],
    ["1.0.70-120/02-ready", EMPTY],
    ["1.0.70-120/32-mcp-call", EMPTY],
    ["1.0.70-dashboard/01-open", EMPTY],
    ["1.0.70-compact-120/60-compact-fail-a", EMPTY],
  ] as const)("%s is an empty boxed prompt", (step, box) => {
    expect(readGrokInputBox(pane(AUDIT, step + ".pane.txt"))).toEqual(box);
  });

  it("watcher idle and busy keep an empty boxed prompt under the transcript echo", () => {
    expect(readGrokInputBox(pane(FIX, "grok-watcher-idle.pane.txt"))).toEqual(EMPTY);
    expect(readGrokInputBox(pane(FIX, "grok-watcher-busy.pane.txt"))).toEqual(EMPTY);
    expect(pane(FIX, "grok-watcher-idle.pane.txt")).toMatch(/^\s+❯ finish the analysis/m);
    expect(readGrokInputBox(pane(FIX, "grok-watcher-idle.pane.txt"))!.text).toBe("");
  });

  it("06-after-cancel is a live draft still sitting in the boxed prompt", () => {
    expect(readGrokInputBox(pane(AUDIT, "1.0.70-80/06-after-cancel.pane.txt")))
      .toEqual({ text: "stall forever b", collapsedPastes: 0 });
    expect(readGrokInputBox(pane(AUDIT, "1.0.70-120/06-after-cancel.pane.txt")))
      .toEqual({ text: "stall forever b", collapsedPastes: 0 });
  });

  it("trust, weekly-limit and approval have no box", () => {
    expect(readGrokInputBox(pane(AUDIT, "1.0.70-80/01-trust.pane.txt"))).toBeNull();
    expect(readGrokInputBox(pane(AUDIT, "1.0.70-80/07-err-402.pane.txt"))).toBeNull();
    expect(readGrokInputBox(pane(AUDIT, "1.0.70-approval/20-approval.pane.txt"))).toBeNull();
    expect(readGrokInputBox(pane(FIX, "grok-weekly-limit-modal.pane.txt"))).toBeNull();
    expect(readGrokInputBox(pane(AUDIT, "1.0.70-120/51-quit-double.pane.txt"))).toBeNull();
  });

  it("every 1.0.70 audit composer pane has an empty box; dialogs do not", () => {
    for (const dir of ["1.0.70-80", "1.0.70-120", "1.0.67-80", "1.0.67-120"]) {
      for (const f of readdirSync(join(AUDIT, dir)).filter(name => name.endsWith(".pane.txt"))) {
        const box = readGrokInputBox(pane(AUDIT, dir, f));
        if (/01-trust|07-err-402|51-quit-double/.test(f)) expect(box, `${dir}/${f}`).toBeNull();
        else if (/06-after-cancel/.test(f)) expect(box, `${dir}/${f}`).toEqual({ text: "stall forever b", collapsedPastes: 0 });
        else expect(box, `${dir}/${f}`).toEqual(EMPTY);
      }
    }
  });

  it("a draft is the boxed ❯ row, never the transcript echo above it", () => {
    const ready = pane(AUDIT, "1.0.70-80/02-ready.pane.txt");
    const draft = withDraft(ready, "draft one two three");
    expect(readGrokInputBox(draft)).toEqual({ text: "draft one two three", collapsedPastes: 0 });
    const echoed = pane(AUDIT, "1.0.70-80/04-done.pane.txt");
    expect(echoed).toMatch(/^\s+❯ please stall a/m);
    expect(readGrokInputBox(withDraft(echoed, "still in the box"))).toEqual({ text: "still in the box", collapsedPastes: 0 });
  });

  it("is anchored to the bottom: a box-shaped block with more than the footer under it is not the live box", () => {
    const quoted = `${pane(AUDIT, "1.0.70-80/02-ready.pane.txt").trimEnd()}\n  one\n  two\n  three\n  four\n  five`;
    expect(readGrokInputBox(quoted)).toBeNull();
  });

  it("refuses a first inner row without the boxed ❯, and a ragged frame", () => {
    const ready = pane(AUDIT, "1.0.70-80/02-ready.pane.txt");
    expect(readGrokInputBox(ready.replace("│ ❯", "│ >"))).toBeNull();
    expect(readGrokInputBox(ready.replace("╭", "+"))).toBeNull();
  });

  it("the backend exposes it as readInputRow, and does not claim the prompt-row reader", () => {
    const backend = new GrokBackend("/nonexistent-3199");
    expect(backend.readInputRow(pane(AUDIT, "1.0.70-80/02-ready.pane.txt"))).toEqual(EMPTY);
    expect(backend.readInputRow(withDraft(pane(AUDIT, "1.0.70-80/02-ready.pane.txt"), "hello"))).toEqual({ text: "hello", collapsedPastes: 0 });
    expect((backend as { getBottomReadyPattern?: unknown }).getBottomReadyPattern).toBeUndefined();
  });
});

const roots: Array<{ root: string; outbox: DeliveryOutbox; daemon: any }> = [];
afterEach(() => {
  for (const h of roots.splice(0)) {
    h.daemon.fenceDeliveryWritesForStop();
    h.outbox.close();
    rmSync(h.root, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const log: any = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } };
const person = nativeHumanOrigin("discord", "bot-one", "42", "person", false, "900")!;

function grokHarness(behavior: "accepted" | "output" = "accepted") {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-human-3199-"));
  process.env.HOME = root;
  process.env.AGEND_HOME = root;
  const dir = join(root, "instances/leader");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "window-id"), "@private");
  const backend = new GrokBackend(dir);
  const daemon: any = new Daemon("leader", {
    backend: "grok", working_directory: root, log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { max_age_hours: 0, grace_period_ms: 600000 },
  } as any, dir, false, backend as any, undefined, log);
  const state = { pane: grokBox(""), wire: "", epoch: 0, freeze: false };
  const tmux = {
    getWindowId: () => "@private", capturePane: vi.fn(async () => state.pane), getPaneInputMode: async () => "raw",
    isWindowAlive: async () => true,
    pasteBuffer: vi.fn(async (wire: string) => {
      state.wire = wire;
      state.pane = grokBox(wire.split("\n")[0] ?? "");
      return true;
    }),
    sendSpecialKey: vi.fn(async () => {
      if (behavior === "accepted") {
        state.pane = `     ❯ ${state.wire.split("\n")[0]}                                      1:22 PM\n\n${grokBox("")}`;
      } else {
        state.pane = "unrelated output\n" + grokBox("");
      }
      return true;
    }),
    getLastPasteError: () => null, isLastPasteFailureRecoverable: () => false, getLastSendSpecialKeyError: () => null,
  };
  daemon.tmux = tmux;
  daemon.controlClient = {
    isIdle: () => true, waitUntilIdle: async () => true, hasOutputSince: () => behavior === "output",
    getLastOutputAt: () => 0, getObservationResetAt: () => 0,
  };
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("ready");
  vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(true);
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  vi.spyOn(daemon, "markTurnStarted").mockImplementation(() => {});
  const outbox = new DeliveryOutbox(join(root, "outbox.db"), "manager");
  const fm: any = Object.assign(Object.create(FleetManager.prototype), {
    managerBootId: "manager", deliveryOutbox: outbox, logger: log, shuttingDown: false,
    deliveryEpochs: new Map(), lastDeliveryAt: new Map(), ipcWaitTails: new Map(),
    lifecycle: { daemons: new Map([["leader", daemon]]), epochOf: () => state.epoch, isPaused: () => false },
    instanceIpcClients: new Map([["leader", { connected: true, send: vi.fn((p: any) => {
      daemon.pushChannelMessage(p.content, p.meta, undefined, p.delivery_epoch);
      return true;
    }) }]]),
  });
  roots.push({ root, outbox, daemon });
  return { root, dir, outbox, fm, daemon, state, tmux };
}

async function deliver(h: ReturnType<typeof grokHarness>, body = "Reset only resource A") {
  const payload = {
    type: "fleet_inbound", content: body,
    meta: { message_id: "900", chat_id: "room", user: "person", user_id: "42", source: "discord", adapter_id: "bot-one" },
  };
  await h.fm.deliverHumanToInstance("leader", payload, person, body);
  await vi.advanceTimersByTimeAsync(60000);
  const p = h.fm.instanceIpcClients.get("leader").send.mock.calls[0][0];
  return {
    payload: p,
    row: p.meta.human_receipt_id ? h.outbox.getHumanReceipt(p.meta.human_receipt_id)! : null,
  };
}

describe("Grok human receipts (#3199)", () => {
  it("unique-id-pane delivers when the boxed prompt is readable and the id is on screen", async () => {
    const h = grokHarness("accepted");
    const r = await deliver(h);
    expect(r.row?.state).toBe("delivered");
    expect(r.row?.proof_tag).toBe("unique-id-pane");
    expect(r.row?.proof_mode).toBe("idle_submit");
    expect(h.state.pane).toMatch(/^\s+❯ /m);
    expect(readGrokInputBox(h.state.pane)).toEqual(EMPTY);
    expect(h.outbox.queryStatusForInstance("leader", { messageId: r.row!.message_id }).items[0])
      .toMatchObject({ state: "delivered", proof_kind: "unique-id-pane", origin: person, consumed_at: null });
    expect(h.outbox.admit({
      operationId: "relay", sourceKey: "relay-3199", sourceInstance: "leader", sourceDaemonBootId: "boot",
      targetInstance: "worker", kind: "fleet_inbound", forwards: [r.row!.message_id],
      payload: { type: "fleet_inbound", content: "relay", meta: { message_id: "xmsg-3199-forward" } },
    }).delivery).toMatchObject({ kind: "fleet_inbound" });
  });

  it("a readerless Grok plus output-edge / transcript-marker stays uncertain (verification is not loosened)", async () => {
    const h = grokHarness("output");
    h.daemon.backend.readInputRow = undefined;
    const r = await deliver(h);
    expect(r.row?.state).toBe("uncertain");
    expect(r.row?.proof_tag).toBeNull();
    h.daemon.finishHumanReceipt(r.payload.meta, { reached: true, proof: "transcript-marker" });
    expect(h.outbox.getHumanReceipt(r.row!.receipt_id)?.state).toBe("uncertain");
    expect(() => h.outbox.admit({
      operationId: "relay", sourceKey: "relay", sourceInstance: "leader", sourceDaemonBootId: "boot",
      targetInstance: "worker", kind: "fleet_inbound", forwards: [r.row!.message_id],
      payload: { type: "fleet_inbound", content: "relay", meta: { forwards: JSON.stringify([r.row!.message_id]) } },
    })).toThrow(/Forwarded message verification is unavailable|verification/i);
  });
});
