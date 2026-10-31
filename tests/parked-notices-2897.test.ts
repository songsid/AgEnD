import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { InstanceLifecycle, type IncidentEventSource, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setLocale } from "../src/locale.js";
import {
  ParkedNotices, PARKED_NOTICE_LEDGER_FILE, PARKED_NOTICE_MAX_ATTEMPTS, PARKED_NOTICE_RETRY_INTERVAL_MS,
  type ParkedNoticeRow,
} from "../src/parked-notices.js";

/**
 * #2897: a held CLI dialog's "needs a human" notices — one live message per place (instance topic, General), edited
 * in place on a re-report, deleted when the dialog is resolved ("✓ resolved" edit where an adapter cannot delete),
 * and kept in a ledger so a fleet restart retires what the last process left. The adapters are mocks with the
 * Discord and Telegram method shapes; nothing here starts a CLI, a fleet or a tmux server.
 */

let dir: string;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-parked-notices-")); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); setLocale("en"); });

/** A mock chat platform: numbered messages, with delete unless `canDelete` is false. */
function mockAdapter(kind: "discord" | "telegram", canDelete = true) {
  let next = 100;
  const messages = new Map<string, string>();
  const sent: Array<{ chatId: string; text: string; threadId?: string }> = [];
  const edits: Array<{ messageId: string; text: string }> = [];
  const deletes: string[] = [];
  const fail = { delete: false, edit: false, send: false };
  const adapter: any = {
    type: kind,
    sendText: vi.fn(async (chatId: string, text: string, opts?: { threadId?: string }) => {
      if (fail.send) throw new Error("send refused");
      const messageId = String(next++);
      messages.set(messageId, text);
      sent.push({ chatId, text, threadId: opts?.threadId });
      return { messageId, chatId, ...(opts?.threadId !== undefined ? { threadId: opts.threadId } : {}) };
    }),
    editMessage: vi.fn(async (_chatId: string, messageId: string, text: string) => {
      if (fail.edit || !messages.has(messageId)) throw new Error("edit refused");
      messages.set(messageId, text);
      edits.push({ messageId, text });
    }),
  };
  if (canDelete) {
    adapter.deleteMessage = vi.fn(async (_chatId: string, messageId: string) => {
      if (fail.delete || !messages.has(messageId)) throw new Error("delete refused");
      messages.delete(messageId);
      deletes.push(messageId);
    });
  }
  return { adapter, messages, sent, edits, deletes, fail };
}

function store(adapters: Record<string, any>) {
  const file = join(dir, PARKED_NOTICE_LEDGER_FILE);
  const notices = new ParkedNotices({
    file, logger,
    post: async (instanceName, place, text) => {
      const adapter = adapters.discord.adapter;
      const sent = await adapter.sendText("guild-1", text, { threadId: place === "general" ? "general-topic" : `${instanceName}-topic` });
      return { adapterId: "discord", chatId: sent.chatId, threadId: sent.threadId, messageId: sent.messageId };
    },
    adapterFor: id => adapters[id]?.adapter,
    resolvedText: () => "✓ resolved",
    render: (_row, text) => text,
  });
  const ledger = (): ParkedNoticeRow[] => existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : [];
  return { notices, file, ledger };
}

