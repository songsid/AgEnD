/**
 * #1266: buttons on an agent's reply. Design: https://github.com/songsid/AgEnD/issues/1266#issuecomment-6082375631
 *
 * Driven through the real FleetManager reply path (handleOutboundFromInstance → routeToolCall → the adapter), the
 * real click dispatch (dispatchAdapterCallback), the real store (reply-buttons.db in a scratch dir) and the real web
 * history. The adapters here record calls and enforce the platform limits the real ones meet (callback_data ≤ 64
 * bytes; ≤ 25 buttons, labels ≤ 80, custom_id ≤ 100); the real adapters' own handling is tested at the bottom.
 * Nothing starts a fleet, tmux or a process: delivery to the agent is the seam (deliverToInstance).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { AdapterWorld } from "../src/adapter-world.js";
import { AccessManager } from "../src/channel/access-manager.js";
import type { ChannelAdapter, ChannelConfig } from "../src/channel/types.js";
import {
  ReplyButtonStore, parseReplyButtons, parseReplyButtonCallback, replyButtonCallback, replyButtonClickText,
  replyButtonsClickPlace, replyButtonsFallbackText, REPLY_BUTTON_TTL_MS,
} from "../src/reply-buttons.js";

const dirs: string[] = [];
const fleets: FleetManager[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fm of fleets.splice(0)) { (fm as any).replyButtonsCtl?.stop(); (fm as any).replyButtonsStore?.close(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1266-")); dirs.push(d); return d; };

// ── the module ──

describe("which buttons a reply may carry", () => {
  const ok = (raw: unknown, args: Record<string, unknown> = { text: "Deploy?" }) => parseReplyButtons(raw, args);
  it("labels are trimmed one-line text; value defaults to the label", () => {
    expect(ok([{ label: " Deploy ", value: "deploy-prod" }, { label: "Wait" }])).toEqual({ buttons: [{ label: "Deploy", value: "deploy-prod" }, { label: "Wait", value: "Wait" }] });
    expect(ok(undefined)).toBeNull();
    expect(ok([])).toBeNull();
  });
  it.each([
    ["eleven buttons", Array.from({ length: 11 }, (_, i) => ({ label: `b${i}` })), {}, /at most 10 buttons/],
    ["a label of 81 characters", [{ label: "x".repeat(81) }], {}, /81 characters; at most 80/],
    ["a newline in a label", [{ label: "a\nb" }], {}, /one line/],
    ["a value of 201 characters", [{ label: "a", value: "v".repeat(201) }], {}, /201 characters; at most 200/],
    ["the same label twice", [{ label: "a" }, { label: " a" }], {}, /used twice/],
    ["no text", [{ label: "a" }], { text: " " }, /need text/],
    ["stickers too", [{ label: "a" }], { stickers: ["1"] }, /buttons and stickers/],
    ["not a list", { label: "a" }, {}, /must be a list/],
  ])("refuses %s", (_name, raw, args, error) => {
    const r = parseReplyButtons(raw, { text: "Deploy?", ...args });
    expect(r && "error" in r ? r.error : null).toMatch(error);
  });
  it("the platform callback is the set and the index — never a label or a value — and fits Telegram's 64 bytes", () => {
    const id = "a".repeat(32);
    const cb = replyButtonCallback(id, 9);
    expect(cb).toBe(`rb:${id}:9`);
    expect(Buffer.byteLength(cb)).toBeLessThanOrEqual(64);
    expect(parseReplyButtonCallback(cb)).toEqual({ id, index: 9 });
    for (const bad of [`rb:${id}:10`, `rb:${id.slice(1)}:0`, `rb:${id}:x`, "rb:closed", `xx:${id}:0`]) expect(parseReplyButtonCallback(bad), bad).toBeNull();
  });
  it("the click text and the fallback list", () => {
    expect(replyButtonClickText({ label: "Deploy", value: "Deploy" })).toBe("[button] Deploy");
    expect(replyButtonClickText({ label: "Deploy", value: "deploy-prod" })).toBe("[button] Deploy (value: deploy-prod)");
    expect(replyButtonsFallbackText([{ label: "A", value: "A" }, { label: "B", value: "B" }])).toBe("Options: 1) A  2) B — reply with your choice.");
  });
});

describe("the store: one choice per set, atomically, and it outlives a restart", () => {
  it("unbound sets match nothing; the first consume wins; a second is 'used'; release reopens only that claim", () => {
    const path = join(scratch(), "reply-buttons.db");
    const store = new ReplyButtonStore(path);
    const set = store.create({ id: "c".repeat(32), instance: "w", adapterId: "dc", chatId: "g", threadId: "t", buttons: [{ label: "A", value: "a" }, { label: "B", value: "b" }] }, 1000);
    expect(store.consume(set.id, 0, "alice", 1001)).toMatchObject({ ok: false, reason: "pending" });
    expect(store.bind(set.id, "m1")).toBe(true);
    expect(store.bind(set.id, "m2"), "bound once").toBe(false);
    expect(store.consume(set.id, 5, "alice", 1002)).toMatchObject({ ok: false, reason: "missing" });
    expect(store.consume(set.id, 1, "alice", 1003)).toMatchObject({ ok: true, button: { label: "B" } });
    expect(store.consume(set.id, 0, "bob", 1004)).toMatchObject({ ok: false, reason: "used" });
    store.release(set.id, 999);                                   // not that claim: nothing changes
    expect(store.get(set.id)!.chosenIndex).toBe(1);
    store.release(set.id, 1003);
    expect(store.get(set.id)!.consumedAt).toBeNull();
    store.close();
    // Reopened as after a restart: the row is still there, and still open.
    const again = new ReplyButtonStore(path);
    expect(again.consume(set.id, 0, "bob", 1005)).toMatchObject({ ok: true, button: { label: "A" } });
    again.close();
  });
  it("the claim itself is atomic: a stale read (another process consumed it, or it expired, since) still cannot win", () => {
    const store = new ReplyButtonStore(join(scratch(), "rb.db"));
    const set = store.create({ id: "9".repeat(32), instance: "w", adapterId: "dc", chatId: "g", threadId: "", buttons: [{ label: "A", value: "A" }] }, 0);
    store.bind(set.id, "m1");
    expect(store.consume(set.id, 0, "alice", 10)).toMatchObject({ ok: true });
    const real = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementationOnce((id: string) => ({ ...real(id)!, consumedAt: null, chosenIndex: null }));
    expect(store.consume(set.id, 0, "bob", 11), "a stale 'still open'").toMatchObject({ ok: false, reason: "used" });
    const other = store.create({ id: "8".repeat(32), instance: "w", adapterId: "dc", chatId: "g", threadId: "", buttons: [{ label: "A", value: "A" }] }, 0);
    store.bind(other.id, "m2");
    vi.spyOn(store, "get").mockImplementationOnce((id: string) => ({ ...real(id)!, expiresAt: Number.MAX_SAFE_INTEGER }));
    expect(store.consume(other.id, 0, "bob", REPLY_BUTTON_TTL_MS), "a stale 'not expired'").toMatchObject({ ok: false, reason: "expired" });
    expect(real(other.id)!.consumedAt).toBeNull();
    store.close();
  });

  it("expired: nothing is consumed; it is listed as unsettled until settled", () => {
    const store = new ReplyButtonStore(join(scratch(), "rb.db"));
    const set = store.create({ id: "d".repeat(32), instance: "w", adapterId: "dc", chatId: "g", threadId: "", buttons: [{ label: "A", value: "A" }] }, 0);
    store.bind(set.id, "m1");
    expect(store.nextExpiry(1)).toBe(REPLY_BUTTON_TTL_MS);
    expect(store.consume(set.id, 0, "x", REPLY_BUTTON_TTL_MS)).toMatchObject({ ok: false, reason: "expired" });
    expect(store.unsettled(REPLY_BUTTON_TTL_MS).map(s => s.id)).toEqual([set.id]);
    store.markSettled(set.id, REPLY_BUTTON_TTL_MS);
    expect(store.unsettled(REPLY_BUTTON_TTL_MS)).toEqual([]);
    store.close();
  });
  it("a click is on the set's message: same adapter and message, and its chat or thread is the set's (Discord and Telegram shapes)", () => {
    const set = { id: "e".repeat(32), instance: "w", adapterId: "dc", chatId: "guild", threadId: "chan", messageId: "m1", buttons: [], createdAt: 0, expiresAt: 1, consumedAt: null, chosenIndex: null, chosenBy: null, settledAt: null };
    expect(replyButtonsClickPlace(set, { adapterId: "dc", chatId: "guild", threadId: "chan", messageId: "m1" })).toBe(true);
    expect(replyButtonsClickPlace({ ...set, chatId: "chan", threadId: "" }, { adapterId: "dc", chatId: "guild", threadId: "chan", messageId: "m1" }), "Discord ClassicBot room").toBe(true);
    expect(replyButtonsClickPlace({ ...set, adapterId: "tg", chatId: "-100", threadId: "42" }, { adapterId: "tg", chatId: "-100", threadId: "42", messageId: "m1" }), "Telegram topic").toBe(true);
    expect(replyButtonsClickPlace(set, { adapterId: "dc", chatId: "guild", threadId: "chan", messageId: "m2" }), "another message").toBe(false);
    expect(replyButtonsClickPlace(set, { adapterId: "tg", chatId: "guild", threadId: "chan", messageId: "m1" }), "another bot").toBe(false);
    expect(replyButtonsClickPlace(set, { adapterId: "dc", chatId: "other", threadId: "elsewhere", messageId: "m1" }), "another chat").toBe(false);
  });
});

// ── the fleet ──

interface Rec { sends: Array<{ chatId: string; text: string; opts: any }>; settles: Array<{ chatId: string; messageId: string; threadId?: string; labels: readonly string[]; outcome: unknown }> }

/** A Discord-like adapter that enforces Discord's component limits and returns a message per part. */
function discordLike(id: string, rec: Rec, opts: { supports?: boolean } = {}): ChannelAdapter {
  let n = 0;
  return {
    id, type: "discord",
    ...(opts.supports === false ? {} : { supportsReplyButtons: true }),
    sendText: async (chatId: string, text: string, o: any) => {
      if (o?.replyButtons) {
        expect(o.replyButtons.length).toBeLessThanOrEqual(25);
        for (const b of o.replyButtons) { expect(b.label.length).toBeLessThanOrEqual(80); expect(b.id.length).toBeLessThanOrEqual(100); }
      }
      rec.sends.push({ chatId, text, opts: o });
      const mid = `msg-${++n}`;
      return { messageId: mid, chatId, ...(o?.replyButtons ? { buttonsMessageId: `${mid}-last` } : {}) };
    },
    sendFile: async () => ({ messageId: "f", chatId: "x" }),
    settleReplyButtons: async (chatId: string, messageId: string, threadId: string | undefined, labels: readonly string[], outcome: unknown) => {
      rec.settles.push({ chatId, messageId, threadId, labels, outcome });
    },
  } as unknown as ChannelAdapter;
}

