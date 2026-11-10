import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";
import { selectionCard } from "../src/selection-card.js";
import { answerRemoteCard, type RemoteCardAction, type RemoteCardIo } from "../src/remote-card-answer.js";

const pane = readFileSync(join(import.meta.dirname, "fixtures/claude-2.1.318-bash-permission-prompt.pane.txt"), "utf8");
const permission = () => selectionCard(pane, "Claude Code")!;
const owned: Array<{ fm: FleetManager; dir: string }> = [];
beforeEach(() => setLocale("en"));
afterEach(() => {
  for (const { fm, dir } of owned.splice(0)) {
    fm.retireRemoteCard("worker", null);
    fm.stormWindow.shutdown(); fm.spawnGate.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

// The real card reader/answer walk runs against a scripted pane. No CLI, model or network is started.
function fleet(type: "telegram" | "discord" | "web", classic = false, rawPane = pane) {
  const dir = mkdtempSync(join(tmpdir(), "agend-question-3334-"));
  vi.stubEnv("AGEND_HOME", dir);
  const fm = new FleetManager(dir); owned.push({ fm, dir });
  const adapterId = `${type}-owner`, chatId = "owned-group", threadId = classic ? undefined : "worker-topic";
  const channel = { id: adapterId, type, mode: "topic", group_id: chatId, bot_token_env: "DUMMY_TOKEN",
    access: { mode: "open", allowed_users: ["owner-admin"] } };
  const adapter = { id: adapterId, type,
    notifyAlert: vi.fn().mockResolvedValue({ messageId: "card-message", chatId, threadId }),
    sendText: vi.fn().mockResolvedValue({ messageId: "outcome", chatId, threadId }),
    editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined),
  } as any;
  fm.fleetConfig = { defaults: {}, ...(type === "web" ? {} : { channels: [channel] }),
    instances: { worker: { topic_id: "worker-topic", working_directory: dir } } } as any;
  if (type !== "web") {
    fm.adapter = adapter;
    fm.worlds.set(adapterId, { id: adapterId, adapter, groupId: chatId, channelConfig: channel,
      accessManager: { isAllowed: () => true } } as any);
  }
  if (classic) (fm as any).classicChannels = {
    getChannelIdByInstance: () => chatId, getAdapterIdByInstance: () => adapterId,
  };
  vi.spyOn(fm, "emitSseEvent").mockImplementation(() => {});
  let cursor = 1, closed = false, changed = false, time = 0, livePane = rawPane;
  const keys: string[] = [];
  const screen = () => closed ? "\n> \n" : (changed ? livePane.replaceAll("perm-probe.txt", "another-request.txt") : livePane)
    .replace(/^([ \t]*)(?:❯[ \t]*)?(\d)\. (.*)$/gm, (_row, _indent, n, title) => `${Number(n) === cursor ? " ❯ " : "   "}${n}. ${title}`);
  const io: RemoteCardIo = {
    locked: fn => fn(), read: async () => screen(), paste: async () => false,
    sleep: async ms => { time += ms; }, now: () => time,
    key: async key => { keys.push(key); if (key === "Down") cursor++; if (key === "Up") cursor--; if (key === "Enter") closed = true; return true; },
  };
  const answer = vi.fn((identity: string, action: RemoteCardAction) => answerRemoteCard(io, p => selectionCard(p, "Claude Code"), identity, action));
  const repost = vi.fn();
  fm.lifecycle.daemons.set("worker", { answerRemoteCard: answer, repostRemoteCard: repost } as any);
  const currentPrompt = () => fm.listWebPrompts()[0]!;
  const click = (action = "opt-1", userId = "owner-admin", overrides = {}) => ({
    callbackData: `card-answer:${currentPrompt().nonce}:${action}`, chatId, threadId, messageId: "card-message",
    userId, username: userId, ack: vi.fn(), ...overrides,
  });
  const dispatch = (data: ReturnType<typeof click>, id = adapterId, receiver = adapter) => (fm as any).dispatchAdapterCallback(data, id, receiver);
  const reply = (userId: string) => ({ source: type, adapterId, chatId, threadId, messageId: "reply-1", replyTo: "card-message", userId, text: "Yes" });
  return { fm, adapter, adapterId, channel, keys, answer, repost, currentPrompt, click, dispatch, reply,
    changeQuestion: () => { changed = true; }, replacePane: (next: string) => { livePane = next; },
    card: () => selectionCard(rawPane, "Claude Code")! };
}

describe.each(["telegram", "discord"] as const)("#3334 CLI permission on a %s fleet", type => {
  it("posts the exact question and choices in the worker's topic and Needs-you, without answering automatically", async () => {
    const h = fleet(type);
    await h.fm.postRemoteCard("worker", permission());
    expect(h.adapter.notifyAlert).toHaveBeenCalledOnce();
    const [chat, alert, opts] = h.adapter.notifyAlert.mock.calls[0];
    expect([chat, opts]).toEqual(["owned-group", { threadId: "worker-topic" }]);
    expect(alert.message).toContain("touch perm-probe.txt");
    expect(alert.message).toContain(permission().options.map(o => `${o.n}. ${o.title}`).join("\n"));
    expect(alert.choices.map((c: any) => c.label)).toEqual(["1. Yes", expect.stringMatching(/^2\. Yes, and always allow access/),
      expect.stringMatching(/^3\. Yes, and switch to auto mode/), "4. No"]);
    expect(alert.choices.map((c: any) => c.id)).toEqual([1, 2, 3, 4].map(n => `card-answer:${h.currentPrompt().nonce}:opt-${n}`));
    expect(h.currentPrompt().actions.map(a => a.id)).toEqual(["opt-1", "opt-2", "opt-3", "opt-4"]);
    expect(h.keys).toEqual([]); expect(h.answer).not.toHaveBeenCalled();
  });

  it("only the owning adapter's current admin can answer, once, even when ordinary chat is open", async () => {
    const h = fleet(type);
    await h.fm.postRemoteCard("worker", permission());
    const denied = h.click("opt-1", "chat-member");
    await h.dispatch(denied);
    expect(denied.ack).toHaveBeenCalledWith(expect.stringContaining("admin"));
    expect(h.answer).not.toHaveBeenCalled(); expect(h.keys).toEqual([]);
    expect(h.fm.listWebPrompts()).toHaveLength(1);
    const allowed = h.click();
    await h.dispatch(allowed);
    expect(h.answer).toHaveBeenCalledWith(permission().identity, { kind: "option", n: 1 });
    expect(h.keys).toEqual(["Enter"]);
    await h.dispatch(allowed);
    expect(h.answer).toHaveBeenCalledTimes(1);
    expect(h.fm.listWebPrompts()).toEqual([]);
  });

  it("a different adapter's admin or a callback from another place cannot claim the answer", async () => {
    const h = fleet(type);
    h.fm.fleetConfig!.channels!.unshift({ ...h.channel, id: "other-adapter", access: { mode: "locked", allowed_users: ["other-admin"] } } as any);
    h.fm.fleetConfig!.instances.worker.channel_id = h.adapterId;
    await h.fm.postRemoteCard("worker", permission());
    await h.dispatch(h.click("opt-1", "other-admin"));
    expect(h.answer).not.toHaveBeenCalled();
    const mismatches = [{ chatId: "other-group" }, { threadId: "other-topic" }, { messageId: "other-message" }];
    for (const wrong of mismatches) {
      await h.dispatch(h.click("opt-1", "owner-admin", wrong));
      expect(h.keys).toEqual([]);
      expect(h.fm.listWebPrompts()).toHaveLength(1);
    }
    await h.dispatch(h.click(), "other-adapter");
    expect(mismatches).toHaveLength(3);
    expect(h.answer).not.toHaveBeenCalled(); expect(h.keys).toEqual([]);
    expect(h.fm.listWebPrompts()).toHaveLength(1);
    await h.dispatch(h.click("opt-4"));
    expect(h.keys).toEqual(["Down", "Down", "Down", "Enter"]);
  });

  it("rechecks admin revocation after posting and does not consume a refused click", async () => {
    const h = fleet(type);
    await h.fm.postRemoteCard("worker", permission());
    h.channel.access.allowed_users = [];
    await h.dispatch(h.click());
    expect(h.answer).not.toHaveBeenCalled(); expect(h.keys).toEqual([]);
    expect(h.fm.listWebPrompts()).toHaveLength(1);
    h.channel.access.allowed_users = ["owner-admin"];
    await h.dispatch(h.click());
    expect(h.keys).toEqual(["Enter"]);
  });

  it.each(["button", "text", "web"] as const)("retires an old CLI prompt after its worker transfers to another connection (%s)", async surface => {
    const h = fleet(type);
    await h.fm.postRemoteCard("worker", permission());
    const originalClick = h.click();
    const nonce = h.currentPrompt().nonce;
    h.fm.fleetConfig!.channels!.push({ ...h.channel, id: "new-owner", group_id: "new-group",
      access: { mode: "locked", allowed_users: ["new-admin"] } } as any);
    h.fm.fleetConfig!.instances.worker.channel_id = "new-owner";
    expect(h.fm.getInstanceAdapterId("worker")).toBe("new-owner");
    if (surface === "button") await h.dispatch(originalClick);
    else if (surface === "text") await (h.fm as any).takeRemoteCardReply(h.reply("owner-admin"));
    else await h.fm.clickWebPrompt("worker", nonce, "opt-1");
    expect(h.answer).not.toHaveBeenCalled();
    expect(h.keys).toEqual([]);
    expect(h.fm.listWebPrompts()).toEqual([]);
    expect(h.repost).not.toHaveBeenCalled();
  });

  it("a typed reply cannot bypass admin authority or invent an answer the dialog does not offer", async () => {
    const h = fleet(type);
    await h.fm.postRemoteCard("worker", permission());
    expect(await (h.fm as any).takeRemoteCardReply(h.reply("chat-member"))).toBe(false);
    expect(h.answer).not.toHaveBeenCalled(); expect(h.fm.listWebPrompts()).toHaveLength(1);
    expect(await (h.fm as any).takeRemoteCardReply(h.reply("owner-admin"))).toBe(true);
    expect(h.answer).toHaveBeenCalledWith(permission().identity, { kind: "text", text: "Yes" });
    expect(h.keys).toEqual([]);
    expect(h.repost).toHaveBeenCalledOnce();
  });

  it("an answer to a replaced live question sends no key", async () => {
    const h = fleet(type);
    await h.fm.postRemoteCard("worker", permission());
    h.changeQuestion();
    await h.dispatch(h.click());
    expect(h.answer).toHaveBeenCalledOnce();
    expect(h.keys).toEqual([]);
    expect(h.repost).not.toHaveBeenCalled();
  });

  it("a Classic room receives no CLI dialog body or buttons; the admin dashboard retains the exact answer", async () => {
    const h = fleet(type, true);
    await h.fm.postRemoteCard("worker", permission());
    expect(h.adapter.notifyAlert).not.toHaveBeenCalled();
    expect(h.adapter.sendText).not.toHaveBeenCalled();
    expect(h.fm.listWebPrompts()).toHaveLength(1);
    expect(h.currentPrompt().text).toContain("touch perm-probe.txt");
    expect(h.currentPrompt().actions.map(a => a.id)).toEqual(["opt-1", "opt-2", "opt-3", "opt-4"]);
    const nonce = h.currentPrompt().nonce;
    await h.dispatch(h.click()); // even an admin's fabricated room callback is not the private web prompt
    expect(h.answer).not.toHaveBeenCalled(); expect(h.keys).toEqual([]);
    expect((await h.fm.clickWebPrompt("worker", nonce, "opt-1")).status).toBe(200);
    expect(h.keys).toEqual(["Enter"]);
    expect(h.adapter.editMessageRemoveButtons).not.toHaveBeenCalled();
  });

  it("redacts chat text, labels before clipping and the selected answer, while preserving the raw request identity", async () => {
    const value = "fixture-private-" + "x".repeat(90);
    const raw = pane.replaceAll("touch perm-probe.txt", `API_KEY="${value}" curl -H "Authorization: Bearer ${value}" https://example.invalid`)
      .replace("❯ 1. Yes", `❯ 1. Yes TOKEN="${value}"`);
    const h = fleet(type, false, raw);
    const card = h.card();
    await h.fm.postRemoteCard("worker", card);
    const wire = JSON.stringify(h.adapter.notifyAlert.mock.calls);
    expect(wire).toContain("[REDACTED]");
    expect(wire).not.toContain("fixture-private-");
    expect(h.currentPrompt().text).not.toContain(value);
    expect(h.currentPrompt().actions[0].label).toBe("1. Yes TOKEN=[REDACTED]");
    expect(card.question).toContain(value); // presentation never mutates the raw request
    await h.dispatch(h.click());
    expect(h.answer).toHaveBeenCalledWith(card.identity, { kind: "option", n: 1 });
    expect(h.keys).toEqual(["Enter"]);
    expect(JSON.stringify(h.adapter.editMessageRemoveButtons.mock.calls)).not.toContain("fixture-private-");
    expect(JSON.stringify(h.adapter.editMessageRemoveButtons.mock.calls)).toContain("[REDACTED]");
  });

  it("different secret-bearing requests remain different live cards even when their chat presentation is masked", async () => {
    const first = "fixture-private-" + "a".repeat(20), second = "fixture-private-" + "b".repeat(20);
    const raw = pane.replaceAll("touch perm-probe.txt", `TOKEN=${first} curl https://example.invalid`);
    const h = fleet(type, false, raw), original = h.card();
    await h.fm.postRemoteCard("worker", original);
    expect(h.fm.listWebPrompts()).toHaveLength(1);
    h.replacePane(raw.replaceAll(first, second));
    expect(selectionCard(raw.replaceAll(first, second), "Claude Code")!.identity).not.toBe(original.identity);
    await h.dispatch(h.click());
    expect(h.answer).toHaveBeenCalledWith(original.identity, { kind: "option", n: 1 });
    expect(h.keys).toEqual([]);
  });

  it("ordinary agent questions retain the Classic room's conversation authority", async () => {
    const h = fleet(type, true);
    await h.fm.postRemoteCard("worker", { ...permission(), webOnly: undefined });
    await h.dispatch(h.click("opt-1", "chat-member"));
    expect(h.answer).toHaveBeenCalledWith(permission().identity, { kind: "option", n: 1 });
    expect(h.keys).toEqual(["Enter"]);
  });
});

it("#3334 the web-only control retains the same choices, exact instance binding and one-shot answer", async () => {
  const h = fleet("web");
  await h.fm.postRemoteCard("worker", permission());
  expect(h.currentPrompt().actions.map(a => a.id)).toEqual(["opt-1", "opt-2", "opt-3", "opt-4"]);
  expect(h.adapter.notifyAlert).not.toHaveBeenCalled(); expect(h.keys).toEqual([]);
  const nonce = h.currentPrompt().nonce;
  expect((await h.fm.clickWebPrompt("other-worker", nonce, "opt-4")).status).toBe(403);
  expect((await h.fm.clickWebPrompt("worker", nonce, "skip")).status).toBe(400);
  expect((await h.fm.clickWebPrompt("worker", nonce, "opt-4")).status).toBe(200);
  expect(h.keys).toEqual(["Down", "Down", "Down", "Enter"]);
  expect((await h.fm.clickWebPrompt("worker", nonce, "opt-1")).status).toBe(409);
});
