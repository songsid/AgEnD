import { describe, expect, it, vi } from "vitest";
import { TopicCommands } from "../src/topic-commands.js";
import type { InboundMessage } from "../src/channel/types.js";

/**
 * /status now folds in the old /sysinfo instance table (per-instance cost and
 * IPC health), so it is admin-gated. /sysinfo keeps only machine-level facts and
 * stays open.
 */

function makeCommands(isAdmin: boolean) {
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
    adapters: new Map([["discord", { sendText }]]),
  } as any);
  return { commands, sendText };
}

const msg = (): InboundMessage => ({
  source: "discord", adapterId: "discord", chatId: "c1", messageId: "m0",
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

  it("answers an admin with the merged table, IPC column included", async () => {
    const { commands, sendText } = makeCommands(true);

    await commands.handleGeneralCommand(msg());

    const reply = sendText.mock.calls[0][1] as string;
    expect(reply).toContain("Fleet Status");
    expect(reply).toContain("| IPC |");
  });
});
