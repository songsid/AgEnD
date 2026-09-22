import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";

/**
 * In a collab channel every message is written to the chat log, including other
 * bots'. A bot reacting to `/chat` with 👀 arrives with no text at all, and
 * logging it put a `textLen: 0` line in the log that said nothing (#7).
 *
 * The guard that skips those has been in `handleClassicChannelMessage` since
 * the day the issue was filed, with nothing testing it — so deleting it, or
 * widening it until real bot speech disappears from the log, would both have
 * been silent. These two cases hold each edge.
 */

type Internals = {
  classicChannels: { isCollab: (channelId: string, adapterId?: string) => boolean };
  handleClassicChannelMessage: (instanceName: string, msg: unknown) => Promise<void>;
};

describe("collab chat log and empty bot messages", () => {
  let tmpDir: string;
  let logMessage: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-empty-bot-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    logMessage = vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});
  });
  afterEach(() => {
    logMessage.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    const fm = new FleetManager(tmpDir);
    const internals = fm as unknown as Internals;
    // Only the one answer this path asks of the classic channel registry.
    internals.classicChannels = { isCollab: () => true };
    return { fm, internals };
  }

  const message = (over: Record<string, unknown> = {}) => ({
    source: "discord", adapterId: "discord", chatId: "guild", threadId: "channel-1",
    messageId: "m-1", userId: "bot-777", username: "other-bot",
    text: "", isBotMessage: true, timestamp: new Date(),
    ...over,
  });

  it("does not log a bot message with no text and no attachments", async () => {
    // The 👀 react on a /chat command: a message shaped like nothing.
    const { internals } = setup();

    await internals.handleClassicChannelMessage("classic-room", message());

    expect(logMessage, "an empty bot message says nothing worth keeping").not.toHaveBeenCalled();
  });

  it("still logs what another bot actually says", async () => {
    // The guard has to stay narrow: collab mode exists so the agent can read
    // what other bots say, and skipping those would empty the log of its point.
    const { internals } = setup();

    await internals.handleClassicChannelMessage("classic-room", message({ text: "deploy finished" }));

    expect(logMessage).toHaveBeenCalledTimes(1);
    expect(logMessage.mock.calls[0][2]).toContain("deploy finished");
  });

  it("still logs a bot message that carries only an attachment", async () => {
    // No text, but something was said: a screenshot posted by another bot.
    const { fm, internals } = setup();
    vi.spyOn(fm as unknown as { saveClassicAttachment: () => Promise<undefined> }, "saveClassicAttachment")
      .mockResolvedValue(undefined);

    await internals.handleClassicChannelMessage("classic-room",
      message({ attachments: [{ kind: "photo", filename: "shot.png" }] }));

    expect(logMessage).toHaveBeenCalledTimes(1);
  });
});
