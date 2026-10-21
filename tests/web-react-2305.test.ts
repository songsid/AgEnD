/**
 * #2305: an instance's reaction to a web chat message — the minimal reply the platforms already had. The emoji rules
 * (web-reactions.ts), the row in the web chat history (kept, read back, polled), the fleet taking a react on a web id
 * before any adapter (MCP and HTTP paths, a web-only fleet, the channel copy), what a guest sees, and the reply guard
 * counting it as the turn's answer.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEB_ECHO_COPIES_MAX, WEB_MIRROR_TIMEOUT_MS, WEB_REACTIONS_MAX, WEB_REACTION_SUGGESTIONS, webReactionEmoji, webReactionProblem, webReactionsOf } from "../src/web-reactions.js";
import { WebChatHistory, type StoredWebChatMessage } from "../src/web-chat-history.js";
import { guestFrameData, guestPollBody } from "../src/web-guest-access.js";
import { dispatchAgentOperation } from "../src/agent-endpoint.js";
import { Daemon } from "../src/daemon.js";
import type { Logger } from "../src/logger.js";

vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
vi.mock("../src/backend/types.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/backend/types.js")>(), resolveBinary: (name: string) => name }));

const homes: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const ts = "2026-10-21T08:00:00.000Z";

describe("the web reaction set", () => {
  it("one emoji of Telegram's reaction set, spelled as the set spells it; a variation selector is accepted", () => {
    expect([webReactionEmoji("👍"), webReactionEmoji("👍\uFE0F"), webReactionEmoji("❤\uFE0F"), webReactionEmoji(" 🙏 ")]).toEqual(["👍", "👍", "❤", "🙏"]);
    for (const bad of ["👍👍", "OK", "", "<:ok:123456789012345678>", "🦊", 42, null]) expect(webReactionEmoji(bad), String(bad)).toBeNull();
  });
  it("refused: outside the set, or one of the instance's delivery marks — the error names allowed ones, never a mark", () => {
    expect(webReactionProblem("👍", ["👀", "⏳", "✅", "❌"])).toBeNull();
    expect(webReactionProblem("🦊", [])).toMatch(/cannot be a web reaction.*👍/);
    const mark = webReactionProblem("👀", ["👀", "⏳"]);
    expect(mark).toMatch(/delivery marks/);
    const offered = webReactionProblem("🦊", ["👍"])!;
    expect(offered).not.toMatch(/👍/);
    expect(WEB_REACTION_SUGGESTIONS.every(e => webReactionEmoji(e) === e)).toBe(true);
  });
  it("webReactionsOf (read back): distinct, in the set, at most WEB_REACTIONS_MAX; nothing valid is none", () => {
    expect(webReactionsOf(["👍", "👍", "🦊", "🙏", 3])).toEqual(["👍", "🙏"]);
    expect(webReactionsOf([...WEB_REACTION_SUGGESTIONS])).toHaveLength(WEB_REACTIONS_MAX);
    expect([webReactionsOf([]), webReactionsOf("👍"), webReactionsOf(["🦊"])]).toEqual([undefined, undefined, undefined]);
  });
});

describe("the web chat history", () => {
  const ok = (h: WebChatHistory, messageId = "web-ok1") => h.record({ instance: "dev", sender: "han", text: "OK", ts, role: "user", messageId });
  it("addReaction: on the message with that id; again or past the cap changes nothing; an unknown id is null", () => {
    const h = new WebChatHistory({ boot: "b1" });
    const m = ok(h);
    expect(h.addReaction("dev", "web-ok1", "👍")).toEqual({ message: m, added: true });
    expect(h.addReaction("dev", "web-ok1", "👍")!.added).toBe(false);
    for (const e of WEB_REACTION_SUGGESTIONS) h.addReaction("dev", "web-ok1", e);
    expect(m.reactions).toHaveLength(WEB_REACTIONS_MAX);
    expect([h.addReaction("dev", "web-nope", "👍"), h.addReaction("other", "web-ok1", "👍")]).toEqual([null, null]);
    expect(h.reactionStates()).toEqual([{ instance: "dev", boot: "b1", id: m.id, reactions: m.reactions }]);
  });
  it("kept on disk and read back by the next process: the reactions (validated) — still no message id (#1565), so no new one", () => {
    const rows: Record<string, StoredWebChatMessage[]> = {};
    const store = { schedule: (i: string, snap: () => StoredWebChatMessage[]) => { rows[i] = snap(); }, remove: async () => {} };
    const a = new WebChatHistory({ boot: "b1", store: store as never });
    ok(a);
    a.record({ instance: "dev", sender: "dev", text: "done", ts, role: "agent", messageId: "web-agent-x" });
    a.addReaction("dev", "web-ok1", "👌");
    expect(rows.dev![0]).toMatchObject({ reactions: ["👌"] });
    expect(rows.dev!.map(r => (r as { messageId?: string }).messageId)).toEqual([undefined, undefined]);
    const tampered = [{ ...rows.dev![0]!, reactions: ["👌", "🦊", "<script>"], messageId: "web-ok1" }];
    const b = new WebChatHistory({ boot: "b2" });
    b.restore("dev", tampered);
    const [first] = b.list("dev");
    expect([first!.messageId, first!.reactions]).toEqual([undefined, ["👌"]]);
    expect(b.addReaction("dev", "web-ok1", "🙏")).toBeNull();
  });
});

describe("what a guest sees", () => {
  const guestOf = (h: WebChatHistory) => ({ owner: { adapterId: "discord", userId: "9" }, scope: () => new Set(["dev"]), history: () => h, current: () => true }) as never;
  it("a reaction on a message it may see (its own, or the channel's); not on another person's", () => {
    const h = new WebChatHistory({ boot: "b1" });
    const mine = h.record({ instance: "dev", sender: "g", text: "OK", ts, role: "user", messageId: "web-g1", from: "discord:9" });
    const other = h.record({ instance: "dev", sender: "han", text: "OK", ts, role: "user", messageId: "web-h1", from: "discord:1" });
    h.addReaction("dev", "web-g1", "👍"); h.addReaction("dev", "web-h1", "👍");
    const frame = (m: { boot: string; id: number }) => guestFrameData("reactions", { instance: "dev", boot: m.boot, id: m.id, reactions: ["👍"] }, new Set(["dev"]), guestOf(h));
    expect(frame(mine)).toEqual({ instance: "dev", boot: "b1", id: mine.id, reactions: ["👍"] });
    expect(frame(other)).toBeUndefined();
    const poll = guestPollBody({}, new Set(["dev"]), Date.now(), guestOf(h), null, () => []) as { reactions: Array<{ id: number }> };
    expect(poll.reactions.map(r => r.id)).toEqual([mine.id]);
  });
});

async function fleet() {
  const home = mkdtempSync(join(tmpdir(), "agend-test-react-")); homes.push(home);
  vi.stubEnv("AGEND_HOME", home);
  const { FleetManager } = await import("../src/fleet-manager.js");
  const fm = new FleetManager(home) as any;
  clearInterval(fm.sessionPruneTimer);
  fm.fleetConfig = { defaults: {}, instances: { dev: { working_directory: home } } };   // no channel: a web-only fleet
  const answers: Array<{ result: unknown; error?: string }> = [];
  fm.instanceIpcClients.set("dev", { send: (m: any) => { answers.push({ result: m.result, error: m.error }); return true; } });
  const events: Array<[string, any]> = [];
  const emit = fm.emitSseEvent.bind(fm);
  fm.emitSseEvent = (e: string, d: unknown) => { events.push([e, d]); emit(e, d); };
  const react = async (args: Record<string, unknown>) => { await fm.handleOutboundFromInstance("dev", { tool: "react", args, fleetRequestId: "tool_1_1" }); return answers.at(-1)!; };
  return { fm, react, events, answers };
}

describe("the fleet takes a react on a web id (MCP path)", () => {
  it("a web-only fleet: on the row, live on the stream; again: ok, no second event", async () => {
    const { fm, react, events } = await fleet();
    fm.emitSseEvent("message", { instance: "dev", sender: "han", text: "OK", ts, role: "user", messageId: "web-ok1" });
    expect(await react({ message_id: "web-ok1", emoji: "👍\uFE0F", chat_id: "" })).toEqual({ result: "ok", error: undefined });
    const row = fm.webChatHistory.findByMessageId("dev", "web-ok1");
    expect(row.reactions).toEqual(["👍"]);
    expect(events.filter(([e]) => e === "reactions")).toEqual([["reactions", { instance: "dev", boot: row.boot, id: row.id, reactions: ["👍"] }]]);
    expect(await react({ message_id: "web-ok1", emoji: "👍" })).toEqual({ result: "ok", error: undefined });
    expect(events.filter(([e]) => e === "reactions")).toHaveLength(1);
  });
  it("refused with the tool's error: an emoji outside the set, a delivery mark, a message the chat does not have", async () => {
    const { fm, react } = await fleet();
    fm.emitSseEvent("message", { instance: "dev", sender: "han", text: "OK", ts, role: "user", messageId: "web-ok1" });
    expect((await react({ message_id: "web-ok1", emoji: "🦊" })).error).toMatch(/cannot be a web reaction/);
    expect((await react({ message_id: "web-ok1", emoji: "⏳" })).error).toMatch(/cannot be a web reaction|delivery marks/);
    expect((await react({ message_id: "web-ok1", emoji: "👀" })).error).toMatch(/delivery marks/);
    expect((await react({ message_id: "web-gone", emoji: "👍" })).error).toMatch(/not a message in dev's web chat now .* answer with reply instead/);
    expect(fm.webChatHistory.findByMessageId("dev", "web-ok1").reactions).toBeUndefined();
  });
  it("the web message's channel copies get it too (their adapter's spelling); a copy's failure is not the tool's", async () => {
    const { fm, react } = await fleet();
    fm.emitSseEvent("message", { instance: "dev", sender: "han", text: "thanks", ts, role: "user", messageId: "web-t1" });
    const tg = { type: "telegram", react: vi.fn(async () => {}) };
    const dc = { type: "discord", react: vi.fn(async () => { throw new Error("Missing Permissions"); }) };
    fm.webMessageInChannel("dev", "web-t1", [{ adapter: tg, chatId: "-100", threadId: "7", messageId: "555" }, { adapter: dc, chatId: "g", messageId: "777" }]);
    expect(await react({ message_id: "web-t1", emoji: "❤\uFE0F" })).toEqual({ result: "ok", error: undefined });
    await vi.waitFor(() => expect(dc.react).toHaveBeenCalled());
    expect(tg.react).toHaveBeenCalledWith("-100", "555", "❤", "7");
    expect(dc.react).toHaveBeenCalledWith("g", "777", "❤", undefined);
    // Without a copy (none sent, or another process sent it): the web only.
    fm.emitSseEvent("message", { instance: "dev", sender: "han", text: "ok", ts, role: "user", messageId: "web-t2" });
    const none = await fm.reactToWebMessage("dev", "web-t2", "👌");
    expect([none.ok, await none.mirrored]).toEqual([true, 0]);
  });
  it("#2310 review: the socket's own instance — a session name the caller wrote itself reaches no other chat", async () => {
    const { fm, react } = await fleet();
    fm.emitSseEvent("message", { instance: "other", sender: "han", text: "OK", ts, role: "user", messageId: "web-o1" });
    await fm.handleOutboundFromInstance("dev", { tool: "react", args: { message_id: "web-o1", emoji: "👍" }, fleetRequestId: "tool_1_2", senderSessionName: "other" });
    expect(fm.webChatHistory.findByMessageId("other", "web-o1").reactions).toBeUndefined();
    expect((await react({ message_id: "web-o1", emoji: "👍" })).error).toMatch(/not a message in dev's web chat/);
  });
  it("#2310 review: copies are kept at most WEB_ECHO_COPIES_MAX (the oldest go), and only those whose adapter can react", async () => {
    const { fm } = await fleet();
    const adapter = { type: "discord", react: vi.fn(async () => {}) };
    for (let i = 0; i <= WEB_ECHO_COPIES_MAX; i++) fm.webMessageInChannel("dev", `web-c${i}`, [{ adapter, chatId: "g", messageId: String(i) }]);
    expect([fm.webEchoCopies.size, fm.webEchoCopies.has("web-c0"), fm.webEchoCopies.has(`web-c${WEB_ECHO_COPIES_MAX}`)]).toEqual([WEB_ECHO_COPIES_MAX, false, true]);
    fm.webMessageInChannel("dev", "web-norx", [{ adapter: { type: "telegram" }, chatId: "c", messageId: "9" }]);
    expect(fm.webEchoCopies.get("web-norx") ?? []).toEqual([]);
  });
  it("#2310 review: a copy that never answers holds neither the tool nor anything else — given up after WEB_MIRROR_TIMEOUT_MS", async () => {
    const { fm } = await fleet();
    fm.emitSseEvent("message", { instance: "dev", sender: "han", text: "OK", ts, role: "user", messageId: "web-slow" });
    const hung = { type: "discord", react: vi.fn(() => new Promise<void>(() => {})) };
    fm.webMessageInChannel("dev", "web-slow", [{ adapter: hung, chatId: "g", messageId: "1" }]);
    vi.useFakeTimers();
    const r = await fm.reactToWebMessage("dev", "web-slow", "👍");
    expect(r.ok).toBe(true);                                         // answered: the copy is not waited for
    let settled: number | null = null;
    void r.mirrored.then((n: number) => { settled = n; });
    await vi.advanceTimersByTimeAsync(0);
    expect(hung.react).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WEB_MIRROR_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(0);
    vi.useRealTimers();
  });
  it("a react on a platform message still goes to the adapter path (not taken here)", async () => {
    const { react } = await fleet();
    expect((await react({ message_id: "12345", emoji: "👍" })).error).toMatch(/Channel adapters are not ready/);
  });
});

describe("the HTTP agent path", () => {
  const ctx = (reactToWebMessage?: unknown) => ({ dataDir: "/nowhere", fleetConfig: { instances: { dev: {} } }, logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }, ...(reactToWebMessage ? { reactToWebMessage } : {}) }) as never;
  it("a react on a web id goes to the fleet's web reaction, its error as the result's", async () => {
    const fn = vi.fn(async (_i: string, id: string) => (id === "web-ok1" ? { ok: true, mirrored: Promise.resolve(0) } : { ok: false, error: "react: nope" }));
    expect(await dispatchAgentOperation(ctx(fn), "dev", "react", { message_id: "web-ok1", emoji: "👍" })).toBe("ok");
    expect(fn).toHaveBeenCalledWith("dev", "web-ok1", "👍");
    expect(await dispatchAgentOperation(ctx(fn), "dev", "react", { message_id: "web-x", emoji: "👍" })).toEqual({ error: "react: nope" });
    expect(await dispatchAgentOperation(ctx(), "dev", "react", { message_id: "web-ok1", emoji: "👍" })).toEqual({ error: "react: the web chat is not available" });
  });
});

describe("the reply guard counts a successful web react as the turn's answer", () => {
  function daemon(): any {
    const dir = mkdtempSync(join(tmpdir(), "agend-react-guard-")); homes.push(dir);
    const d = new Daemon("worker", { backend: "claude-code", working_directory: dir, restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent" } as never, dir, true, { binaryName: "claude", replyCompletionGuard: true } as never,
      undefined, pino({ level: "silent" }) as Logger) as any;
    d.tmux = {}; d.deliverMessage = vi.fn(async () => true); d.deliverDaemonReply = vi.fn(async () => true);
    d.mcpServerAlive = vi.fn(() => ({ alive: true, source: "connection" }));
    d.ipcServer = { broadcast: vi.fn(), send: vi.fn(() => true) };
    return d;
  }
  const idle = () => ({ state: "idle", unchangedForMs: 0, observedAt: Date.now(), stateChangedAt: Date.now() });
  it.each([["ok", 0], ["refused", 1]] as const)("a web message answered with a react (%s): re-prompts %i time(s)", async (outcome, prompts) => {
    vi.useFakeTimers();
    const d = daemon();
    d.markTurnStarted({ chat_id: "", thread_id: "", message_id: "web-ok1", source: "web" }, "[user:han via web] OK");
    const socket = new EventEmitter() as any;
    d.socketSessionNames.set(socket, "worker");
    d.handleToolCall({ tool: "react", args: { message_id: "web-ok1", emoji: "👍" }, requestId: 3 }, socket);
    const pending = [...d.pendingIpcRequests.entries()].find(([key]: [string]) => key === "tool_1_3");
    expect(pending).toBeDefined();
    pending![1](outcome === "ok" ? { result: "ok" } : { result: null, error: "react: 🦊 cannot be a web reaction" });
    d.applyInstanceStateSnapshot({ ...idle(), state: "working" }, "work\n❯");
    d.applyInstanceStateSnapshot(idle(), "work\n❯");
    await vi.advanceTimersByTimeAsync(61_000);
    d.applyInstanceStateSnapshot(idle(), "work\n❯");
    await d.pasteLock;
    expect(d.deliverMessage).toHaveBeenCalledTimes(prompts);
    vi.useRealTimers();
  });
});

describe("the page", () => {
  it("applyReactions patches the row by boot and id (the same list when nothing changed); reactionsHtml escapes and labels", async () => {
    // @ts-expect-error — a UMD module of the app, with no types
    const R = (await import("../src/ui/chat-render.js")).default ?? (globalThis as any).AgendChatRender;
    const list = [{ boot: "b1", id: 1, text: "OK" }, { boot: "b1", id: 2, text: "x" }];
    const next = R.applyReactions(list, "b1", 1, ["👍", "👍", 5, "❤"]);
    expect(next[0].reactions).toEqual(["👍", "❤"]);
    expect(next[1]).toBe(list[1]);
    expect(R.applyReactions(next, "b1", 1, ["👍", "❤"])).toBe(next);
    expect(R.applyReactions(list, "zz", 1, ["👍"])).toBe(list);
    const html = R.reactionsHtml(["👍", "❤", "<b>"], 'dev "reacted"');
    expect(html).toContain('aria-label="dev &quot;reacted&quot;"');
    expect(html).toContain("❤\uFE0F");
    expect(html).not.toContain("<b>");
    expect(R.reactionsHtml([], "x")).toBe("");
  });
});
