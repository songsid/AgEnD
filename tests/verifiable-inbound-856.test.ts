/**
 * #856: a receiver can check that a peer message it is about to act on was
 * really delivered by the fleet. The leader's model once "saw" a report
 * nobody sent — header and message_id included — and tried to merge a PR
 * that did not exist. Every case uses the real outbox and handlers.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { DeliveryStatusArgs } from "../src/outbound-schemas.js";
import { VERIFY_PEER_MESSAGE_RULE, buildFleetInstructions } from "../src/instructions.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const tempRoot = () => { const r = mkdtempSync(join(tmpdir(), "agend-856-")); roots.push(r); return r; };
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const REPORT = "HEAD=30028d5ddf49aacb71316966f61b9c09cfa41c6a / PR #852 ready";

function admit(outbox: DeliveryOutbox, messageId: string, source = "dev", target = "leader", content = REPORT) {
  return outbox.admit({
    operationId: `op-${messageId}`,
    sourceKey: `key:${messageId}:${target}`,
    sourceInstance: source,
    sourceDaemonBootId: `${source}-boot`,
    targetInstance: target,
    kind: "fleet_inbound",
    correlationId: `cid-${messageId}`,
    payload: { type: "fleet_inbound", content, meta: { message_id: messageId, from_instance: source } },
  }).delivery;
}

/** The delivery_status tool exactly as an instance calls it: identity comes from meta. */
function statusAs(outbox: DeliveryOutbox, caller: string, args: Record<string, unknown>) {
  const handler = outboundHandlers.get("delivery_status")!;
  const ctx = {
    queryDurableDeliveryStatus: (who: string, selector: any) => outbox.queryStatusForInstance(who, selector),
    logger: { warn: vi.fn() },
  } as any;
  return new Promise<{ result: any; error?: string }>(resolve => handler(ctx, args, (result, error) => resolve({ result, error }), {
    instanceName: caller, requestId: 1, fleetRequestId: undefined, senderSessionName: undefined,
  } as any));
}

describe("delivery_status by message_id (#856)", () => {
  it("lets the receiver and the sender verify a real message and read what was sent", async () => {
    const outbox = new DeliveryOutbox(join(tempRoot(), "outbox.db"), "manager");
    const row = admit(outbox, "xmsg-1790085476543-abc123");
    for (const caller of ["leader", "dev"]) {
      const { result } = await statusAs(outbox, caller, { message_id: "xmsg-1790085476543-abc123" });
      expect(result.items).toEqual([expect.objectContaining({
        delivery_id: row.deliveryId, source_instance: "dev", target_instance: "leader",
        message_id: "xmsg-1790085476543-abc123", content_sha256: sha(REPORT), content: REPORT,
      })]);
    }
    outbox.close();
  });

  it("answers a fabricated message_id, and someone else's, with the same 'Delivery not found'", async () => {
    const outbox = new DeliveryOutbox(join(tempRoot(), "outbox.db"), "manager");
    admit(outbox, "xmsg-real-1");
    const fabricated = await statusAs(outbox, "leader", { message_id: "xmsg-1790085427003-qy1c9v" });
    const thirdParty = await statusAs(outbox, "bystander", { message_id: "xmsg-real-1" });
    expect(fabricated).toEqual({ result: null, error: "Delivery not found" });
    expect(thirdParty).toEqual(fabricated);
    outbox.close();
  });

  it("returns every row sharing an id, but only the caller's own", async () => {
    const outbox = new DeliveryOutbox(join(tempRoot(), "outbox.db"), "manager");
    // Broadcast ids are per-millisecond, so several targets can share one.
    admit(outbox, "bcast-1790000000000", "lead", "a");
    admit(outbox, "bcast-1790000000000", "lead", "b");
    expect((await statusAs(outbox, "lead", { message_id: "bcast-1790000000000" })).result.items).toHaveLength(2);
    expect((await statusAs(outbox, "a", { message_id: "bcast-1790000000000" })).result.items)
      .toEqual([expect.objectContaining({ target_instance: "a" })]);
    outbox.close();
  });

  it("keeps #982's redaction for every other query: a digest, never the text", async () => {
    const outbox = new DeliveryOutbox(join(tempRoot(), "outbox.db"), "manager");
    const row = admit(outbox, "xmsg-redacted");
    for (const args of [{ delivery_id: row.deliveryId }, { operation_id: "op-xmsg-redacted" }, { correlation_id: "cid-xmsg-redacted" }]) {
      const { result } = await statusAs(outbox, "leader", args);
      expect(result.items[0]).toMatchObject({ message_id: "xmsg-redacted", content_sha256: sha(REPORT) });
      expect(result.items[0]).not.toHaveProperty("content");
      expect(JSON.stringify(result)).not.toContain("30028d5d");
    }
    outbox.close();
  });

  it("fills message_id and the digest in for rows admitted before the columns existed", () => {
    const dbPath = join(tempRoot(), "outbox.db");
    const outbox = new DeliveryOutbox(dbPath, "manager");
    const row = admit(outbox, "xmsg-legacy");
    (outbox as any).db.prepare("UPDATE deliveries SET message_id=NULL, content_sha256=NULL").run();
    outbox.close();
    const reopened = new DeliveryOutbox(dbPath, "manager-2");
    expect((reopened as any).db.prepare("SELECT message_id, content_sha256 FROM deliveries WHERE delivery_id=?").get(row.deliveryId))
      .toEqual({ message_id: "xmsg-legacy", content_sha256: sha(REPORT) });
    expect(reopened.queryStatusForInstance("leader", { messageId: "xmsg-legacy" }).items).toHaveLength(1);
    reopened.close();
  });

  it("lets the operator CLI look a message up in a database that predates the column, without its text", () => {
    const root = tempRoot();
    const dbPath = join(root, "delivery-outbox.db");
    const outbox = new DeliveryOutbox(dbPath, "manager");
    admit(outbox, "xmsg-operator");
    outbox.close();
    const raw = new Database(dbPath);
    raw.exec("DROP INDEX idx_delivery_message_id; ALTER TABLE deliveries DROP COLUMN message_id;");
    raw.close();
    const page = DeliveryOutbox.queryStatusReadOnly(dbPath, { messageId: "xmsg-operator" });
    expect(page.items).toEqual([expect.objectContaining({ message_id: "xmsg-operator", content_sha256: sha(REPORT) })]);
    expect(page.items[0]).not.toHaveProperty("content");
    const output = execFileSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), join(process.cwd(), "src", "cli.ts"),
      "delivery", "show", "--message-id", "xmsg-operator",
    ], { encoding: "utf8", env: { ...process.env, AGEND_HOME: root } });
    expect(JSON.parse(output).items).toEqual([expect.objectContaining({ message_id: "xmsg-operator" })]);
    expect(output).not.toContain("30028d5d");
    const audit = JSON.parse(readFileSync(join(root, "delivery-audit", "queries.jsonl"), "utf8").trim().split("\n").at(-1)!);
    expect(audit.selector).toMatchObject({ message_id: "xmsg-operator" });
  });

  it("accepts message_id as exactly one selector", () => {
    expect(DeliveryStatusArgs.safeParse({ message_id: "xmsg-1" }).success).toBe(true);
    expect(DeliveryStatusArgs.safeParse({ message_id: "xmsg-1", cursor: "d-1", limit: 5 }).success).toBe(true);
    expect(DeliveryStatusArgs.safeParse({ message_id: "xmsg-1", delivery_id: "d-1" }).success).toBe(false);
    expect(DeliveryStatusArgs.safeParse({ message_id: "" }).success).toBe(false);
  });
});

