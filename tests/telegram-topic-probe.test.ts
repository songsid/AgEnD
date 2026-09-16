import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrammyError, HttpError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyTelegramProbeError,
  TELEGRAM_PROBE_RETRY_MS,
  TelegramAdapter,
} from "../src/channel/adapters/telegram.js";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const roots: string[] = [];

function makeAdapter(): TelegramAdapter {
  const root = mkdtempSync(join(tmpdir(), "agend-tg-probe-"));
  roots.push(root);
  const adapter = new TelegramAdapter({
    id: "telegram-test",
    botToken: TOKEN,
    accessManager: {} as never,
    inboxDir: root,
  });
  (adapter as any).lastChatId = "-100123";
  return adapter;
}

function transportError(code = "ECONNRESET"): HttpError {
  const inner = Object.assign(
    new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: `),
    { code, errno: code, type: "system" },
  );
  return new HttpError("Network request for 'sendMessage' failed!", inner);
}

function apiError(error_code: number, description: string): GrammyError {
  return new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code, description }, "sendMessage", {});
}

/** Drive a probe whose transport retry sleeps on a fake timer. */
async function probeWithRetryClock(adapter: TelegramAdapter, topicId: number) {
  const probe = adapter.probeTopicPresence(topicId);
  await vi.advanceTimersByTimeAsync(TELEGRAM_PROBE_RETRY_MS);
  return probe;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Telegram topic probe classification (#776)", () => {
  it("retries one transport failure and reports present when the second attempt lands", async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const send = vi.spyOn(adapter.getBot().api, "sendMessage")
      .mockRejectedValueOnce(transportError())
      .mockResolvedValueOnce({ message_id: 77 } as never);
    const del = vi.spyOn(adapter.getBot().api, "deleteMessage").mockResolvedValue(true as never);

    await expect(probeWithRetryClock(adapter, 118)).resolves.toEqual({ status: "present" });

    expect(send).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledWith(-100123, 77);
    (adapter as any).httpAgent.destroy();
    (adapter as any).httpsAgent.destroy();
  });

  it("reports transport-failed with a redacted detail after the retry also fails", async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const send = vi.spyOn(adapter.getBot().api, "sendMessage").mockRejectedValue(transportError("ECONNRESET"));

    const result = await probeWithRetryClock(adapter, 118);

    expect(result).toMatchObject({ status: "unknown", reason: "transport-failed" });
    expect((result as { detail?: string }).detail).toContain("ECONNRESET");
    expect((result as { detail?: string }).detail).not.toContain(TOKEN);
    expect(send).toHaveBeenCalledTimes(2);
    (adapter as any).httpAgent.destroy();
    (adapter as any).httpsAgent.destroy();
  });

  it.each([
    [429, "Too Many Requests: retry after 5", "provider-unavailable"],
    [502, "Bad Gateway", "provider-unavailable"],
    [400, "Bad Request: chat not found", "provider-rejected"],
    [403, "Forbidden: bot is not a member of the supergroup chat", "provider-rejected"],
  ])("classifies Telegram %s as %s without retrying", async (code, description, reason) => {
    const adapter = makeAdapter();
    const send = vi.spyOn(adapter.getBot().api, "sendMessage").mockRejectedValue(apiError(code, description));

    const result = await adapter.probeTopicPresence(118);

    expect(result).toMatchObject({ status: "unknown", reason });
    expect((result as { detail?: string }).detail).toContain(String(code));
    expect(send).toHaveBeenCalledTimes(1);
    (adapter as any).httpAgent.destroy();
    (adapter as any).httpsAgent.destroy();
  });

  it("still treats Telegram's own thread-not-found as missing, without retrying", async () => {
    const adapter = makeAdapter();
    const send = vi.spyOn(adapter.getBot().api, "sendMessage")
      .mockRejectedValue(apiError(400, "Bad Request: message thread not found"));

    await expect(adapter.probeTopicPresence(118)).resolves.toEqual({
      status: "missing",
      evidence: "telegram-topic-not-found",
    });
    expect(send).toHaveBeenCalledTimes(1);
    (adapter as any).httpAgent.destroy();
    (adapter as any).httpsAgent.destroy();
  });

  it("never turns a transport failure into missing, even when the message text mentions threads", () => {
    const inner = Object.assign(new Error("request to /bot/sendMessage failed, reason: thread not found in pool"), { code: "ECONNRESET" });
    const result = classifyTelegramProbeError(new HttpError("Network request for 'sendMessage' failed!", inner), TOKEN);
    // Only Telegram's own description may prove absence; a transport error is unknown.
    expect(result.status).toBe("unknown");
  });

  it("falls back to provider-probe-failed for an unrecognised error shape", () => {
    expect(classifyTelegramProbeError(new Error("weird"), TOKEN)).toMatchObject({
      status: "unknown",
      reason: "provider-probe-failed",
      detail: "weird",
    });
  });
});