function fleet(options: { dir?: string; classic?: boolean; supports?: boolean } = {}) {
  const dir = options.dir ?? scratch();
  const fm = new FleetManager(dir);
  fleets.push(fm);
  const any = fm as any;
  const rec: Rec = { sends: [], settles: [] };
  const adapter = discordLike("dc", rec, { supports: options.supports });
  const channel = { id: "dc", type: "discord", mode: "topic", bot_token_env: "X", group_id: "guild", access: { mode: "locked", allowed_users: ["owner", "bot-self"], max_pending_codes: 0, code_expiry_minutes: 0 } } as unknown as ChannelConfig;
  // "bot-self" is on the allowed list on purpose: a fleet bot is refused by who it is, not only by the list.
  any.fleetConfig = { channels: [channel], defaults: {}, instances: { w: { working_directory: "/tmp", topic_id: "42", channel_id: "dc" } } };
  const world = new AdapterWorld("dc", adapter, new AccessManager(channel.access as any, join(dir, "access.json")), channel);
  world.botUserId = "bot-self";
  any.worlds.set("dc", world);
  any.adapter = adapter;
  if (options.classic) any.classicChannels = { getChannelIdByInstance: (n: string) => (n === "w" ? "room" : undefined), getAll: () => [], isCollab: () => false };
  const answers: any[] = [];
  any.instanceIpcClients.set("w", { send: (m: unknown) => { answers.push(m); return true; } });
  any.getInstanceIdle = () => true; any.clearCancelButton = () => {}; any.reactDone = () => {};
  const delivered: Array<{ name: string; payload: any }> = [];
  let deliverResult: boolean = true;
  any.deliverToInstance = vi.fn(async (name: string, payload: any) => { delivered.push({ name, payload }); return deliverResult; });
  const sse: Array<{ event: string; data: any }> = [];
  const realEmit = any.emitSseEvent.bind(fm);
  any.emitSseEvent = (event: string, data: any) => { sse.push({ event, data }); realEmit(event, data); };
  const reply = async (args: Record<string, unknown>, id = `r${answers.length}`) => {
    const before = answers.length;
    await any.handleOutboundFromInstance("w", { tool: "reply", args: { chat_id: "guild", ...args }, fleetRequestId: id });
    await vi.waitFor(() => expect(answers.length).toBeGreaterThan(before));
    return answers[answers.length - 1];
  };
  const click = async (callbackData: string, over: Record<string, unknown> = {}) => {
    const acks: Array<string | undefined> = [];
    const handled = await any.dispatchAdapterCallback({ callbackData, chatId: "guild", threadId: "42", messageId: rec.sends.at(-1) ? `${rec.sends.length === 0 ? "" : `msg-${rec.sends.length}`}-last` : "", userId: "owner", username: "alice", ack: (n?: string) => acks.push(n), ...over }, "dc", adapter);
    return { handled, acks };
  };
  return { fm, any, rec, adapter, answers, delivered, sse, reply, click, dir, failDelivery: (v: boolean) => { deliverResult = !v; } };
}
const callbacksOf = (rec: Rec) => (rec.sends.at(-1)!.opts.replyButtons as Array<{ id: string; label: string }>);

