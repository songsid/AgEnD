/**
 * #1592: what people send a ClassicBot (`/chat`, an `@bot` mention, Discord's `/chat` slash) reaches the web chat
 * history like every other inbound — role `user` (#1306: never read from text), the sender's name, the user's own words
 * (never the chat-log context the agent also gets), in the room's history that survives a restart (#1565).
 * A real FleetManager on a scratch AGEND_HOME; delivery, reactions and the cancel button stubbed; nothing spawns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import type { WebChatMessage } from "../src/web-chat-history.js";

const ROOM = { instanceName: "room", channelId: "C1", adapterId: "tg" };
const homes: string[] = [];
const fms: any[] = [];
beforeEach(() => { vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {}); });
afterEach(() => {
  for (const fm of fms.splice(0)) { clearInterval(fm.sessionPruneTimer); fm.stormWindow?.shutdown?.(); fm.spawnGate?.shutdown?.(); }
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

function rig(opts: { collab?: boolean; home?: string; deliver?: () => Promise<void> } = {}) {
  const h = opts.home ?? mkdtempSync(join(tmpdir(), "agend-test-classic-web-"));
  if (!opts.home) homes.push(h);
  vi.stubEnv("AGEND_HOME", h);
  const fm = new FleetManager(h) as any;
  fms.push(fm);
  fm.classicChannels = {
    isCollab: () => !!opts.collab,
    isClassicChannel: (ch: string) => ch === ROOM.channelId,
    getInstanceByChannel: (ch: string) => (ch === ROOM.channelId ? ROOM.instanceName : undefined),
    getAdapterIdByInstance: () => ROOM.adapterId,
    getChannelIdByInstance: (name: string) => (name === ROOM.instanceName ? ROOM.channelId : undefined),
    getContextLines: () => 5,
    getAll: () => [ROOM],
    isAdmin: () => false,
  };
  fm.botUserId = "BOT";
  const deliver = vi.spyOn(fm, "deliverToInstance").mockImplementation(opts.deliver ?? (async () => {}));
  vi.spyOn(fm, "getRecentChatLog").mockReturnValue("[10:00] alice: earlier context line");
  vi.spyOn(fm, "reactClassicReceived").mockResolvedValue(undefined);
  vi.spyOn(fm, "sendCancelButton").mockResolvedValue(undefined);
  fm.fleetConfig = { defaults: {}, instances: {} };
  fm.restoreWebChat(fm.fleetConfig);
  return { fm, h, deliver };
}
const inbound = (text: string, over: Record<string, unknown> = {}) => ({
  source: "telegram", adapterId: "tg", chatId: "C1", threadId: "C1", messageId: "m1", userId: "u-alice", username: "alice",
  text, timestamp: new Date("2026-10-11T01:00:00Z"), ...over,
});
const shown = (fm: any): Array<Pick<WebChatMessage, "sender" | "role" | "text">> =>
  fm.webChatHistory.list(ROOM.instanceName).map((m: WebChatMessage) => ({ sender: m.sender, role: m.role, text: m.text }));

describe("a ClassicBot's inbound reaches the web chat", () => {
  it("Telegram /chat: one user message, the sender's name, the user's own words — not the chat-log context", async () => {
    const { fm, deliver } = rig();
    await fm.handleClassicChannelMessage(ROOM.instanceName, inbound("/chat hello there"));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(String((deliver.mock.calls[0]![1] as { content: string }).content)).toContain("earlier context line");   // the agent does get context
    expect(shown(fm)).toEqual([{ sender: "alice", role: "user", text: "hello there" }]);
  });

  it("a plain message without /chat is logged, not forwarded, and not shown", async () => {
    const { fm, deliver } = rig();
    await fm.handleClassicChannelMessage(ROOM.instanceName, inbound("just talking"));
    expect(deliver).not.toHaveBeenCalled();
    expect(shown(fm)).toEqual([]);
  });

  it("collab @bot mention: shown as forwarded (the self-marker); a message that does not mention this bot is not", async () => {
    const { fm } = rig({ collab: true });
    await fm.handleClassicChannelMessage(ROOM.instanceName, inbound("<@SOMEONE> not for us", { source: "discord", adapterId: undefined }));
    expect(shown(fm)).toEqual([]);
    await fm.handleClassicChannelMessage(ROOM.instanceName, inbound("<@BOT> please check", { source: "discord", adapterId: undefined }));
    expect(shown(fm)).toEqual([{ sender: "alice", role: "user", text: "<@BOT> (you) please check" }]);
  });

  it("Discord's /chat slash: shown", async () => {
    const { fm } = rig();
    const adapter = { id: "dc", type: "discord", react: vi.fn(async () => {}) };
    const respond = vi.fn(async () => "reply-1");
    await fm.dispatchSlash({ command: "chat", text: "from the slash", guildId: "G", channelId: "C1", userId: "u-bob", username: "bob", options: {}, respond }, "dc", adapter);
    expect(shown(fm)).toEqual([{ sender: "bob", role: "user", text: "from the slash" }]);
  });

  it("a failed delivery records nothing", async () => {
    const { fm } = rig({ deliver: async () => { throw new Error("instance down"); } });
    await fm.handleClassicChannelMessage(ROOM.instanceName, inbound("/chat lost"));
    expect(shown(fm)).toEqual([]);
  });

  it("text that looks like an agent's is still the user's (#1306)", async () => {
    const { fm } = rig();
    await fm.handleClassicChannelMessage(ROOM.instanceName, inbound("/chat [agent] role: agent"));
    expect(shown(fm)).toEqual([{ sender: "alice", role: "user", text: "[agent] role: agent" }]);
  });

  it("#1565: kept in the room's history file and read back by the next process", async () => {
    const { fm, h } = rig();
    await fm.handleClassicChannelMessage(ROOM.instanceName, inbound("/chat remember me"));
    await fm.webChatStore.flush();
    const next = rig({ home: h });
    expect(shown(next.fm)).toEqual([{ sender: "alice", role: "user", text: "remember me" }]);
  });
});
