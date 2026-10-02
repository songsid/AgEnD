import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sqliteOpenCalls = vi.hoisted(() => ({ options: [] as Array<unknown> }));
vi.mock("better-sqlite3", async importOriginal => {
  const actual = await importOriginal() as any;
  const RealDatabase = actual.default ?? actual;
  class ObservedDatabase extends RealDatabase {
    constructor(...args: any[]) {
      super(...args);
      sqliteOpenCalls.options.push(args[1] ?? {});
    }
  }
  return { ...actual, default: ObservedDatabase };
});
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { DeliveryStatusArgs } from "../src/outbound-schemas.js";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { dispatchAgentOperation, toolForAgentOp } from "../src/agent-endpoint.js";
import { TOOL_PROFILES } from "../src/tool-permissions.js";
import { FleetManager } from "../src/fleet-manager.js";

const roots: string[] = [];
function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "agend-delivery-status-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seed(outbox: DeliveryOutbox, operationId: string, source: string, target: string, correlationId: string) {
  return outbox.admit({
    operationId,
    sourceKey: `key:${operationId}:${target}`,
    sourceInstance: source,
    sourceDaemonBootId: `${source}-boot`,
    targetInstance: target,
    kind: "fleet_inbound",
    correlationId,
    payload: { type: "fleet_inbound", content: `secret payload ${operationId}`, meta: { transcript_path: "/private/session.jsonl" } },
  }).delivery;
}