describe("the reply path", () => {
  it("buttons go to the adapter as callbacks on the reply; the web chat gets the labels; the set is bound to the message carrying them", async () => {
    const h = fleet();
    const answer = await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy", value: "deploy-prod" }, { label: "Wait" }] });
    expect(answer.error).toBeUndefined();
    const cbs = callbacksOf(h.rec);
    expect(cbs.map(c => c.label)).toEqual(["Deploy", "Wait"]);
    expect(cbs.every(c => /^rb:[0-9a-f]{32}:\d$/.test(c.id))).toBe(true);
    expect(JSON.stringify(h.rec.sends)).not.toContain("deploy-prod");           // the value never leaves AgEnD
    const setId = cbs[0]!.id.split(":")[1]!;
    const msg = h.sse.find(e => e.event === "message" && e.data.role === "agent")!.data;
    expect(msg.buttons).toEqual({ id: setId, labels: ["Deploy", "Wait"], state: "open" });
    expect(h.fm.webChatHistory.list("w").at(-1)!.buttons).toEqual({ id: setId, labels: ["Deploy", "Wait"], state: "open" });
    expect((h.any.replyButtonsStore as ReplyButtonStore).get(setId)!.messageId).toBe("msg-1-last");
  });

  it("refused buttons are the reply's error, and nothing is sent or stored", async () => {
    const h = fleet();
    const answer = await h.reply({ text: "x", buttons: [{ label: "a\nb" }] });
    expect(answer.error).toMatch(/^reply: buttons\[0\]\.label must be one line/);
    expect(h.rec.sends).toEqual([]);
    expect(h.any.replyButtonsCtl).toBeNull();
  });

  it("an adapter without buttons gets the choices as text, and no set exists", async () => {
    const h = fleet({ supports: false });
    await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy" }, { label: "Wait" }] });
    expect(h.rec.sends[0]!.text).toBe("Deploy now?\n\nOptions: 1) Deploy  2) Wait — reply with your choice.");
    expect(h.rec.sends[0]!.opts.replyButtons).toBeUndefined();
  });

  it("a send that fails leaves no set behind", async () => {
    const h = fleet();
    let offered: Array<{ id: string }> = [];
    (h.adapter as any).sendText = async (_c: string, _t: string, o: any) => { offered = o.replyButtons; throw new Error("Discord said no"); };
    const answer = await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy" }] });
    expect(answer.error).toBe("Discord said no");
    expect(h.sse.some(e => e.event === "message")).toBe(false);
    const setId = offered[0]!.id.split(":")[1]!;
    expect((h.any.replyButtonsStore as ReplyButtonStore).get(setId), "the set was removed").toBeNull();
  });
});

