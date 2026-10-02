import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import pino from "pino";
import { createInterface } from "node:readline";
import { DeliveryOutbox, DURABLE_DELIVERY_MAX_AGE_MS, type OutboxState } from "../src/delivery-outbox.js";
import { FleetManager, DURABLE_DELIVERY_LANE_ALERT_MS } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { setLocale, t, type Locale } from "../src/locale.js";
import { encodeOperationError } from "../src/channel/mcp-operation-response.js";

const roots: string[] = [];
const stores: DeliveryOutbox[] = [];
const managers: any[] = [];
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "agend-1096-"));
  roots.push(root);
  return root;
};
const store = () => {
  const outbox = new DeliveryOutbox(join(tempRoot(), "delivery-outbox.db"), "manager");
  stores.push(outbox);
  return outbox;
};
const admit = (outbox: DeliveryOutbox, id = "op-test", reply = false) => outbox.admit({
  operationId: id, sourceKey: id, sourceInstance: "sender", sourceDaemonBootId: "source-boot",
  targetInstance: "worker", kind: "fleet_inbound", correlationId: `cid-${id}`,
  payload: { type: "fleet_inbound", content: "original message", meta: { requires_reply: String(reply) } },
}).delivery;
const finish = (outbox: DeliveryOutbox, outcome: "delivered" | "failed" | "uncertain", evidence: string) => {
  const claim = outbox.claimNext("manager", () => "worker-boot", new Set())!;
  expect(outbox.begin(claim.deliveryId, "worker-boot", claim.attemptNo)).toBe("begun");
  expect(outbox.complete(claim.deliveryId, "worker-boot", claim.attemptNo, outcome, evidence)).toBe(true);
};
function quietFleet() {
  const fm = new FleetManager(tempRoot()) as any;
  fm.fleetConfig = { defaults: {}, instances: {} };
  fm.scheduleDeliveryOutboxPump = () => {};
  const notify = vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});
  fm.ensureDeliveryOutbox();
  managers.push(fm);
  stores.push(fm.deliveryOutbox);
  return { fm, notify, outbox: fm.deliveryOutbox as DeliveryOutbox };
}
const oldJargon = /durable delivery|durably accepted|outbox bound|unresolved submissions|bounded retr|best-effort-submission:unverified|until .*reconciles/i;
function readable(text: string, locale: Locale) {
  expect(text).not.toMatch(oldJargon);
  expect(text).not.toMatch(/\{\d+\}/);
  expect(text).not.toMatch(/^delivery\./);
  if (locale === "zh-TW") expect(text).toMatch(/[\u4e00-\u9fff]/);
}
afterEach(() => {
  vi.useRealTimers();
  for (const fm of managers.splice(0)) {
    clearInterval(fm.replyObligationTimer);
    fm.wakeCoordinator?.stop();
  }
  for (const outbox of stores.splice(0)) if (outbox.isOpen) outbox.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  setLocale("en");
});

