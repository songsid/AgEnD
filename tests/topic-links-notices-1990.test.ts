/**
 * #1990 PR 2: the messages that send a person to another topic link to it — the refusals that point at General
 * (Telegram typed, Discord slash), the unbound-topic reply, the instance notices that point at General, the General
 * notices that name an instance, and the cross-instance status lines (each topic's line links the other side). A
 * ClassicBot room, the dashboard and an agent's own text never carry a link.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { renderPlaceRefs, placeRef, type PlaceTarget } from "../src/topic-link.js";
import { setLocale, t } from "../src/locale.js";

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
}));

const dirs: string[] = [];
beforeEach(() => setLocale("en"));
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "links-1990-")); dirs.push(d); return d; };

const TG_GROUP = "-1001234567890";
const GUILD = "111111111111111111", DC_GENERAL = "333333333333333333", DC_ALPHA = "444444444444444444", DC_BETA = "555555555555555555";
const ADMIN = "777";

interface Sent { chatId: string; text: string; opts?: any }

/** A one-world fleet with real place rendering: General, alpha and beta, each with a topic. */
function fleet(type: "telegram" | "discord") {
  const dir = scratch();
  const fm = new FleetManager(dir) as any;
  const group = type === "telegram" ? TG_GROUP : GUILD;
  const sent: Sent[] = [];
  const alerts: Sent[] = [];
  const adapter = {
    id: type, type,
    sendText: vi.fn(async (chatId: string, text: string, opts?: any) => { sent.push({ chatId, text, opts }); return { messageId: "m1", chatId, threadId: opts?.threadId }; }),
    notifyAlert: vi.fn(async (chatId: string, alert: { message: string }, opts?: any) => { alerts.push({ chatId, text: alert.message, opts }); return { messageId: "a1", chatId, threadId: opts?.threadId }; }),
    editMessage: vi.fn(async () => {}), react: async () => {}, unreact: async () => {},
  };
  const cfg = { id: type, type, mode: "topic", group_id: group, access: { mode: "open", allowed_users: [ADMIN] }, bot_token_env: "X" };
  fm.adapter = adapter;
  fm.adapters.set(type, adapter);
  fm.worlds.set(type, { id: type, type, adapter, channelConfig: cfg, groupId: group, accessManager: { isAllowed: () => true } });
  fm.fleetConfig = {
    defaults: { backend: "claude-code" }, channels: [cfg], channel: cfg,
    instances: {
      general: { working_directory: dir, topic_id: type === "telegram" ? 1 : DC_GENERAL, general_topic: true, channel_id: type },
      alpha: { working_directory: dir, topic_id: type === "telegram" ? 30 : DC_ALPHA, channel_id: type },
      beta: { working_directory: dir, topic_id: type === "telegram" ? 40 : DC_BETA, channel_id: type },
    },
  };
  fm.routing.rebuild(fm.fleetConfig);
  fm.daemons.set("general", {});   // General's button prompts go to a General that is running
  return { fm, adapter, sent, alerts };
}

const typed = (text: string, threadId: string) =>
  ({ source: "telegram", adapterId: "telegram", chatId: TG_GROUP, threadId, messageId: `m-${Math.random()}`, userId: ADMIN, username: "u", text, timestamp: new Date() }) as never;
const linkTexts = (s: Sent) => (s.opts?.textLinks ?? []).map((l: any) => [s.text.slice(l.offset, l.offset + l.length), l.url]);