describe("#2897: one live notice per place", () => {
  it("a held dialog posts exactly one notice per place; a re-report edits that message, never a second post", async () => {
    const discord = mockAdapter("discord");
    const { notices, ledger } = store({ discord });
    await notices.show("w", "topic", "⚠️ w is parked (first)");
    await notices.show("w", "general", "⚠️ w parked — General");
    expect(discord.sent).toHaveLength(2);
    const [topicId, generalId] = [...discord.messages.keys()];

    // The interval re-report: same text → nothing to change; new text → the same message is edited.
    await notices.show("w", "topic", "⚠️ w is parked (first)");
    await notices.show("w", "topic", "⚠️ w is parked (still, 2 attempts)");
    await notices.show("w", "general", "⚠️ w parked — General, again");
    expect(discord.sent).toHaveLength(2);
    expect(discord.edits).toEqual([
      { messageId: topicId, text: "⚠️ w is parked (still, 2 attempts)" },
      { messageId: generalId, text: "⚠️ w parked — General, again" },
    ]);
    expect(ledger().map(r => [r.place, r.messageId])).toEqual([["topic", topicId], ["general", generalId]]);
  });

  it("an edit that fails (deleted by hand) posts one fresh notice and retires the old id", async () => {
    const discord = mockAdapter("discord");
    const { notices, ledger } = store({ discord });
    await notices.show("w", "topic", "first");
    const oldId = [...discord.messages.keys()][0]!;
    discord.messages.delete(oldId);   // someone deleted it on the platform
    await notices.show("w", "topic", "second");
    expect(discord.sent.map(s => s.text)).toEqual(["first", "second"]);
    const newId = [...discord.messages.keys()][0]!;
    // The new one is live; the old id stays in the ledger as a retire to retry (it may only have been un-editable).
    await vi.waitFor(() => expect(ledger().map(r => [r.messageId, r.attempts])).toEqual([[newId, undefined], [oldId, 1]]));
    notices.dispose();
  });
});

describe("#2897: resolve takes the notices back", () => {
  it("deletes both the instance-topic and the General notice, and empties the ledger", async () => {
    const discord = mockAdapter("discord");
    const { notices, ledger } = store({ discord });
    await notices.show("w", "topic", "t");
    await notices.show("w", "general", "g");
    await notices.show("other", "topic", "someone else's");
    await notices.resolve("w");
    expect(discord.deletes).toHaveLength(2);
    expect([...discord.messages.values()]).toEqual(["someone else's"]);
    expect(ledger().map(r => r.instanceName)).toEqual(["other"]);
    expect(notices.hasLive("w")).toBe(false);
    // Resolving again (another "gone" scan, a stop after it) touches nothing.
    await notices.resolve("w");
    expect(discord.deletes).toHaveLength(2);
  });

  it("an adapter without delete gets the ✓ resolved edit instead", async () => {
    const discord = mockAdapter("discord");
    const telegram = mockAdapter("telegram", false);
    const notices = new ParkedNotices({
      file: join(dir, PARKED_NOTICE_LEDGER_FILE), logger,
      post: async (_n, _p, text) => {
        const sent = await telegram.adapter.sendText("-100777", text, { threadId: "7" });
        return { adapterId: "telegram", chatId: sent.chatId, threadId: sent.threadId, messageId: sent.messageId };
      },
      adapterFor: id => ({ discord, telegram } as Record<string, any>)[id]?.adapter,
      resolvedText: () => "✓ resolved",
      render: (_row, text) => text,
    });
    await notices.show("w", "topic", "⚠️ held");
    await notices.resolve("w");
    expect(telegram.adapter.deleteMessage).toBeUndefined();
    expect([...telegram.messages.values()]).toEqual(["✓ resolved"]);
  });

  it("a delete the platform refuses falls back to the ✓ resolved edit", async () => {
    const discord = mockAdapter("discord");
    const { notices, ledger } = store({ discord });
    await notices.show("w", "topic", "⚠️ held");
    discord.fail.delete = true;
    await notices.resolve("w");
    expect([...discord.messages.values()]).toEqual(["✓ resolved"]);
    expect(ledger()).toEqual([]);
  });

  it("a resolve that lands while the post is still in flight deletes the message once it exists", async () => {
    const discord = mockAdapter("discord");
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const notices = new ParkedNotices({
      file: join(dir, PARKED_NOTICE_LEDGER_FILE), logger,
      post: async (_n, _p, text) => {
        await gate;
        const sent = await discord.adapter.sendText("guild-1", text, { threadId: "t" });
        return { adapterId: "discord", chatId: sent.chatId, threadId: sent.threadId, messageId: sent.messageId };
      },
      adapterFor: () => discord.adapter, resolvedText: () => "✓ resolved", render: (_row, text) => text,
    });
    const shown = notices.show("w", "topic", "⚠️ held");
    const resolved = notices.resolve("w");
    release();
    await Promise.all([shown, resolved]);
    expect(discord.sent).toHaveLength(1);
    expect(discord.messages.size).toBe(0);
  });
});

