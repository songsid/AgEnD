/**
 * #1201: the late "consumed" signal for a delivery the CLI took into its own queue (a steer; a native-queue hand-off).
 *
 * Captured live from Claude Code 2.1.293 (mock Anthropic API, private tmux; tests/fixtures/claude-2.1.293-steer-
 * consumed-*.transcript.jsonl): a queued message taken when the turn ends is `enqueue` → `dequeue` → a `user` entry
 * leading with its `[agend-delivery-id:…]` marker; one taken at a tool boundary, inside the running turn, is
 * `enqueue` → `remove` (reason `absorbed_mid_turn`) → an `attachment` of type `queued_command` whose prompt leads with
 * the marker — no user entry at all. Codex was not re-captured: it keeps its existing `response_item` user detection.
 *
 * Nothing here starts a CLI, a fleet or a tmux server; transcripts are scratch files.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { markerConsumed, transcriptDeltaDeliveryMarker, transcriptDeltaHasDeliveryMarker } from "../src/delivery-reconciliation.js";
import { CONSUMED_WATCH, ConsumedWatch, ConsumedWatchRegistry } from "../src/delivery-consumed-watch.js";

/** Holds the watcher's next `stat` or `open` until released — a read still pending — and records when it is entered. */
const fsHold = vi.hoisted(() => ({ stat: null as null | Promise<void>, open: null as null | Promise<void>, entered: [] as string[], opens: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const held = async (call: "stat" | "open") => {
    const wait = fsHold[call];
    if (!wait) return;
    fsHold[call] = null;
    fsHold.entered.push(call);
    await wait;
  };
  return {
    ...real,
    stat: (async (...args: Parameters<typeof real.stat>) => { await held("stat"); return real.stat(...args); }) as typeof real.stat,
    open: (async (...args: Parameters<typeof real.open>) => { fsHold.opens++; await held("open"); return real.open(...args); }) as typeof real.open,
  };
});
/** Hold the watcher's next stat (default) or open; the returned function lets it go. */
const holdNextRead = (call: "stat" | "open" = "stat") => {
  let release!: () => void;
  fsHold[call] = new Promise<void>(r => { release = r; });
  return () => release();
};
/** Until the watcher is parked inside the held call. */
const untilEntered = async (call: "stat" | "open") => {
  // Bounded by time, not by turns: reaching `open` means a real `stat` finished first, which a loaded machine can take
  // longer than any fixed number of event-loop turns to do (CI and a busy dev box flaked on a 200-turn bound).
  for (let i = 0; i < 2_500 && !fsHold.entered.includes(call); i++) await new Promise(r => setTimeout(r, 2));
  expect(fsHold.entered).toContain(call);
};

const FIX = join(__dirname, "fixtures");
const AFTER_TURN = readFileSync(join(FIX, "claude-2.1.293-steer-consumed-after-turn.transcript.jsonl"), "utf8");
const MID_TURN = readFileSync(join(FIX, "claude-2.1.293-steer-consumed-mid-turn.transcript.jsonl"), "utf8");
const AFTER_TURN_ID = "5b0c1d2e-0000-4000-8000-000000000002";
const MID_TURN_ID = "5b0c1d2e-0000-4000-8000-000000000003";
const withId = (transcript: string, from: string, to: string) => transcript.split(from).join(to);
const roots: string[] = [];
const scratch = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
afterEach(() => { fsHold.stat = null; fsHold.open = null; fsHold.entered = []; fsHold.opens = 0; vi.restoreAllMocks(); vi.useRealTimers(); for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("the parser on the live captures", () => {
  it("after the turn: a user entry → consumed as its own turn", () => {
    expect(transcriptDeltaDeliveryMarker(AFTER_TURN, "claude-code", AFTER_TURN_ID)).toBe("user");
  });

  it("at a tool boundary: remove(absorbed_mid_turn) + queued_command → consumed mid-turn (it used to read as only queued)", () => {
    expect(transcriptDeltaDeliveryMarker(MID_TURN, "claude-code", MID_TURN_ID)).toBe("absorbed");
    expect(transcriptDeltaHasDeliveryMarker(MID_TURN, "claude-code", MID_TURN_ID)).toBe(true);
    expect(markerConsumed("absorbed")).toBe(true);
    expect(markerConsumed("queued")).toBe(false);
  });

  it("either absorbed record alone is enough; the enqueue alone is only queued", () => {
    const lines = MID_TURN.split("\n");
    const without = (re: RegExp) => lines.filter(l => !re.test(l)).join("\n");
    expect(transcriptDeltaDeliveryMarker(without(/queued_command/), "claude-code", MID_TURN_ID)).toBe("absorbed");
    expect(transcriptDeltaDeliveryMarker(without(/"operation":"remove"/), "claude-code", MID_TURN_ID)).toBe("absorbed");
    expect(transcriptDeltaDeliveryMarker(without(/queued_command|"operation":"remove"/), "claude-code", MID_TURN_ID)).toBe("queued");
  });

  it("ownership is the exact marker: another id, a prefix of this one, the marker not leading, another reason — nothing", () => {
    expect(transcriptDeltaDeliveryMarker(MID_TURN, "claude-code", "5b0c1d2e-0000-4000-8000-000000000004")).toBeNull();
    expect(transcriptDeltaDeliveryMarker(MID_TURN, "claude-code", "5b0c1d2e-0000-4000-8000-00000000000")).toBeNull();
    const quoted = MID_TURN.split(`"prompt":"[agend-delivery-id:${MID_TURN_ID}]`).join(`"prompt":"see [agend-delivery-id:${MID_TURN_ID}]`)
      .split(`"content":"[agend-delivery-id:${MID_TURN_ID}]`).join(`"content":"see [agend-delivery-id:${MID_TURN_ID}]`);
    expect(transcriptDeltaDeliveryMarker(quoted, "claude-code", MID_TURN_ID)).toBeNull();
    const otherReason = MID_TURN.split("\n").filter(l => !/queued_command/.test(l)).join("\n")
      .replace('"reason":"absorbed_mid_turn"', '"reason":"cancelled"').replace(/"operation":"enqueue"/, '"operation":"x"');
    expect(transcriptDeltaDeliveryMarker(otherReason, "claude-code", MID_TURN_ID)).toBeNull();
  });

  it("the absorbed shapes are Claude's: a codex transcript never matches them", () => {
    expect(transcriptDeltaDeliveryMarker(MID_TURN, "codex", MID_TURN_ID)).toBeNull();
  });
});

// ── The outbox ─────────────────────────────────────────────────────────────────────────────────────────────────

function outboxWith(outcome: "delivered" | "uncertain" | "failed", opts: { requiresReply?: boolean; kind?: string } = {}) {
  const root = scratch("agend-1201-outbox-");
  const outbox = new DeliveryOutbox(join(root, "outbox.db"), "manager-1");
  const kind = opts.kind ?? "steer";
  const row = outbox.admit({
    operationId: "op-1201", sourceKey: `source:op-1201:${kind}`, sourceInstance: "source", sourceDaemonBootId: "source-boot",
    targetInstance: "worker", kind, correlationId: "cid-1201",
    payload: { type: kind, content: "work", meta: { message_id: "msg-1201", ...(opts.requiresReply ? { requires_reply: "true" } : {}) } },
  }).delivery;
  const claimed = outbox.claimNext("manager-1", () => "boot-1", new Set())!;
  expect(outbox.begin(row.deliveryId, "boot-1", claimed.attemptNo, {
    backend: "claude-code", backendVersion: null, windowId: "@w", transcriptPath: "/t.jsonl", transcriptOffset: 0, transcriptSessionId: "/t.jsonl",
    submissionMode: kind === "steer" ? "steer" : "native_queue_handoff",
  })).toBe("begun");
  outbox.complete(row.deliveryId, "boot-1", claimed.attemptNo, outcome, outcome === "delivered" ? "positive submission proof" : "native-queue-proof:unverifiable");
  const db = (outbox as any).db as Database.Database;
  const events: unknown[] = [];
  outbox.on("state", e => events.push(e));
  const notice = () => {
    const ref = db.prepare("SELECT notice_delivery_id FROM failure_notices WHERE parent_delivery_id=?").get(row.deliveryId) as { notice_delivery_id: string } | undefined;
    return ref ? (db.prepare("SELECT state FROM deliveries WHERE delivery_id=?").get(ref.notice_delivery_id) as { state: string }).state : null;
  };
  const status = () => outbox.queryStatusForInstance("source", { deliveryId: row.deliveryId }).items[0]!;
  return { outbox, row, attemptNo: claimed.attemptNo, db, events, notice, status, root };
}

describe("the outbox records a consumed delivery", () => {
  it("delivered → stays delivered, gains consumed_at/consumed_via; no state event; a second hit is 'already'", () => {
    const h = outboxWith("delivered");
    expect(h.outbox.markConsumed(h.row.deliveryId, "boot-1", h.attemptNo, "mid_turn", "transcript-consumed:absorbed-mid-turn")).toBe("marked");
    const st = h.status();
    expect(st.state).toBe("delivered");
    expect(st.consumed_via).toBe("mid_turn");
    expect(st.consumed_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(h.events).toEqual([]);
    expect(h.outbox.markConsumed(h.row.deliveryId, "boot-1", h.attemptNo, "turn", "x")).toBe("already");
    expect(h.status().consumed_via).toBe("mid_turn");
    h.outbox.close();
  });

  it("uncertain → delivered: error cleared, attempt delivered with the evidence, the reply obligation opened, the unsent notice cancelled", () => {
    const h = outboxWith("uncertain", { requiresReply: true });
    expect(h.notice()).toBe("queued");
    expect(h.status().reply_obligation ?? null).toBeNull();
    expect(h.outbox.markConsumed(h.row.deliveryId, "boot-1", h.attemptNo, "turn", "transcript-consumed:user-entry")).toBe("upgraded");
    const st = h.status();
    expect(st).toMatchObject({ state: "delivered", error_summary: null, consumed_via: "turn" });
    expect(st.reply_obligation?.state).toBe("open");
    const attempt = h.db.prepare("SELECT state, evidence FROM delivery_attempts WHERE delivery_id=?").get(h.row.deliveryId) as { state: string; evidence: string };
    expect(attempt.state).toBe("delivered");
    expect(attempt.evidence).toBe("native-queue-proof:unverifiable; transcript-consumed:user-entry");
    expect(h.notice()).toBe("cancelled");
    expect(h.events).toEqual([{ deliveryId: h.row.deliveryId, state: "delivered" }, expect.objectContaining({ state: "cancelled" })]);
    h.outbox.close();
  });

  describe("the notice and the pump race: never both sent and cancelled", () => {
    it("the cancel lands first → the pump never gets the notice", () => {
      const h = outboxWith("uncertain");
      expect(h.outbox.markConsumed(h.row.deliveryId, "boot-1", h.attemptNo, "turn", "e")).toBe("upgraded");
      expect(h.notice()).toBe("cancelled");
      expect(h.outbox.claimNext("manager-1", () => "boot-src", new Set()) ?? null).toBeNull();
      h.outbox.close();
    });

    it("the pump claims it first → the cancel is a no-op on it (it goes out; delivery_status already says delivered)", () => {
      const h = outboxWith("uncertain");
      const claimedNotice = h.outbox.claimNext("manager-1", () => "boot-src", new Set());
      expect(claimedNotice?.kind).toBe("delivery_outcome_notice");
      expect(h.outbox.markConsumed(h.row.deliveryId, "boot-1", h.attemptNo, "turn", "e")).toBe("upgraded");
      expect(h.notice()).toBe("delivering");
      expect(h.events).toEqual([{ deliveryId: h.row.deliveryId, state: "delivered" }]);
      h.outbox.close();
    });
  });

  it("never changes a failed row, another attempt, or another boot's attempt", () => {
    const failed = outboxWith("failed");
    expect(failed.outbox.markConsumed(failed.row.deliveryId, "boot-1", failed.attemptNo, "turn", "e")).toBe("ignored");
    expect(failed.status().state).toBe("failed");
    failed.outbox.close();
    const h = outboxWith("uncertain");
    expect(h.outbox.markConsumed(h.row.deliveryId, "boot-2", h.attemptNo, "turn", "e")).toBe("ignored");
    expect(h.outbox.markConsumed(h.row.deliveryId, "boot-1", h.attemptNo + 1, "turn", "e")).toBe("ignored");
    expect(h.outbox.markConsumed("no-such-delivery", "boot-1", h.attemptNo, "turn", "e")).toBe("ignored");
    expect(h.status().state).toBe("uncertain");
    h.outbox.close();
  });

  it("delivery_status says how it was routed and written (#1201: delivery_mode was promised, never shown)", () => {
    const steer = outboxWith("delivered");
    expect(steer.status()).toMatchObject({ delivery_mode: "steer", submission_mode: "steer", consumed_at: null, consumed_via: null });
    steer.outbox.close();
    const queued = outboxWith("delivered", { kind: "fleet_inbound" });
    expect(queued.status()).toMatchObject({ delivery_mode: "idle_queue", submission_mode: "native_queue_handoff" });
    queued.outbox.close();
  });

  it("a withdrawn notice is pruned like the other terminal rows", async () => {
    const h = outboxWith("uncertain");
    h.outbox.markConsumed(h.row.deliveryId, "boot-1", h.attemptNo, "turn", "e");
    h.db.prepare("UPDATE deliveries SET finished_at='2000-01-01T00:00:00.000Z', updated_at='2000-01-01T00:00:00.000Z' WHERE state='cancelled'").run();
    await h.outbox.prune(1);
    expect(h.notice()).toBeNull();
    h.outbox.close();
  });
});

describe("the schema migration", () => {
  it("an outbox written before #1201 opens, gains the columns, keeps its rows, and reads as not consumed", () => {
    const h = outboxWith("delivered");
    const path = join(h.root, "outbox.db");
    h.outbox.close();
    // Make it an old database: drop what #1201 added.
    const db = new Database(path);
    db.prepare("ALTER TABLE deliveries DROP COLUMN consumed_at").run();
    db.prepare("ALTER TABLE deliveries DROP COLUMN consumed_via").run();
    db.close();
    // An operator's read-only look at the old file works before any migration.
    const ro = DeliveryOutbox.queryStatusReadOnly(path, { deliveryId: h.row.deliveryId });
    expect(ro.items[0]).toMatchObject({ state: "delivered", consumed_at: null, consumed_via: null, delivery_mode: "steer" });
    const reopened = new DeliveryOutbox(path, "manager-2");
    const cols = (reopened as any).db.prepare("PRAGMA table_info(deliveries)").all().map((c: { name: string }) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["consumed_at", "consumed_via"]));
    expect(reopened.queryStatusForInstance("source", { deliveryId: h.row.deliveryId }).items[0]).toMatchObject({ state: "delivered", consumed_at: null });
    expect(reopened.markConsumed(h.row.deliveryId, "boot-1", h.attemptNo, "turn", "e")).toBe("marked");
    reopened.close();
  });
});

// ── The watcher ────────────────────────────────────────────────────────────────────────────────────────────────

function watchOn(transcript: string, deliveryId: string, opts: { current?: () => boolean; backend?: string } = {}) {
  const dir = scratch("agend-1201-watch-");
  const path = join(dir, "session.jsonl");
  writeFileSync(path, transcript);
  const consumed = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const ended: string[] = [];
  const watch = new ConsumedWatch({
    deliveryId, attemptNo: 1, backend: opts.backend ?? "claude-code", path, offset: Buffer.byteLength(transcript),
    current: opts.current ?? (() => true), consumed, logger,
  }, why => ended.push(why));
  return { path, watch, consumed, ended, logger };
}

describe("the watcher", () => {
  it("records the hit when the CLI takes the steer: mid-turn and as its own turn", async () => {
    const mid = watchOn("", MID_TURN_ID);
    appendFileSync(mid.path, MID_TURN);
    await mid.watch.look();
    expect(mid.consumed).toHaveBeenCalledWith("mid_turn", "transcript-consumed:absorbed-mid-turn");
    expect(mid.ended).toEqual(["consumed"]);
    const turn = watchOn("", AFTER_TURN_ID);
    appendFileSync(turn.path, AFTER_TURN);
    await turn.watch.look();
    expect(turn.consumed).toHaveBeenCalledWith("turn", "transcript-consumed:user-entry");
  });

  it("reads from the checkpoint: the marker already in the transcript before it is not this attempt's", async () => {
    const w = watchOn(MID_TURN, MID_TURN_ID);
    appendFileSync(w.path, "{\"type\":\"system\"}\n");
    await w.watch.look();
    expect(w.consumed).not.toHaveBeenCalled();
  });

  it("only queued (enqueue) or another delivery: no hit, keeps watching", async () => {
    const w = watchOn("", MID_TURN_ID);
    appendFileSync(w.path, MID_TURN.split("\n").filter(l => !/queued_command|"operation":"remove"/.test(l)).join("\n") + "\n");
    await w.watch.look();
    appendFileSync(w.path, withId(MID_TURN, MID_TURN_ID, "5b0c1d2e-0000-4000-8000-000000000009"));
    await w.watch.look();
    expect(w.consumed).not.toHaveBeenCalled();
    expect(w.ended).toEqual([]);
    w.watch.stop();
  });

  it("a line split across two looks is judged once it is complete", async () => {
    const w = watchOn("", MID_TURN_ID);
    const cut = MID_TURN.indexOf("queued_command") + 10;
    appendFileSync(w.path, MID_TURN.slice(0, cut).split("\n").filter(l => !/"operation":"remove"/.test(l)).join("\n"));
    await w.watch.look();
    expect(w.consumed).not.toHaveBeenCalled();
    appendFileSync(w.path, MID_TURN.slice(cut));
    await w.watch.look();
    expect(w.consumed).toHaveBeenCalledWith("mid_turn", expect.any(String));
  });

  it("ends quietly — no verdict — when its CLI is gone, the file is gone or truncated, or its lifetime is over", async () => {
    let current = true;
    const fenced = watchOn("", MID_TURN_ID, { current: () => current });
    appendFileSync(fenced.path, MID_TURN);
    current = false;
    const at = fenced.watch.position;
    await fenced.watch.look();
    expect(fenced.ended).toEqual(["fenced"]);
    expect(fenced.watch.position, "a fenced watch does not even read").toBe(at);
    expect(fenced.consumed).not.toHaveBeenCalled();

    const gone = watchOn("x\n", MID_TURN_ID);
    unlinkSync(gone.path);
    await gone.watch.look();
    expect(gone.ended).toEqual(["unavailable"]);

    const truncated = watchOn("some earlier transcript\n", MID_TURN_ID);
    writeFileSync(truncated.path, "");
    await truncated.watch.look();
    expect(truncated.ended).toEqual(["unavailable"]);

    let clock = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const old = watchOn("", MID_TURN_ID);
    clock += CONSUMED_WATCH.lifetimeMs + 1;
    appendFileSync(old.path, MID_TURN);
    await old.watch.look();
    expect(old.ended).toEqual(["expired"]);
    expect(old.consumed).not.toHaveBeenCalled();
  });

  it("its lifetime is monotonic: a wall clock moved back does not extend it, one moved forward does not end it", async () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const back = watchOn("", MID_TURN_ID);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 24 * 3_600_000);
    clock += CONSUMED_WATCH.lifetimeMs + 1;
    appendFileSync(back.path, MID_TURN);
    await back.watch.look();
    expect(back.ended).toEqual(["expired"]);
    expect(back.consumed).not.toHaveBeenCalled();

    const forward = watchOn("", MID_TURN_ID);
    vi.setSystemTime(Date.now() + 2 * CONSUMED_WATCH.lifetimeMs);
    appendFileSync(forward.path, MID_TURN);
    await forward.watch.look();
    expect(forward.consumed).toHaveBeenCalledWith("mid_turn", expect.any(String));
  });

  it("a read that returns after the lifetime ended proves nothing (the deadline is asked again after the await)", async () => {
    let clock = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    // Held in the stat, or past the stat and held in the read's open: each await is followed by its own check.
    for (const held of ["stat", "open"] as const) {
      const w = watchOn("", MID_TURN_ID);
      appendFileSync(w.path, MID_TURN);
      fsHold.entered = [];
      fsHold.opens = 0;
      const release = holdNextRead(held);
      const look = w.watch.look();
      await untilEntered(held);
      clock += CONSUMED_WATCH.lifetimeMs + 1;
      release();
      await look;
      expect(w.consumed, held).not.toHaveBeenCalled();
      expect(w.ended, held).toEqual(["expired"]);
      // expired during the stat: the file is not even opened for the read
      if (held === "stat") expect(fsHold.opens).toBe(0);
      clock = 1_000;
    }
  });

  it("stopped while a read is pending: the read that returns proves nothing", async () => {
    const w = watchOn("", MID_TURN_ID);
    appendFileSync(w.path, MID_TURN);
    const release = holdNextRead("open");
    const look = w.watch.look();
    await untilEntered("open");
    w.watch.stop();
    release();
    await look;
    expect(w.ended).toEqual(["stopped"]);
    expect(w.consumed).not.toHaveBeenCalled();
  });

  it("its CLI gone while a read is pending (stop, pause, respawn): the read that returns proves nothing", async () => {
    let current = true;
    const w = watchOn("", MID_TURN_ID, { current: () => current });
    appendFileSync(w.path, MID_TURN);
    const release = holdNextRead("open");
    const look = w.watch.look();
    await untilEntered("open");
    current = false;
    release();
    await look;
    expect(w.ended).toEqual(["fenced"]);
    expect(w.consumed).not.toHaveBeenCalled();
  });

  it("a big backlog is read in bounded chunks, one per look, never all at once — and still found", async () => {
    const filler = `${JSON.stringify({ type: "assistant", message: { content: "x".repeat(200) } })}\n`;
    const backlog = filler.repeat(Math.ceil((3 * CONSUMED_WATCH.chunkBytes) / filler.length));
    const w = watchOn("", MID_TURN_ID);
    appendFileSync(w.path, backlog + MID_TURN);
    const total = Buffer.byteLength(backlog + MID_TURN);
    const positions: number[] = [];
    while (!w.ended.length) {
      const before = w.watch.position;
      await w.watch.look();
      positions.push(w.watch.position - before);
    }
    expect(positions.every(n => n <= CONSUMED_WATCH.chunkBytes)).toBe(true);
    expect(positions.length).toBeGreaterThanOrEqual(Math.ceil(total / CONSUMED_WATCH.chunkBytes));
    expect(w.consumed).toHaveBeenCalledOnce();
  });

  it("a look over a big backlog yields to the event loop (async reads; timers still fire between looks)", async () => {
    const backlog = `${"{\"type\":\"assistant\"}\n".repeat(20_000)}`.repeat(10); // a few MB
    const w = watchOn("", MID_TURN_ID);
    appendFileSync(w.path, backlog);
    let fired = 0;
    const ticker = setInterval(() => { fired++; }, 0);
    try {
      for (let i = 0; i < 4; i++) await w.watch.look();
    } finally { clearInterval(ticker); }
    expect(fired).toBeGreaterThan(0);
    w.watch.stop();
  });

  it("a newline-free stretch longer than the line cap is skipped whole; the next line is still judged", async () => {
    const w = watchOn("", MID_TURN_ID);
    appendFileSync(w.path, "z".repeat(4 * CONSUMED_WATCH.maxLineBytes + 17) + "\n" + MID_TURN);
    let maxCarried = 0;
    while (!w.ended.length) { await w.watch.look(); maxCarried = Math.max(maxCarried, w.watch.carriedBytes); }
    // Memory stays bounded: the oversized line is dropped, not accumulated.
    expect(maxCarried).toBeLessThanOrEqual(CONSUMED_WATCH.maxLineBytes);
    expect(w.consumed).toHaveBeenCalledWith("mid_turn", expect.any(String));
  });

  /** This delivery's own after-turn user entry, as Claude writes it, padded to exactly `bytes` (without its newline). */
  const ownUserLine = (bytes: number) => {
    const line = AFTER_TURN.split("\n").find(l => l.includes('"type":"user"') && l.includes(AFTER_TURN_ID))!;
    const entry = JSON.parse(line);
    const base = Buffer.byteLength(JSON.stringify(entry));
    entry.message.content += "p".repeat(bytes - base);
    const out = JSON.stringify(entry);
    expect(Buffer.byteLength(out)).toBe(bytes);
    return out;
  };
  const readAll = async (w: ReturnType<typeof watchOn>) => {
    for (let i = 0; i < 100 && !w.ended.length; i++) {
      const before = w.watch.position;
      await w.watch.look();
      if (w.watch.position === before) break;
    }
  };

  it("a complete line over the cap is skipped before it is decoded — even this delivery's own, valid user entry", async () => {
    for (const bytes of [CONSUMED_WATCH.maxLineBytes + 1, 409_600]) {
      const alone = watchOn("", AFTER_TURN_ID);
      appendFileSync(alone.path, `${ownUserLine(bytes)}\n`);
      await readAll(alone);
      expect(alone.consumed, String(bytes)).not.toHaveBeenCalled();
      alone.watch.stop();
      // …and a valid short line after it is still judged: the mid-turn shape for the same delivery is the hit
      const after = watchOn("", AFTER_TURN_ID);
      appendFileSync(after.path, `${ownUserLine(bytes)}\n${withId(MID_TURN, MID_TURN_ID, AFTER_TURN_ID)}`);
      await readAll(after);
      expect(after.consumed, String(bytes)).toHaveBeenCalledWith("mid_turn", "transcript-consumed:absorbed-mid-turn");
    }
  });

  it("a line of exactly the cap is still judged", async () => {
    const w = watchOn("", AFTER_TURN_ID);
    appendFileSync(w.path, `${ownUserLine(CONSUMED_WATCH.maxLineBytes)}\n`);
    await readAll(w);
    expect(w.consumed).toHaveBeenCalledWith("turn", "transcript-consumed:user-entry");
  });

  it("a transcript that does not grow is looked at less and less often", async () => {
    const w = watchOn("", MID_TURN_ID);
    expect(w.watch.currentInterval).toBe(CONSUMED_WATCH.tickMs);
    for (let i = 0; i < CONSUMED_WATCH.idleLooksBeforeBackoff; i++) await w.watch.look();
    expect(w.watch.currentInterval).toBe(2 * CONSUMED_WATCH.tickMs);
    for (let i = 0; i < 40 * CONSUMED_WATCH.idleLooksBeforeBackoff; i++) await w.watch.look();
    expect(w.watch.currentInterval).toBe(CONSUMED_WATCH.maxTickMs);
    w.watch.stop();
  });
});

describe("the fleet-wide registry", () => {
  it("caps the watches alive at once: one over the cap is logged and not started", () => {
    const registry = new ConsumedWatchRegistry();
    const dir = scratch("agend-1201-cap-");
    const path = join(dir, "t.jsonl");
    writeFileSync(path, "");
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const target = (i: number) => ({ deliveryId: `d-${i}`, attemptNo: 1, backend: "claude-code", path, offset: 0, current: () => true, consumed: vi.fn(), logger });
    for (let i = 0; i < CONSUMED_WATCH.maxWatchers; i++) expect(registry.start(target(i))).toBe(true);
    expect(registry.start(target(999))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ cap: CONSUMED_WATCH.maxWatchers }), expect.stringContaining("watch cap"));
    expect(registry.start(target(0))).toBe(false); // the same attempt twice
    registry.stopAll();
    expect(registry.size).toBe(0);
    expect(registry.start(target(999))).toBe(true);
    registry.stopAll();
  });
});

