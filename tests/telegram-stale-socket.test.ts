import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  redactTelegramSecrets,
  TelegramAdapter,
  telegramNetworkErrorDetails,
  toThreadId,
} from "../src/channel/adapters/telegram.js";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const roots: string[] = [];

function makeAdapter(): TelegramAdapter {
  const root = mkdtempSync(join(tmpdir(), "agend-tg-socket-"));
  roots.push(root);
  return new TelegramAdapter({
    id: "telegram-test",
    botToken: TOKEN,
    accessManager: {} as never,
    inboxDir: root,
  });
}

function fetchError(code: string, syscall = "write"): HttpError {
  const inner = Object.assign(
    new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: socket broke`),
    { code, errno: code, syscall, type: "system" },
  );
  return new HttpError("Network request for 'sendMessage' failed!", inner);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Telegram stale HTTP socket recovery", () => {
  it("surfaces errno without leaking the bot token", () => {
    const detail = telegramNetworkErrorDetails(fetchError("ECONNRESET"), TOKEN);
    expect(detail).toContain("ECONNRESET");
    expect(detail).toContain("socket broke");
    expect(detail).not.toContain(TOKEN);
    expect(detail).toContain("/bot[REDACTED]/sendMessage");
    expect(redactTelegramSecrets(`url=/bot${TOKEN}/getMe`, TOKEN)).not.toContain(TOKEN);
  });

  it("expands an empty-message Happy Eyeballs AggregateError", () => {
    const v6 = Object.assign(new Error("connect ENETUNREACH ::1"), { code: "ENETUNREACH" });
    const v4 = Object.assign(new Error("connect ETIMEDOUT 149.154.167.220"), { code: "ETIMEDOUT" });
    const aggregate = new AggregateError([v6, v4], "");
    const wrapped = new HttpError("Network request for 'sendMessage' failed!", aggregate);

    const detail = telegramNetworkErrorDetails(wrapped, TOKEN);
    expect(detail).toContain("ENETUNREACH");
    expect(detail).toContain("ETIMEDOUT");
  });

  it("rotates a poisoned pool and does not replay an ambiguous sendMessage", async () => {
    const adapter = makeAdapter();
    const transformer = adapter.getBot().api.config.installedTransformers()[0] as any;
    const originalAgent = (adapter as any).httpsAgent;
    const prev = vi.fn().mockRejectedValue(fetchError("ECONNRESET"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(transformer(prev, "sendMessage", { chat_id: 1, text: "hello" }))
      .rejects.toThrow(/ECONNRESET/);

    expect(prev).toHaveBeenCalledOnce();
    expect((adapter as any).httpsAgent).not.toBe(originalAgent);
    expect(warn.mock.calls.flat().join(" ")).not.toContain(TOKEN);
    originalAgent.destroy();
    (adapter as any).httpAgent.destroy();
    (adapter as any).httpsAgent.destroy();
  });

  it("retries once after a definitely pre-delivery connection failure", async () => {
    const adapter = makeAdapter();
    const transformer = adapter.getBot().api.config.installedTransformers()[0] as any;
    const prev = vi.fn()
      .mockRejectedValueOnce(fetchError("ENOTFOUND"))
      .mockResolvedValueOnce({ ok: true, result: { message_id: 7 } });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(transformer(prev, "sendMessage", { chat_id: 1, text: "hello" }))
      .resolves.toEqual({ ok: true, result: { message_id: 7 } });
    expect(prev).toHaveBeenCalledTimes(2);
    (adapter as any).httpAgent.destroy();
    (adapter as any).httpsAgent.destroy();
  });

  it("retries a connect ETIMEDOUT but not a post-connect timeout", async () => {
    const adapter = makeAdapter();
    const transformer = adapter.getBot().api.config.installedTransformers()[0] as any;
    const prev = vi.fn()
      .mockRejectedValueOnce(fetchError("ETIMEDOUT", "connect"))
      .mockResolvedValueOnce({ ok: true, result: { message_id: 8 } });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(transformer(prev, "sendMessage", { chat_id: 1, text: "hello" }))
      .resolves.toEqual({ ok: true, result: { message_id: 8 } });
    expect(prev).toHaveBeenCalledTimes(2);

    const ambiguous = vi.fn().mockRejectedValue(fetchError("ETIMEDOUT", "read"));
    await expect(transformer(ambiguous, "sendMessage", { chat_id: 1, text: "again" }))
      .rejects.toMatchObject({ deliveryPhase: "unknown" });
    expect(ambiguous).toHaveBeenCalledOnce();
    (adapter as any).httpAgent.destroy();
    (adapter as any).httpsAgent.destroy();
  });

  it("omits Telegram's sentinel General topic id from sendMessage", async () => {
    const adapter = makeAdapter();
    const send = vi.spyOn(adapter.getBot().api, "sendMessage")
      .mockResolvedValue({ message_id: 9 } as never);

    await adapter.sendText("-100123", "hello", { threadId: "1" });

    expect(toThreadId("1")).toBeUndefined();
    expect(send.mock.calls[0][2]).not.toHaveProperty("message_thread_id");
    (adapter as any).httpAgent.destroy();
    (adapter as any).httpsAgent.destroy();
  });

  it("omits the General sentinel from approval messages too", async () => {
    const adapter = makeAdapter();
    adapter.setChatId("-100123");
    const send = vi.spyOn(adapter.getBot().api, "sendMessage")
      .mockResolvedValue({ message_id: 10, chat: { id: -100123 } } as never);

    const handle = await adapter.sendApproval(
      { tool_name: "Bash", description: "Allow?" },
      vi.fn(),
      undefined,
      "1",
    );

    expect(send.mock.calls[0][2]).not.toHaveProperty("message_thread_id");
    handle.cancel();
    (adapter as any).httpAgent.destroy();
    (adapter as any).httpsAgent.destroy();
  });

  it("treats the General sentinel as existing and never tries to delete it", async () => {
    const adapter = makeAdapter();
    (adapter as any).lastChatId = "-100123";
    const send = vi.spyOn(adapter.getBot().api, "sendMessage");

    await expect(adapter.topicExists(1)).resolves.toBe(true);
    await expect(adapter.deleteTopic(1)).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    (adapter as any).httpAgent.destroy();
    (adapter as any).httpsAgent.destroy();
  });
});