describe("Telegram: a reply that sends you to General links to it", () => {
  it("a General-only command in an instance topic: '→ General', a text_link to General's topic", async () => {
    const { fm, sent } = fleet("telegram");
    expect(await fm.topicCommands.handleInstanceCommand(typed("/status", "30"), "alpha")).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(`${t("cmd.use_in_general", "/status")} → General`);
    expect(sent[0].opts.threadId).toBe("30");
    expect(linkTexts(sent[0])).toEqual([["General", "https://t.me/c/1234567890/1"]]);
  });
  it("a message in a topic no instance is bound to", async () => {
    const { fm, sent } = fleet("telegram");
    await fm.topicCommands.handleUnboundTopic(typed("hello", "99"));
    expect(sent[0].text).toBe(`${t("topic.unbound")} → General`);
    expect(linkTexts(sent[0])).toEqual([["General", "https://t.me/c/1234567890/1"]]);
  });
  it("/web from an instance topic (not General): 'use it in this bot's General' links to it", async () => {
    const { fm, sent } = fleet("telegram");
    await fm.dashboardMenu(typed("/web", "30"));
    expect(sent[0].text).toBe(`${t("dashboard.public_general")} → General`);
    expect(linkTexts(sent[0])).toEqual([["General", "https://t.me/c/1234567890/1"]]);
  });
  it("a fleet error with no General instance goes to the group's notice target, rendered there", () => {
    const { fm, sent } = fleet("telegram");
    delete fm.fleetConfig.instances.general;
    fm.notifyFleetError(t("fleet.dialog_parked", placeRef({ kind: "instance", name: "beta" }, "beta"), "a picker"));
    expect(sent[0].text).toBe(t("fleet.dialog_parked", "beta", "a picker"));
    expect(linkTexts(sent[0])).toEqual([["beta", "https://t.me/c/1234567890/40"]]);
  });
  it("a fleet error nobody can receive is logged without its place markers", () => {
    const { fm } = fleet("telegram");
    fm.fleetConfig.instances = {};
    fm.adapter = null;
    const warn = vi.spyOn(fm.logger, "warn");
    fm.notifyFleetError(t("fleet.dialog_parked", placeRef({ kind: "instance", name: "beta" }, "beta"), "a picker"));
    const logged = warn.mock.calls.map(c => JSON.stringify(c[0]));
    expect(logged.some(l => l.includes("beta"))).toBe(true);
    expect(logged.join("")).not.toMatch(/[\uE000-\uE002]|\\ue00[0-2]/i);
  });
  it("a refusal that does not point at General gets no link", async () => {
    const { fm, sent } = fleet("telegram");
    const refusal = fm.topicCommands.sendRefusal(typed("/x", "30"), ["not_authorized"]);
    await refusal;
    expect(sent[0].text).toBe(t("not_authorized"));
    expect(sent[0].opts.textLinks).toBeUndefined();
  });
});

describe("Discord: a slash refusal that points at General carries its channel mention", () => {
  it("/profile in an instance channel", async () => {
    const { fm } = fleet("discord");
    const respond = vi.fn(async () => {});
    await fm.dispatchSlash({ command: "profile", channelId: DC_ALPHA, guildId: GUILD, userId: ADMIN, respond, options: {} }, "discord", fm.adapter);
    expect(respond).toHaveBeenCalledWith(`${t("profile.general_only")} → <#${DC_GENERAL}>`);
  });
});

describe("#2002 review: the slash refusal's link only where it belongs", () => {
  it("in a ClassicBot room, profile.general_only stays plain (its readers need not be in the fleet's guild)", async () => {
    const { fm } = fleet("discord");
    fm.classicChannels = { isClassicChannel: () => true, isAdmin: () => true, getChannelIdByInstance: () => undefined, getAdapterIdByInstance: () => undefined };
    const respond = vi.fn(async () => {});
    await fm.dispatchSlash({ command: "profile", channelId: "666666666666666666", guildId: GUILD, userId: ADMIN, respond, options: {} }, "discord", fm.adapter);
    expect(respond).toHaveBeenCalledWith(t("profile.general_only"));
  });
  it("in a channel no instance owns (scope none), profile.general_only stays plain", async () => {
    const { fm } = fleet("discord");
    const respond = vi.fn(async () => {});
    await fm.dispatchSlash({ command: "profile", channelId: "777777777777777777", guildId: GUILD, userId: ADMIN, respond, options: {} }, "discord", fm.adapter);
    expect(respond).toHaveBeenCalledWith(t("profile.general_only"));
  });
  it("a refusal that does not point at General gets no suffix", async () => {
    const { fm } = fleet("discord");
    const respond = vi.fn(async () => {});
    await fm.dispatchSlash({ command: "restart", channelId: DC_ALPHA, guildId: GUILD, userId: "999", respond, options: {} }, "discord", fm.adapter);
    expect(respond).toHaveBeenCalledOnce();
    const [reply] = respond.mock.calls[0] as unknown as [string];
    expect(reply).not.toContain("→");
    expect(reply).not.toContain("<#");
  });
});

