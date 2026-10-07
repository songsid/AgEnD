/**
 * `agend-agent reply … --sticker <id>` (agent_mode: cli, POST /agent) reaches the same reply rules as the MCP path
 * (#1226): the sticker pre-check runs before anything is sent, and a reply with stickers is not deduplicated against
 * the same text without them. Before this, the HTTP path called routeToolCall directly — no pre-check, and the dedup
 * key was the text alone.
 *
 * Scratch data dir and fake adapters only; no fleet, CLI or network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAgentOperation } from "../src/agent-endpoint.js";
import { FleetManager } from "../src/fleet-manager.js";
import { ReplyDeduper, replyDedupText } from "../src/reply-dedup.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const TG_STICKER = "CAACAgIAAxkBAAEBAAFtestStickerIdAA";

/** A Telegram-ish adapter whose sends stay pending until released, so a second call can arrive in flight. */
function adapter(type = "telegram") {
  const releases: Array<() => void> = [];
  const pending = <T,>(value: T) => new Promise<T>(resolve => releases.push(() => resolve(value)));
  return {
    id: `${type}-main`, type,
    sendText: vi.fn((_chat: string, _text: string) => pending({ messageId: "t1", chatId: "chat-1" })),
    sendStickers: vi.fn((_chat: string, _ids: string[]) => pending({ messageId: "s1", chatId: "chat-1" })),
    listStickers: vi.fn(async () => ({ scope: "set", stickers: [] })),
    sendFile: vi.fn(),
    releaseAll: () => releases.splice(0).forEach(release => release()),
  };
}

function context(a: ReturnType<typeof adapter>, replyStickerProblem?: (...args: any[]) => Promise<string | null>) {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-cli-stickers-"));
  dirs.push(dataDir);
  mkdirSync(join(dataDir, "instances", "agy"), { recursive: true });
  writeFileSync(join(dataDir, "instances", "agy", "last-chat.json"), JSON.stringify({ chatId: "chat-1", adapterId: a.id }));
  return {
    dataDir,
    fleetConfig: { defaults: {}, instances: { agy: { tool_set: "worker" } } },
    adapters: new Map([[a.id, a]]),
    replyDeduper: new ReplyDeduper(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    clearCancelButton: vi.fn(),
    ...(replyStickerProblem ? { replyStickerProblem } : {}),
  } as any;
}

describe("the sticker pre-check runs on the HTTP reply path too", () => {
  it("a refused sticker is the reply's error and nothing is sent (the real check: not a Telegram sticker id)", async () => {
    const a = adapter();
    const realCheck = (...args: any[]) => (FleetManager.prototype.replyStickerProblem as any).call({}, ...args);
    const result = await dispatchAgentOperation(context(a, realCheck), "agy", "reply", { text: "look", stickers: ["sticker id!"] });
    expect(result).toEqual({ error: expect.stringContaining("is not a Telegram sticker id") });
    expect(a.sendStickers).not.toHaveBeenCalled();
    expect(a.sendText).not.toHaveBeenCalled();
  });

  it("is asked with the adapter, the routed args and the reply's world, and a passed check sends", async () => {
    const a = adapter();
    const check = vi.fn(async () => null);
    const sending = dispatchAgentOperation(context(a, check), "agy", "reply", { text: "look", stickers: [TG_STICKER] });
    await vi.waitFor(() => expect(a.sendStickers).toHaveBeenCalledOnce());
    a.releaseAll();
    await expect(sending).resolves.toMatchObject({ messageId: "s1" });
    expect(check).toHaveBeenCalledWith(a, expect.objectContaining({ chat_id: "chat-1", stickers: [TG_STICKER] }), undefined, a.id);
  });

  it("text and stickers both missing: refused like the MCP path", async () => {
    const a = adapter();
    const realCheck = (...args: any[]) => (FleetManager.prototype.replyStickerProblem as any).call({}, ...args);
    const result = await dispatchAgentOperation(context(a, realCheck), "agy", "reply", { text: "" });
    expect(result).toEqual({ error: "reply: text is required (or stickers)" });
    expect(a.sendText).not.toHaveBeenCalled();
  });
});

describe("a reply with stickers is a different reply from its text alone", () => {
  it("in flight: the same text with a sticker is sent, not joined to the text-only send", async () => {
    const a = adapter();
    const ctx = context(a, async () => null);
    const first = dispatchAgentOperation(ctx, "agy", "reply", { text: "x" });
    await vi.waitFor(() => expect(a.sendText).toHaveBeenCalledOnce());
    const second = dispatchAgentOperation(ctx, "agy", "reply", { text: "x", stickers: [TG_STICKER] });
    await vi.waitFor(() => expect(a.sendStickers).toHaveBeenCalledOnce());
    a.releaseAll();
    await expect(first).resolves.toMatchObject({ messageId: "t1" });
    await expect(second).resolves.toMatchObject({ messageId: "s1" });
  });

  it("the same reply twice in flight still joins (one send, both get its outcome)", async () => {
    const a = adapter();
    const ctx = context(a, async () => null);
    const first = dispatchAgentOperation(ctx, "agy", "reply", { text: "x", stickers: [TG_STICKER] });
    await vi.waitFor(() => expect(a.sendStickers).toHaveBeenCalledOnce());
    const second = dispatchAgentOperation(ctx, "agy", "reply", { text: "x", stickers: [TG_STICKER] });
    await new Promise(r => setTimeout(r, 10));
    a.releaseAll();
    await expect(first).resolves.toMatchObject({ messageId: "s1" });
    await expect(second).resolves.toMatchObject({ messageId: "s1" });
    expect(a.sendStickers).toHaveBeenCalledOnce();
  });

  it("one key rule for both paths", () => {
    expect(replyDedupText({ text: "x" })).toBe("x");
    expect(replyDedupText({ text: "x", stickers: [] })).toBe("x");
    expect(replyDedupText({ text: "x", stickers: ["A", "B"] })).toBe("x\u0000stickers:A,B");
    expect(replyDedupText({ text: "x", stickers: ["A"] })).not.toBe(replyDedupText({ text: "x", stickers: ["B"] }));
  });
});