describe("#2897: the ledger survives a restart", () => {
  it("a delete that failed is retried by the next process's sweep", async () => {
    vi.useFakeTimers();
    const discord = mockAdapter("discord");
    const first = store({ discord });
    await first.notices.show("w", "topic", "⚠️ held");
    discord.fail.delete = true;
    discord.fail.edit = true;
    await first.notices.resolve("w");
    expect(first.ledger()).toEqual([expect.objectContaining({ instanceName: "w", attempts: 1 })]);
    first.notices.dispose();   // the fleet stops before the retry timer fires

    discord.fail.delete = false;
    discord.fail.edit = false;
    const second = store({ discord });
    await second.notices.sweep();
    expect(discord.messages.size).toBe(0);
    expect(second.ledger()).toEqual([]);
  });

  it("a notice the last process left live is deleted by the sweep (a dialog still there is re-reported fresh)", async () => {
    const discord = mockAdapter("discord");
    const first = store({ discord });
    await first.notices.show("w", "topic", "t");
    await first.notices.show("w", "general", "g");
    const second = store({ discord });
    await second.notices.sweep();
    expect(discord.messages.size).toBe(0);
    expect(second.ledger()).toEqual([]);
  });

  it("retries on an interval and gives up after the ceiling, counting attempts across restarts", async () => {
    vi.useFakeTimers();
    const discord = mockAdapter("discord");
    const { notices, ledger, file } = store({ discord });
    await notices.show("w", "topic", "t");
    discord.fail.delete = true;
    discord.fail.edit = true;
    await notices.resolve("w");
    await vi.advanceTimersByTimeAsync(PARKED_NOTICE_RETRY_INTERVAL_MS);
    expect(ledger()[0]?.attempts).toBe(2);
    notices.dispose();
    // One attempt short of the ceiling, the next process tries once more and stops there.
    const rows = ledger();
    rows[0]!.attempts = PARKED_NOTICE_MAX_ATTEMPTS - 1;
    writeFileSync(file, JSON.stringify(rows));
    const next = store({ discord });
    await next.notices.sweep();
    expect(next.ledger()).toEqual([]);
    await vi.advanceTimersByTimeAsync(PARKED_NOTICE_RETRY_INTERVAL_MS * 2);
    expect(discord.adapter.deleteMessage).toHaveBeenCalledTimes(3);
  });

  it("a corrupt ledger is dropped, not thrown", async () => {
    const discord = mockAdapter("discord");
    const { notices, file, ledger } = store({ discord });
    writeFileSync(file, "{not json");
    await notices.sweep();
    expect(ledger()).toEqual([]);
  });
});

describe("#2897: startup ordering — a notice posted before the sweep is this process's, not an orphan", () => {
  it("an early parked report in a slow boot keeps its notice; the sweep retires only what the last process left", async () => {
    const discord = mockAdapter("discord");
    const first = store({ discord });
    await first.notices.show("w", "topic", "old warning");
    first.notices.dispose();
    const [oldId] = [...discord.messages.keys()];

    const second = store({ discord });             // the new process: an instance reports before finishStartup's sweep
    await second.notices.show("w", "topic", "still held");
    const newId = [...discord.messages.keys()].find(id => id !== oldId)!;
    expect(second.ledger().map(r => r.messageId).sort()).toEqual([oldId, newId].sort());   // the old row survives the write
    await second.notices.sweep();
    expect([...discord.messages.entries()]).toEqual([[newId, "still held"]]);
    expect(second.ledger().map(r => r.messageId)).toEqual([newId]);
    // Still live: an identical re-report touches nothing, a resolve deletes it.
    await second.notices.show("w", "topic", "still held");
    expect(discord.sent).toHaveLength(2);
    await second.notices.sweep();                   // a second sweep has nothing of the last process's left
    expect(discord.messages.has(newId)).toBe(true);
    await second.notices.resolve("w");
    expect(discord.messages.size).toBe(0);
  });
});

