/**
 * #2675 part 2: a kiro V3 card on an instance's screen is put to the people who talk to that instance — in its topic
 * (or ClassicBot room, or the dashboard on a fleet without a chat platform) — with a button per answer; a click, a reply
 * to the post, or the dashboard's text box answers it through the daemon (part 1), and the post collapses to what
 * happened. The cards are read from the captured fixtures.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readKiroMcpInputCard, readKiroQuestionCard } from "../src/backend/kiro.js";
import type { RemoteCard } from "../src/backend/types.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";
import { deriveNeedsYou } from "../src/needs-you.js";
import { remoteCardAction, remoteCardPrompt } from "../src/remote-card-prompt.js";

const Q = (name: string) => readKiroQuestionCard(readFileSync(join(import.meta.dirname, "fixtures", "kiro-question-2592", `${name}.pane.txt`), "utf-8"))!;
const MCP = (name: string) => readKiroMcpInputCard(readFileSync(join(import.meta.dirname, "fixtures", "kiro-2.34.0-audit", `${name}.pane.txt`), "utf-8"))!;
const RICH = () => Q("2.34.0-120-50-question-rich");
const SUB = () => Q("2.34.0-120-51-question-suboptions");
const URL_CARD = () => MCP("mcp-120-20-url-2.34.0");

afterEach(() => setLocale("en"));

describe("#2675 what a card says in the chat", () => {
  it("a question: the question, its options (recommended, descriptions), a button each, Skip; the typed answer is the dashboard's", () => {
    const p = remoteCardPrompt("deployer", RICH());
    expect(p.message).toBe([
      "❓ deployer is asking you:",
      "How should I deploy this change?",
      "1. Staged rollout (recommended) — Ship to 10% of hosts first, then the rest",
      "2. All at once",
      "3. Choose components",
      "Tap an answer below, or reply to this message to answer in your own words.",
    ].join("\n"));
    expect(p.choices).toEqual([
      { action: "opt-1", label: "1. Staged rollout ★" }, { action: "opt-2", label: "2. All at once" },
      { action: "opt-3", label: "3. Choose components" }, { action: "skip", label: "⏭ Skip" },
    ]);
    expect(p.webInput).toEqual({ action: "text", label: "✍️ Answer in words" });
  });

  it("a sub-options page: all, only one, back", () => {
    const p = remoteCardPrompt("deployer", SUB());
    expect(p.message).toBe("❓ deployer: choose what to include\nHow should I deploy this change?\n☑ api\n☑ web");
    expect(p.choices.map(c => c.action)).toEqual(["sub-all", "sub-1", "sub-2", "back"]);
    expect(p.choices[0].label).toBe("All: api, web");
    expect(p.webInput).toBeNull();
  });

  it("an MCP url request: the host, never the URL; Decline and Cancel only", () => {
    const p = remoteCardPrompt("worker", URL_CARD());
    expect(p.message).toContain("🔐 An MCP server (MCP server) is asking worker for input:");
    expect(p.message).toContain("Host: example.invalid");
    expect(p.message).not.toContain("authorize");
    expect(p.choices).toEqual([{ action: "decline", label: "Decline" }, { action: "cancel", label: "Cancel" }]);
  });

  it("zh-TW", () => {
    setLocale("zh-TW");
    const p = remoteCardPrompt("deployer", RICH());
    expect(p.message.split("\n")[0]).toBe("❓ deployer 在問你：");
    expect(p.choices.at(-1)!.label).toBe("⏭ 略過");
  });

  it("every callback id fits Telegram's 64 bytes; ids parse back to their actions, and nothing else does", () => {
    for (const card of [RICH(), SUB(), URL_CARD()]) {
      for (const c of remoteCardPrompt("x", card).choices) {
        expect(Buffer.byteLength(`card-answer:${"f".repeat(32)}:${c.action}`)).toBeLessThanOrEqual(64);
        expect(remoteCardAction(c.action)).not.toBeNull();
      }
    }
    expect(remoteCardAction("opt-2")).toEqual({ kind: "option", n: 2 });
    expect(remoteCardAction("sub-all")).toEqual({ kind: "suboptions", only: null });
    expect(remoteCardAction("text", "  ")).toBeNull();
    expect(remoteCardAction("text")).toBeNull();
    expect(remoteCardAction("text", "x".repeat(5000))).toEqual({ kind: "text", text: "x".repeat(4000) });
    for (const bad of ["opt-", "opt-x", "sub-", "confirm", ""]) expect(remoteCardAction(bad)).toBeNull();
  });

  it("more options than buttons: answered in words or the pane, still with Skip", () => {
    const many: RemoteCard = { ...RICH(), options: Array.from({ length: 21 }, (_, i) => ({ n: i + 1, title: `o${i + 1}`, recommended: false, description: null })) };
    expect(remoteCardPrompt("x", many).choices.map(c => c.action)).toEqual(["skip"]);
  });
});

describe("#2675 Needs you: a posted card is a question, and the wait is not listed twice", () => {
  it("card-answer: → reason question; awaiting_input for the same instance folded", () => {
    const items = deriveNeedsYou({
      prompts: [{ nonce: "n1", prefix: "card-answer:", instance: "w", text: "❓ w is asking you:", actions: [{ id: "opt-1", label: "1. a" }, { id: "text", label: "✍️", input: true }],
        createdAt: 1, adapterId: "tg", chatId: "g" }],
      instances: [{ name: "w", state: "awaiting_input", interaction: { kind: "dialog", owner: "o", episode: 1, since: 1 }, interactionSummary: "x" }],
      deliveries: [], ownerOf: () => "tg",
    } as never);
    expect(items.map(i => [i.type, i.reason])).toEqual([["prompt", "question"]]);
  });
});

describe("#2675 the fleet: post, click, reply, dashboard, retire", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-2675-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(answer = vi.fn(async () => ({ outcome: "answered" as const }))) {
    const adapter = {
      id: "telegram-main", type: "telegram",
      sendText: vi.fn().mockResolvedValue({ messageId: "n", chatId: "fleet-group" }),
      notifyAlert: vi.fn().mockResolvedValue({ messageId: "card-msg", chatId: "fleet-group", threadId: "worker-topic" }),
      editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined),
      editMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const fm = new FleetManager(dir);
    fm.fleetConfig = {
      defaults: {},
      channels: [{ id: "telegram-main", type: "telegram", mode: "topic", group_id: "fleet-group", bot_token_env: "T", access: { mode: "locked", allowed_users: ["alice"] } }],
      instances: { worker: { topic_id: "worker-topic", working_directory: dir } },
    } as any;
    fm.adapter = adapter;
    fm.worlds.set("telegram-main", { id: "telegram-main", adapter, groupId: "fleet-group", channelConfig: fm.fleetConfig!.channels![0],
      accessManager: { isAllowed: (id: string) => id === "alice" } } as any);
    const repost = vi.fn();
    fm.lifecycle.daemons.set("worker", { answerRemoteCard: answer, repostRemoteCard: repost } as any);
    return { fm, adapter, answer, repost };
  }
  const click = (action: string, nonce: string, userId = "alice") => ({
    callbackData: `card-answer:${nonce}:${action}`, chatId: "fleet-group", threadId: "worker-topic", messageId: "card-msg", userId, username: userId, ack: vi.fn(),
  });
  const nonceOf = (adapter: any) => /^card-answer:([0-9a-f]{32}):/.exec(adapter.notifyAlert.mock.calls.at(-1)[1].choices[0].id)![1];

  it("posts to the instance's own topic, with the card's buttons", async () => {
    const { fm, adapter } = setup();
    await fm.postRemoteCard("worker", RICH());
    expect(adapter.notifyAlert).toHaveBeenCalledWith("fleet-group", expect.objectContaining({
      instanceName: "worker", message: expect.stringContaining("How should I deploy this change?"),
      choices: expect.arrayContaining([expect.objectContaining({ id: expect.stringMatching(/^card-answer:[0-9a-f]{32}:opt-1$/), label: "1. Staged rollout ★" })]),
    }), { threadId: "worker-topic" });
  });

  it("a click by someone who may talk to the instance: the daemon keys it on that card; the post says who chose what", async () => {
    const { fm, adapter, answer } = setup();
    await fm.postRemoteCard("worker", RICH());
    await (fm as any).dispatchAdapterCallback(click("opt-2", nonceOf(adapter)), "telegram-main", adapter);
    expect(answer).toHaveBeenCalledWith(RICH().identity, { kind: "option", n: 2 });
    expect(adapter.editMessageRemoveButtons).toHaveBeenCalledWith("fleet-group", "card-msg", "✅ alice answered: All at once", "worker-topic");
    // Claimed once: a second click is stale and keys nothing.
    await (fm as any).dispatchAdapterCallback(click("opt-1", nonceOf(adapter)), "telegram-main", adapter);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("someone who may not talk to the instance: refused, the buttons stay for the others", async () => {
    const { fm, adapter, answer } = setup();
    await fm.postRemoteCard("worker", RICH());
    const stranger = click("opt-1", nonceOf(adapter), "mallory");
    await (fm as any).dispatchAdapterCallback(stranger, "telegram-main", adapter);
    expect(answer).not.toHaveBeenCalled();
    expect(stranger.ack).toHaveBeenCalledWith(expect.any(String));
    await (fm as any).dispatchAdapterCallback(click("skip", nonceOf(adapter)), "telegram-main", adapter);
    expect(answer).toHaveBeenCalledWith(RICH().identity, { kind: "skip" });
  });

  it("a reply to the post is the typed answer, taken once (another bot's copy is dropped); other replies flow on", async () => {
    const { fm, adapter, answer } = setup();
    await fm.postRemoteCard("worker", RICH());
    const reply = { adapterId: "telegram-main", chatId: "fleet-group", threadId: "worker-topic", messageId: "m9", replyTo: "card-msg", userId: "alice", username: "alice", text: "release, after the freeze", source: "telegram" } as any;
    expect(await (fm as any).takeRemoteCardReply({ ...reply, replyTo: "some-other-message" })).toBe(false);
    expect(await (fm as any).takeRemoteCardReply({ ...reply, userId: "mallory" })).toBe(false);
    expect(await (fm as any).takeRemoteCardReply(reply)).toBe(true);
    expect(answer).toHaveBeenCalledWith(RICH().identity, { kind: "text", text: "release, after the freeze" });
    expect(adapter.editMessageRemoveButtons).toHaveBeenCalledWith("fleet-group", "card-msg", "✅ alice answered: an answer in words", "worker-topic");
    expect(await (fm as any).takeRemoteCardReply(reply)).toBe(true);   // the same message again: dropped, not delivered
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("through the inbound handler: the reply answers the card and is not delivered to the instance", async () => {
    const { fm, adapter, answer } = setup();
    const deliver = vi.spyOn(fm as any, "deliverToInstance");
    await fm.postRemoteCard("worker", RICH());
    await (fm as any).handleInboundMessage({ source: "telegram", adapterId: "telegram-main", chatId: "fleet-group", threadId: "worker-topic",
      messageId: "m10", replyTo: "card-msg", userId: "alice", username: "alice", text: "release", timestamp: new Date() });
    expect(answer).toHaveBeenCalledWith(RICH().identity, { kind: "text", text: "release" });
    expect(deliver).not.toHaveBeenCalled();
    expect(adapter.editMessageRemoveButtons).toHaveBeenCalledWith("fleet-group", "card-msg", "✅ alice answered: an answer in words", "worker-topic");
  });

  it("an MCP input card takes no reply as an answer", async () => {
    const { fm, answer } = setup();
    await fm.postRemoteCard("worker", URL_CARD());
    expect(await (fm as any).takeRemoteCardReply({ adapterId: "telegram-main", chatId: "fleet-group", messageId: "m1", replyTo: "card-msg", userId: "alice", text: "x" })).toBe(false);
    expect(answer).not.toHaveBeenCalled();
  });

  it("the dashboard: the card is offered with its text box; a typed answer goes through, an empty or stray one is refused", async () => {
    const { fm, adapter, answer } = setup();
    await fm.postRemoteCard("worker", RICH());
    const nonce = nonceOf(adapter);
    const offered = fm.listWebPrompts().find(p => p.nonce === nonce)!;
    expect(offered.actions.at(-1)).toEqual({ id: "text", label: "✍️ Answer in words", input: true });
    expect((await fm.clickWebPrompt("worker", nonce, "text", "   ")).status).toBe(400);
    expect((await fm.clickWebPrompt("worker", nonce, "text")).status).toBe(400);
    expect((await fm.clickWebPrompt("worker", nonce, "opt-1", "words on a button")).status).toBe(400);
    expect(answer).not.toHaveBeenCalled();
    expect((await fm.clickWebPrompt("worker", nonce, "text", "ship it")).status).toBe(200);
    expect(answer).toHaveBeenCalledWith(RICH().identity, { kind: "text", text: "ship it" });
    expect(adapter.editMessageRemoveButtons).toHaveBeenCalledWith("fleet-group", "card-msg", "✅ someone on the dashboard answered: an answer in words", "worker-topic");
  });

  it("an answer that did not take: the post says so, and the daemon posts the card again", async () => {
    const { fm, adapter, repost } = setup(vi.fn(async () => ({ outcome: "stopped" as const, step: "moving to option 2" })));
    await fm.postRemoteCard("worker", RICH());
    await (fm as any).dispatchAdapterCallback(click("opt-2", nonceOf(adapter)), "telegram-main", adapter);
    expect(adapter.editMessageRemoveButtons).toHaveBeenCalledWith("fleet-group", "card-msg", expect.stringMatching(/^Could not confirm that answer on worker's screen/), "worker-topic");
    expect(repost).toHaveBeenCalledTimes(1);
  });

  it("stale (answered in the pane first): told, not reposted", async () => {
    const { fm, adapter, repost } = setup(vi.fn(async () => ({ outcome: "stale" as const })));
    await fm.postRemoteCard("worker", RICH());
    await (fm as any).dispatchAdapterCallback(click("opt-2", nonceOf(adapter)), "telegram-main", adapter);
    expect(adapter.editMessageRemoveButtons).toHaveBeenCalledWith("fleet-group", "card-msg", "This question to worker was already answered or has changed.", "worker-topic");
    expect(repost).not.toHaveBeenCalled();
  });

  it("the card closes in the pane: its post collapses; another card's gone leaves it alone", async () => {
    const { fm, adapter } = setup();
    await fm.postRemoteCard("worker", RICH());
    fm.retireRemoteCard("worker", "some other card");
    expect(adapter.editMessageRemoveButtons).not.toHaveBeenCalled();
    fm.retireRemoteCard("worker", RICH().identity);
    await vi.waitFor(() => expect(adapter.editMessageRemoveButtons).toHaveBeenCalledWith("fleet-group", "card-msg", "This question was answered at the instance's terminal.", "worker-topic"));
    expect(fm.listWebPrompts()).toEqual([]);
  });

  it("a new card while one is posted: the old post collapses first", async () => {
    const { fm, adapter } = setup();
    await fm.postRemoteCard("worker", RICH());
    await fm.postRemoteCard("worker", SUB());
    expect(adapter.editMessageRemoveButtons).toHaveBeenCalledTimes(1);
    expect(fm.listWebPrompts()).toHaveLength(1);
  });
});