describe("delivery_status query access", () => {
  it("scopes each row by authenticated source/target and paginates only visible correlation rows", () => {
    const root = tempRoot();
    const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager");
    const first = seed(outbox, "op-visible-1", "source", "worker", "shared-correlation");
    seed(outbox, "op-hidden", "other-source", "other-target", "shared-correlation");
    const third = seed(outbox, "op-visible-2", "source", "worker", "shared-correlation");
    (outbox as any).db.prepare("UPDATE deliveries SET last_error=? WHERE delivery_id=?")
      .run("/home/alice/private/session.jsonl secret-token", third.deliveryId);

    const firstPage = outbox.queryStatusForInstance("source", { correlationId: "shared-correlation", limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]).toMatchObject({ delivery_id: first.deliveryId, source_instance: "source" });
    expect(firstPage.next_cursor).toBe(first.deliveryId);
    expect(JSON.stringify(firstPage)).not.toContain("secret payload");
    expect(JSON.stringify(firstPage)).not.toContain("session.jsonl");

    const secondPage = outbox.queryStatusForInstance("source", {
      correlationId: "shared-correlation", limit: 1, cursor: firstPage.next_cursor!,
    });
    expect(secondPage.items).toMatchObject([
      { delivery_id: third.deliveryId, error_summary: "A delivery error was recorded; check the logs for details." },
    ]);
    expect(secondPage.next_cursor).toBeNull();
    expect(outbox.queryStatusForInstance("worker", { operationId: "op-visible-1" }).items)
      .toMatchObject([{ delivery_id: first.deliveryId }]);
    expect(outbox.queryStatusForInstance("outsider", { deliveryId: first.deliveryId }).items).toEqual([]);
    expect(outbox.queryStatusForInstance("outsider", { operationId: "op-hidden" }).items).toEqual([]);
    expect(outbox.get(first.deliveryId)?.state).toBe("queued"); // query is read-only
    outbox.close();
  });

  it("registers a read-only MCP/HTTP handler and trusts the authenticated instance, not spoofed args/session labels", async () => {
    expect(TOOLS.some(tool => tool.name === "delivery_status")).toBe(true);
    expect(outboundHandlers.has("delivery_status")).toBe(true);
    expect(toolForAgentOp("delivery-status")).toBe("delivery_status");
    for (const profile of ["worker", "general", "standard", "minimal"] as const) {
      expect(TOOL_PROFILES[profile]).toContain("delivery_status");
    }
    expect(DeliveryStatusArgs.safeParse({ delivery_id: "id", caller_instance: "source" }).success).toBe(false);
    expect(DeliveryStatusArgs.safeParse({ operation_id: "op", correlation_id: "corr" }).success).toBe(false);

    const root = tempRoot();
    const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager");
    const row = seed(outbox, "op-auth", "source", "worker", "corr-auth");
    seed(outbox, "op-auth-hidden", "unrelated", "elsewhere", "corr-auth");
    const secondVisible = seed(outbox, "op-auth-visible-2", "source", "worker", "corr-auth");
    const manager = new FleetManager(root);
    manager.deliveryOutbox = outbox;
    manager.fleetConfig = {
      defaults: {},
      instances: {
        source: { tool_set: "worker", working_directory: root },
        worker: { tool_set: "worker", working_directory: root },
        outsider: { tool_set: "worker", working_directory: root },
      },
    } as any;
    (manager as any).adapter = {};
    (manager as any).worlds.set("default-world", { id: "default-world", adapter: {} });
    const sourceIpc = { send: vi.fn(() => true) };
    const outsiderIpc = { send: vi.fn(() => true) };
    manager.instanceIpcClients.set("source", sourceIpc as any);
    manager.instanceIpcClients.set("outsider", outsiderIpc as any);

    await (manager as any).handleOutboundFromInstance("source", {
      tool: "delivery_status", args: { delivery_id: row.deliveryId }, requestId: 19,
      senderSessionName: "outsider", fleetRequestId: "mcp-status-source",
    });
    expect(sourceIpc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "fleet_outbound_response", fleetRequestId: "mcp-status-source",
      result: { items: expect.arrayContaining([expect.objectContaining({ delivery_id: row.deliveryId })]), next_cursor: null },
    }));
    await (manager as any).handleOutboundFromInstance("outsider", {
      tool: "delivery_status", args: { delivery_id: row.deliveryId }, requestId: 20,
      senderSessionName: "source", fleetRequestId: "mcp-status-outsider",
    });
    expect(outsiderIpc.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "fleet_outbound_response", fleetRequestId: "mcp-status-outsider",
      result: null, error: "Delivery not found",
    }));

    const statusFor = (caller: string, args: Record<string, unknown>) =>
      dispatchAgentOperation(manager as any, caller, "delivery-status", args);
    await expect(statusFor("source", { delivery_id: row.deliveryId }))
      .resolves.toMatchObject({ items: [{ delivery_id: row.deliveryId }] });
    await expect(statusFor("outsider", { delivery_id: row.deliveryId, caller_instance: "source" }))
      .resolves.toMatchObject({ error: expect.stringContaining("Invalid args") });
    await expect(statusFor("outsider", { delivery_id: row.deliveryId }))
      .resolves.toEqual({ error: "Delivery not found" });
    await expect(statusFor("worker", { operation_id: "op-auth" }))
      .resolves.toMatchObject({ items: [{ delivery_id: row.deliveryId }] });
    const page1 = await statusFor("source", { correlation_id: "corr-auth", limit: 1 }) as any;
    expect(page1.items).toMatchObject([{ delivery_id: row.deliveryId }]);
    expect(page1.next_cursor).toBe(row.deliveryId);
    const page2 = await statusFor("source", { correlation_id: "corr-auth", limit: 1, cursor: page1.next_cursor }) as any;
    expect(page2.items).toMatchObject([{ delivery_id: secondVisible.deliveryId }]);
    expect(page2.items.some((item: { operation_id: string }) => item.operation_id === "op-auth-hidden")).toBe(false);
    expect(JSON.stringify(page1) + JSON.stringify(page2)).not.toContain("secret payload");

    const handler = outboundHandlers.get("delivery_status")!;
    const senderSpoofResult = await new Promise<unknown>(resolve => handler(manager as any,
      { delivery_id: row.deliveryId }, resolve, {
        instanceName: "source", requestId: 1, fleetRequestId: undefined, senderSessionName: "outsider",
      }));
    expect(senderSpoofResult).toMatchObject({ items: [{ delivery_id: row.deliveryId }] });

    const query = vi.fn(() => ({ items: [], next_cursor: null }));
    const missingIdentity = await new Promise<{ result: unknown; error?: string }>(resolve => handler({
      queryDurableDeliveryStatus: query,
      logger: { warn: vi.fn() },
    } as any, { delivery_id: row.deliveryId }, (result, error) => resolve({ result, error }), {
      instanceName: "", requestId: 1, fleetRequestId: undefined, senderSessionName: "source",
    }));
    expect(missingIdentity).toEqual({ result: null, error: "Delivery not found" });
    expect(query).not.toHaveBeenCalled();
    outbox.close();
  });

  it("exposes an audited operator CLI query without opening the database for writes", () => {
    const root = tempRoot();
    const dbPath = join(root, "delivery-outbox.db");
    const outbox = new DeliveryOutbox(dbPath, "manager");
    const row = seed(outbox, "op-cli", "source", "worker", "corr-cli");
    outbox.close();
    const beforeReadOnlyQuery = sqliteOpenCalls.options.length;
    expect(DeliveryOutbox.queryStatusReadOnly(dbPath, { deliveryId: row.deliveryId }).items)
      .toMatchObject([{ delivery_id: row.deliveryId }]);
    expect(sqliteOpenCalls.options.slice(beforeReadOnlyQuery)).toContainEqual(
      expect.objectContaining({ readonly: true, fileMustExist: true }),
    );
    const output = execFileSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), join(process.cwd(), "src", "cli.ts"),
      "delivery", "show", "--delivery-id", row.deliveryId,
    ], { encoding: "utf8", env: { ...process.env, AGEND_HOME: root } });
    expect(JSON.parse(output).items).toMatchObject([{ delivery_id: row.deliveryId, operation_id: "op-cli" }]);
    expect(output).not.toContain("secret payload");
    const auditPath = join(root, "delivery-audit", "queries.jsonl");
    expect(existsSync(auditPath)).toBe(true);
    expect(statSync(join(root, "delivery-audit")).mode & 0o777).toBe(0o700);
    expect(statSync(auditPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(auditPath, "utf8"))).toMatchObject({
      selector: { delivery_id: row.deliveryId }, result_count: 1,
    });
  });
});