describe("a click", () => {
  it("someone who may message the instance: delivered once as their inbound line, shown chosen everywhere; a second click is 'already answered'", async () => {
    const h = fleet();
    await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy", value: "deploy-prod" }, { label: "Wait" }] });
    const [deploy, wait] = callbacksOf(h.rec);
    const first = await h.click(deploy!.id);
    expect(first.handled).toBe(true);
    expect(first.acks).toEqual(["Sent: Deploy"]);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.payload).toMatchObject({ type: "fleet_inbound", content: "[button] Deploy (value: deploy-prod)", targetSession: "w",
      meta: { user: "alice", user_id: "owner", message_id: "msg-1-last", adapter_id: "dc", source: "discord", chat_id: "guild", thread_id: "42" } });
    expect(h.rec.settles).toEqual([{ chatId: "guild", messageId: "msg-1-last", threadId: "42", labels: ["Deploy", "Wait"], outcome: { chosenIndex: 0, by: "alice" } }]);
    const update = h.sse.find(e => e.event === "reply_buttons")!.data;
    expect(update.buttons).toMatchObject({ state: "chosen", chosen: 0, by: "alice" });
    expect(h.fm.webChatHistory.list("w").find(m => m.role === "agent")!.buttons).toMatchObject({ state: "chosen", chosen: 0 });
    expect(h.sse.filter(e => e.event === "message" && e.data.role === "user").map(e => e.data.text)).toEqual(["[button] Deploy (value: deploy-prod)"]);

    const second = await h.click(wait!.id, { userId: "owner" });
    expect([second.acks, h.delivered.length, h.rec.settles.length]).toEqual([["Already answered."], 1, 1]);
    // …and from the web chat too.
    const setId = deploy!.id.split(":")[1]!;
    expect(await h.fm.clickWebReplyButton("w", setId, 1)).toEqual({ status: 409, error: "Already answered." });
    expect(h.delivered).toHaveLength(1);
  });

  it("someone who may not message it here: refused, and the set stays open for someone who may", async () => {
    const h = fleet();
    await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy" }] });
    const [deploy] = callbacksOf(h.rec);
    expect((await h.click(deploy!.id, { userId: "stranger" })).acks).toEqual(["⛔ You can't use this button."]);
    expect((await h.click(deploy!.id, { userId: "bot-self" })).acks, "a fleet bot never answers").toEqual(["⛔ You can't use this button."]);
    expect(h.delivered).toEqual([]);
    expect((await h.click(deploy!.id)).acks).toEqual(["Sent: Deploy"]);
  });

  it("in a ClassicBot room anyone there may answer (as anyone there may write)", async () => {
    const h = fleet({ classic: true });
    await h.reply({ text: "Pick one", buttons: [{ label: "A" }] });
    // A ClassicBot reply is posted in its room (the chat_id the fleet forces); Discord reports the click as guild + room.
    expect(h.rec.sends[0]!.chatId).toBe("room");
    expect((await h.click(callbacksOf(h.rec)[0]!.id, { userId: "anyone", threadId: "room" })).acks).toEqual(["Sent: A"]);
  });

  it("a callback copied to another message, or replayed from another chat, consumes nothing", async () => {
    const h = fleet();
    await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy" }] });
    const [deploy] = callbacksOf(h.rec);
    expect((await h.click(deploy!.id, { messageId: "msg-9" })).acks).toEqual(["⚠️ This button does not match the prompt it belongs to. Run the command again."]);
    expect((await h.click(deploy!.id, { chatId: "other", threadId: "elsewhere" })).acks[0]).toMatch(/does not match/);
    expect(h.delivered).toEqual([]);
    expect((await h.click(deploy!.id)).acks).toEqual(["Sent: Deploy"]);
  });

  it("an unknown or closed callback is answered 'closed', never left spinning", async () => {
    const h = fleet();
    expect((await h.click(`rb:${"f".repeat(32)}:0`)).acks).toEqual(["This choice is closed — reply in text."]);
    expect((await h.click("rb:closed")).acks).toEqual(["This choice is closed — reply in text."]);
  });

  it("a choice the agent could not be given reopens the set (nothing is shown as chosen)", async () => {
    const h = fleet();
    await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy" }] });
    const [deploy] = callbacksOf(h.rec);
    h.failDelivery(true);
    expect((await h.click(deploy!.id)).acks).toEqual(["This choice is closed — reply in text."]);
    expect(h.rec.settles).toEqual([]);
    h.failDelivery(false);
    expect((await h.click(deploy!.id)).acks).toEqual(["Sent: Deploy"]);
    expect(h.rec.settles).toHaveLength(1);
  });

  it("a web click: delivered as the web user (a web message id), the platform message shows it", async () => {
    const h = fleet();
    await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy" }, { label: "Wait" }] });
    const setId = callbacksOf(h.rec)[0]!.id.split(":")[1]!;
    expect(await h.fm.clickWebReplyButton("w", setId, 1)).toEqual({ status: 200 });
    expect(h.delivered[0]!.payload.meta).toMatchObject({ user: "web-user", user_id: "web-user", source: "web" });
    expect(h.delivered[0]!.payload.meta.message_id).toMatch(/^web-/);
    expect(h.rec.settles[0]!.outcome).toEqual({ chosenIndex: 1, by: "web-user" });
    expect(await h.fm.clickWebReplyButton("other", setId, 0), "another instance's buttons").toMatchObject({ status: 403 });
    expect(await h.fm.clickWebReplyButton("w", "nothex", 0)).toMatchObject({ status: 400 });
  });

  it("after a restart: a pending set still answers once; a replay of the same click is 'already answered'", async () => {
    const h = fleet();
    await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy" }] });
    const [deploy] = callbacksOf(h.rec);
    h.any.replyButtonsCtl.stop(); h.any.replyButtonsStore.close(); h.any.replyButtonsCtl = null; h.any.replyButtonsStore = null;
    const after = fleet({ dir: h.dir });                         // a new FleetManager on the same data dir
    after.rec.sends.push(h.rec.sends[0]!);                       // (the click helper reads the message from here)
    expect((await after.click(deploy!.id)).acks).toEqual(["Sent: Deploy"]);
    expect((await after.click(deploy!.id)).acks).toEqual(["Already answered."]);
    expect(after.delivered).toHaveLength(1);
  });

  it("after 24 h: a click is closed, and the sweep shows the set expired on the platform and in the web chat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const h = fleet();
    await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy" }] });
    const [deploy] = callbacksOf(h.rec);
    vi.setSystemTime(new Date(Date.now() + REPLY_BUTTON_TTL_MS + 1));
    expect((await h.click(deploy!.id)).acks).toEqual(["This choice is closed — reply in text."]);
    await vi.waitFor(() => expect(h.rec.settles).toHaveLength(1));
    expect(h.rec.settles[0]!.outcome).toEqual({ expired: true });
    expect(h.fm.webChatHistory.list("w").find(m => m.role === "agent")!.buttons!.state).toBe("expired");
    expect(h.delivered).toEqual([]);
    await h.any.replyButtons().sweep();                          // settled once only
    expect(h.rec.settles).toHaveLength(1);
  });

  it("settling is once: two settles racing (a late click and the sweep) update the platform message once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const h = fleet();
    await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy" }] });
    const setId = callbacksOf(h.rec)[0]!.id.split(":")[1]!;
    vi.setSystemTime(new Date(Date.now() + REPLY_BUTTON_TTL_MS));
    const set = (h.any.replyButtonsStore as ReplyButtonStore).get(setId)!;
    await Promise.all([h.any.replyButtons().settle(set), h.any.replyButtons().settle(set)]);
    expect(h.rec.settles).toHaveLength(1);
    expect(h.sse.filter(e => e.event === "reply_buttons")).toHaveLength(1);
  });

  it("the expiry sweep settles a set nobody clicked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const h = fleet();
    await h.reply({ text: "Deploy now?", buttons: [{ label: "Deploy" }] });
    vi.setSystemTime(new Date(Date.now() + REPLY_BUTTON_TTL_MS));
    await h.any.replyButtons().sweep();
    expect(h.rec.settles.map(s => s.outcome)).toEqual([{ expired: true }]);
    expect(h.sse.filter(e => e.event === "reply_buttons").map(e => e.data.buttons.state)).toEqual(["expired"]);
  });
});

