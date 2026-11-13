/**
 * M-3098: Grok delivery proof said "could not confirm" for messages Grok had taken, and Needs you listed rows nobody
 * has to act on. Fixtures: tests/fixtures/grok-receipt-m3098 (README) — the incident's own five records (redacted),
 * and live grok 1.0.70 / 1.0.77 captures (real binaries, offline mock).
 *
 * Root cause: the pane proof looks for the envelope's trailing `message_id: …`; Grok echoes a user message as three
 * rows and a `…`, so a short envelope's footer never reaches the screen after Enter. Long pastes "passed" only because
 * the collapsed paste's preview card (still the draft) shows the footer — which would also prove a lost Enter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrokBackend, readGrokInputBox, readGrokTakenMarkers } from "../src/backend/grok.js";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox, NEEDS_ATTENTION_SQL } from "../src/delivery-outbox.js";
import { consumedWatches } from "../src/delivery-consumed-watch.js";
import { grokConsumedMarker } from "../src/grok-delivery-proof.js";

const FIX = join(import.meta.dirname, "fixtures", "grok-receipt-m3098");
const frame = (v: string, name: string) => readFileSync(join(FIX, v, `${name}.pane.txt`), "utf8");
const VERSIONS = ["1.0.70", "1.0.77"] as const;
const SHORT = "15e40695-0000-4000-8000-000000003098", LONG = "854874b4-0000-4000-8000-000000003098";
const lead = (id: string) => `[agend-delivery-id:${id}]`;
const SHORT_ID = "message_id:xmsg-1794587073675-m3098s", LONG_ID = "message_id:xmsg-1794588382724-m3098l";

const roots: string[] = [];
afterEach(() => {
  consumedWatches.stopAll();
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const log: any = { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } };
function temp() { const p = mkdtempSync(join(tmpdir(), "agend-m3098-")); roots.push(p); return p; }
function grokDaemon(): any {
  const p = temp(), dir = join(p, "instances", "worker"); mkdirSync(dir, { recursive: true });
  return new Daemon("worker", { working_directory: p, log_level: "error", backend: "grok" } as any, dir, false, new GrokBackend(dir) as any, undefined as any, log);
}
/** The delivery path's signature: the trusted message_id, plus (M-3098, #3870) the attempt's own lead marker. */
const sig = (value: string, id?: string) => ({ value, unique: true, ...(id ? { takenMarker: lead(id) } : {}) });

describe("root cause: Grok's echo is cut before the envelope's message_id (fail-first)", () => {
  it.each(VERSIONS)("%s: after Enter the 3-line envelope's echo shows its lead marker, never its message_id", v => {
    for (const name of ["11-short-after-0.2s", "15-short-after-8s"]) {
      const pane = frame(v, name);
      expect(pane.replace(/\s+/g, "")).not.toContain(SHORT_ID);               // the old signature has nothing to find
      expect(pane).toMatch(/^ {5}❯ \[agend-delivery-id:15e40695-0000-4000-8000-000000003098\]/m);
      expect(pane).toMatch(/…$/m);                                             // the echo is cut
      expect(readGrokInputBox(pane)).toEqual({ text: "", collapsedPastes: 0 });
    }
  });

  it.each(VERSIONS)("%s: message_id alone stays unproven (the incident); its taken lead marker proves it", v => {
    const d = grokDaemon(), baseline = d.paneEvidence(frame(v, "00-ready"), sig(SHORT_ID));
    for (const name of ["11-short-after-0.2s", "15-short-after-8s"]) {
      expect(d.judgeSubmission(frame(v, name), sig(SHORT_ID), baseline)).toBe("unproven");
      expect(d.judgeSubmission(frame(v, name), sig(SHORT_ID, SHORT), baseline)).toBe("submitted");
      expect(d.judgeSubmission(frame(v, name), sig(SHORT_ID, SHORT), null)).toBe("submitted");
    }
  });

  it("the incident's five deliveries are each in the session record, leading with their own marker", () => {
    const text = readFileSync(join(FIX, "incident", "updates.jsonl"), "utf8");
    const attempts = JSON.parse(readFileSync(join(FIX, "incident", "attempts.json"), "utf8")).grok as Array<{ delivery: string; evidence: string; recordedEpoch: number; enter: string }>;
    expect(attempts).toHaveLength(5);
    for (const a of attempts) {
      expect(a.evidence).toBe("post-submit-proof:unproven");
      expect(grokConsumedMarker(text, "01a05ade-0000-4000-8000-000000003098", lead(a.delivery))).toBe("user");
      // Recorded within a second of Enter: taken at once, not held for a later turn.
      const enter = Date.parse(`2026-11-13T${a.enter}`) / 1000;
      expect(Math.abs(a.recordedEpoch - enter)).toBeLessThanOrEqual(1);
    }
    expect(grokConsumedMarker(text, "01a05ade-0000-4000-8000-000000003098", lead("00000000-0000-4000-8000-000000000000"))).toBeNull();
  });
});

