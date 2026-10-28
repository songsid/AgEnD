/**
 * #926 phase 2, cut down by #2802 (the user's decision of 2026-10-28): one safety net over reply obligations.
 *   An owner whose turn ended without answering gets one reminder per ask — the 9/24 #924 and #925 cases. After a
 *   restart it is the same reminder (no batch), once the owner is idle, unless that ask was already reminded.
 *   The requester is never told (no overdue or expiry notice); `reply_overdue_minutes` is accepted and ignored.
 * Real outbox, real FleetManager, a real Daemon pane write, and a whole-process SIGKILL for the restart case.
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
    expect(outbox.remindReplyObligations("reviewer", { now: at(59), graceMs: 60_000 })).toBe(0);
    expect(outbox.remindReplyObligations("reviewer", { now: at(61), graceMs: 60_000 })).toBe(1);
    expect(outbox.remindReplyObligations("reviewer", { now: at(600), graceMs: 60_000 })).toBe(0);
    expect(notices(outbox)).toEqual([{ target: "reviewer", cid: "cid-925", text: expect.stringMatching(/^\[system:reply-pending\] Your turn ended without answering leader.*report_result.*terminal text does not reach them\.\ncorrelation_id=cid-925/) }]);
    expect(outbox.getReplyObligation("cid-925", "leader", "reviewer")?.nudgedAt).toBe(at(61).toISOString());
    outbox.close();
  });

  it("reminds again after the requester asks again", () => {
    const outbox = asked(T0);
    outbox.remindReplyObligations("reviewer", { now: at(61), graceMs: 60_000 });
    vi.setSystemTime(at(300));
    admit(outbox, "leader", "reviewer", "cid-925", true);
    deliverAll(outbox);
    expect(outbox.remindReplyObligations("reviewer", { now: at(330), graceMs: 60_000 })).toBe(0);
    expect(outbox.remindReplyObligations("reviewer", { now: at(361), graceMs: 60_000 })).toBe(1);
    outbox.close();
  });

  it("never reminds about an answered request", () => {
    const outbox = asked(T0);
    admit(outbox, "reviewer", "leader", "cid-925");
    expect(outbox.remindReplyObligations("reviewer", { now: at(600), graceMs: 60_000 })).toBe(0);
    outbox.close();
  });
});

describe("the requester is never told (#2802)", () => {
  it("does not let a notice that fails spawn a failure notice of its own", () => {
    const outbox = asked(T0);
    outbox.remindReplyObligations("reviewer", { now: at(61), graceMs: 60_000 });
    deliverAll(outbox, "failed");
    const kinds = (outbox as any).db.prepare("SELECT kind FROM deliveries").all().map((r: any) => r.kind);
    expect(kinds).not.toContain("delivery_outcome_notice");
    outbox.close();
  });
});

describe("the fleet sweep (#926, #2802)", () => {
  function fleet(state: Record<string, string>, overdue?: number) {
    const { fm, outbox } = quietFleet(tempRoot(), overdue === undefined ? {} : { reply_overdue_minutes: overdue });
    for (const [name, s] of Object.entries(state)) fm.lifecycle.daemons.set(name, { getInstanceState: () => s });
    admit(outbox, "leader", "reviewer", "cid-925", true);
    deliverAll(outbox);
    return { fm, outbox };
  }
  const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  it("reminds an idle owner once; the requester hears nothing, not when overdue, not when the ask expires", () => {
    const { fm, outbox } = fleet({ reviewer: "idle", leader: "idle" });
    fm.sweepReplyObligations(later(2));
    expect(notices(outbox).map((n: any) => n.target)).toEqual(["reviewer"]);
    fm.sweepReplyObligations(later(2 + 15));
    fm.sweepReplyObligations(later(120));
    fm.sweepReplyObligations(later(25 * 60));
    expect(outbox.getReplyObligation("cid-925", "leader", "reviewer")).toMatchObject({ state: "expired" });
    expect(notices(outbox).map((n: any) => n.target)).toEqual(["reviewer"]);
    outbox.close();
  });

  it("leaves a working owner alone; reply_overdue_minutes changes nothing", () => {
    const busy = fleet({ reviewer: "working" });
    busy.fm.sweepReplyObligations(later(120));
    expect(notices(busy.outbox)).toEqual([]);
    busy.outbox.close();
    for (const overdue of [0, 1]) {
      const idle = fleet({ reviewer: "idle", leader: "idle" }, overdue);
      idle.fm.sweepReplyObligations(later(120));
      expect(notices(idle.outbox).map((n: any) => n.target), String(overdue)).toEqual(["reviewer"]);
      idle.outbox.close();
    }
  });

  it("a restart adds no batch: the owner gets the ordinary reminder once idle, and an ask reminded before is not repeated", () => {
    const { fm, outbox } = fleet({ reviewer: "idle" });
    fm.onDaemonReady("reviewer", "reviewer-boot-2");
    expect(notices(outbox)).toEqual([]);
    fm.sweepReplyObligations(later(2));
    expect(notices(outbox)).toEqual([expect.objectContaining({ target: "reviewer", cid: "cid-925", text: expect.stringMatching(/^\[system:reply-pending\] Your turn ended without answering leader/) })]);
    fm.onDaemonReady("reviewer", "reviewer-boot-3");
    fm.sweepReplyObligations(later(5));
    expect(notices(outbox)).toHaveLength(1);
    outbox.close();
  });

  it("reply_overdue_minutes is ignored but keeps 2.3.2's check, so a downgrade still loads the file", () => {
    const errors = (value: unknown) => JSON.stringify(validateFleetConfig({ defaults: { reply_overdue_minutes: value }, instances: {} }))
      .includes("reply_overdue_minutes");
    expect([15, 0, -1, "15"].map(errors)).toEqual([false, false, true, true]);
  });
});

describe("the #925 shape: the whole process dies mid-review (#926)", () => {
  it("keeps the obligation through a SIGKILL and reminds the owner once it is back and idle", async () => {
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
    fm.lifecycle.daemons.set("reviewer", { getInstanceState: () => "idle" });
    fm.onDaemonReady("reviewer", "reviewer-boot-after-restart");
    expect(notices(outbox)).toEqual([]);
    fm.sweepReplyObligations(new Date(Date.now() + 2 * 60_000));
    expect(notices(outbox)).toEqual([expect.objectContaining({ target: "reviewer", cid: "cid-925", text: expect.stringMatching(/^\[system:reply-pending\] Your turn ended without answering leader.*\ncorrelation_id=cid-925/s) })]);
    outbox.close();
  }, 30_000);
});

describe("a reminder reaches the owner's pane through the real dispatcher and Daemon (#926)", () => {
  it("is dispatched like any fleet message and pasted with its text intact", async () => {
    const root = tempRoot();
    const { fm, outbox } = quietFleet(root);
    admit(outbox, "leader", "reviewer", "cid-925", true);
    deliverAll(outbox);
    outbox.remindReplyObligations("reviewer", { now: new Date(Date.now() + 120_000), graceMs: 60_000 });

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
