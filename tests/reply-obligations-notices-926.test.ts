/**
 * #926 phase 2: the two safety nets over reply obligations.
 *   1. An owner whose turn ended (or whose turn a restart killed) without
 *      answering gets one reminder — the 9/24 #924 and #925 cases.
 *   2. The requester is told once when an idle owner still has not answered
 *      after `reply_overdue_minutes` — the coordinator's poll-on-timeout.
 * Real outbox, real FleetManager, a real Daemon pane write, and a
 * whole-process SIGKILL for the restart case.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryOutbox, REPLY_OBLIGATION_NOTICE_KIND } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { validateFleetConfig } from "../src/config-validator.js";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tempRoot = () => { const r = mkdtempSync(join(tmpdir(), "agend-926b-")); roots.push(r); return r; };

let seq = 0;
function admit(outbox: DeliveryOutbox, from: string, to: string, cid: string, requiresReply = false) {
  const n = ++seq;
  return outbox.admit({
    operationId: `op-${n}`, sourceKey: `key-${n}`, sourceInstance: from, sourceDaemonBootId: `${from}-boot`,
    targetInstance: to, kind: "fleet_inbound", correlationId: cid,
    payload: { type: "fleet_inbound", content: `message ${n}`, meta: requiresReply ? { requires_reply: "true" } : {} },
  }).delivery;
}
function deliverAll(outbox: DeliveryOutbox, outcome: "delivered" | "failed" = "delivered") {
  for (;;) {
    const c = outbox.claimNext(outbox.managerBootId, name => `${name}-boot`, new Set());
    if (!c) return;
    const boot = `${c.targetInstance}-boot`;
    outbox.begin(c.deliveryId, boot, c.attemptNo, { backend: "codex", windowId: "@w", transcriptPath: null, transcriptOffset: null, transcriptSessionId: null, submissionMode: "idle_submit" });
    outbox.complete(c.deliveryId, boot, c.attemptNo, outcome, "test");
  }
}
const notices = (outbox: DeliveryOutbox) => (outbox as any).db.prepare(
  `SELECT target_instance, correlation_id, payload_json FROM deliveries WHERE kind=? ORDER BY created_seq`,
).all(REPLY_OBLIGATION_NOTICE_KIND).map((r: any) => ({ target: r.target_instance, cid: r.correlation_id, text: JSON.parse(r.payload_json).content as string }));

/** leader asked reviewer for a verdict at `askedAt`; the request was delivered. */
function asked(askedAt: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(askedAt));
  const outbox = new DeliveryOutbox(join(tempRoot(), "delivery-outbox.db"), "manager");
  admit(outbox, "leader", "reviewer", "cid-925", true);
  deliverAll(outbox);
  return outbox;
}
/** A FleetManager whose pump and sweep timers never outlive the test's outbox. */
const managers: any[] = [];
afterEach(() => { for (const fm of managers.splice(0)) { if (fm.replyObligationTimer) clearInterval(fm.replyObligationTimer); } });
function quietFleet(root: string, defaults: Record<string, unknown> = {}) {
  const fm = new FleetManager(root) as any;
  fm.scheduleDeliveryOutboxPump = () => {};
  fm.fleetConfig = { defaults, instances: {} };
  fm.ensureDeliveryOutbox();
  managers.push(fm);
  return { fm, outbox: fm.deliveryOutbox as DeliveryOutbox };
}

const T0 = "2026-09-24T13:09:53.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000);

describe("safety net 1: remind the owner (#926)", () => {
  it("after the grace, reminds once that terminal text does not reach the requester", () => {
    const outbox = asked(T0);
    expect(outbox.remindReplyObligations("reviewer", { now: at(59), graceMs: 60_000, reason: "turn-ended" })).toBe(0);
    expect(outbox.remindReplyObligations("reviewer", { now: at(61), graceMs: 60_000, reason: "turn-ended" })).toBe(1);
    expect(outbox.remindReplyObligations("reviewer", { now: at(600), graceMs: 60_000, reason: "turn-ended" })).toBe(0);
    expect(notices(outbox)).toEqual([{ target: "reviewer", cid: "cid-925", text: expect.stringMatching(/^\[system:reply-pending\] Your turn ended without answering leader.*report_result.*terminal text does not reach them\.\ncorrelation_id=cid-925/) }]);
    expect(outbox.getReplyObligation("cid-925", "leader", "reviewer")?.nudgedAt).toBe(at(61).toISOString());
    outbox.close();
  });

  it("reminds again after the requester asks again", () => {
    const outbox = asked(T0);
    outbox.remindReplyObligations("reviewer", { now: at(61), graceMs: 60_000, reason: "turn-ended" });
    vi.setSystemTime(at(300));
    admit(outbox, "leader", "reviewer", "cid-925", true);
    deliverAll(outbox);
    expect(outbox.remindReplyObligations("reviewer", { now: at(330), graceMs: 60_000, reason: "turn-ended" })).toBe(0);
    expect(outbox.remindReplyObligations("reviewer", { now: at(361), graceMs: 60_000, reason: "turn-ended" })).toBe(1);
    outbox.close();
  });

  it("after a restart, reminds once per restart even if it was reminded before", () => {
    const outbox = asked(T0);
    outbox.remindReplyObligations("reviewer", { now: at(61), graceMs: 60_000, reason: "turn-ended" });
    const restart = at(958);  // the 21:25:51 fleet restart, relative to the 21:09:53 ask
    expect(outbox.remindReplyObligations("reviewer", { now: restart, graceMs: 0, reason: "restart", since: restart })).toBe(1);
    expect(outbox.remindReplyObligations("reviewer", { now: at(960), graceMs: 0, reason: "restart", since: restart })).toBe(0);
    expect(notices(outbox).at(-1)!.text).toMatch(/^\[system:reply-pending\] A restart interrupted your work for leader.*report_result.*\ncorrelation_id=cid-925/);
    outbox.close();
  });

  it("never reminds about an answered request", () => {
    const outbox = asked(T0);
    admit(outbox, "reviewer", "leader", "cid-925");
    expect(outbox.remindReplyObligations("reviewer", { now: at(600), graceMs: 60_000, reason: "turn-ended" })).toBe(0);
    expect(outbox.remindReplyObligations("reviewer", { now: at(600), graceMs: 0, reason: "restart", since: at(600) })).toBe(0);
    expect(outbox.notifyOverdueReplyObligations({ now: at(99_999), overdueMs: 60_000, ownerIdle: () => true })).toBe(0);
    outbox.close();
  });
});

