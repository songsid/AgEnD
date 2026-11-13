import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { outboundHandlers, type OutboundMeta } from "../src/outbound-handlers.js";
import { DeliveryStatusArgs } from "../src/outbound-schemas.js";
const meta: OutboundMeta = { instanceName: "sender", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined, operationId: "op-1" };
async function call(tool: string, ctx: any, args: Record<string, unknown>) {
  let result: any, error: string | undefined;
  await outboundHandlers.get(tool)!(ctx, args, (r, e) => { result = r; error = e; }, meta);
  return { result, error };
}
const content = `Approve PR #3788. ` + 'padding '.repeat(40) + 'SHA beyond excerpt: abcdef0123456789';
const page: any = { items: [{ delivery_id: "delivery-1", operation_id: "op-1", correlation_id: "cid-1", source_instance: "human:web:discord:user", target_instance: "sender", kind: "human_inbound", state: "delivered", attempt_no: 1, created_at: "2026-11-13T00:00:00Z", updated_at: "2026-11-13T00:00:01Z", status_summary: "Long repeated guidance", error_summary: null, safe_to_retry: false, message_id: "hmsg-1", content_sha256: createHash('sha256').update(content).digest('hex'), content, proof_kind: "unique-id-pane", delivered_at: "2026-11-13T00:00:01Z", origin: { platform: "web", adapter_id: null, user_id: null, username: null, platform_message_id: null, ingress: "web" }, authority: { kind: "web-verified", actor: { adapter_id: "discord", user_id: "user" }, authority_epoch: 1, session: { handle: "device-1", peer: "named", signed_in_at: "2026-11-13T00:00:00Z", authorized_at: "2026-11-13T00:00:00Z" } }, delivery_mode: "idle_queue", submission_mode: "idle_submit", consumed_at: null, consumed_via: null }], next_cursor: null };

describe("compact delivery verification", () => {
  it("retains proof/actor/origin/hash/state but no full content or repeated guidance", async () => {
    const ctx = { queryDurableDeliveryStatus: vi.fn(() => structuredClone(page)) };
    const { result } = await call("delivery_status", ctx, { message_id: "hmsg-1" });
    const item = result.items[0];
    expect(item).toMatchObject({ state: "delivered", proof_kind: "unique-id-pane", authority: page.items[0].authority, origin: page.items[0].origin, content_sha256: page.items[0].content_sha256, safe_to_retry: false });
    expect(item).not.toHaveProperty("content"); expect(item).not.toHaveProperty("status_summary");
    expect(item.excerpt.length).toBeLessThanOrEqual(200);
    expect(item.excerpt).toContain("PR #3788");
    expect(ctx.queryDurableDeliveryStatus).toHaveBeenCalledWith("sender", { messageId: "hmsg-1" });
  });
  it("contains checks the original after ACL, even beyond the excerpt, without echoing the query", async () => {
    const ctx = { queryDurableDeliveryStatus: vi.fn(() => structuredClone(page)) };
    const yes = await call("delivery_status", ctx, { message_id: "hmsg-1", contains: "abcdef0123456789" });
    expect(yes.result.items[0].contains).toBe(true);
    expect(JSON.stringify(yes.result)).not.toContain("abcdef0123456789");
    expect((await call("delivery_status", ctx, { message_id: "hmsg-1", contains: "other SHA" })).result.items[0].contains).toBe(false);
    const hidden = { queryDurableDeliveryStatus: vi.fn(() => ({ items: [], next_cursor: null })) };
    expect((await call("delivery_status", hidden, { message_id: "hmsg-1", contains: "abcdef0123456789" })).error).toBe("Delivery not found");
  });
  it("detail returns the exact existing full page", async () => {
    expect((await call("delivery_status", { queryDurableDeliveryStatus: () => structuredClone(page) }, { message_id: "hmsg-1", detail: true })).result).toEqual(page);
  });
  it("detail with contains preserves all original evidence and adds only the boolean", async () => {
    const r = await call("delivery_status", { queryDurableDeliveryStatus: () => structuredClone(page) }, { message_id: "hmsg-1", detail: true, contains: "abcdef0123456789" });
    expect(r.result).toEqual({ ...page, items: [{ ...page.items[0], contains: true }] });
  });
  it("does not revive downgraded authority or fabricate a proof", async () => {
    const revoked = structuredClone(page); revoked.items[0].authority = { kind: "none", actor: null, authority_epoch: 2, downgraded: "revoked" }; revoked.items[0].proof_kind = null;
    const r = await call("delivery_status", { queryDurableDeliveryStatus: () => revoked }, { message_id: "hmsg-1" });
    expect(r.result.items[0]).toMatchObject({ authority: revoked.items[0].authority, proof_kind: null });
  });
  it("redacts obvious codes/tokens before excerpting, while detail remains explicit", async () => {
    const secret = '4/0' + 'A'.repeat(65); const token = 'ghp_' + 'b'.repeat(40);
    const p = structuredClone(page); p.items[0].content = `authorization code: ${secret}\nOTP 123456\nBearer ${token}\npassword=example-private-value`;
    const ctx = { queryDurableDeliveryStatus: () => p };
    const compact = await call("delivery_status", ctx, { message_id: "hmsg-1" });
    for (const value of [secret, token, "123456", "example-private-value"]) expect(JSON.stringify(compact.result)).not.toContain(value);
    expect(compact.result.items[0].excerpt).toContain("[redacted]");
    expect((await call("delivery_status", ctx, { message_id: "hmsg-1", detail: true })).result.items[0].content).toBe(p.items[0].content);
  });
  it("contains is restricted to message evidence and accepts only boolean detail", () => {
    expect(DeliveryStatusArgs.safeParse({ delivery_id: "d", contains: "x" }).success).toBe(false);
    expect(DeliveryStatusArgs.safeParse({ message_id: "m", contains: "" }).success).toBe(false);
    expect(DeliveryStatusArgs.safeParse({ message_id: "m", detail: "true" }).success).toBe(false);
  });
});