describe("the delivery path, end to end on the recorded frames", () => {
  const ENVELOPE = (id: string) => `${lead(id)}\n[from:fixture-sender] please stall: an inert three-line fleet message for the M-3098 fixture. Its middle line is long enough to wrap across the echo row, as the incident messages did on the live pane.\n(message_id: xmsg-1794587073675-m3098s | correlation_id: cid-m3098-short)`;
  async function write(v: string, after: string, deliveryId = SHORT) {
    const d = grokDaemon();
    const begin = vi.fn(() => "begun"), complete = vi.fn();
    d.setDeliveryOutboxPort({ begin, complete, markEnterStarted: () => true, markConsumed: vi.fn() } as any);
    const state = { pane: frame(v, "00-ready") };
    const sent: string[] = [];
    d.tmux = {
      getWindowId: () => "@w", capturePane: vi.fn(async () => state.pane), getPaneInputMode: async () => "raw", isWindowAlive: async () => true,
      pasteBuffer: vi.fn(async () => { state.pane = frame(v, "10-short-draft"); return true; }),
      sendSpecialKey: vi.fn(async (key: string) => { sent.push(key); state.pane = frame(v, after); return true; }),
      getLastPasteError: () => null, isLastPasteFailureRecoverable: () => false, getLastSendSpecialKeyError: () => null,
    };
    d.controlClient = { isIdle: () => true, waitUntilIdle: async () => true, hasOutputSince: () => true, getLastOutputAt: () => 0, getObservationResetAt: () => 0 };
    vi.spyOn(d, "wake").mockResolvedValue(undefined);
    vi.spyOn(d, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
    vi.spyOn(d, "waitForInputTransientToClear").mockResolvedValue(true);
    vi.spyOn(d, "paneReadinessForDelivery").mockResolvedValue("ready");
    vi.spyOn(d, "waitForPaneReadyForDelivery").mockResolvedValue(false);
    vi.spyOn(d, "hasPositiveDeliveryInput").mockResolvedValue(true);
    vi.spyOn(d, "markTurnStarted").mockImplementation(() => {});
    const verdict: any = { reached: false };
    const ok = await d.writeMessageToPane(ENVELOPE(deliveryId), "@w", false, undefined, "xmsg-1794587073675-m3098s", verdict,
      { deliveryId, attemptNo: 1 }, false, () => true);
    return { ok, verdict, sent, begin };
  }
  it.each(VERSIONS)("%s: the incident's 3-line envelope is proven by its echo — one Enter, no strand, no uncertain", async v => {
    const r = await write(v, "11-short-after-0.2s");
    expect(r.begin).toHaveBeenCalledWith(SHORT, expect.any(String), 1, expect.objectContaining({ submissionMode: "idle_submit" }));
    expect(r.ok).toBe(true);
    expect(r.sent).toEqual(["Enter"]);
    expect(r.verdict.phase).toBeUndefined();
  });
  it.each(VERSIONS)("%s: control — an echo that is another delivery's is not this one's proof", async v => {
    const r = await write(v, "11-short-after-0.2s", "f0f0f0f0-0000-4000-8000-000000003098");
    expect(r.ok).toBe(false);
    expect(r.verdict.phase).toBe("post-submit-proof");
  });
});

describe("a collapsed paste's preview card is the draft, never an echo (the hidden false positive)", () => {
  it.each(VERSIONS)("%s: the card above `[Pasted: 20 lines]` is read as input, message_id and all", v => {
    const box = readGrokInputBox(frame(v, "20-long-draft"))!;
    expect(box.collapsedPastes).toBe(1);
    expect(box.text.split("\n")[0]).toBe("[Pasted: 20 lines]");
    expect(box.text.replace(/\s+/g, "")).toContain(LONG_ID);
    expect(box.text).toContain(lead(LONG));
  });

  it.each(VERSIONS)("%s: a paste whose Enter never happened is stranded, with or without a baseline", v => {
    const d = grokDaemon(), never = frame(v, "32-long-noenter-8.6s");
    expect(never.replace(/\s+/g, "")).toContain(LONG_ID);                    // the id IS on screen…
    const baseline = d.paneEvidence(frame(v, "00-ready"), sig(LONG_ID));
    expect(d.judgeSubmission(never, sig(LONG_ID, LONG), baseline)).toBe("stranded");   // …but only in the draft
    expect(d.judgeSubmission(never, sig(LONG_ID, LONG), null)).toBe("stranded");
    // The short draft, never sent, holds its marker in the box: stranded too, not taken.
    const short = frame(v, "35-short-noenter-8.6s");
    expect(d.judgeSubmission(short, sig("message_id:xmsg-1794587073675-m3098s", "b6b6b6b6-0000-4000-8000-000000003098"), baseline)).toBe("stranded");
  });

  it.each(VERSIONS)("%s: after Enter the card is gone and the echo's lead marker proves the long paste", v => {
    const d = grokDaemon(), after = frame(v, "21-long-after-0.2s");
    expect(after.replace(/\s+/g, "")).not.toContain(LONG_ID);
    const baseline = d.paneEvidence(frame(v, "00-ready"), sig(LONG_ID));
    expect(d.judgeSubmission(after, sig(LONG_ID, LONG), baseline)).toBe("submitted");
    expect(d.judgeSubmission(after, sig(LONG_ID), baseline)).toBe("unproven");
  });
});

describe("taken while busy: Grok's own queue", () => {
  it.each(VERSIONS)("%s: `#N <marker> (+K lines)` rows are taken markers; the box stays empty", v => {
    const pane = frame(v, "43-busy-short-queued");
    expect(readGrokTakenMarkers(pane)).toEqual(expect.arrayContaining([
      lead("d8d8d8d8-0000-4000-8000-000000003098"), lead("e9e9e9e9-0000-4000-8000-000000003098")]));
    expect(readGrokInputBox(pane)?.text).toBe("");
    const d = grokDaemon(), baseline = d.paneEvidence(frame(v, "00-ready"), sig("message_id:x"));
    expect(d.judgeSubmission(frame(v, "42-busy-long-queued"), sig("message_id:x", "d8d8d8d8-0000-4000-8000-000000003098"), baseline)).toBe("submitted");
  });

  it.each(VERSIONS)("%s: the queued messages are recorded when Grok takes them (late watch evidence)", v => {
    const text = readFileSync(join(FIX, v, "updates.jsonl"), "utf8");
    const sid = `4b388fc1-2601-4552-bd03-4a6e2edcf8e${v === "1.0.70" ? 1 : 2}`;
    for (const id of [SHORT, LONG, "d8d8d8d8-0000-4000-8000-000000003098", "e9e9e9e9-0000-4000-8000-000000003098"]) {
      expect(grokConsumedMarker(text, sid, lead(id))).toBe("user");
    }
  });
});

describe("what a taken marker can never prove", () => {
  it("another delivery's marker on screen proves nothing for this one", () => {
    const d = grokDaemon(), pane = frame("1.0.77", "15-short-after-8s");
    const baseline = d.paneEvidence(frame("1.0.77", "00-ready"), sig("message_id:other"));
    expect(d.judgeSubmission(pane, sig("message_id:other", "aaaaaaaa-0000-4000-8000-000000003098"), baseline)).toBe("unproven");
  });

  it("no readable box: nothing above it can be placed (no markers, no proof)", () => {
    const rows = frame("1.0.77", "15-short-after-8s").split("\n").filter(r => !/[╭╰]/.test(r)).join("\n");
    expect(readGrokTakenMarkers(rows)).toEqual([]);
    const d = grokDaemon();
    expect(d.judgeSubmission(rows, sig(SHORT_ID, SHORT), null)).not.toBe("submitted");
  });

  it("the marker in the box, in the preview card, or quoted mid-row is not taken", () => {
    for (const v of VERSIONS) {
      expect(readGrokTakenMarkers(frame(v, "10-short-draft"))).toEqual([]);
      expect(readGrokTakenMarkers(frame(v, "32-long-noenter-8.6s"))).not.toContain(lead("a5a5a5a5-0000-4000-8000-000000003098"));
    }
    for (const row of [`     the agent wrote ${lead(SHORT)} in its reply`, `     step #2 ${lead(SHORT)} came in`, `     the prompt was ❯ ${lead(SHORT)}`, `❯ ${lead(SHORT)}`]) {
      const quoted = frame("1.0.77", "00-ready").replace(/\n(\s*╭)/, `\n${row}\n$1`);
      expect(readGrokTakenMarkers(quoted)).toEqual([]);
    }
  });

  it("an echo of an untrusted shape (a quoted message_id line) is not a marker", () => {
    const pane = frame("1.0.77", "00-ready").replace(/\n(\s*╭)/, `\n     ❯ [message_id:${SHORT}]\n$1`);
    expect(readGrokTakenMarkers(pane)).toEqual([]);
  });
});

describe("late proof clears an uncertain idle submission (Claude/Codex join Grok)", () => {
  const checkpoint = { backend: "claude-code", path: "/owned/transcript.jsonl", offset: 0 };
  function claudeDaemon(): any {
    const p = temp(), dir = join(p, "instances", "worker"); mkdirSync(dir, { recursive: true });
    const d: any = new Daemon("worker", { working_directory: p, log_level: "error", backend: "claude-code" } as any, dir, false, undefined as any, undefined as any, log);
    d.setDeliveryOutboxPort({ complete: vi.fn(), markConsumed: vi.fn() });
    return d;
  }
  it("an uncertain claude-code idle_submit with a checkpoint is watched", () => {
    const d = claudeDaemon(), start = vi.spyOn(consumedWatches, "start").mockReturnValue(true);
    d.finishDurableDelivery({ deliveryId: "d-3098", attemptNo: 1 }, "uncertain", "post-submit-proof:unproven", { submissionMode: "idle_submit", transcriptCheckpoint: checkpoint });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: "d-3098", backend: "claude-code", path: checkpoint.path, offset: 0 }));
  });
  it("a delivered idle_submit is not watched (no upgrade to wait for); a failed one never", () => {
    const d = claudeDaemon(), start = vi.spyOn(consumedWatches, "start").mockReturnValue(true);
    d.finishDurableDelivery({ deliveryId: "d-ok", attemptNo: 1 }, "delivered", "positive submission proof", { submissionMode: "idle_submit", transcriptCheckpoint: checkpoint });
    d.finishDurableDelivery({ deliveryId: "d-bad", attemptNo: 1 }, "failed", "stranded", { submissionMode: "idle_submit", transcriptCheckpoint: checkpoint });
    expect(start).not.toHaveBeenCalled();
  });
  it("steer keeps its watch whatever the outcome (unchanged)", () => {
    const d = claudeDaemon(), start = vi.spyOn(consumedWatches, "start").mockReturnValue(true);
    d.finishDurableDelivery({ deliveryId: "d-steer", attemptNo: 1 }, "delivered", "steer-accepted", { submissionMode: "steer", transcriptCheckpoint: checkpoint });
    expect(start).toHaveBeenCalledOnce();
  });
});

