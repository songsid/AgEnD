import { describe, expect, it, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";

const meta = { instanceName: "worker", requestId: 1 };
function context(restricted = true) {
  return { hubContactRestricted: vi.fn(() => restricted),
    fleetConfig: { defaults: {}, instances: { worker: {}, peer: {} } }, adapter: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    lifecycle: { daemons: new Map(), isPaused: () => false }, instanceIpcClients: new Map([["peer", { connected: true, send: vi.fn() }]]), sessionRegistry: new Map(),
    classicChannels: null, eventLog: null, lastActivityMs: () => 0,
    deliverToInstance: vi.fn(async () => true), notifyInstanceTopic: vi.fn(),
  } as any;
}
async function call(tool: string, ctx: any, args: any) {
  const respond = vi.fn(); await outboundHandlers.get(tool)!(ctx, args, respond, meta as any); return respond;
}
describe("Hub-question contact limit", () => {
  it.each([
    ["send_to_instance", { instance_name: "peer", message: "ask" }],
    ["delegate_task", { target_instance: "peer", task: "ask" }],
    ["request_information", { target_instance: "peer", question: "ask" }],
    ["broadcast", { targets: ["peer"], message: "ask" }],
    ["broadcast", { message: "ask" }],
    ["send_to_instance", { instance_name: "agend-hub", correlation_id: "unknown", message: "ask" }],
    ["report_result", { target_instance: "peer", summary: "ask" }],
  ])("refuses %s before any outbound admission and explains why", async (tool, args) => {
    const ctx = context(); const response = await call(tool, ctx, args);
    expect(response).toHaveBeenCalledWith(null, expect.stringContaining("this turn is answering a Hub question"));
    expect(ctx.hubContactRestricted).toHaveBeenCalledWith("worker");
    expect(ctx.deliverToInstance).not.toHaveBeenCalled();
  });
  it("M-3660: names the Hub question it is for and says when it lifts, so the agent knows it is not stuck", async () => {
    for (const [tool, args] of [["send_to_instance", { instance_name: "peer", message: "ask" }], ["broadcast", { message: "ask" }]] as const) {
      const ctx = context(); ctx.hubContactQuestion = vi.fn(() => "hub-19a46113-ebfc-4e89-b0c4-f26b2f877d32");
      const text = (await call(tool, ctx, args)).mock.calls[0]![1] as string;
      expect(text).toContain("Hub question hub-19a46113-ebfc-4e89-b0c4-f26b2f877d32");
      expect(text).toContain("not stuck: it lifts when this answer turn ends.");
      expect(text).toContain("correlation_id hub-19a46113-ebfc-4e89-b0c4-f26b2f877d32");
      expect(ctx.hubContactQuestion).toHaveBeenCalledWith("worker");
      ctx.hubContactQuestion = vi.fn(() => { throw new Error("unreadable"); });   // unknown: the general reason, never a crash
      expect((await call(tool, ctx, args)).mock.calls[0]![1]).toContain("this turn is answering a Hub question");
    }
  });
  it("keeps the reserved Hub answer route available", async () => {
    const ctx = context(); ctx.hubReport = vi.fn(async () => ({ ok: true }));
    const response = await call("report_result", ctx, { target_instance: "agend-hub", correlation_id: "hub-123", summary: "answer" });
    expect(ctx.hubReport).toHaveBeenCalled(); expect(response.mock.calls[0]?.[1]).toBeUndefined();
  });
  it("does not block ordinary work outside a Hub answer", async () => {
    const ctx = context(false); const response = await call("send_to_instance", ctx, { instance_name: "peer", message: "ask" });
    expect(response.mock.calls[0]?.[1]).toBeUndefined(); expect(ctx.deliverToInstance).toHaveBeenCalled();
  });
});

import { HubContactWindows, HUB_CONTACT_WINDOW_MS } from "../src/hub-contact-windows.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
describe("durable independent Hub-question windows", () => {
  it("survives restart, closes only the answered question and expires at the exact boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-contact-")); let now = 10;
    try {
      const file = join(dir, "windows.json"), first = new HubContactWindows(file, () => now);
      expect(first.restricted("worker")).toBe(false);
      first.begin("worker", "hub-one"); now += 100; first.begin("worker", "hub-two");
      const restored = new HubContactWindows(file, () => now);
      restored.answered("someone-else", "hub-two"); restored.answered("worker", "hub-one");
      expect(restored.restricted("worker")).toBe(true); expect(restored.restricted("peer")).toBe(false);
      now = 110 + HUB_CONTACT_WINDOW_MS - 1; expect(restored.restricted("worker")).toBe(true);
      now++; expect(restored.restricted("worker")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("a retry does not renew the deadline; corrupt storage refuses contact and new input", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-contact-")); let now = 0;
    try {
      const file = join(dir, "windows.json"), windows = new HubContactWindows(file, () => now);
      windows.begin("worker", "hub-one"); now = HUB_CONTACT_WINDOW_MS - 1; windows.begin("worker", "hub-one");
      now++; expect(windows.restricted("worker")).toBe(false);
      windows.begin("worker", "hub-two"); expect(windows.restrictingQuestion("worker")).toBe("hub-two");   // M-3660: the refusal names it
      expect(windows.restrictingQuestion("worker", (_a, cid) => cid === "hub-two")).toBeNull(); expect(windows.restrictingQuestion("peer")).toBeNull();
      writeFileSync(file, "bad"); const broken = new HubContactWindows(file, () => now);
      expect(broken.restricted("worker")).toBe(true); expect(() => broken.begin("worker", "hub-two")).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