describe("#2897: the production Discord delete reports a refusal", () => {
  /** DiscordAdapter.prototype.deleteMessage over a fake client: `exact` is the thread's fetch, `scan` the text channels'. */
  function discordDelete(opts: { exact: () => Promise<any>; scan?: Array<() => Promise<any>>; guildFails?: unknown }) {
    const adapter = Object.create(DiscordAdapter.prototype) as any;
    adapter.guildId = "g1";
    adapter._fetchTextChannel = async () => ({ messages: { fetch: opts.exact } });
    adapter.readyClient = async () => ({ guilds: { fetch: async () => {
      if (opts.guildFails) throw opts.guildFails;
      const cache = new Map((opts.scan ?? []).map((fetch, i) => [String(i), { type: 0, messages: { fetch } }]));
      return { channels: { cache: { filter: (f: (c: any) => boolean) => new Map([...cache].filter(([, c]) => f(c))) } } };
    } } });
    return adapter as DiscordAdapter;
  }
  const apiErr = (code: number, message: string) => Object.assign(new Error(message), { code, status: code === 10008 ? 404 : 403 });

  it("found but not deleted (Missing Permissions) rejects; already gone resolves", async () => {
    const refused = discordDelete({ exact: async () => ({ delete: async () => { throw apiErr(50013, "Missing Permissions"); } }) });
    await expect(refused.deleteMessage("g1", "m1", "t1")).rejects.toThrow("Missing Permissions");
    const goneOnDelete = discordDelete({ exact: async () => ({ delete: async () => { throw apiErr(10008, "Unknown Message"); } }) });
    await expect(goneOnDelete.deleteMessage("g1", "m1", "t1")).resolves.toBeUndefined();
    const nowhere = discordDelete({ exact: async () => { throw apiErr(10008, "Unknown Message"); }, scan: [async () => { throw apiErr(10008, "Unknown Message"); }] });
    await expect(nowhere.deleteMessage("g1", "m1", "t1")).resolves.toBeUndefined();
  });

  it("an exact lookup the API refused (Missing Access, an outage) rejects when the scan does not find it", async () => {
    const noAccess = discordDelete({ exact: async () => { throw apiErr(50001, "Missing Access"); } });
    await expect(noAccess.deleteMessage("g1", "m1", "t1")).rejects.toThrow("Missing Access");
    const outage = discordDelete({ exact: async () => { throw Object.assign(new Error("Service Unavailable"), { status: 503 }); }, guildFails: new Error("fetch failed") });
    await expect(outage.deleteMessage("g1", "m1", "t1")).rejects.toThrow();
    // "Not a text channel here" only means look elsewhere: found by the scan, deleted.
    let deleted = false;
    const elsewhere = discordDelete({ exact: async () => { throw new Error("Channel g1 is not a text channel"); }, scan: [async () => ({ delete: async () => { deleted = true; } })] });
    await expect(elsewhere.deleteMessage("g1", "m1")).resolves.toBeUndefined();
    expect(deleted).toBe(true);
  });

  it("a refused Discord delete leaves the notice saying ✓ resolved, not the held text", async () => {
    let text = "⚠️ held";
    const adapter = discordDelete({ exact: async () => ({ delete: async () => { throw apiErr(50013, "Missing Permissions"); } }) }) as any;
    adapter.editMessage = async (_c: string, _m: string, next: string) => { text = next; };
    const notices = new ParkedNotices({
      file: join(dir, PARKED_NOTICE_LEDGER_FILE), logger,
      post: async () => ({ adapterId: "discord", chatId: "g1", threadId: "t1", messageId: "m1" }),
      adapterFor: () => adapter, resolvedText: () => "✓ resolved", render: (_row, t) => t,
    });
    await notices.show("w", "topic", "⚠️ held");
    await notices.resolve("w");
    expect(text).toBe("✓ resolved");
    expect(JSON.parse(readFileSync(join(dir, PARKED_NOTICE_LEDGER_FILE), "utf-8"))).toEqual([]);
  });
});