describe("Needs you lists only delivery problems a person must act on", () => {
  function box() {
    const p = temp(), path = join(p, "outbox.db");
    new DeliveryOutbox(path).close();
    const db = new Database(path);
    const insert = (id: string, kind: string, source: string, state: string, sourceKey = `src-${id}`) =>
      db.prepare(`INSERT INTO deliveries (delivery_id, operation_id, source_key, source_instance, source_daemon_boot_id, target_instance,
        kind, payload_json, state, attempt_no, created_seq, created_at, updated_at, accepted_at, finished_at)
        VALUES (?, ?, ?, ?, 'b', 't', ?, '{}', ?, 1, ?, ?, ?, ?, ?)`)
        .run(id, `op-${id}`, sourceKey, source, kind, state, Math.floor(Math.random() * 1e9), ...Array(4).fill("2026-11-13T16:00:00.000Z"));
    return { path, db, insert };
  }
  it("leaves out AgEnD's own notices and broadcasts; agent and human messages stay, failed or unconfirmed", () => {
    const { path, db, insert } = box();
    insert("reply-reminder", "reply_obligation_notice", "agend-system", "uncertain");
    insert("sys-notice", "system_notice", "agend-system", "failed");
    insert("outcome", "delivery_outcome_notice", "agend-system", "uncertain");
    insert("bcast", "broadcast", "leader", "uncertain");
    insert("bcast-failed", "broadcast", "leader", "failed");
    insert("fleet-uncertain", "fleet_inbound", "fable", "uncertain");
    insert("fleet-failed", "fleet_inbound", "fable", "failed");
    insert("steer", "steer", "leader", "uncertain");
    insert("raw", "raw_paste", "worker", "uncertain");
    db.close();
    const ob = new DeliveryOutbox(path);
    expect(ob.needsAttention("2026-11-13T00:00:00.000Z").map(d => d.deliveryId).sort())
      .toEqual(["fleet-failed", "fleet-uncertain", "raw", "steer"]);
    ob.close();
  });
  it("the plan stays a range on idx_delivery_attention", () => {
    const { db } = box();
    expect(db.prepare(`EXPLAIN QUERY PLAN ${NEEDS_ATTENTION_SQL}`).all("2026-01-01T00:00:00.000Z", 50).map((r: any) => r.detail))
      .toEqual(["SEARCH deliveries USING INDEX idx_delivery_attention (finished_at>?)"]);
    db.close();
  });
  it("an uncertain row whose later proof arrives leaves the list by itself", () => {
    const p = temp(), ob = new DeliveryOutbox(join(p, "outbox.db"), "manager");
    try {
      const row = ob.admit({ operationId: "op3098", sourceKey: "k3098", sourceInstance: "fable", sourceDaemonBootId: "sb", targetInstance: "worker",
        kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "x" } }).delivery;
      const claim = ob.claimNext("manager", () => "boot", new Set())!;
      expect(ob.begin(row.deliveryId, "boot", claim.attemptNo, { backend: "grok", backendVersion: null, windowId: "@w", transcriptPath: null, transcriptOffset: null, transcriptSessionId: null, submissionMode: "idle_submit" })).toBe("begun");
      ob.complete(row.deliveryId, "boot", claim.attemptNo, "uncertain", "post-submit-proof:unproven");
      const since = new Date(Date.now() - 3600_000).toISOString();
      expect(ob.needsAttention(since).map(d => d.deliveryId)).toEqual([row.deliveryId]);
      const states: string[] = []; ob.on("state", (e: any) => { if (e.deliveryId === row.deliveryId) states.push(e.state); });
      expect(ob.markConsumed(row.deliveryId, "boot", claim.attemptNo, "turn", "transcript-consumed:user-entry")).toBe("upgraded");
      expect(states).toEqual(["delivered"]);                       // the event Needs you recomputes on
      expect(ob.needsAttention(since)).toEqual([]);
    } finally { ob.close(); }
  });
});
