import { afterEach, describe, expect, it, vi } from "vitest";
import { TopicCommands } from "../src/topic-commands.js";

const TOKEN_ENV = "AGEND_TEST_TELEGRAM_TOKEN";

function setup() {
  process.env[TOKEN_ENV] = "test-token";
  const info = vi.fn();
  const warn = vi.fn();
  const commands = new TopicCommands({
    fleetConfig: {
      channels: [{
        id: "telegram-main",
        type: "telegram",
        mode: "topic",
        bot_token_env: TOKEN_ENV,
        group_id: "-1001234567890",
      }],
    },
    logger: { info, warn },
  } as any);
  return { commands, info, warn };
}

function telegramOk(): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ ok: true, result: true }),
  } as unknown as Response;
}

afterEach(() => {
  delete process.env[TOKEN_ENV];
  vi.unstubAllGlobals();
});

describe("Telegram command-menu registration", () => {
  it("registers the complete fleet list for both chat and administrator scopes", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => telegramOk());
    vi.stubGlobal("fetch", fetchMock);
    const { commands, info, warn } = setup();

    await commands.registerBotCommands();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const payloads = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    const fleetPayloads = payloads.filter(p => p.scope.type !== "default");
    expect(fleetPayloads.map(p => p.scope.type)).toEqual(["chat", "chat_administrators"]);
    for (const payload of fleetPayloads) {
      expect(payload.commands.map((c: { command: string }) => c.command)).toEqual([
        "status", "sysinfo", "dashboard", "ctx", "compact", "steer", "clear", "model", "effort",
        "pause", "wake", "restart", "collab", "update", "doctor", "usage",
      ]);
    }
    expect(payloads.find(p => p.scope.type === "default").commands.map((c: { command: string }) => c.command))
      .toEqual(["start", "stop", "compact", "steer", "clear", "model", "effort", "pause", "wake", "ctx"]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: "telegram-main", fleetCommandCount: 16 }),
      expect.stringContaining("Registered Telegram bot commands"),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not report success when Telegram rejects setMyCommands", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ ok: false, description: "Bad Request: chat not found" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { commands, info, warn } = setup();

    await commands.registerBotCommands();

    // Each scope is independent: a rejected fleet-chat scope must not prevent
    // AgEnD from attempting to refresh the administrator and Classic menus.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "telegram-main",
        err: expect.objectContaining({ message: expect.stringContaining("chat not found") }),
      }),
      "Failed to register bot commands (non-fatal)",
    );
  });
});