describe.each<Locale>(["en", "zh-TW"])("delivery notices in %s", locale => {
  beforeEach(() => setLocale(locale));

  it("has matching keys and placeholders in both dictionaries, without old jargon", () => {
    const source = readFileSync(join(process.cwd(), "src/locale.ts"), "utf8");
    const pairs = [...source.matchAll(/"(delivery\.[^"]+)": ("(?:[^"\\]|\\.)*")/g)];
    const values = new Map<string, string[]>();
    for (const [, key, value] of pairs) values.set(key!, [...(values.get(key!) ?? []), JSON.parse(value!)]);
    expect(values.size).toBeGreaterThan(50);
    for (const [key, texts] of values) {
      expect(texts, key).toHaveLength(2);
      expect(texts[0]!.match(/\{\d+\}/g)?.sort(), key).toEqual(texts[1]!.match(/\{\d+\}/g)?.sort());
      expect(t(key, "worker", "op-1", 2, "detail", "cid-1"), key).not.toBe(key);
      for (const text of texts) expect(text, key).not.toMatch(oldJargon);
    }
  });

  it.each(["failed", "uncertain"] as const)("localizes %s outcome and leaves stored evidence and retry policy intact", outcome => {
    const outbox = store();
    const row = admit(outbox);
    finish(outbox, outcome, "best-effort-submission:unverified");
    const notice = outbox.listPending().find(r => r.kind === "delivery_outcome_notice")!;
    const text = String(notice.payload.content);
    readable(text, locale);
    expect(text.split("\n")[0]).toContain("worker");
    expect(text.split("\n")[0]).not.toMatch(/operation_id|delivery_id|state=/);
    expect(text).toContain(`state=${outcome}`);
    expect(text).toContain(`operation_id=${row.operationId}`);
    expect(text).toContain(`delivery_id=${row.deliveryId}`);
    expect(text).toContain(locale === "en" ? (outcome === "uncertain" ? "Do not resend" : "Report this to the operator") : (outcome === "uncertain" ? "不要重送" : "請向操作者回報"));
    expect(outbox.get(row.deliveryId)).toMatchObject({ state: outcome, lastError: "best-effort-submission:unverified", payload: { content: "original message" } });
    const status = outbox.queryStatusForInstance("sender", { deliveryId: row.deliveryId }).items[0]!;
    expect(status.safe_to_retry).toBe(outcome === "failed");
    if (outcome === "failed") {
      expect(text).not.toContain(locale === "en" ? "Do not resend" : "不要重送");
      expect(status.error_summary).not.toContain(locale === "en" ? "Do not resend" : "不要重送");
    }
  });

  it("localizes every status and error summary without exposing raw errors", () => {
    const outbox = store();
    const row = admit(outbox);
    const db = (outbox as any).db;
    const states: OutboxState[] = ["queued", "delivering", "retry_wait", "submission_started", "reconciliation_pending", "delivered", "failed", "uncertain", "cancelled"];
    for (const state of states) {
      db.prepare("UPDATE deliveries SET state=?,reconciliation_pending=? WHERE delivery_id=?").run(state === "reconciliation_pending" ? "submission_started" : state, Number(state === "reconciliation_pending"), row.deliveryId);
      db.prepare("UPDATE deliveries SET last_error=? WHERE delivery_id=?").run("best-effort-submission:unverified", row.deliveryId);
      const result = outbox.queryStatusForInstance("sender", { deliveryId: row.deliveryId }).items[0]!;
      readable(result.status_summary, locale);
      if (result.safe_to_retry) expect(result.error_summary).not.toContain(locale === "en" ? "Do not resend" : "不要重送");
      expect(result.state).toBe(state);
      expect(result.safe_to_retry).toBe(["queued", "delivering", "retry_wait", "failed"].includes(state));
      if (state === "delivered") expect(result.status_summary).toContain(locale === "en" ? "does not mean the agent finished" : "不代表 agent 已處理完畢");
    }
    for (const error of ["TTL expired", "attempt limit", "reconciliation required", "best-effort-submission:unverified", "/private/auth.json secret-token"]) {
      db.prepare("UPDATE deliveries SET last_error=? WHERE delivery_id=?").run(error, row.deliveryId);
      const result = outbox.queryStatusForInstance("sender", { deliveryId: row.deliveryId }).items[0]!;
      readable(result.error_summary!, locale);
      expect(result.error_summary).not.toContain(error);
      if (error.includes("unverified")) expect(result.error_summary).toContain(locale === "en" ? "Do not resend" : "不要重送");
    }
  });

  it("localizes restart and both reply reminder paths with usable tool IDs", () => {
    const outbox = store();
    const row = admit(outbox, "op-reply", true);
    finish(outbox, "delivered", "confirmed");
    const recovery = outbox.admitPostRestartOutcomeNotice(outbox.get(row.deliveryId)!, "source-next-boot")!;
    readable(String(recovery.payload.content), locale);
    expect(recovery.payload.content).toContain(locale === "en" ? "Do not resend this operation" : "請不要重送");
    expect(recovery.payload.content).toContain("delivery_status");
    // Reply obligations are opened when the request is delivered; each reminder is idempotent.
    for (const [index, reason] of (["turn-ended", "restart"] as const).entries()) {
      const now = new Date(Date.now() + 120_000 + index * 1000);
      expect(outbox.remindReplyObligations("worker", { now, since: now, graceMs: 0, reason })).toBe(1);
    }
    outbox.notifyOverdueReplyObligations({ now: new Date(Date.now() + 240_000), overdueMs: 1, ownerIdle: () => true });
    const notices = outbox.listPending().filter(r => r.kind === "reply_obligation_notice");
    expect(notices).toHaveLength(3);
    for (const notice of notices) {
      const text = String(notice.payload.content);
      readable(text, locale);
      expect(text).toContain("correlation_id=cid-op-reply");
      expect(text).toContain(notice.targetInstance === "worker" ? "report_result" : "describe_instance");
      expect(text.split("\n")[0]).not.toContain("correlation_id=");
    }
  });

  it("uses locale on real fleet failure and 24-hour expiry event listeners", () => {
    const { outbox, notify } = quietFleet();
    const row = admit(outbox);
    finish(outbox, "uncertain", "best-effort-submission:unverified");
    const first = String(notify.mock.calls[0]![0]);
    readable(first, locale);
    expect(first).toContain(locale === "en" ? "could not be confirmed" : "無法確認");
    expect(first).toContain(`delivery_id=${row.deliveryId}`);
    expect(first).toContain("target=worker");
    // Expiry creates a failed sender notice and a batch notice; do not alter either event.
    const expired = admit(outbox, "op-expiry");
    expect(outbox.expireStale(Date.parse(expired.createdAt!) + DURABLE_DELIVERY_MAX_AGE_MS + 1)).toBeGreaterThan(0);
    const batch = String(notify.mock.calls.at(-1)![0]);
    readable(batch, locale);
    expect(batch).toContain("24");
    expect(batch).toContain(locale === "en" ? "Notices to the sending instances have been queued" : "通知已排入佇列");
    expect(outbox.get(expired.deliveryId)?.state).toBe("failed");
  });

  it("localizes the long lane wait notice without releasing the lane", async () => {
    vi.useFakeTimers();
    const { fm, outbox, notify } = quietFleet();
    const row = admit(outbox);
    const claimed = outbox.claimNext("manager", () => "worker-boot", new Set())!;
    // The store was created with the FleetManager's boot ID.
    const waiting = fm.waitForDurableLaneRelease(claimed) as Promise<void>;
    await vi.advanceTimersByTimeAsync(DURABLE_DELIVERY_LANE_ALERT_MS);
    expect(notify).toHaveBeenCalledOnce();
    const text = String(notify.mock.calls[0]![0]);
    readable(text, locale);
    expect(text).toContain(`delivery_id=${row.deliveryId}`);
    expect(outbox.get(row.deliveryId)?.state).toBe("delivering");
    expect(outbox.begin(row.deliveryId, "worker-boot", claimed.attemptNo)).toBe("begun");
    expect(outbox.abort(row.deliveryId, "worker-boot", claimed.attemptNo, "test finished")).toBe(true);
    await waiting;
  });

  it("keeps MCP unknown-outcome and known-not-sent guidance distinct", () => {
    const unknown = encodeOperationError("IPC request timed out after 30000ms", "op-timeout");
    const safe = encodeOperationError("Not connected to daemon IPC", "op-preflight");
    readable(unknown, locale);
    readable(safe, locale);
    expect(unknown).toContain(locale === "en" ? "do not resend" : "不要重送");
    expect(safe).toContain(locale === "en" ? "safe to retry" : "可以安全重試");
    expect(safe).not.toContain(locale === "en" ? "do not resend" : "不要重送");
    expect(unknown.split("\n")[0]).not.toContain("operation_id=");
    expect(unknown).toContain("operation_id=op-timeout");
  });

  it("localizes daemon queue hold reasons without changing the null readiness signal", () => {
    const d = new Daemon("worker", { working_directory: "/tmp", log_level: "silent" } as any, tempRoot(), false, undefined, undefined, pino({ level: "silent" })) as any;
    d.pauseWakeState = "active";
    d.inputBlockedDialogKey = null;
    d.authFailureUnresolved = false;
    d.instanceState = "idle";
    expect(d.notAcceptingReason()).toBeNull();
    d.authFailureUnresolved = true;
    readable(d.notAcceptingReason(), locale);
    d.authFailureUnresolved = false;
    d.instanceState = "stuck";
    readable(d.notAcceptingReason(), locale);
    d.instanceState = "idle";
    d.inputBlockedDialogKey = "confirm";
    readable(d.notAcceptingReason(), locale);
    expect(d.notAcceptingReason()).toContain("confirm");
    d.inputBlockedDialogKey = null;
    d.pauseWakeState = "paused";
    readable(d.notAcceptingReason(), locale);
  });
});