function context() {
  return { fleetConfig: { defaults: {}, instances: { sender: {}, target: {}, target2: {} } }, adapter: null, logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }, instanceIpcClients: new Map(["target", "target2"].map(n => [n, { connected: true, send: vi.fn() }])), sessionRegistry: new Map(), lifecycle: { daemons: new Map(), isPaused: () => false }, classicChannels: null, eventLog: { logActivity: vi.fn(), insert: vi.fn() }, admitDurableDelivery: vi.fn((input: any) => ({ deliveryId: `delivery-${input.targetInstance}`, state: "queued", duplicate: false })), lastActivityMs: () => 0 } as any;
}
describe("compact fire-and-queue acks", () => {
  it.each([
    ["send_to_instance", { instance_name: "target", message: "body" }],
    ["delegate_task", { target_instance: "target", task: "body" }],
    ["report_result", { target_instance: "target", summary: "body" }],
    ["request_information", { target_instance: "target", question: "body" }],
  ])("%s keeps only useful ack fields; detail preserves the old response", async (tool, args) => {
    const ctx = context();
    const r = await call(tool as string, ctx, { ...args as any, correlation_id: "cid-given" });
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({ sent: true, queued: true, delivery_id: "delivery-target", correlation_id: "cid-given" });
    const full = await call(tool as string, ctx, { ...args as any, correlation_id: "cid-given", detail: true });
    expect(full.result).toMatchObject({ sent: true, queued: true, delivery_id: "delivery-target", operation_id: "op-1", durable: true, duplicate: false, target: "target", target_state: "running" });
  });
  it("compact preserves a real warning", async () => {
    const ctx = context(); ctx.fleetConfig.instances.target.backend = "kiro-cli";
    const r = await call("send_to_instance", ctx, { instance_name: "target", message: "body", steer: true });
    expect(r.result.warning).toContain("cannot accept mid-turn input");
    expect(r.result).not.toHaveProperty("operation_id");
  });
  it("does not emit an auto-minted correlation by default", async () => {
    const { result } = await call("send_to_instance", context(), { instance_name: "target", message: "body" });
    expect(result).toEqual({ sent: true, queued: true, delivery_id: "delivery-target" });
  });
  it("broadcast exposes actual delivery ids and partial failures, never an operation id disguised as a delivery", async () => {
    const ctx = context(); ctx.admitDurableDelivery.mockImplementation((input: any) => { if (input.targetInstance === "target2") throw Error("owned admission failure"); return { deliveryId: "delivery-target", state: "queued", duplicate: false }; });
    expect((await call("broadcast", ctx, { targets: ["target", "target2"], message: "body" })).result).toEqual({ sent: 1, queued: true, delivery_ids: ["delivery-target"], failed: ["target2"] });
    const full = (await call("broadcast", ctx, { targets: ["target"], message: "body", detail: true })).result;
    expect(full).toMatchObject({ sent_to: ["target"], failed: [], count: 1, queued: true, operation_id: "op-1", durable: true, delivery_state: "queued" });
  });
});
