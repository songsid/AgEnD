/**
 * #2940: in a ClassicBot room with several bots, each bot's status bubble ("👀 處理中…") — deleted once its reply lands —
 * still reached every other bot's chat log (chat-logs/YYYY-MM-DD.log, read back as "[Chat log for context]"). Now:
 *  - a status bubble of this fleet (any bot's: one process posts them all, FleetManager.sendCancelButton) is never logged
 *    — matched by the message id recorded when it was posted, never by text (a person may write 「處理中」);
 *  - one logged before its id was known (the sibling's gateway event beat the post's own answer) is taken out again;
 *  - a deleted message (the platform's delete event) is taken out of the log, and never logged if it arrives after;
 *  - real replies and people's lines stay.
 * Real files under a scratch AGEND_HOME; the real collab path (handleClassicChannelMessage) and sendCancelButton.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }) }));
import { ChatLogLines, CHAT_LOG_ID_MAX, CHAT_LOG_ID_TTL_MS, OwnStatusMessages } from "../src/chat-log-ids.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { FleetManager } from "../src/fleet-manager.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

describe("#2940 the id registry and the line index", () => {
  it("a status id and a deleted id are excluded; any other is not; both expire and are bounded", () => {
    let now = 1_000_000;
    const own = new OwnStatusMessages(() => now);
    own.addStatus("s1"); own.markDeleted("d1");
    expect([own.excluded("s1"), own.excluded("d1"), own.excluded("r1"), own.excluded(undefined)]).toEqual([true, true, false, false]);
    now += CHAT_LOG_ID_TTL_MS + 1;
    expect([own.excluded("s1"), own.excluded("d1")]).toEqual([false, false]);
    for (let i = 0; i <= CHAT_LOG_ID_MAX; i++) own.addStatus(`x${i}`);
    expect([own.excluded("x0"), own.excluded(`x${CHAT_LOG_ID_MAX}`)]).toEqual([false, true]);
  });
  it("removes exactly the line recorded for an id (the last such line, whole lines only), keeps the file's modified time, once", () => {
    const dir = temp("agend-2940-lines-"), file = join(dir, "2026-11-02.log");
    const a = "[2026-11-02T20:51:30] <BotB> 👀 處理中…\n", human = "[2026-11-02T20:51:31] <ann> 處理中 means processing\n";
    writeFileSync(file, a + human + a + "x" + a);     // the last copy is glued to "x": not a whole line
    utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const lines = new ChatLogLines();
    lines.record("s1", file, a);
    expect(lines.remove("s1")).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(a + human + "x" + a);      // the last whole one went
    expect(statSync(file).mtimeMs).toBe(1_700_000_000_000);
    // Once: the same words written again later (another message) are not taken out by a second removal of s1.
    writeFileSync(file, readFileSync(file, "utf8") + a);
    expect([lines.remove("s1"), lines.remove("never"), readFileSync(file, "utf8").endsWith("x" + a + a)]).toEqual([0, 0, true]);
    lines.record("gone", join(dir, "rotated-away.log"), a);
    expect(lines.remove("gone")).toBe(0);                 // the file is gone: nothing, no throw
  });
});

type Internals = {
  classicChannels: { isCollab: () => boolean; getReplyTriggers: () => boolean };
  handleClassicChannelMessage: (instanceName: string, msg: unknown) => Promise<void>;
  sendCancelButton: (name: string) => Promise<void>;
  lifecycle: { isPaused: () => boolean };
  getInstanceStatus: () => string;
};
function fleet() {
  const home = temp("agend-2940-home-");
  vi.stubEnv("AGEND_HOME", home);
  const fm = new FleetManager(home), x = fm as unknown as Internals;
  x.classicChannels = { isCollab: () => true, getReplyTriggers: () => false };
  x.lifecycle.isPaused = () => false;
  x.getInstanceStatus = () => "running";
  // Bot B's status bubble is posted for instance "beta" (its adapter answers the post with the bubble's message id).
  const answers: Array<(v: unknown) => void> = [];
  const notifyAlert = vi.fn((..._a: unknown[]) => new Promise(resolve => answers.push(resolve)));
  (fm as any).fleetConfig = { defaults: {}, channel: { type: "discord", group_id: "g1" }, instances: { beta: { working_directory: home, topic_id: "123" } } };
  (fm as any).adapter = { notifyAlert, deleteMessage: vi.fn().mockResolvedValue(undefined), editAlert: vi.fn() };
  const say = (room: string, messageId: string, username: string, text: string, isBotMessage = true) =>
    x.handleClassicChannelMessage(room, { source: "discord", adapterId: "bot-a", chatId: "guild", threadId: "room-1", messageId, userId: `${username}-id`, username, text, isBotMessage, timestamp: new Date() });
  const log = (room: string) => {
    const d = ClassicChannelManager.chatLogDir(room);
    try { return readdirSync(d).map(f => readFileSync(join(d, f), "utf8")).join(""); } catch { return ""; }
  };
  const post = async (messageId: string) => { const p = x.sendCancelButton("beta"); await new Promise(r => setTimeout(r, 0)); answers.shift()!({ messageId, chatId: "guild", threadId: "room-1" }); await p; };
  return { fm, x, say, log, post, answers };
}

describe("#2940 a ClassicBot room with several bots", () => {
  it("bot B's status bubble never enters bot A's (or C's) log; B's real reply and a person's 「處理中」 do", async () => {
    const f = fleet();
    await f.post("s-1");
    for (const room of ["alpha", "gamma"]) {                    // two other bots of the fleet in the room
      await f.say(room, "s-1", "BotB", "👀 處理中…");
      await f.say(room, "r-1", "BotB", "Deployed to staging.");
      await f.say(room, "h-1", "ann", "處理中 — I am still looking", false);
    }
    for (const room of ["alpha", "gamma"]) {
      const text = f.log(room);
      expect([text.includes("👀 處理中…"), text.includes("<BotB> Deployed to staging."), text.includes("<ann> 處理中 — I am still looking")], room).toEqual([false, true, true]);
    }
  });
  it("the race: B's bubble reaches A before B's post is answered — logged, then taken out once its id is known (mtime kept)", async () => {
    const f = fleet();
    const p = f.x.sendCancelButton("beta");
    await new Promise(r => setTimeout(r, 0));
    await f.say("alpha", "s-2", "BotB", "⚡ 處理中…");
    await f.say("alpha", "r-2", "BotB", "Here is the answer.");
    expect(f.log("alpha")).toContain("⚡ 處理中…");
    const file = join(ClassicChannelManager.chatLogDir("alpha"), readdirSync(ClassicChannelManager.chatLogDir("alpha"))[0]!);
    utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    f.answers.shift()!({ messageId: "s-2", chatId: "guild", threadId: "room-1" }); await p;
    expect([f.log("alpha").includes("⚡ 處理中…"), f.log("alpha").includes("Here is the answer."), statSync(file).mtimeMs]).toEqual([false, true, 1_700_000_000_000]);
  });
  it("a delete event takes a recorded line out (any bot's log); one deleted before it arrives is never logged; the others stay", async () => {
    const f = fleet();
    for (const room of ["alpha", "gamma"]) { await f.say(room, "m-1", "ann", "oops wrong channel", false); await f.say(room, "m-2", "ann", "real question", false); }
    f.fm.onPlatformMessageDeleted("m-1");
    f.fm.onPlatformMessageDeleted("m-3");                         // deleted before its event reached the fleet
    await f.say("alpha", "m-3", "BotB", "📒 處理中…");
    for (const room of ["alpha", "gamma"]) expect([f.log(room).includes("oops wrong channel"), f.log(room).includes("real question"), f.log(room).includes("📒")], room).toEqual([false, true, false]);
  });
  it("the context block read back from the log has no status line", async () => {
    const f = fleet();
    await f.post("s-4");
    await f.say("alpha", "h-4", "ann", "can someone check the build?", false);
    await f.say("alpha", "s-4", "BotB", "👊 處理中…");
    await f.say("alpha", "h-5", "ann", "@alpha please look", false);   // the trigger: the newest entry, left out of the block
    const block = (f.fm as any).getRecentChatLog("alpha", 10) as string;
    expect([block.includes("can someone check the build?"), block.includes("處理中")]).toEqual([true, false]);
  });
});

describe("#2940 the Discord adapter says a message was deleted", () => {
  it("messageDelete and messageDeleteBulk → message_deleted with the id (an uncached message has its id only)", async () => {
    const dir = temp("agend-2940-dc-");
    const adapter = new DiscordAdapter({ id: "discord", botToken: "FAKE-TOKEN-FOR-TEST", inboxDir: dir, guildId: "guild-1", registerCommands: false,
      accessManager: new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 10 }, join(dir, "access.json")) });
    try {
      const seen: unknown[] = [];
      adapter.on("message_deleted", (e) => seen.push(e));
      const client = (adapter as any).client;
      client.emit("messageDelete", { id: "111", channelId: "c-1", partial: true });
      client.emit("messageDeleteBulk", new Map([["222", {}], ["333", {}]]), { id: "c-2" });
      expect(seen).toEqual([{ messageId: "111", channelId: "c-1" }, { messageId: "222", channelId: "c-2" }, { messageId: "333", channelId: "c-2" }]);
    } finally { await adapter.stop(); }
  });
  it("the fleet listens for it on every adapter (primary and each bot's)", () => {
    const src = readFileSync(join(process.cwd(), "src", "fleet-manager.ts"), "utf8");
    expect(src.match(/adapter\.on\("message_deleted", \(e: \{ messageId\?: string \}\) => \{ if \(isCurrentAdapter\(\)\) this\.onPlatformMessageDeleted\(e\?\.messageId\); \}\);/g)?.length).toBe(2);
  });
});