describe("MCP child locale selection", () => {
  it.each(["en", "zh-TW"])("reads the fleet's %s setting in the actual stdio child", async locale => {
    const root = tempRoot();
    writeFileSync(join(root, "fleet.yaml"), `defaults:\n  locale: ${locale}\ninstances: {}\n`);
    const child = spawn(process.execPath, ["--import", "tsx", "src/channel/mcp-server.ts"], {
      cwd: process.cwd(), env: { ...process.env, AGEND_HOME: root, AGEND_SOCKET_PATH: join(root, "missing.sock") }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", data => { stderr += String(data); });
    const lines = createInterface({ input: child.stdout });
    try {
      const response = new Promise<any>((resolve, reject) => {
        lines.on("line", line => {
          try { const msg = JSON.parse(line); if (msg.id === 1) resolve(msg); } catch (err) { reject(err); }
        });
        child.once("exit", code => reject(new Error(`MCP exited ${code}: ${stderr}`)));
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_to_instance", arguments: { instance_name: "worker", message: "test" } } }) + "\n");
      const msg = await response;
      expect(msg.result.isError).toBe(true);
      const text = String(msg.result.content[0].text);
      expect(text).toContain(locale === "en" ? "safe to retry" : "可以安全重試");
      expect(text).toContain("operation_id=");
      expect(text).not.toContain(locale === "en" ? "do not resend" : "不要重送");
    } finally {
      lines.close();
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }, 15_000);
});


describe("delivery status CLI notices", () => {
  it.each(["en", "zh-TW"])("uses the configured %s locale for missing records and invalid selectors", locale => {
    const root = tempRoot();
    writeFileSync(join(root, "fleet.yaml"), `defaults:\n  locale: ${locale}\ninstances: {}\n`);
    const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "delivery", "show", ...args], {
      cwd: process.cwd(), env: { ...process.env, AGEND_HOME: root }, encoding: "utf8", timeout: 10_000,
    });
    const missing = run(["--delivery-id", "d-test"]);
    expect(missing.error).toBeUndefined();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(locale === "en" ? "No message delivery records" : "目前沒有訊息送達紀錄");
    const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager");
    stores.push(outbox);
    const invalid = run(["--delivery-id", "d-test", "--operation-id", "op-test"]);
    expect(invalid.error).toBeUndefined();
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain(locale === "en" ? "Specify exactly one" : "請只指定");
  }, 20_000);
});