describe("a web-only fleet", () => {
  it("the web chat is where the buttons are: shown, clicked, delivered as the web user", async () => {
    const dir = scratch();
    const fm = new FleetManager(dir);
    fleets.push(fm);
    const any = fm as any;
    any.fleetConfig = { defaults: {}, instances: { w: { working_directory: "/tmp" } } };
    const answers: any[] = [];
    any.instanceIpcClients.set("w", { send: (m: unknown) => { answers.push(m); return true; } });
    any.getInstanceIdle = () => true; any.clearCancelButton = () => {}; any.reactDone = () => {};
    const delivered: any[] = [];
    any.deliverToInstance = vi.fn(async (_n: string, p: any) => { delivered.push(p); return true; });
    await any.handleOutboundFromInstance("w", { tool: "reply", args: { text: "Deploy now?", buttons: [{ label: "Deploy" }] }, fleetRequestId: "r1" });
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    const msg = fm.webChatHistory.list("w").at(-1)!;
    expect(msg.buttons).toMatchObject({ labels: ["Deploy"], state: "open" });
    expect(await fm.clickWebReplyButton("w", msg.buttons!.id, 0)).toEqual({ status: 200 });
    expect(delivered[0].content).toBe("[button] Deploy");
    expect(fm.webChatHistory.list("w").find(m => m.role === "agent")!.buttons!.state).toBe("chosen");
    expect(fm.webChatHistory.buttonStates()).toEqual([{ instance: "w", buttons: expect.objectContaining({ state: "chosen", chosen: 0, by: "web-user" }) }]);
  });
});
