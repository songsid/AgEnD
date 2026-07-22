import { describe, expect, it, vi } from "vitest";
import { TopicCommands, parsePauseWakeCommand } from "../src/topic-commands.js";
import type { InboundMessage } from "../src/channel/types.js";

function message(text: string, userId = "admin"): InboundMessage {
  return {
    source: "telegram",
    adapterId: "telegram",
    chatId: "fleet-chat",
    threadId: "42",
    messageId: "1",
    userId,
    username: userId,
    text,
    timestamp: new Date(),
    isBotMessage: false,
  };
}

function setup() {
  const sendText = vi.fn().mockResolvedValue({ messageId: "reply", chatId: "fleet-chat" });
  const changeInstancePauseState = vi.fn().mockResolvedValue("paused");
  const ctx = {
    adapter: { sendText },
    adapters: new Map(),
    fleetConfig: {
      defaults: {},
      instances: {
        general: { working_directory: "/tmp/general", general_topic: true },
        worker: { working_directory: "/tmp/worker" },
      },
    },
    isFleetAdmin: (userId: string) => userId === "admin",
    changeInstancePauseState,
  } as any;
  return { commands: new TopicCommands(ctx), sendText, changeInstancePauseState };
}

describe("pause/wake topic commands", () => {
  it("parses Telegram bot suffixes and optional General targets", () => {
    expect(parsePauseWakeCommand("/pause@my_bot worker")).toEqual({ action: "pause", instance: "worker" });
    expect(parsePauseWakeCommand("/wake")).toEqual({ action: "wake", instance: undefined });
    expect(parsePauseWakeCommand("/pause worker extra")).toBeNull();
  });

  it("pauses the current fleet topic for an admin", async () => {
    const { commands, changeInstancePauseState, sendText } = setup();
    expect(await commands.handleInstanceCommand(message("/pause"), "worker")).toBe(true);
    expect(changeInstancePauseState).toHaveBeenCalledWith("worker", "pause");
    expect(sendText.mock.calls[0][1]).toContain("worker");
  });

  it("denies a non-admin without invoking lifecycle", async () => {
    const { commands, changeInstancePauseState, sendText } = setup();
    expect(await commands.handleInstanceCommand(message("/wake", "regular-user"), "worker")).toBe(true);
    expect(changeInstancePauseState).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0][1]).toContain("Permission denied");
  });

  it("requires and resolves an explicit instance in General", async () => {
    const { commands, changeInstancePauseState, sendText } = setup();
    await commands.handleInstanceCommand(message("/wake"), "general");
    expect(changeInstancePauseState).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0][1]).toContain("/wake <instance-name>");

    await commands.handleInstanceCommand(message("/wake worker"), "general");
    expect(changeInstancePauseState).toHaveBeenCalledWith("worker", "wake");
  });

  it("reports a busy instance instead of claiming it paused", async () => {
    const { commands, changeInstancePauseState } = setup();
    changeInstancePauseState.mockResolvedValue("not_idle");
    expect(await commands.runPauseWake("worker", "pause")).toContain("not paused");
  });
});