// ── The daemon starts a watch only where it means something ──────────────────────────────────────────────────

describe("the daemon", () => {
  async function settle(verdict: Record<string, unknown>, outcome: "delivered" | "uncertain" | "failed") {
    const { Daemon } = await import("../src/daemon.js");
    const { consumedWatches } = await import("../src/delivery-consumed-watch.js");
    const root = scratch("agend-1201-daemon-");
    const instanceDir = join(root, "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
    const daemon: any = new Daemon("worker", {
      working_directory: root, log_level: "error", backend: "claude-code",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    }, instanceDir, false, undefined as any, undefined as any, logger);
    const port = { complete: vi.fn(() => true), markConsumed: vi.fn(() => "marked") };
    daemon.setDeliveryOutboxPort(port);
    const start = vi.spyOn(consumedWatches, "start").mockReturnValue(true);
    spies.push(start);
    daemon.finishDurableDelivery({ deliveryId: "d-1", attemptNo: 2 }, outcome, "e", verdict);
    return { start, port, daemon };
  }
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
  const checkpoint = { backend: "claude-code", path: "/t.jsonl", offset: 10 };

  it("a steer or a native-queue hand-off with a transcript checkpoint, delivered or uncertain → watched", async () => {
    for (const mode of ["steer", "native_queue_handoff"]) {
      for (const outcome of ["delivered", "uncertain"] as const) {
        const { start } = await settle({ submissionMode: mode, transcriptCheckpoint: checkpoint }, outcome);
        expect(start, `${mode} ${outcome}`).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: "d-1", attemptNo: 2, backend: "claude-code", path: "/t.jsonl", offset: 10 }));
      }
    }
  });

  it("not watched: an idle submit, a raw paste, a failure, no checkpoint, a backend with no readable transcript", async () => {
    const cases: Array<[Record<string, unknown>, "delivered" | "uncertain" | "failed"]> = [
      [{ submissionMode: "idle_submit", transcriptCheckpoint: checkpoint }, "delivered"],
      [{ submissionMode: "raw_paste", transcriptCheckpoint: checkpoint }, "uncertain"],
      [{ submissionMode: "steer", transcriptCheckpoint: checkpoint }, "failed"],
      [{ submissionMode: "steer" }, "delivered"],
      [{ submissionMode: "steer", transcriptCheckpoint: { ...checkpoint, backend: "grok" } }, "delivered"],
    ];
    for (const [verdict, outcome] of cases) {
      const { start } = await settle(verdict, outcome);
      expect(start, JSON.stringify(verdict) + outcome).not.toHaveBeenCalled();
    }
  });

  it("the hit goes to the outbox with this daemon's boot and the attempt; a stop or respawn fences the watch", async () => {
    const { start, port, daemon } = await settle({ submissionMode: "steer", transcriptCheckpoint: checkpoint }, "delivered");
    const target = start.mock.calls[0]![0];
    expect(target.current()).toBe(true);
    target.consumed("mid_turn", "transcript-consumed:absorbed-mid-turn");
    expect(port.markConsumed).toHaveBeenCalledWith("d-1", daemon.bootId, 2, "mid_turn", "transcript-consumed:absorbed-mid-turn");
    daemon.spawnGeneration++;
    expect(target.current()).toBe(false);
  });

  describe("a write that started and then threw still starts the watch (the verdict reaches the post-write catch)", () => {
    // Real Daemon, real DeliveryOutbox; only deliverMessage is stubbed: it begins the durable submission, records the
    // pane write, the hand-off mode and the transcript checkpoint — then throws, or returns false (the control).
    async function deliverThrough(entry: "steer" | "push", mode: "steer" | "native_queue_handoff", end: "throw" | "false") {
      const { Daemon } = await import("../src/daemon.js");
      const { consumedWatches } = await import("../src/delivery-consumed-watch.js");
      const root = scratch("agend-1201-catch-");
      const instanceDir = join(root, "instances", "worker");
      mkdirSync(instanceDir, { recursive: true });
      const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
      const daemon: any = new Daemon("worker", {
        working_directory: root, log_level: "error", backend: "claude-code",
        restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
        context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
      }, instanceDir, false, undefined as any, undefined as any, logger);
      const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
      daemon.setDeliveryOutboxPort(outbox);
      // An inert tmux: the push path only asks that one exists; every pane write is the stubbed deliverMessage.
      daemon.tmux = { capturePane: vi.fn(async () => ""), getWindowId: () => "@worker" };
      const row = outbox.admit({
        operationId: "op", sourceKey: "s:op:w:fleet_inbound", sourceInstance: "source", sourceDaemonBootId: "sb",
        targetInstance: "worker", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "hello", meta: {} },
      }).delivery;
      const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
      const start = vi.spyOn(consumedWatches, "start").mockReturnValue(true);
      vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
      vi.spyOn(daemon, "deliverMessage").mockImplementation(async (...args: unknown[]) => {
        const opts = args[2] as { verdict: Record<string, unknown>; durableAttempt: unknown; steer?: boolean };
        if (!opts?.durableAttempt) return true; // a system notice the push path writes first
        const evidence = await daemon.durableAttemptEvidence(undefined, true, opts.steer === true, false);
        expect(daemon.beginDurableDelivery(opts.durableAttempt, evidence)).toBe(true);
        Object.assign(opts.verdict, {
          durableBeginCommitted: true, paneWriteStarted: true, submissionMode: mode,
          transcriptCheckpoint: { backend: "claude-code", path: join(root, "t.jsonl"), offset: 0 },
        });
        if (end === "throw") throw new Error("capture failed after the Enter");
        return false;
      });
      const meta = {
        delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
        user: "instance:source", user_id: "instance:source", message_id: "m-1201", chat_id: "chat", thread_id: "", ts: new Date().toISOString(),
      };
      if (entry === "steer") daemon.steerMessage("hello", meta);
      else daemon.pushChannelMessage("hello", meta);
      for (let i = 0; i < 200 && outbox.get(row.deliveryId)?.state !== "uncertain"; i++) await new Promise(r => setImmediate(r));
      return { state: outbox.get(row.deliveryId)?.state, start, deliveryId: row.deliveryId, attemptNo: claimed.attemptNo };
    }

    for (const [entry, mode] of [["steer", "steer"], ["push", "native_queue_handoff"]] as const) {
      it(`${entry === "steer" ? "steerMessage" : "pushChannelMessage"} (${mode}): throws after the write → uncertain AND watched, like the false return`, async () => {
        for (const end of ["throw", "false"] as const) {
          const r = await deliverThrough(entry, mode, end);
          expect(r.state, end).toBe("uncertain");
          expect(r.start, end).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: r.deliveryId, attemptNo: r.attemptNo }));
          vi.restoreAllMocks();
        }
      });
    }
  });
});