describe("safety net 2: tell the requester (#926)", () => {
  const minutes = (m: number) => m * 60_000;

  it("tells the requester once when an idle owner is overdue, measured from the last ask or reminder", () => {
    const outbox = asked(T0);
    outbox.remindReplyObligations("reviewer", { now: at(61), graceMs: 60_000, reason: "turn-ended" });
    const idle = () => true;
    expect(outbox.notifyOverdueReplyObligations({ now: at(61 + 15 * 60 - 1), overdueMs: minutes(15), ownerIdle: idle })).toBe(0);
    expect(outbox.notifyOverdueReplyObligations({ now: at(61 + 15 * 60), overdueMs: minutes(15), ownerIdle: idle })).toBe(1);
    expect(outbox.notifyOverdueReplyObligations({ now: at(99_999), overdueMs: minutes(15), ownerIdle: idle })).toBe(0);
    expect(notices(outbox).at(-1)).toEqual({ target: "leader", cid: "cid-925",
      text: expect.stringMatching(/^\[system:reply-overdue\] reviewer has not replied.*describe_instance or delivery_status.*\ncorrelation_id=cid-925; asked=.*; reminded=/) });
    outbox.close();
  });

  it("never reports an owner that is still working, and 0 turns the notice off", () => {
    const outbox = asked(T0);
    expect(outbox.notifyOverdueReplyObligations({ now: at(99_999), overdueMs: minutes(15), ownerIdle: () => false })).toBe(0);
    expect(outbox.notifyOverdueReplyObligations({ now: at(99_999), overdueMs: 0, ownerIdle: () => true })).toBe(0);
    expect(notices(outbox)).toEqual([]);
    outbox.close();
  });

  it("does not let a notice that fails spawn a failure notice of its own", () => {
    const outbox = asked(T0);
    outbox.remindReplyObligations("reviewer", { now: at(61), graceMs: 60_000, reason: "turn-ended" });
    deliverAll(outbox, "failed");
    const kinds = (outbox as any).db.prepare("SELECT kind FROM deliveries").all().map((r: any) => r.kind);
    expect(kinds).not.toContain("delivery_outcome_notice");
    outbox.close();
  });
});

describe("the fleet runs both nets (#926)", () => {
  function fleet(state: Record<string, string>, overdue?: number) {
    const { fm, outbox } = quietFleet(tempRoot(), overdue === undefined ? {} : { reply_overdue_minutes: overdue });
    for (const [name, s] of Object.entries(state)) fm.lifecycle.daemons.set(name, { getInstanceState: () => s });
    admit(outbox, "leader", "reviewer", "cid-925", true);
    deliverAll(outbox);
    return { fm, outbox };
  }
  const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  it("reminds an idle owner and, 15 minutes later by default, tells the requester", () => {
    const { fm, outbox } = fleet({ reviewer: "idle", leader: "idle" });
    fm.sweepReplyObligations(later(2));
    expect(notices(outbox).map((n: any) => n.target)).toEqual(["reviewer"]);
    fm.sweepReplyObligations(later(2 + 15));
    expect(notices(outbox).map((n: any) => n.target)).toEqual(["reviewer", "leader"]);
    outbox.close();
  });

  it("leaves a working owner alone, and honours reply_overdue_minutes: 0", () => {
    const busy = fleet({ reviewer: "working" });
    busy.fm.sweepReplyObligations(later(120));
    expect(notices(busy.outbox)).toEqual([]);
    busy.outbox.close();
    const off = fleet({ reviewer: "idle" }, 0);
    off.fm.sweepReplyObligations(later(120));
    expect(notices(off.outbox).map((n: any) => n.target)).toEqual(["reviewer"]);
    off.outbox.close();
  });

  it("reminds the owner when its daemon comes back after a restart", () => {
    const { fm, outbox } = fleet({ reviewer: "idle" });
    fm.onDaemonReady("reviewer", "reviewer-boot-2");
    expect(notices(outbox)).toEqual([expect.objectContaining({ target: "reviewer", text: expect.stringMatching(/A restart interrupted/) })]);
    outbox.close();
  });

  it("validates reply_overdue_minutes", () => {
    const errors = (value: unknown) => JSON.stringify(validateFleetConfig({ defaults: { reply_overdue_minutes: value }, instances: {} }))
      .includes("reply_overdue_minutes");
    expect(errors(15)).toBe(false);
    expect(errors(0)).toBe(false);
    expect(errors(-1)).toBe(true);
    expect(errors("15")).toBe(true);
  });
});

