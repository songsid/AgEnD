import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/locale.js";
import { TopicCommands } from "../src/topic-commands.js";
import type { InboundMessage } from "../src/channel/types.js";

/**
 * /status folds in the old /sysinfo instance table,
 * so it is admin-gated. /sysinfo keeps only machine-level facts and stays
 * open. Per-instance IPC health left /status in #1052 and stays queryable
 * via /api/fleet.
 */

afterEach(() => setLocale("en"));
function makeCommands(isAdmin: boolean, source: InboundMessage["source"] = "discord") {
  const sendText = vi.fn().mockResolvedValue({ messageId: "m1" });
  const commands = new TopicCommands({
    fleetConfig: { defaults: {}, instances: { alpha: { working_directory: "/tmp" } } },
    dataDir: "/tmp/agend-status-gate-test",
    isFleetAdmin: () => isAdmin,
    getInstanceStatus: () => "running",
    getInstanceExecutionState: () => "idle",
    instanceIpcClients: new Map(),
    getAdapterStates: () => new Map(),
    classicChannels: null,
    costGuard: null,
    adapter: { sendText },
    getAdapterForInstance: () => ({ sendText }),
    adapters: new Map([[source, { sendText }]]),
  } as any);
  return { commands, sendText };
}

const msg = (source: InboundMessage["source"] = "discord"): InboundMessage => ({
  source, adapterId: source, chatId: "c1", messageId: "m0",
  userId: "u1", username: "someone", text: "/status", timestamp: new Date(),
});

describe("/status admin gate", () => {
  it("denies a non-admin without leaking the table", async () => {
    const { commands, sendText } = makeCommands(false);

    const handled = await commands.handleGeneralCommand(msg());

    expect(handled).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    const reply = sendText.mock.calls[0][1] as string;
    expect(reply).toContain("/status");
    expect(reply).not.toContain("Fleet Status");
    expect(reply).not.toContain("alpha");
  });

  it.each((["discord", "telegram", "web"] as const).flatMap(source =>
    (["en", "zh-TW"] as const).map(lang => [source, lang] as const)))
  ("answers an admin through %s with the six-column table (%s)", async (source, lang) => {
    setLocale(lang);
    const { commands, sendText } = makeCommands(true, source);

    await commands.handleGeneralCommand(msg(source));

    const reply = sendText.mock.calls[0][1] as string;
    expect(reply).toContain(lang === "en" ? "Fleet Status" : "Fleet 狀態");
    expect(reply).toContain(lang === "en" ? "| Instance | Backend | Model | Ctx | Effort | State |"
      : "| Agent | 後端 | 模型 | 上下文 | 推理強度 | 執行狀態 |");
    expect(reply).not.toContain("| IPC |");
    expect(reply).not.toMatch(/\| Cost \||\| 花費 \|/);
  });
});