describe("#2897: the daemon says when the held dialog is gone", () => {
  function daemon() {
    mkdirSync(join(dir, "inst"), { recursive: true });
    const d: any = new Daemon("w", {
      working_directory: dir, backend: "claude-code", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, join(dir, "inst"), false, { binaryName: "fake", getRuntimeDialogs: () => [] } as any, undefined, logger);
    const events: string[] = [];
    d.on("dialog_parked", () => events.push("parked"));
    d.on("dialog_unparked", () => events.push("unparked"));
    return { d, events };
  }
  const trust = { pattern: /Trust this folder\?/, description: "Trust prompt", keys: ["Enter"], holdOnly: true };
  const picker = { pattern: /Pick a model/, description: "Model picker", keys: ["Enter"], holdOnly: true };

  it("parked → gone emits dialog_unparked once; a pane with no dialog tracked emits nothing", () => {
    vi.useFakeTimers();
    const { d, events } = daemon();
    d.trackDialogParked(null);
    expect(events).toEqual([]);
    d.trackDialogParked(trust);
    vi.advanceTimersByTime(120_000);
    d.trackDialogParked(trust);
    expect(events).toEqual(["parked"]);
    d.trackDialogParked(null);
    d.trackDialogParked(null);
    expect(events).toEqual(["parked", "unparked"]);
  });

  it("a non-blocking dialog's answer-ignored notice stays while it is on screen and goes when the answer takes", () => {
    vi.useFakeTimers();
    const { d, events } = daemon();
    d.on("dialog_answer_ignored", () => events.push("ignored"));
    const intro = { pattern: /Welcome tour/, description: "Intro screen", keys: ["Escape"] };
    for (let i = 0; i < 3; i++) { d.noteDialogAnswer(intro, "ignored", "screen-1"); d.trackDialogParked(null); }
    expect(events).toEqual(["ignored"]);           // every scan passes no blocking dialog: the notice must stay
    d.noteDialogAnswer(intro, "took", "screen-1");
    expect(events).toEqual(["ignored", "unparked"]);
  });

  it("a non-blocking answer episode that ends because the screen changed retires its notice too", () => {
    vi.useFakeTimers();
    const { d, events } = daemon();
    const intro = { pattern: /Welcome tour/, description: "Intro screen", keys: ["Escape"] };
    const other = { pattern: /Feedback/, description: "Feedback screen", keys: ["Escape"] };
    for (let i = 0; i < 3; i++) d.noteDialogAnswer(intro, "ignored", "screen-1");
    d.noteDialogAnswer(other, "ignored", "screen-2");
    expect(events).toEqual(["unparked"]);
  });

  it("a blocking dialog's answer-ignored notice lives with the parked clock, not the answer episode", () => {
    vi.useFakeTimers();
    const { d, events } = daemon();
    const prompt = { pattern: /Trust this folder\?/, description: "Trust prompt", keys: ["Enter"], blocksDelivery: true };
    d.trackDialogParked(prompt);
    for (let i = 0; i < 3; i++) d.noteDialogAnswer(prompt, "ignored", "screen-1");
    d.endDialogEpisode(false);                       // the episode ends, the dialog is still on screen
    expect(events).toEqual([]);
    d.trackDialogParked(null);
    expect(events).toEqual(["unparked"]);
  });

  it("a relaunched CLI retires the notice out for the old one", () => {
    vi.useFakeTimers();
    const { d, events } = daemon();
    d.trackDialogParked(trust);
    vi.advanceTimersByTime(120_000);
    d.trackDialogParked(trust);
    d.beginSpawn();
    expect(events).toEqual(["parked", "unparked"]);
  });

  it("a different dialog replacing the tracked one retires the old one's notices", () => {
    vi.useFakeTimers();
    const { d, events } = daemon();
    d.trackDialogParked(trust);
    vi.advanceTimersByTime(120_000);
    d.trackDialogParked(trust);
    d.trackDialogParked(picker);
    expect(events).toEqual(["parked", "unparked"]);
  });
});

describe("#2897: the lifecycle routes notices through the ledger", () => {
  function lifecycle(extra: Partial<Record<string, unknown>> = {}) {
    const notifyInstanceTopic = vi.fn(() => true);
    const notifyFleetError = vi.fn();
    const showParkedNotice = vi.fn();
    const resolveParkedNotice = vi.fn();
    const ctx = {
      fleetConfig: { defaults: {}, instances: { general: { general_topic: true }, w: {} } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataDir: dir, getInstanceDir: (name: string) => join(dir, name),
      eventLog: { insert: vi.fn() }, isPlannedRestart: () => false, isClassicInstance: () => false,
      notifyInstanceTopic, notifyFleetError, showParkedNotice, resolveParkedNotice, ...extra,
    } as unknown as LifecycleContext;
    const daemon = new EventEmitter() as IncidentEventSource & EventEmitter;
    new InstanceLifecycle(ctx).attachIncidentHandlers("w", daemon);
    return { daemon, notifyInstanceTopic, notifyFleetError, showParkedNotice, resolveParkedNotice };
  }

  it("dialog_parked and dialog_answer_ignored show through the ledger (no fresh posts); dialog_unparked resolves", () => {
    const { daemon, notifyInstanceTopic, notifyFleetError, showParkedNotice, resolveParkedNotice } = lifecycle();
    daemon.emit("dialog_parked", { name: "w", description: "Trust prompt", holdOnly: true });
    daemon.emit("dialog_answer_ignored", { name: "w", description: "Trust prompt", attempts: 3, holdsDeliveries: true });
    expect(notifyInstanceTopic).not.toHaveBeenCalled();
    expect(notifyFleetError).not.toHaveBeenCalled();
    expect(showParkedNotice).toHaveBeenCalledTimes(2);
    expect(showParkedNotice.mock.calls[0]![1]).toContain("Trust prompt");
    expect(showParkedNotice.mock.calls[0]![2]).toContain("Trust prompt");
    daemon.emit("dialog_unparked", { name: "w" });
    expect(resolveParkedNotice).toHaveBeenCalledWith("w");
  });

  it("a storm folds the topic notice into its summary as before; General's is still shown", () => {
    const { daemon, showParkedNotice } = lifecycle({ stormSuppressed: () => true });
    daemon.emit("dialog_parked", { name: "w", description: "Trust prompt", holdOnly: true });
    expect(showParkedNotice).toHaveBeenCalledWith("w", null, expect.stringContaining("Trust prompt"));
  });

  it("without a ledger (older contexts) the notices are posted as before", () => {
    const { daemon, notifyInstanceTopic, notifyFleetError } = lifecycle({ showParkedNotice: undefined });
    daemon.emit("dialog_parked", { name: "w", description: "Trust prompt", holdOnly: true });
    expect(notifyInstanceTopic).toHaveBeenCalledOnce();
    expect(notifyFleetError).toHaveBeenCalledOnce();
  });
});

describe("#2897: a stopped instance's notices are taken back", () => {
  it("stop resolves the instance's parked notices", async () => {
    const resolveParkedNotice = vi.fn();
    const ctx = {
      fleetConfig: { defaults: {}, instances: { w: {} } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataDir: dir, getInstanceDir: (name: string) => join(dir, name),
      setTopicIcon: vi.fn(), resolveParkedNotice,
      ipcStoppingInstances: new Set<string>(), instanceIpcClients: new Map(), sessionRegistry: new Map(),
    } as unknown as LifecycleContext;
    await new InstanceLifecycle(ctx).stop("w");
    expect(resolveParkedNotice).toHaveBeenCalledWith("w");
  });
});

describe("#2897: the fleet posts, edits and deletes through the real routing", () => {
  function fleet() {
    const fm = new FleetManager(dir) as any;
    const discord = mockAdapter("discord");
    const telegram = mockAdapter("telegram");
    fm.fleetConfig = {
      defaults: {},
      channels: [
        { id: "discord", type: "discord", mode: "topic", group_id: "111111111111111111" },
        { id: "telegram", type: "telegram", mode: "topic", group_id: "-100777" },
      ],
      instances: {
        general: { general_topic: true, topic_id: "222222222222222222", channel_id: "discord" },
        w: { topic_id: "333333333333333333", channel_id: "discord" },
        tg: { topic_id: "42", channel_id: "telegram" },
      },
    };
    fm.worlds.set("discord", { id: "discord", type: "discord", adapter: discord.adapter, groupId: "111111111111111111", channelConfig: fm.fleetConfig.channels[0] });
    fm.worlds.set("telegram", { id: "telegram", type: "telegram", adapter: telegram.adapter, groupId: "-100777", channelConfig: fm.fleetConfig.channels[1] });
    fm.adapter = discord.adapter;
    return { fm, discord, telegram };
  }
  const settle = () => new Promise(r => setTimeout(r, 0));

  it("Discord: one post in the topic and one in General; a re-report edits; resolve deletes both", async () => {
    const { fm, discord } = fleet();
    fm.showParkedNotice("w", "⚠️ w topic", "⚠️ w General");
    await vi.waitFor(() => expect(discord.sent).toHaveLength(2));
    expect(discord.sent.map(s => s.threadId).sort()).toEqual(["222222222222222222", "333333333333333333"]);
    fm.showParkedNotice("w", "⚠️ w topic (again)", "⚠️ w General (again)");
    await vi.waitFor(() => expect(discord.edits).toHaveLength(2));
    expect(discord.sent).toHaveLength(2);
    fm.resolveParkedNotice("w");
    await vi.waitFor(() => expect(discord.deletes).toHaveLength(2));
    expect(discord.messages.size).toBe(0);
    await settle();
    expect(JSON.parse(readFileSync(join(dir, PARKED_NOTICE_LEDGER_FILE), "utf-8"))).toEqual([]);
  });

  it("Telegram: the instance's own world posts and deletes its topic notice; General stays on its world", async () => {
    const { fm, discord, telegram } = fleet();
    fm.showParkedNotice("tg", "⚠️ tg topic", "⚠️ tg General");
    await vi.waitFor(() => expect(telegram.sent).toHaveLength(1));
    await vi.waitFor(() => expect(discord.sent).toHaveLength(1));
    expect(telegram.sent[0]).toMatchObject({ chatId: "-100777", threadId: "42" });
    fm.resolveParkedNotice("tg");
    await vi.waitFor(() => expect(telegram.deletes).toHaveLength(1));
    await vi.waitFor(() => expect(discord.deletes).toHaveLength(1));
  });

  it("FleetManager: an instance parked before finishStartup's sweep keeps its notice; the dead process's row is swept", async () => {
    const { fm, discord } = fleet();
    discord.messages.set("77", "from the dead process");
    writeFileSync(join(dir, PARKED_NOTICE_LEDGER_FILE), JSON.stringify([{ instanceName: "w", place: "topic", adapterId: "discord", chatId: "111111111111111111", threadId: "333333333333333333", messageId: "77" }]));
    fm.showParkedNotice("w", "⚠️ w topic (this process)", null);
    await vi.waitFor(() => expect(discord.sent).toHaveLength(1));
    await fm.parkedNotices.sweep();
    expect([...discord.messages.values()]).toEqual(["⚠️ w topic (this process)"]);
    fm.resolveParkedNotice("w");
    await vi.waitFor(() => expect(discord.messages.size).toBe(0));
  });

  it("a resolved notice the fleet could not delete is retried after a restart (FleetManager sweep)", async () => {
    const { fm, discord } = fleet();
    fm.showParkedNotice("w", "⚠️ w topic", null);
    await vi.waitFor(() => expect(discord.sent).toHaveLength(1));
    discord.fail.delete = true;
    discord.fail.edit = true;
    fm.resolveParkedNotice("w");
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(dir, PARKED_NOTICE_LEDGER_FILE), "utf-8"))[0]?.attempts).toBe(1));
    fm.parkedNoticesStore.dispose();

    discord.fail.delete = false;
    const next = fleet();
    next.fm.worlds.set("discord", { id: "discord", type: "discord", adapter: discord.adapter, groupId: "111111111111111111", channelConfig: next.fm.fleetConfig.channels[0] });
    next.fm.adapter = discord.adapter;
    await next.fm.parkedNotices.sweep();
    expect(discord.messages.size).toBe(0);
  });
});