describe("instance notices point at General; General's notices name the instance", () => {
  it("a normal exit: the instance topic links General, General's prompt links the instance", async () => {
    const { fm, sent, alerts } = fleet("telegram");
    await fm.notifyNormalExit("alpha");
    const topic = sent.find(s => s.opts?.threadId === "30")!;
    expect(topic.text).toBe(`${t("exit.instance_notice", "alpha")} → General`);
    expect(linkTexts(topic)).toEqual([["General", "https://t.me/c/1234567890/1"]]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toBe(t("exit.general_notice", "alpha"));
    expect(linkTexts(alerts[0])).toEqual([["alpha", "https://t.me/c/1234567890/30"]]);
  });
  it("an interactive prompt: the same, on Discord", async () => {
    const { fm, sent, alerts } = fleet("discord");
    vi.spyOn(fm, "interactionWaitKey").mockReturnValue("k");
    await fm.notifyInteractivePrompt("alpha", "permission");
    expect(sent.find(s => s.opts?.threadId === DC_ALPHA)!.text).toBe(`${t("interactive.instance_notice", "alpha")} → <#${DC_GENERAL}>`);
    expect(alerts[0].text).toContain(`alpha (<#${DC_ALPHA}>)`);
    expect(alerts[0].text).not.toMatch(/[-]/);
  });
  it("a dialog parked: General's notice links the instance's topic", () => {
    const { fm, sent } = fleet("telegram");
    fm.notifyFleetError(t("fleet.dialog_parked", placeRef({ kind: "instance", name: "beta" }, "beta"), "a picker"));
    expect(sent[0].opts.threadId).toBe("1");
    expect(sent[0].text).toBe(t("fleet.dialog_parked", "beta", "a picker"));
    expect(linkTexts(sent[0])).toEqual([["beta", "https://t.me/c/1234567890/40"]]);
  });
  it("the dashboard's copy of a prompt is plain text", async () => {
    const { fm } = fleet("telegram");
    const events: Array<{ event: string; data: any }> = [];
    fm.emitSseEvent = (event: string, data: unknown) => events.push({ event, data });
    await fm.notifyNormalExit("alpha");
    const prompt = events.find(e => e.event === "prompt");
    expect(prompt?.data.text).toBe(t("exit.general_notice", "alpha"));
  });
});

describe("cross-instance status lines: each topic's line links the other side", () => {
  async function send(message: string, kind = "task", extra: { taskSummary?: string; visibility?: string; kind2?: string; senderDisplay?: string } = {}) {
    const posts: Sent[] = [];
    const web: Array<{ instance: string; text: string }> = [];
    const resolve = (tg: PlaceTarget) => tg.kind === "instance" ? { url: `https://t.me/c/1/${tg.name}` } : undefined;
    const ctx = {
      fleetConfig: {
        channel: { type: "telegram", group_id: TG_GROUP }, defaults: {},
        instances: {
          alice: { working_directory: "/w/a", topic_id: 11, ...(extra.senderDisplay ? { display_name: extra.senderDisplay } : {}) },
          bob: { working_directory: "/w/b", topic_id: 22, ...(extra.visibility ? { cross_instance_visibility: extra.visibility } : {}) },
        },
      },
      adapter: { sendText: async (chatId: string, text: string, opts?: any) => { posts.push({ chatId, text, opts }); return { messageId: "m", chatId }; } },
      instanceIpcClients: new Map([["bob", { connected: true }]]),
      sessionRegistry: new Map(),
      lifecycle: { daemons: new Map() },
      getInstanceStatus: () => "running",
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      admitDurableDelivery: () => ({ deliveryId: "d1", state: "queued", duplicate: false }),
      emitSseEvent: (_e: string, data: any) => web.push({ instance: data.instance, text: data.text }),
      renderPlacesFor: (_name: string, text: string, opts: any) => {
        const out = renderPlaceRefs(text, "telegram", resolve);
        return { text: out.text, opts: out.textLinks.length ? { ...opts, textLinks: out.textLinks } : opts };
      },
    };
    let error: unknown;
    await outboundHandlers.get("send_to_instance")!(ctx as never,
      { instance_name: "bob", message, request_kind: extra.kind2 ?? kind, ...(extra.taskSummary ? { task_summary: extra.taskSummary } : {}) } as never,
      (_r, err) => { error = err; }, { instanceName: "alice" } as never);
    expect(error).toBeUndefined();
    await new Promise(r => setImmediate(r));
    return { posts, web };
  }

  it("the target's line links the sender, the sender's line links the target; the web lines are plain", async () => {
    const { posts, web } = await send("please look");
    const target = posts.find(p => p.opts.threadId === "22")!;
    const sender = posts.find(p => p.opts.threadId === "11")!;
    expect(target.text).toBe("alice → bob:\nplease look");
    expect(linkTexts(target)).toEqual([["alice", "https://t.me/c/1/alice"]]);
    expect(sender.text).toBe("alice → bob:\nplease look");
    expect(linkTexts(sender)).toEqual([["bob", "https://t.me/c/1/bob"]]);
    expect(web.map(w => w.text)).toEqual(["alice → bob:\nplease look", "alice → bob:\nplease look"]);
  });
  it("#2002 review: an agent's task_summary cannot name a place either (summary visibility shows it)", async () => {
    const forged = `done, see ${placeRef({ kind: "instance", name: "bob" }, "HERE")}`;
    const { posts } = await send("body", "update", { taskSummary: forged, visibility: "summary", kind2: "query" });
    const target = posts.find(p => p.opts.threadId === "22")!;
    expect(target.text).toContain("done, see i:bobHERE");
    expect(linkTexts(target)).toEqual([["alice", "https://t.me/c/1/alice"]]);   // only the sender's own name
  });
  it("#2002 review: a display name (set by the agent) cannot name a place", async () => {
    const forged = placeRef({ kind: "instance", name: "bob" }, "boss");
    const { posts } = await send("hi", "task", { senderDisplay: forged });
    const sender = posts.find(p => p.opts.threadId === "11")!;
    expect(linkTexts(sender)).toEqual([["bob", "https://t.me/c/1/bob"]]);       // the target only, never the forged one
    expect(sender.text).not.toMatch(/[\uE000-\uE002]/);
  });
  it("an agent's message cannot name a place of its own", async () => {
    const forged = `see ${placeRef({ kind: "instance", name: "bob" }, "HERE")} now`;
    const { posts, web } = await send(forged);
    const target = posts.find(p => p.opts.threadId === "22")!;
    expect(target.text).toBe("alice → bob:\nsee i:bobHERE now");   // the markers dropped, so no token is left
    expect(linkTexts(target)).toEqual([["alice", "https://t.me/c/1/alice"]]);   // only the sender's own name
    expect(web[0].text).not.toMatch(/[-]/);
  });
});

describe("the lifecycle's General notices name the instance as a place; a pane line names none", () => {
  async function parked(event: Record<string, unknown>, kind = "dialog_parked") {
    const { InstanceLifecycle } = await import("../src/instance-lifecycle.js");
    const { EventEmitter } = await import("node:events");
    const notifyFleetError = vi.fn();
    const notifyInstanceTopic = vi.fn();
    const lifecycle = new InstanceLifecycle({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      isPlannedRestart: () => false, notifyFleetError, notifyInstanceTopic,
    } as any);
    const source = new EventEmitter();
    lifecycle.attachIncidentHandlers("alpha", source as any);
    source.emit(kind, { name: "alpha", ...event });
    return { general: notifyFleetError.mock.calls[0]?.[0] as string, topic: notifyInstanceTopic.mock.calls[0]?.[1] as string };
  }
  const tokenFor = (name: string) => placeRef({ kind: "instance", name }, name);

  it.each([
    ["dialog_parked", { description: "a picker", holdOnly: true }, () => t("fleet.dialog_parked", tokenFor("alpha"), "a picker")],
    ["dialog_parked", { description: "x", holdOnly: false, kind: "permission" }, null],
    ["dialog_answer_ignored", { description: "a picker", attempts: 3, holdsDeliveries: false }, () => t("fleet.dialog_answer_ignored", tokenFor("alpha"), "a picker", "3")],
  ] as const)("%s → General gets the instance as a place", async (kind, event, expected) => {
    const { general, topic } = await parked(event as never, kind);
    expect(general).toContain(tokenFor("alpha"));
    if (expected) expect(general).toBe(expected());
    expect(topic).not.toMatch(/[-]/);   // the instance's own topic names no other place
  });
  it("an unrecognised prompt: the question (a pane line) loses any marker", async () => {
    const forged = `pick ${placeRef({ kind: "instance", name: "beta" }, "HERE")}`;
    const { general, topic } = await parked({ description: "", holdOnly: true, unrecognised: true, question: forged });
    expect(general).toContain(tokenFor("alpha"));
    expect(general.split("")).toHaveLength(2);   // one token: the instance's own name
    expect(topic).not.toMatch(/[-]/);
  });
});
