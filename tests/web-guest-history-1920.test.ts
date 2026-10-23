/**
 * #1920 phase 2 (step 2a): what a guest sees of the chat — "what they could already read in that channel" (§5.2).
 * - Each kept message says whether it reached the instance's channel (`channel`) and whose account wrote it (`from`),
 *   set by the code path that knows; both survive a restart; rows from before carry neither, so no guest sees them.
 * - A guest sees an in-scope instance's channel messages, its own messages, and everything in its own Telegram private
 *   room — never someone else's web-only exchange, a status line, an effect Try, or another instance.
 * - As a guest gets a message: no account ids, another person's message id or ticks; `mine` on its own.
 * - The stream, the poll, the history and the catch-up ticks follow the same rule; a message that becomes the channel's
 *   (its copy was sent) reaches the guests' streams only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebChatHistory, webChatFrom, type WebChatMessage } from "../src/web-chat-history.js";
import { WebChatDiskStore } from "../src/web-chat-store.js";
import { guestButtonStates, guestDeliveries, guestFrameData, guestHistory, guestMessage, guestPollBody, guestSeesMessage, type GuestRequest } from "../src/web-guest-access.js";
import { EventEmitter } from "node:events";
import { broadcastToGuests, handleWebRequest } from "../src/web-api.js";
import { bindGuestRequest } from "../src/web-guest-access.js";

vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const ALICE = { adapterId: "dc", userId: "111" };
const BOB_FROM = "dc:222";
const ts = () => new Date().toISOString();
const SCOPE = new Set(["a"]);

function hist() {
  const h = new WebChatHistory({ boot: "b1" });
  const say = (instance: string, text: string, extra: Record<string, unknown> = {}) => h.record({ instance, sender: "x", text, ts: ts(), ...extra });
  return { h, say };
}
function guestOf(history: WebChatHistory | null, ownRoom: string[] = []): GuestRequest {
  return { owner: ALICE, scope: () => SCOPE, current: () => true, ownRoom: (i) => ownRoom.includes(i), history: () => history };
}

describe("a kept message says where it was seen and whose it is", () => {
  it("`channel` only when true; `from` only on a person's message, only an account's shape", () => {
    const { say } = hist();
    expect(say("a", "x", { channel: true, from: "dc:111" })).toMatchObject({ channel: true, from: "dc:111" });
    for (const channel of ["true", 1, {}]) expect(say("a", "x", { channel })).not.toHaveProperty("channel");
    expect(say("a", "x", { role: "agent", channel: true, from: "dc:111" }), "an agent's reply names no account").not.toHaveProperty("from");
    for (const from of ["dc", ":111", "dc:", "d c:1", "dc:1 2", "d:c:1", 7, "x".repeat(70) + ":1"]) expect(say("a", "x", { from }), String(from)).not.toHaveProperty("from");
    expect([webChatFrom("dc", "111"), webChatFrom("dc", 111), webChatFrom(undefined, "1"), webChatFrom("d:c", "1")]).toEqual(["dc:111", undefined, undefined, undefined]);
  });
  it("both survive a restart; a row kept before them has neither (so no guest is shown it)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-1920-hist-")); homes.push(home);
    const store = () => new WebChatDiskStore({ home, logger: { warn: vi.fn() }, debounceMs: 1, ownerOf: () => "dir:/w/a" });
    const one = new WebChatHistory({ boot: "b1" }); const s1 = store(); one.restore("a", s1.load("a")); one.setStore(s1);
    one.record({ instance: "a", sender: "bob", text: "from discord", ts: ts(), channel: true, from: BOB_FROM });
    one.record({ instance: "a", sender: "alice", text: "mine, web only", ts: ts(), from: "dc:111", messageId: "web-1" });
    one.record({ instance: "a", sender: "old", text: "before #1920", ts: ts() });
    await s1.flush();
    const two = new WebChatHistory({ boot: "b2" }); two.restore("a", store().load("a"));
    expect(two.list("a").map((m) => [m.text, m.channel ?? null, m.from ?? null])).toEqual([
      ["from discord", true, BOB_FROM], ["mine, web only", null, "dc:111"], ["before #1920", null, null]]);
    const g = guestOf(two);
    expect(guestHistory(two, "a", 50, g, SCOPE).map((m) => m.text), "the old row stays hidden; its own (restored) shows").toEqual(["from discord", "mine, web only"]);
  });
  it("a restored row is the channel's only when it says exactly true", () => {
    const h = new WebChatHistory({ boot: "b2" });
    const row = (id: number, channel: unknown) => ({ boot: "b1", id, instance: "a", role: "user", sender: "x", text: `row ${id}`, ts: ts(), channel });
    h.restore("a", [row(1, true), row(2, "true"), row(3, 1), row(4, false)]);
    expect(h.list("a").map((m) => m.channel ?? null)).toEqual([true, null, null, null]);
  });
  it("markChannel: a web message becomes the channel's once (persisted), by the id the agent was given", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-1920-mark-")); homes.push(home);
    const store = () => new WebChatDiskStore({ home, logger: { warn: vi.fn() }, debounceMs: 1, ownerOf: () => "dir:/w/a" });
    const one = new WebChatHistory({ boot: "b1" }); const s1 = store(); one.restore("a", s1.load("a")); one.setStore(s1);
    one.record({ instance: "a", sender: "x", text: "copied", ts: ts(), messageId: "web-8", from: "dc:111" });
    await s1.flush();
    one.markChannel("a", "web-8");
    await s1.flush();
    const two = new WebChatHistory({ boot: "b2" }); two.restore("a", store().load("a"));
    expect(two.list("a").map((m) => [m.text, m.channel ?? null]), "the mark is kept across a restart").toEqual([["copied", true]]);
    const { h, say } = hist();
    say("a", "hello", { messageId: "web-9", from: "dc:111" });
    expect(h.markChannel("a", "web-9")).toMatchObject({ text: "hello", channel: true });
    expect(h.markChannel("a", "web-9"), "already").toBeNull();
    expect([h.markChannel("a", "web-404"), h.markChannel("b", "web-9")]).toEqual([null, null]);
  });
});

describe("what a guest sees (§5.2)", () => {
  function rows() {
    const { h, say } = hist();
    const m = {
      platform: say("a", "said in the topic", { channel: true, from: BOB_FROM }),
      reply: say("a", "the agent's reply there", { role: "agent", channel: true }),
      mine: say("a", "my web message", { messageId: "web-1", from: "dc:111" }),
      others: say("a", "an admin's web-only note", { messageId: "web-2", from: BOB_FROM }),
      operator: say("a", "the operator's (no account)", { messageId: "web-3" }),
      webReply: say("a", "a reply that stayed on the web", { role: "agent" }),
      status: say("a", "worker → b: a cross-instance notice", { role: "status" }),
      other: say("b", "b's topic", { channel: true }),
    };
    return { h, m };
  }
  it("the channel's and its own; never another's web-only exchange, a status line, or another instance", () => {
    const { h, m } = rows(), g = guestOf(h);
    const seen = Object.entries(m).filter(([, row]) => guestSeesMessage(row, g, SCOPE)).map(([k]) => k);
    expect(seen).toEqual(["platform", "reply", "mine"]);
    expect(guestHistory(h, "a", 50, g, SCOPE).map((x) => x.text)).toEqual([m.platform.text, m.reply.text, m.mine.text]);
    expect(guestHistory(h, "a", 2, g, SCOPE).map((x) => x.text), "the newest it may see").toEqual([m.reply.text, m.mine.text]);
    expect(guestHistory(h, "b", 50, g, SCOPE), "out of scope").toEqual([]);
  });
  it("its own Telegram private room: everything in it", () => {
    const { h, m } = rows(), g = guestOf(h, ["a"]);
    expect(Object.values(m).filter((row) => guestSeesMessage(row, g, SCOPE)).length).toBe(7);
    expect(guestSeesMessage(m.other, g, SCOPE)).toBe(false);
  });
  it("as it gets one: no account ids; its own carries `mine`, its id and ticks; another's neither", () => {
    const { h, m } = rows(), g = guestOf(h);
    h.setDelivery("a", "web-1", "delivered"); h.setDelivery("a", "web-2", "delivered");
    const mine = guestMessage(m.mine, g), platform = guestMessage(m.platform, g), others = guestMessage({ ...m.others, channel: true } as WebChatMessage, g);
    expect(mine).toMatchObject({ mine: true, messageId: "web-1", delivery: "delivered" });
    for (const x of [mine, platform, others]) { expect(x).not.toHaveProperty("from"); expect(x).not.toHaveProperty("channel"); }
    expect([platform, others].map((x) => [x.mine ?? null, x.messageId ?? null, x.delivery ?? null])).toEqual([[null, null, null], [null, null, null]]);
  });
  it("an effect Try never reaches a guest", () => {
    const { h } = hist(), g = guestOf(h);
    const trial = { ...h.record({ instance: "a", sender: "agend", text: "", ts: ts(), role: "status", channel: true }), effectTrial: {} } as unknown as WebChatMessage;
    expect(guestFrameData("message", trial, SCOPE, g)).toBeDefined();          // a status row marked channel by hand…
    expect(guestHistory({ list: () => [trial] } as never, "a", 50, g, SCOPE), "…but a Try is never in its lists").toEqual([]);
  });
});

describe("the stream and the poll follow the same rule", () => {
  it("frames: a message it may see; ticks on its own only; buttons on a reply it may see; never the live receipt", () => {
    const { h, say } = hist(), g = guestOf(h);
    const mine = say("a", "mine", { messageId: "web-1", from: "dc:111" }), theirs = say("a", "theirs", { messageId: "web-2", from: BOB_FROM });
    const reply = say("a", "pick", { role: "agent", channel: true, buttons: { id: "f".repeat(32), state: "open", labels: ["A", "B"] } });
    const hidden = say("a", "pick too", { role: "agent", buttons: { id: "e".repeat(32), state: "open", labels: ["A"] } });
    expect(guestFrameData("message", mine, SCOPE, g)).toMatchObject({ text: "mine", mine: true });
    expect(guestFrameData("message", theirs, SCOPE, g)).toBeUndefined();
    expect(guestFrameData("message", mine, SCOPE), "no guest context: nothing").toBeUndefined();
    expect(guestFrameData("delivery", { instance: "a", messageId: "web-1", delivery: "delivered" }, SCOPE, g)).toEqual({ instance: "a", messageId: "web-1", delivery: "delivered" });
    expect(guestFrameData("delivery", { instance: "a", messageId: "web-2", delivery: "delivered" }, SCOPE, g)).toBeUndefined();
    expect(guestFrameData("delivery", { instance: "b", messageId: "web-1", delivery: "delivered" }, SCOPE, g)).toBeUndefined();
    expect(reply.buttons && guestFrameData("reply_buttons", { instance: "a", buttons: { ...reply.buttons, state: "expired" } }, SCOPE, g)).toBeDefined();
    expect(guestFrameData("reply_buttons", { instance: "a", buttons: { ...hidden.buttons, state: "expired" } }, SCOPE, g)).toBeUndefined();
    expect(guestFrameData("agent_reply_live", { v: 1, boot: "b1", id: reply.id, instance: "a" }, SCOPE, g)).toBeUndefined();
    for (const e of ["prompt", "needs", "steps_tick", "traffic", "apply_progress"]) expect(guestFrameData(e, { instance: "a" }, SCOPE, g), e).toBeUndefined();
  });
  it("catch-up: its own ticks, the buttons of replies it may see", () => {
    const { h, say } = hist(), g = guestOf(h);
    say("a", "mine", { messageId: "web-1", from: "dc:111" }); say("a", "theirs", { messageId: "web-2", from: BOB_FROM });
    h.setDelivery("a", "web-1", "processing"); h.setDelivery("a", "web-2", "processing");
    expect(guestDeliveries(h, g, SCOPE)).toEqual([{ instance: "a", messageId: "web-1", delivery: "processing" }]);
    say("a", "pick", { role: "agent", channel: true, buttons: { id: "f".repeat(32), state: "open", labels: ["A"] } });
    say("a", "web pick", { role: "agent", buttons: { id: "e".repeat(32), state: "open", labels: ["A"] } });
    h.updateButtons("a", { id: "f".repeat(32), state: "expired", labels: ["A"] }); h.updateButtons("a", { id: "e".repeat(32), state: "expired", labels: ["A"] });
    expect(guestButtonStates(h, g, SCOPE).map((b) => b.buttons.id)).toEqual(["f".repeat(32)]);
  });
  it("the poll: what it may see of the replay, its ticks, the poll cursor; never prompts or Needs you", () => {
    const { h, say } = hist(), g = guestOf(h);
    say("a", "seen", { channel: true }); say("a", "not seen");
    const body = guestPollBody({ instances: [{ name: "a", model: "secret" }] }, SCOPE, 5, g, null, () => h.after(0));
    expect(body).toMatchObject({ status: { instances: [{ name: "a" }] }, deliveries: [], reply_buttons: [], prompts: [], needs: [], cursor: h.pollCursor(), now: 5 });
    expect((body.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["seen"]);
    expect(JSON.stringify(body)).not.toContain("secret");
  });
  it("a message that became the channel's goes to the guests' streams only, each as projected", async () => {
    const { h, say } = hist(), g = guestOf(h);
    const written: Record<string, string[]> = { admin: [], guest: [], gone: [] };
    const res = (who: string) => Object.assign(new EventEmitter(), { writeHead() {}, setHeader() {}, write: (x: string) => { written[who]!.push(x); return true; }, end() {} });
    const clients = new Set<any>();
    const ctx = { webToken: "c".repeat(48), webSessions: null, logger: { info() {}, debug() {}, warn() {}, error() {} }, sseClients: clients, getUiStatus: () => ({ instances: [] }), sseHeartbeatMs: 3_600_000 } as any;
    const open = (who: string, guest?: GuestRequest) => {
      const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/events", headers: { host: "127.0.0.1:19280", "x-agend-token": "c".repeat(48) }, socket: null });
      if (guest) bindGuestRequest(req, guest);
      const r = res(who);
      handleWebRequest(req as never, r as never, new URL("/ui/events", "http://127.0.0.1:19280"), ctx);
      return r;
    };
    const streams = [open("admin"), open("guest", g), open("gone", { ...g, current: () => false })];
    try {
      expect(clients.size).toBe(3);
      written.admin = []; written.guest = []; written.gone = [];
      const m = say("a", "now in the topic", { messageId: "web-1", from: BOB_FROM });
      broadcastToGuests(clients, "message", h.markChannel("a", "web-1"));
      expect(written.admin, "an admin's page already has it").toEqual([]);
      expect(written.guest.join("")).toContain("now in the topic");
      expect(written.guest.join("")).not.toContain(BOB_FROM);
      expect(written.gone).toEqual([]);
      expect([clients.size, clients.has(streams[0])], "the ended guest stream is dropped; the admin's stays").toEqual([2, true]);
      void m;
    } finally { for (const r of streams) r.emit("close"); }
  });
});


describe("FleetManager: where a reply landed; the marks recorded; a copy that made it the channel's", async () => {
  const home = mkdtempSync(join(tmpdir(), "agend-1920-fm-")); homes.push(home);
  process.env.AGEND_HOME = home;
  const { FleetManager } = await import("../src/fleet-manager.js");
  function fleet() {
    const fm: any = new FleetManager(home);
    fm.fleetConfig = { channels: [{ id: "dc", type: "discord" }, { id: "tg", type: "telegram" }], instances: { a: { channel_id: "dc", topic_id: "42" }, b: { channel_id: "tg", topic_id: "42" }, general: { general_topic: true, channel_id: "dc" } } };
    fm.worlds.set("dc", { id: "dc", groupId: "G" });
    fm.classicChannels = { getAll: () => [{ instanceName: "room", adapterId: "tg", channelId: "5550001" }],
      getChannelIdByInstance: (n: string) => (n === "room" ? "5550001" : undefined), getAdapterIdByInstance: (n: string) => (n === "room" ? "tg" : undefined) };
    return fm;
  }
  it("landedInOwnChannel: its topic in its connection's group; its room; nothing else", () => {
    const fm = fleet();
    expect(fm.landedInOwnChannel("a", "dc", { chatId: "G", threadId: "42" })).toBe(true);
    for (const sent of [{ chatId: "G", threadId: "43" }, { chatId: "G" }, { chatId: "H", threadId: "42" }, { threadId: "42" }, null, "x"]) expect(fm.landedInOwnChannel("a", "dc", sent), JSON.stringify(sent)).toBe(false);
    expect(fm.landedInOwnChannel("a", "tg", { chatId: "G", threadId: "42" }), "another connection").toBe(false);
    expect(fm.landedInOwnChannel("a", undefined, { chatId: "G", threadId: "42" })).toBe(false);
    expect(fm.landedInOwnChannel("general", "dc", { chatId: "G" }), "a General without a topic: the group itself").toBe(true);
    expect(fm.landedInOwnChannel("general", "dc", { chatId: "G", threadId: "42" })).toBe(false);
    expect(fm.landedInOwnChannel("room", "tg", { chatId: "5550001" })).toBe(true);
    expect(fm.landedInOwnChannel("room", "tg", { chatId: "5550002" })).toBe(false);
    expect(fm.landedInOwnChannel("room", "dc", { chatId: "5550001" })).toBe(false);
    expect(fm.landedInOwnChannel("nobody", "dc", { chatId: "G", threadId: "42" })).toBe(false);
    expect(fm.landedInOwnChannel("b", "dc", { chatId: "G", threadId: "42" }), "the same topic id in another connection's group").toBe(false);
  });
  it("emitSseEvent records the marks it is given; webMessageInChannel marks a web message and tells the guests only", () => {
    const fm = fleet();
    fm.emitSseEvent("message", { instance: "a", sender: "bob", role: "user", text: "said there", ts: ts(), channel: true, from: BOB_FROM });
    fm.emitSseEvent("message", { instance: "a", sender: "alice", role: "user", text: "on the web", ts: ts(), messageId: "web-7", from: "dc:111" });
    expect(fm.webChatHistory.list("a").map((m: WebChatMessage) => [m.text, m.channel ?? null, m.from])).toEqual([["said there", true, BOB_FROM], ["on the web", null, "dc:111"]]);
    const admin = { write: vi.fn() };
    fm.sseClients.add(admin);
    fm.webMessageInChannel("a", "web-7");
    expect(fm.webChatHistory.findByMessageId("a", "web-7").channel).toBe(true);
    expect(admin.write, "an admin's stream is not sent it again").not.toHaveBeenCalled();
  });
  it("a person's platform message is the channel's, by that account; an agent's reply is only when it landed there", async () => {
    const fm = fleet();
    const events: Array<Record<string, unknown>> = [];
    fm.emitSseEvent = (e: string, d: Record<string, unknown>) => { if (e === "message") events.push(d); };
    fm.emitPlatformInbound("a", { username: "bob", adapterId: "dc", userId: "222" }, "hi there");
    Object.assign(fm, { getInstanceIdle: () => true, clearCancelButton: () => {}, reactDone: () => {} });
    await fm.afterReplyRouted("a", { text: "landed" }, undefined, null, true);
    await fm.afterReplyRouted("a", { text: "elsewhere" }, undefined, null, false);
    expect(events.map((e) => [e.text, e.channel ?? null, e.from ?? null])).toEqual([["hi there", true, "dc:222"], ["landed", true, null], ["elsewhere", null, null]]);
  });
  it("#2085 review: a platform click is the channel's only when its buttons are in the instance's own topic; a guest reads its label", async () => {
    const fm = fleet();
    const events: Array<Record<string, unknown>> = [];
    Object.assign(fm, { emitSseEvent: (e: string, d: Record<string, unknown>) => { if (e === "message") events.push(d); }, reactMessageStatus: () => {}, touchActivity: () => {},
      setTopicIcon: () => {}, pendingReactionsMeta: () => ({ meta: {}, consume: () => {} }), deliverHumanToInstance: async () => true, afterUserInboundDelivered: () => {}, getDeliveryEpoch: () => 0 });
    fm.worlds.get("dc").adapter = { type: "discord" };
    const click = (chatId: string, threadId: string, userId: string) => fm.deliverReplyButtonChoice({ id: "f".repeat(32), instance: "a", adapterId: "dc", chatId, threadId, messageId: "m1" },
      { label: "Ship it", value: "deploy-prod-7" }, { userId, username: "u", source: "discord" });
    await click("G", "42", "222"); await click("G", "99", "222"); await click("dm-chat", "", "111");
    expect(events.map((e) => [e.channel ?? null, e.from])).toEqual([[true, "dc:222"], [null, "dc:222"], [null, "dc:111"]]);
    const { h } = hist();
    const rows = events.map((e) => h.record(e as never));
    const g = guestOf(h);
    expect(rows.map((r) => guestSeesMessage(r, g, SCOPE)), "own topic: yes; another topic: no; its own DM click: yes").toEqual([true, false, true]);
    const shown = guestMessage(rows[0]!, g);
    expect(shown.text).toBe("Ship it");
    expect(JSON.stringify(shown)).not.toContain("deploy-prod-7");
  });
  it("#2085 review: a message that becomes the channel's after a poll's cursor reaches that guest's next poll, once", () => {
    const { h, say } = hist(), g = guestOf(h);
    say("a", "held", { messageId: "web-1", from: BOB_FROM });
    say("a", "seen", { channel: true });
    const first = guestPollBody({ instances: [] }, SCOPE, 1, g, null, () => h.after(0));
    expect((first.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["seen"]);
    const cursor = first.cursor as string;
    h.markChannel("a", "web-1");
    const parse = (c: string) => ({ boot: c.split("-")[0]!, id: Number(c.split("-")[1]) });
    const next = guestPollBody({ instances: [] }, SCOPE, 2, g, cursor, () => h.replayFor(parse(cursor)));
    expect((next.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["held"]);
    const after = guestPollBody({ instances: [] }, SCOPE, 3, g, next.cursor as string, () => h.replayFor(parse(next.cursor as string)));
    expect(after.messages, "not sent again").toEqual([]);
  });
  it("#2085 review: a mark made before a restart still reaches the old cursor's next poll (persisted), once; unmarked rows stay hidden", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-1920-seen-")); homes.push(home);
    const store = () => new WebChatDiskStore({ home, logger: { warn: vi.fn() }, debounceMs: 1, ownerOf: () => "dir:/w/a" });
    const one = new WebChatHistory({ boot: "b1" }); const s1 = store(); one.restore("a", s1.load("a")); one.setStore(s1);
    const g1 = guestOf(one);
    one.record({ instance: "a", sender: "bob", text: "held", ts: ts(), messageId: "web-1", from: BOB_FROM });
    one.record({ instance: "a", sender: "x", text: "seen", ts: ts(), channel: true });
    one.record({ instance: "a", sender: "bob", text: "never copied", ts: ts(), messageId: "web-3", from: BOB_FROM });
    const first = guestPollBody({ instances: [] }, SCOPE, 1, g1, null, () => one.after(0));
    expect((first.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["seen"]);
    const cursor = first.cursor as string;                       // b1-3
    one.markChannel("a", "web-1");                               // its echo went out; the guest's tab is offline
    await s1.flush();
    // A restart: a new process restores the history from disk.
    const two = new WebChatHistory({ boot: "b2" }); two.restore("a", store().load("a"));
    const g2 = guestOf(two);
    const parse = (c: string) => { const i = c.lastIndexOf("-"); return { boot: c.slice(0, i), id: Number(c.slice(i + 1)) }; };
    const replay = (c: string) => two.replayFor(parse(c));   // #1774: replayFor counts a row where it was seen (seenSeq)
    const next = guestPollBody({ instances: [] }, SCOPE, 2, g2, cursor, () => replay(cursor));
    expect((next.messages as Array<{ text: string }>).map((m) => m.text), "the old tab's next poll gets it").toEqual(["held"]);
    const again = guestPollBody({ instances: [] }, SCOPE, 3, g2, next.cursor as string, () => replay(next.cursor as string));
    expect(again.messages, "and not again").toEqual([]);
    expect(guestHistory(two, "a", 50, g2, SCOPE).map((m) => m.text), "the unmarked row stays hidden").toEqual(["held", "seen"]);
  });
  it("guestOwnRoom: the account's own Telegram private room, on its own connection", () => {
    const fm = fleet();
    expect(fm.guestOwnRoom({ adapterId: "tg", userId: "5550001" }, "room")).toBe(true);
    expect(fm.guestOwnRoom({ adapterId: "tg", userId: "5550002" }, "room")).toBe(false);
    expect(fm.guestOwnRoom({ adapterId: "dc", userId: "5550001" }, "room")).toBe(false);
    expect(fm.guestOwnRoom({ adapterId: "tg", userId: "5550001" }, "a")).toBe(false);
  });
});
