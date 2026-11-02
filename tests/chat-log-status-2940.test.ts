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
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }) }));
import { ChatLogLines, CHAT_LOG_ID_MAX, CHAT_LOG_ID_TTL_MS, CHAT_LOG_OCCURRENCES_MAX, CHAT_LOG_OCCURRENCES_PER_ID, OwnStatusMessages, discordMessageKey } from "../src/chat-log-ids.js";
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
  // #2943 review (Prism): an occurrence is the bytes written at their recorded place in that very file — never "the same
  // text somewhere": a same-second duplicate, or a person quoting the status line, is not it.
  const writeLog = (dir: string, name: string, lines: Array<[string | null, string]>, lines2 = new ChatLogLines()) => {
    const file = join(dir, name);
    writeFileSync(file, "");
    for (const [key, line] of lines) {
      const before = statSync(file).size;
      writeFileSync(file, readFileSync(file, "utf8") + line);
      if (key) lines2.record(key, file, statSync(file).ino, before, line);
    }
    return { file, lines: lines2 };
  };
  it("removes the recorded occurrence: of two identical same-second lines, the one recorded; the order of the rest is kept", () => {
    const dir = temp("agend-2943-dup-");
    const yes = "[2026-11-02T20:51:30] <Ann> yes\n", bob = "[2026-11-02T20:51:30] <Bob> ship it?\n";
    const { file, lines } = writeLog(dir, "a.log", [["old", yes], [null, bob], ["new", yes]]);
    expect(lines.remove("old")).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(bob + yes);
    expect(lines.remove("new")).toBe(1);                       // its recorded place moved up by the removed bytes
    expect(readFileSync(file, "utf8")).toBe(bob);
  });
  it("a person quoting the formatted status line keeps their message; the status line itself goes (multi-byte text before it)", () => {
    const dir = temp("agend-2943-quote-");
    const status = "[2026-11-02T20:51:30] <BotB> 👀 處理中…\n";
    const quote = `[2026-11-02T20:51:31] <ann> 這個是什麼？\n${status}`;
    const { file, lines } = writeLog(dir, "q.log", [[null, quote], ["s1", status]]);
    expect(lines.remove("s1")).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(quote);
  });
  it("fails closed when the place is not proven: another file at the path (rotated, rewritten), or other bytes there", () => {
    const dir = temp("agend-2943-proof-");
    const line = "[2026-11-02T20:51:30] <BotB> ⚡ 處理中…\n";
    const { file, lines } = writeLog(dir, "p.log", [["s1", line], ["s2", line]]);
    const other = join(dir, "other.log");
    writeFileSync(other, line + line); renameSync(other, file);          // a new file (inode) with the same bytes
    expect([lines.remove("s1"), readFileSync(file, "utf8")]).toEqual([0, line + line]);
    const g = writeLog(dir, "g.log", [["s3", line]]);
    writeFileSync(g.file, "[2026-11-02T20:51:30] <ann> something else\n", { flag: "r+" });
    expect(g.lines.remove("s3")).toBe(0);
    lines.record("gone", join(dir, "rotated-away.log"), 1, 0, line);
    expect(lines.remove("gone")).toBe(0);
  });
  it("replaced atomically, its mode and modified time kept; a write that fails leaves the file whole and the occurrence recorded", () => {
    const dir = temp("agend-2943-atomic-");
    const status = "[2026-11-02T20:51:30] <BotB> 👀 處理中…\n", q = "[2026-11-02T20:51:31] <ann> can you check?\n";
    let fail = true;
    const io = { replace: (file: string, data: string, mode: number) => { if (fail) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); writeFileSync(file + ".t", data, { mode }); renameSync(file + ".t", file); } };
    const { file, lines } = writeLog(dir, "w.log", [["s1", status], [null, q]], new ChatLogLines(Date.now, io));
    chmodSync(file, 0o600); utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    expect([lines.remove("s1"), readFileSync(file, "utf8")]).toEqual([0, status + q]);   // nothing lost
    fail = false;
    expect([lines.remove("s1"), readFileSync(file, "utf8"), (statSync(file).mode & 0o777).toString(8), statSync(file).mtimeMs]).toEqual([1, q, "600", 1_700_000_000_000]);
    expect(lines.remove("s1")).toBe(0);                                                    // once
  });
  it("bounded: occurrences per key and in all (not only distinct keys); the same occurrence twice is one", () => {
    const lines = new ChatLogLines();
    for (let i = 0; i < CHAT_LOG_OCCURRENCES_PER_ID + 5; i++) lines.record("k", "/f", 1, i * 10, "x\n");
    lines.record("k", "/f", 1, (CHAT_LOG_OCCURRENCES_PER_ID + 4) * 10, "x\n");
    expect((lines as any).byKey.get("k").length).toBe(CHAT_LOG_OCCURRENCES_PER_ID);
    for (let i = 0; i < CHAT_LOG_OCCURRENCES_MAX + 10; i++) lines.record(`id${i}`, "/f", 1, i, "y\n");
    expect((lines as any).total).toBeLessThanOrEqual(CHAT_LOG_OCCURRENCES_MAX);
  });
  it("discordMessageKey: Discord only, scoped by channel", () => {
    expect([discordMessageKey("c1", "42"), discordMessageKey("c2", "42") === discordMessageKey("c1", "42"), discordMessageKey(undefined, "42"), discordMessageKey("c1", undefined)])
      .toEqual(["discord:c1:42", false, undefined, undefined]);
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
  (fm as any).adapter = { type: "discord", notifyAlert, deleteMessage: vi.fn().mockResolvedValue(undefined), editAlert: vi.fn() };
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
    f.fm.onPlatformMessageDeleted({ messageId: "m-1", channelId: "room-1" });
    f.fm.onPlatformMessageDeleted({ messageId: "m-3", channelId: "room-1" });   // deleted before its event reached the fleet
    f.fm.onPlatformMessageDeleted({ messageId: "m-2", channelId: "another-room" });  // the same id in another channel: not this one
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

// #2943 review (Prism): Telegram message ids are per chat — two groups both have a "42". Nothing is tracked there (our bots
// never see each other's posts on Telegram, and it never says a message was deleted): a status bubble "42" in group A never
// touches a person's "42" in group B, whichever arrives first.
describe("#2943 review: Telegram ids are not Discord's", () => {
  for (const order of ["status first", "person first"] as const) {
    it(`a person's message 42 in group B is logged and stays, with our status bubble 42 posted in group A (${order})`, async () => {
      const f = fleet();
      (f.fm as any).adapter.type = "telegram";
      const person = () => f.x.handleClassicChannelMessage("alpha", { source: "telegram", adapterId: "tg", chatId: "-100B", messageId: "42", userId: "u", username: "ann", text: "a real question", isBotMessage: false, timestamp: new Date() });
      if (order === "person first") { await person(); await f.post("42"); } else { await f.post("42"); await person(); }
      expect(f.log("alpha")).toContain("<ann> a real question");
    });
  }
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
    expect(src.match(/adapter\.on\("message_deleted", \(e: \{ messageId\?: string; channelId\?: string \}\) => \{ if \(isCurrentAdapter\(\)\) this\.onPlatformMessageDeleted\(e\); \}\);/g)?.length).toBe(2);
  });
});