describe("the #925 shape: the whole process dies mid-review (#926)", () => {
  it("keeps the obligation through a SIGKILL and reminds the owner when it comes back", async () => {
    const root = tempRoot();
    const managerUrl = pathToFileURL(join(process.cwd(), "src/fleet-manager.ts")).href;
    const script = [
      `import { FleetManager } from ${JSON.stringify(managerUrl)};`,
      `const fm = new FleetManager(${JSON.stringify(root)}); fm.shuttingDown = true; fm.fleetConfig = { defaults: {}, instances: {} };`,
      `fm.ensureDeliveryOutbox(); const outbox = fm.deliveryOutbox;`,
      `outbox.admit({ operationId: "op-925", sourceKey: "k-925", sourceInstance: "leader", sourceDaemonBootId: "leader-boot", targetInstance: "reviewer", kind: "fleet_inbound", correlationId: "cid-925", payload: { type: "fleet_inbound", content: "Review PR #925", meta: { requires_reply: "true" } } });`,
      `const c = outbox.claimNext(outbox.managerBootId, n => n + "-boot", new Set());`,
      `outbox.begin(c.deliveryId, "reviewer-boot", c.attemptNo, { backend: "codex", windowId: "@w", transcriptPath: null, transcriptOffset: null, transcriptSessionId: null, submissionMode: "idle_submit" });`,
      `outbox.complete(c.deliveryId, "reviewer-boot", c.attemptNo, "delivered", "proof");`,
      `process.stdout.write("reviewing\\n");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", d => { stderr += d; });
    const lines = createInterface({ input: child.stdout });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child never started reviewing: ${stderr}`)), 15_000);
      lines.once("line", line => { clearTimeout(timer); line === "reviewing" ? resolve() : reject(new Error(line)); });
    });
    child.kill("SIGKILL");
    await once(child, "exit");
    lines.close();

    const { fm, outbox } = quietFleet(root);
    expect(outbox.getReplyObligation("cid-925", "leader", "reviewer")).toMatchObject({ state: "open" });
    fm.onDaemonReady("reviewer", "reviewer-boot-after-restart");
    expect(notices(outbox)).toEqual([expect.objectContaining({ target: "reviewer", cid: "cid-925", text: expect.stringMatching(/A restart interrupted your work for leader.*\ncorrelation_id=cid-925/) })]);
    outbox.close();
  }, 30_000);
});

describe("a reminder reaches the owner's pane through the real dispatcher and Daemon (#926)", () => {
  it("is dispatched like any fleet message and pasted with its text intact", async () => {
    const root = tempRoot();
    const { fm, outbox } = quietFleet(root);
    admit(outbox, "leader", "reviewer", "cid-925", true);
    deliverAll(outbox);
    outbox.remindReplyObligations("reviewer", { now: new Date(Date.now() + 120_000), graceMs: 60_000, reason: "turn-ended" });

    const instanceDir = join(root, "instances", "reviewer");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "window-id"), "@reviewer");
    const daemon = new Daemon("reviewer", { working_directory: root, log_level: "silent" } as any, instanceDir, false,
      undefined, undefined, pino({ level: "silent" }) as any) as any;
    daemon.setDeliveryOutboxPort(outbox);
    const claimed = outbox.claimNext(outbox.managerBootId, () => daemon.bootId, new Set())!;
    expect(claimed.kind).toBe(REPLY_OBLIGATION_NOTICE_KIND);
    const pasted: string[] = [];
    daemon.tmux = { capturePane: async () => "❯", pasteBuffer: vi.fn(async (text: string) => { pasted.push(text); return true; }),
      sendSpecialKey: vi.fn(async () => true), getLastPasteError: () => undefined, isLastPasteFailureRecoverable: () => true };
    vi.spyOn(daemon, "sendDeliveryEnter").mockResolvedValue(true);
    vi.spyOn(fm, "deliverToInstance").mockImplementation(async (_target: unknown, payload: any) => {
      daemon.pushChannelMessage(payload.content, payload.meta);
      return true;
    });
    vi.spyOn(fm, "waitForDurableLaneRelease").mockReturnValue(Promise.resolve());
    await fm.dispatchDurableDelivery(claimed);
    await vi.waitFor(() => expect(pasted.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(pasted[0]).toContain("[system:reply-pending] Your turn ended without answering leader.");
    outbox.close();
  }, 20_000);
});