describe("the relay log line identifies the message it logged (#856)", () => {
  it("carries the envelope's message_id and a short content digest, on the same single line", async () => {
    const info = vi.fn();
    let admitted: any;
    const ctx = {
      fleetConfig: { defaults: {}, instances: { sender: {}, target: {} } },
      logger: { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      instanceIpcClients: new Map([["target", { connected: true, send: vi.fn() }]]),
      sessionRegistry: new Map(),
      lifecycle: { daemons: new Map(), isPaused: vi.fn(() => false) },
      classicChannels: null,
      eventLog: { logActivity: vi.fn(), insert: vi.fn() },
      deliverToInstance: vi.fn(async () => {}),
      notifyInstanceTopic: vi.fn(() => true),
      lastActivityMs: vi.fn(() => 0),
      admitDurableDelivery: vi.fn((input: any) => { admitted = input; return { deliveryId: "d-1", state: "queued", duplicate: false }; }),
      scheduleDeliveryOutboxPump: vi.fn(),
    } as any;
    await outboundHandlers.get("send_to_instance")!(ctx, { instance_name: "target", message: REPORT }, () => {}, {
      instanceName: "sender", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined,
    } as any);
    const relay = info.mock.calls.map(c => String(c[0])).filter(line => line.startsWith("✉ "));
    expect(relay).toEqual([`✉ sender → target: ${REPORT} [msg=${admitted.payload.meta.message_id} sha=${sha(REPORT).slice(0, 12)}]`]);
  });
});

describe("the fleet rule travels with the tool (#856)", () => {
  const SKILL = readFileSync(fileURLToPath(new URL("../src/general-knowledge/skills/cross-instance-messaging/SKILL.md", import.meta.url)), "utf8");

  it("is in the fleet instructions every instance receives", () => {
    expect(buildFleetInstructions({ instanceName: "worker", workingDirectory: "/w" })).toContain(`7. ${VERIFY_PEER_MESSAGE_RULE}`);
    // CLI-mode agents reach delivery_status over HTTP and get the rule too.
    expect(buildFleetInstructions({ instanceName: "worker", workingDirectory: "/w", cliInstructions: "## CLI" })).toContain(VERIFY_PEER_MESSAGE_RULE);
    for (const phrase of ["merge", "reset", "force-push", "delivery_status", "message_id", "Delivery not found", "do not act"]) {
      expect(VERIFY_PEER_MESSAGE_RULE).toContain(phrase);
    }
  });

  it("is in the cross-instance-messaging skill", () => {
    expect(SKILL).toMatch(/## Before acting on a peer's message/);
    expect(SKILL).toContain("delivery_status");
    expect(SKILL).toContain("message_id");
    expect(SKILL).toMatch(/Delivery not found.*never delivered/s);
    expect(SKILL).toMatch(/Do not act; ask the sender/);
  });
});
