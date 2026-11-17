import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeToolCall } from "../src/channel/tool-router.js";
import { dispatchAgentOperation } from "../src/agent-endpoint.js";
import { ReplyDeduper, replyDedupText } from "../src/reply-dedup.js";
import { nativePaneToolRefusal } from "../src/native-pane-tools.js";
import { WebChatHistory } from "../src/web-chat-history.js";
import { guestMessage } from "../src/web-guest-access.js";
import { FleetManager } from "../src/fleet-manager.js";
vi.mock("../src/logger.js", async original => { const silent: any = new Proxy({}, { get: (_t, key) => key === "child" ? () => silent : () => {} }); return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent }; });
const refs = [{ path: "src/app.ts", line: 1000, endLine: 1002 }];
const homes: string[] = [];
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const adapter = () => ({ id: "discord", type: "discord", sendText: vi.fn(async () => ({ messageId: "900000000000000001", chatId: "900000000000000002" })), sendFile: vi.fn() });
function route(a: ReturnType<typeof adapter>, args: Record<string, unknown>) { return new Promise<{ result: unknown; error?: string }>(resolve => routeToolCall(a as any, "reply", { chat_id: "900000000000000002", ...args }, undefined, (result, error) => resolve({ result, error }))); }
describe("reply previews through the shared router and CLI HTTP path", () => {
  it("sends plain references on the channel without changing the web caption", async () => {
    const a = adapter(), args = { text: "Changed.", previews: refs };
    expect((await route(a, args)).error).toBeUndefined();
    expect(a.sendText).toHaveBeenCalledWith("900000000000000002", "Changed.\n\nsrc/app.ts:1000-1002", expect.anything());
    expect(args.text).toBe("Changed.");
  });
  it("refuses raw MCP traversal arguments before any channel send", async () => {
    const a = adapter(); expect((await route(a, { text: "Changed.", previews: [{ path: "../hidden.txt" }] })).error).toContain("invalid previews"); expect(a.sendText).not.toHaveBeenCalled();
  });
  it("keeps different preview references distinct during a pending reply", () => {
    expect(replyDedupText({ text: "Changed.", previews: refs })).not.toBe(replyDedupText({ text: "Changed." }));
    expect(replyDedupText({ text: "Changed.", previews: refs })).not.toBe(replyDedupText({ text: "Changed.", previews: [{ path: "src/app.ts", line: 2 }] }));
  });
  it("records the same structured references after a successful CLI/HTTP send, only once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reply-preview-cli-")); homes.push(dir); mkdirSync(join(dir, "instances/agent-alpha"), { recursive: true });
    writeFileSync(join(dir, "instances/agent-alpha/last-chat.json"), JSON.stringify({ chatId: "900000000000000002", adapterId: "discord" }));
    const a = adapter(), delivered = vi.fn(), capture = vi.fn(() => delivered);
    const ctx: any = { dataDir: dir, fleetConfig: { instances: { "agent-alpha": { tool_set: "worker" } } }, adapters: new Map([["discord", a]]), captureReplyPreview: capture, replyDeduper: new ReplyDeduper() };
    const r = await dispatchAgentOperation(ctx, "agent-alpha", "reply", { text: "Changed.", previews: refs });
    expect(r).toMatchObject({ messageId: "900000000000000001" }); expect(delivered).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledWith("agent-alpha", { text: "Changed.", previews: refs });
    a.sendText.mockRejectedValueOnce(new Error("fixture send failed"));
    await dispatchAgentOperation(ctx, "agent-alpha", "reply", { text: "Failed.", previews: refs }); expect(delivered).toHaveBeenCalledTimes(1);
  });
  it("refuses paired Windows preview transfer but keeps ordinary replies", () => {
    expect(nativePaneToolRefusal("reply", { text: "Changed.", previews: refs })).toBe("previews of files on a paired Windows computer aren't available yet");
    expect(nativePaneToolRefusal("reply", { text: "Changed." })).toBeNull();
  });
});
describe("reply previews remain inert history data", () => {
  it("keeps only agent references across save/restore and hides them from a guest", () => {
    const history = new WebChatHistory(), snapshots: any[] = [];
    history.setStore({ schedule(_i: string, snapshot: () => unknown) { snapshots.push(snapshot()); } } as any);
    const msg = history.record({ instance: "agent-alpha", sender: "Helper", role: "agent", text: "Changed.", ts: "2026-01-01T00:00:00Z", previews: refs, channel: true });
    expect(msg.previews).toEqual(refs); expect(snapshots.at(-1)[0].previews).toEqual(refs);
    const restored = new WebChatHistory(); restored.restore("agent-alpha", snapshots.at(-1));
    expect(restored.list("agent-alpha")[0].previews).toEqual(refs);
    expect(guestMessage(msg, { owner: { adapterId: "discord", userId: "900000000000000099" } } as any)).not.toHaveProperty("previews");
    expect(history.record({ instance: "agent-alpha", sender: "Person", role: "user", text: "Changed.", ts: "2026-01-01T00:00:00Z", previews: refs })).not.toHaveProperty("previews");
  });
});

describe("Fleet successful-reply bookkeeping", () => {
  it("keeps previews on the real MCP and captured CLI result paths, fencing an old sender", async () => {
    const home = mkdtempSync(join(tmpdir(), "reply-preview-fleet-")); homes.push(home);
    const fm = new FleetManager(home) as any;
    await fm.afterReplyRouted("agent-alpha", { text: "MCP reply.", previews: refs });
    expect(fm.webChatHistory.list("agent-alpha")[0].previews).toEqual(refs);
    const accepted = fm.captureReplyPreview("agent-alpha", { text: "CLI reply.", previews: refs });
    accepted({ messageId: "900000000000000003" });
    expect(fm.webChatHistory.list("agent-alpha").at(-1).previews).toEqual(refs);
    const stale = fm.captureReplyPreview("agent-alpha", { text: "Old reply.", previews: refs });
    fm.webChatRemovals.set("agent-alpha", { below: 1 }); stale({ messageId: "900000000000000004" });
    expect(fm.webChatHistory.list("agent-alpha").map((m: any) => m.text)).toEqual(["MCP reply.", "CLI reply."]);
  });
});
