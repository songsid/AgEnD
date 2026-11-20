/**
 * M-3491: an agent's `reply` with `reply_to` quotes the same message everywhere.
 *
 * - Web chat: the reply's row carries `replyTo` (the bubble's quote and its jump) when `reply_to` names a kept message:
 *   by its web `message_id` or by any Discord/Telegram copy of
 *   it (`posts`, a reply's separate buttons message included). The leader's case: a reminder replying to its own earlier
 *   button message by that message's Discord id quoted it on Discord, and nothing on the web.
 * - Discord/Telegram: a `reply_to` that names a kept web message (its web id) becomes that message's copy there, so the
 *   reply is a native reply; an id already one of its copies there stays the one named.
 * - An id the chat does not keep: no quote and no error, as before (the adapter ignores an id that is not its own).
 *
 * The real FleetManager and web history on a scratch home; the platform adapter stubbed (nothing started).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "agend-m3491-home-"));
process.env.AGEND_HOME = home;
const { FleetManager } = await import("../src/fleet-manager.js");
const { WebChatHistory, webChatReplyRef } = await import("../src/web-chat-history.js");
const { guestMessage } = await import("../src/web-guest-access.js");
afterAll(() => rmSync(home, { recursive: true, force: true }));

const CHAT = "1000000000000000001", THREAD = "1000000000000000077";
let fm: any, dir: string, sendText: ReturnType<typeof vi.fn>, ipcSend: ReturnType<typeof vi.fn>, n = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agend-m3491-"));
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  n = 0;
  // Synthetic ids as strings (a Number this size loses precision and repeats).
  sendText = vi.fn(async (chatId: string, _text: string, opts: any) => ({ messageId: `1000000000000009${String(++n).padStart(3, "0")}`, chatId, threadId: opts?.threadId }));
  const adapter = { id: "discord", type: "discord", sendText } as any;
  fm.adapter = adapter;
  fm.worlds.set("discord", { adapter } as any);
  ipcSend = vi.fn(() => true);
  fm.instanceIpcClients.set("a", { send: ipcSend } as any);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const last = () => fm.webChatHistory.list("a").at(-1);
/** An earlier agent reply with buttons that landed in the topic: its text message and its separate buttons message. */
async function buttonReply(text: string, messageId: string, buttonsMessageId?: string) {
  await fm.afterReplyRouted("a", { text }, undefined, null, true,
    { adapterId: "discord", result: { chatId: CHAT, threadId: THREAD, messageId, ...(buttonsMessageId ? { buttonsMessageId } : {}) } });
  return last();
}
/** The agent's later reply, as the bookkeeping after a confirmed send records it (not in the topic: no post). */
async function agentReply(text: string, reply_to: string) {
  await fm.afterReplyRouted("a", { text, reply_to }, undefined, null, false, undefined);
  return last();
}
const quoteOf = (row: any) => (row.replyTo ? { boot: row.replyTo.boot, id: row.replyTo.id, sender: row.replyTo.sender, text: row.replyTo.text } : null);

describe("web chat: the reply quotes the message its reply_to names", () => {
  it("a Discord id of an earlier reply (its text message, or its separate buttons message) quotes that reply", async () => {
    const original = await buttonReply("Pick one: deploy now or wait?", "1000000000000000144", "1000000000000000145");
    const byText = await agentReply("Reminder: still waiting on this", "1000000000000000144");
    const byButtons = await agentReply("Reminder again", "1000000000000000145");
    const want = { boot: original.boot, id: original.id, sender: "a", text: "Pick one: deploy now or wait?" };
    expect([quoteOf(byText), quoteOf(byButtons)]).toEqual([want, want]);
  });
  it("a person's platform message and a web message (its web id) each quote it (main keeps no reply anchor)", async () => {
    fm.emitSseEvent("message", { instance: "a", sender: "Ann", role: "user", text: "from Discord", ts: new Date().toISOString(), channel: true,
      posts: [{ adapterId: "discord", chatId: CHAT, threadId: THREAD, messageId: "1000000000000000213" }] });
    const platform = last();
    fm.emitSseEvent("message", { instance: "a", sender: "Ann", role: "user", text: "from the web", ts: new Date().toISOString(), messageId: "web-lz1-0a0b0c0d" });
    const web = last();
    const rows = [await agentReply("re platform", "1000000000000000213"), await agentReply("re web", "web-lz1-0a0b0c0d")];
    expect(rows.map(r => r.replyTo && [r.replyTo.boot, r.replyTo.id])).toEqual([[platform.boot, platform.id], [web.boot, web.id]]);
  });
  it("an id the chat does not keep (or none) quotes nothing, as before", async () => {
    await buttonReply("kept", "1000000000000000144");
    const rows = [await agentReply("unknown", "1000000000000000999"), await agentReply("unknown web", "web-nope-00000000"), await agentReply("none", "")];
    expect(rows.map(r => [r.role, Object.hasOwn(r, "replyTo")])).toEqual([["agent", false], ["agent", false], ["agent", false]]);
  });
  it("kept on disk and restored with the agent's row; a guest-shaped bad ref is dropped, never repaired", () => {
    let saved: unknown[] = [];
    const a = new WebChatHistory({ store: { schedule: (_i: string, rows: () => unknown[]) => { saved = rows(); }, remove: async () => {} } });
    const q = a.record({ instance: "w", sender: "Ann", text: "deploy?", ts: "t", role: "user" });
    a.record({ instance: "w", sender: "w", text: "yes", ts: "t", role: "agent", replyTo: { boot: q.boot, id: q.id, sender: "Ann", text: "deploy?" } });
    a.record({ instance: "w", sender: "w", text: "status", ts: "t", role: "status", replyTo: { boot: q.boot, id: q.id, sender: "Ann", text: "deploy?" } });
    const b = new WebChatHistory();
    b.restore("w", JSON.parse(JSON.stringify(saved)));
    const [, agent, status] = b.list("w");
    expect([agent!.replyTo, Object.hasOwn(status!, "replyTo")]).toEqual([{ boot: q.boot, id: q.id, sender: "Ann", text: "deploy?" }, false]);
  });
});

describe("a guest sees an agent reply's quote only when it may see the quoted row (the rule #2272 has for a person's)", () => {
  it("a quoted row the guest may see keeps its quote; a private one shows only that it replies to an earlier message", () => {
    const h = new WebChatHistory();
    const seen = h.record({ instance: "a", sender: "Ann", role: "user", text: "public question", ts: "t", channel: true });
    const hidden = h.record({ instance: "a", sender: "Ann", role: "user", text: "web-only question", ts: "t" });
    const r1 = h.record({ instance: "a", sender: "a", role: "agent", text: "re public", ts: "t", channel: true, replyTo: webChatReplyRef(seen) });
    const r2 = h.record({ instance: "a", sender: "a", role: "agent", text: "re private", ts: "t", channel: true, replyTo: webChatReplyRef(hidden) });
    const guest = { owner: { adapterId: "discord", userId: "1000000000000000777" }, scope: () => new Set(["a"]), current: () => true, chat: () => true, history: () => h } as any;
    const scope = new Set(["a"]);
    expect([guestMessage(r1, guest, scope).replyTo, guestMessage(r2, guest, scope).replyTo])
      .toEqual([webChatReplyRef(seen), { boot: hidden.boot, id: hidden.id, hidden: true }]);
  });
});

describe("Discord/Telegram: a reply_to naming a web message is a native reply to its copy there", () => {
  async function reply(reply_to: string, thread = THREAD) {
    await fm.handleOutboundFromInstance("a", { type: "fleet_outbound", tool: "reply", args: { chat_id: CHAT, thread_id: thread, text: "answer", reply_to },
      fleetRequestId: `r${n}`, adapterId: "discord" });
    await vi.waitFor(() => expect(sendText).toHaveBeenCalled());
    const opts = sendText.mock.calls.at(-1)![2];
    sendText.mockClear();
    return opts.replyTo ?? null;
  }
  it("its web id → the message's copy in this topic; a copy id named directly stays; elsewhere or unknown → passed on as given", async () => {
    fm.emitSseEvent("message", { instance: "a", sender: "Ann", role: "user", text: "from the web", ts: new Date().toISOString(), messageId: "web-lz1-0a0b0c0d" });
    fm.webChatHistory.addPosts("a", "web-lz1-0a0b0c0d", [{ adapterId: "discord", chatId: CHAT, threadId: THREAD, messageId: "1000000000000000301" }]);
    await buttonReply("Pick one", "1000000000000000144", "1000000000000000145");
    expect([
      await reply("web-lz1-0a0b0c0d"),                        // the web message's copy in this topic
      await reply("1000000000000000145"),                     // already a copy here (the buttons message): unchanged
      await reply("web-lz1-0a0b0c0d", "1000000000000000078"), // another thread: no copy there, passed on (the adapter ignores it)
      await reply("web-unknown-0000"),                         // not kept: passed on as before
    ]).toEqual(["1000000000000000301", "1000000000000000145", "web-lz1-0a0b0c0d", "web-unknown-0000"]);
  });
});
