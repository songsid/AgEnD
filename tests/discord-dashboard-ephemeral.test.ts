/**
 * /dashboard on Discord, end to end: the real DiscordAdapter and the real FleetManager over a stand-in for Discord that
 * keeps Discord's rules (alpha.2 report: "the application did not respond", 10008 from retireNonceButtons, a public link
 * that opened with nothing shown to the user).
 *   - an interaction is acknowledged within 3 s of its creation (10062 after), and its token works for 15 minutes (50027);
 *   - an ephemeral message exists only for its interaction: a channel fetch answers 10008 Unknown Message, and only
 *     editReply on that interaction (or on a click of its buttons) can change it;
 *   - an edit without `components` keeps the buttons.
 * Discord's clock runs 963 ms ahead of the host's here (the reported skew): it moves logged numbers, nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ChannelType, MessageFlags } from "discord.js";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
const logs = vi.hoisted(() => [] as Array<{ level: string; obj: unknown; msg: unknown }>);
vi.mock("../src/logger.js", () => ({ createLogger: () => {
  const at = (level: string) => (obj: unknown, msg?: unknown) => { logs.push({ level, obj, msg: msg ?? obj }); };
  return { info: at("info"), warn: at("warn"), debug: at("debug"), error: at("error"), child() { return this; } };
} }));
import { FleetManager } from "../src/fleet-manager.js";
import { DiscordAdapter } from "../src/channel/adapters/discord.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { PublicWebLink } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import { setLocale, t } from "../src/locale.js";

const SKEW_MS = 963;
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/;
const apiError = (code: number, message: string) => Object.assign(new Error(message), { code, status: code === 10008 ? 404 : 400 });

interface Msg { id: string; channelId: string; ephemeral: boolean; dm?: string; content: string; components: unknown[]; edits: number }
/** Discord's side of the conversation, by its rules. */
class FakeDiscord {
  messages = new Map<string, Msg>();
  /** Every edit Discord applied, in order, with the host time it landed. */
  history: Array<{ id: string; content: string; components: number; at: number }> = [];
  channelFetches = 0;
  dm: "ok" | "refused" = "ok";
  private seq = 0;
  serverNow(): number { return Date.now() + SKEW_MS; }
  create(m: Omit<Msg, "id" | "edits">): Msg { const msg = { ...m, id: `m${++this.seq}`, edits: 0 }; this.messages.set(msg.id, msg); return msg; }
  apply(msg: Msg, payload: string | { content?: string; components?: unknown[] }): void {
    msg.edits++;
    if (typeof payload === "string") { msg.content = payload; return; }
    if (payload.content !== undefined) msg.content = payload.content;
    if (payload.components !== undefined) msg.components = payload.components; // left out → the buttons stay
    this.history.push({ id: msg.id, content: msg.content, components: msg.components.length, at: Date.now() });
  }
  publicIn(channelId: string): Msg[] { return [...this.messages.values()].filter(m => !m.ephemeral && !m.dm && m.channelId === channelId); }
  dms(): Msg[] { return [...this.messages.values()].filter(m => m.dm); }
  channel(id: string) {
    return { id, type: ChannelType.GuildText, isTextBased: () => true,
      messages: { fetch: async (messageId: string) => {
        this.channelFetches++;
        const m = this.messages.get(messageId);
        // An ephemeral message is never visible to a channel fetch.
        if (!m || m.ephemeral || m.dm || m.channelId !== id) throw apiError(10008, "Unknown Message");
        return { id: m.id, edit: async (p: string | { content?: string; components?: unknown[] }) => { this.apply(m, p); return { id: m.id }; } };
      } },
      send: async (p: string | { content: string; components?: unknown[] }) => this.create({ channelId: id, ephemeral: false,
        content: typeof p === "string" ? p : p.content, components: typeof p === "string" ? [] : p.components ?? [] }) };
  }
  /** The interaction token: acknowledged within 3 s, usable for 15 min, then gone. */
  private token(createdTimestamp: number) {
    let acked = false;
    return {
      ack: () => { if (this.serverNow() - createdTimestamp > 3_000) throw apiError(10062, "Unknown interaction"); acked = true; },
      use: () => {
        if (!acked) throw new Error("The reply to this interaction has not been sent or deferred.");
        if (this.serverNow() - createdTimestamp > 15 * 60_000) throw apiError(50027, "Invalid Webhook Token");
      },
    };
  }
  private followUpOf(token: ReturnType<FakeDiscord["token"]>, channelId: string, ids: Set<string>) {
    return async (p: { content: string; flags?: number; components?: unknown[] }) => {
      token.use();
      const m = this.create({ channelId, ephemeral: ((p.flags ?? 0) & MessageFlags.Ephemeral) !== 0, content: p.content, components: p.components ?? [] });
      ids.add(m.id);
      return { id: m.id };
    };
  }
  private editReplyOf(token: ReturnType<FakeDiscord["token"]>, original: () => string | undefined, ids: Set<string>) {
    return async (p: string | { content?: string; components?: unknown[]; message?: string }) => {
      token.use();
      const id = typeof p === "object" && p.message ? p.message : original();
      const m = id && ids.has(id) ? this.messages.get(id) : undefined;
      if (!m) throw apiError(10008, "Unknown Message");
      const { message: _m, ...rest } = typeof p === "object" ? p : { content: p };
      this.apply(m, rest);
      return { id: m.id };
    };
  }
  slash(command: string, channelId: string, userId = "admin", options: Record<string, string> = {}) {
    const createdTimestamp = this.serverNow(), token = this.token(createdTimestamp), ids = new Set<string>();
    let reply: string | undefined;
    return {
      isButton: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => true,
      commandName: command, guildId: "G", channelId, channel: { name: "general" }, user: { id: userId, username: userId }, createdTimestamp,
      options: { getString: (k: string) => options[k] ?? null, data: Object.entries(options).map(([name, value]) => ({ name, value })) },
      deferReply: async (o?: { flags?: number }) => {
        token.ack();
        const m = this.create({ channelId, ephemeral: ((o?.flags ?? 0) & MessageFlags.Ephemeral) !== 0, content: "AgEnD is thinking…", components: [] });
        reply = m.id; ids.add(m.id);
      },
      editReply: this.editReplyOf(token, () => reply, ids),
      deleteReply: async () => { token.use(); if (reply) this.messages.delete(reply); },
      followUp: this.followUpOf(token, channelId, ids),
    };
  }
  click(message: Msg, customId: string, userId = "admin") {
    const createdTimestamp = this.serverNow(), token = this.token(createdTimestamp), ids = new Set([message.id]);
    return {
      isButton: () => true, isStringSelectMenu: () => false, isChatInputCommand: () => false,
      customId, guildId: "G", channelId: message.channelId, user: { id: userId, username: userId }, createdTimestamp,
      message: { id: message.id, flags: { has: (f: MessageFlags) => f === MessageFlags.Ephemeral && message.ephemeral } },
      deferUpdate: async () => { token.ack(); },
      editReply: this.editReplyOf(token, () => message.id, ids),
      followUp: this.followUpOf(token, message.channelId, ids),
    };
  }
}

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
let base = 0;
type EnsureStub = (opts: { onProgress?: (p: any) => void; signal?: AbortSignal }) => Promise<{ path: string; source: string }>;
function rig(opts: { ensure?: EnsureStub; start?: (ctx: any) => Promise<unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-dc-dashboard-")); dirs.push(dir);
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ id: "owner", botToken: "fixture", guildId: "G", registerCommands: false, inboxDir: dir,
    accessManager: new AccessManager({ mode: "open", allowed_users: [], max_pending_codes: 0, code_expiry_minutes: 10 }, join(dir, "access.json")) });
  const client = (adapter as any).client;
  client.isReady = () => true;
  vi.spyOn(client.channels, "fetch").mockImplementation(async (id: unknown) => discord.channel(String(id)));
  vi.spyOn(client.guilds, "fetch").mockImplementation(async () => ({ channels: { cache: new Map(["T0", "T1", "T2"].map(id => [id, discord.channel(id)])) } }));
  vi.spyOn(client.users, "fetch").mockImplementation(async (userId: unknown) => ({ createDM: async () => ({ id: `DM-${userId}`,
    send: async (p: { content: string; components?: unknown[] }) => {
      if (discord.dm === "refused") throw apiError(50007, "Cannot send messages to this user");
      return discord.create({ channelId: `DM-${userId}`, dm: String(userId), ephemeral: false, content: p.content, components: p.components ?? [] });
    } }) }));

  const fm = new FleetManager(dir), s = fm as any;
  const owner = { id: "owner", type: "discord", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
  fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" },
    worker: { working_directory: dir, topic_id: "T1", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!); s.adapters.set("owner", adapter); s.adapter = adapter;
  s.worlds.set("owner", { adapter, groupId: "G", channelConfig: owner, accessManager: { isAllowed: () => true }, stop: async () => {} });
  s.classicChannels = { isClassicChannel: () => false, hasChannel: () => false };
  writeFileSync(join(dir, "web.token"), "c".repeat(48), { mode: 0o600 }); s.initializeWebSessions();
  vi.spyOn(fm, "getDashboardAccess").mockReturnValue({ ready: true, token: "c".repeat(48) });
  // The tunnel comes up when the test says so (the first public link installs cloudflared: tens of seconds).
  let tunnelUp!: () => void;
  const manager = { start: vi.fn((_p: unknown, ctx: any) => opts.start ? opts.start(ctx) : new Promise(resolve => { tunnelUp = () => { ctx.onCandidateHost("sample.trycloudflare.com");
    resolve({ ok: true as const, handle: { pageUrl: "https://sample.trycloudflare.com/signin", onUnexpectedExit: () => () => {} } }); }; })),
  stop: vi.fn(async () => ({ confirmed: true as const })) };
  const lane = new TunnelPurposeLane(manager as never);
  s.tunnelPurposeLane = lane;
  s.publicWebLink = new PublicWebLink({ dataDir: dir, web: () => fm.fleetConfig!.web, permitted: o => s.publicOwnerCurrent(o), reserve: id => lane.reserve("dashboard", id),
    createGateway: () => ({ listen: async () => new URL("http://127.0.0.1:12345"), setHost: () => {}, close: () => {}, readinessMarker: "stub" }) as never,
    ensure: (opts.ensure ?? (async () => ({ path: "/pinned", source: "agend" }))) as never, provider: () => ({}) as never,
    revoke: id => { s.webLoginCodes.revokeAudience(id); s.webSessions.revokeExposure(id); }, log: () => {}, now: () => performance.now() });

  // Wired the way FleetManager wires a started adapter.
  const work: Promise<unknown>[] = [];
  adapter.on("slash_command", data => { work.push(s.dispatchSlash(data, "owner", adapter)); });
  adapter.on("callback_query", data => { work.push(s.receiveAdapterCallback(data, "owner", adapter, () => true)); });
  const settle = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); await Promise.allSettled(work); for (let n = 0; n < 40; n++) await Promise.resolve(); };
  async function slash(command = "dashboard", channelId = "T0") {
    const interaction = discord.slash(command, channelId);
    client.emit("interactionCreate", interaction);
    await settle();
    return discord.messages.get([...discord.messages.values()].filter(m => m.ephemeral && m.channelId === channelId).at(-1)!.id)!;
  }
  async function click(message: Msg, action: string) {
    const button = JSON.stringify(message.components).match(new RegExp(`dashboard:[0-9a-f]{32}:${action}`));
    expect(button, `the message offers ${action}`).toBeTruthy();
    client.emit("interactionCreate", discord.click(message, button![0]));
    for (let n = 0; n < 60; n++) await Promise.resolve();
  }
  cleanups.push(async () => { await s.publicWebLink.close("test end"); for (const e of s.pendingNonceButtons.values()) clearTimeout(e.timer); fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); await adapter.stop(); });
  return { discord, fm, s, manager, slash, click, settle, tunnelUp: () => tunnelUp() };
}

// The monotonic clock follows the fake timers, so throttling and step durations are measured on the same time line.
beforeEach(() => { setLocale("en"); logs.length = 0; vi.useFakeTimers(); base = Date.now(); vi.spyOn(performance, "now").mockImplementation(() => Date.now() - base); });
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks();
});
const buttons = (m: { components: unknown[] }) => m.components.length;

describe("Discord /dashboard: the ephemeral menu is answered and edited through its interaction", () => {
  it("a local sign-in click: the DM goes, and the menu itself says so — no channel fetch, no public post", async () => {
    const h = rig();
    const menu = await h.slash();
    expect(menu.content).toContain(t("dashboard.public_risk"));
    expect(buttons(menu)).toBeGreaterThan(0);
    await h.click(menu, "local"); await h.settle();
    expect(h.discord.dms()).toHaveLength(1);
    expect(h.discord.dms()[0].content).toMatch(CODE);
    expect(menu.content).toBe(t("dashboard.private_sent_dm"));
    expect(buttons(menu), "the spent buttons are gone").toBe(0);
    expect(h.discord.channelFetches, "an ephemeral message is never looked up in a channel (10008 + a scan)").toBe(0);
    expect(h.discord.publicIn("T0"), "nothing is posted publicly in General").toEqual([]);
    expect(logs.filter(l => l.level === "warn")).toEqual([]);
  });

  it("a public link while the tunnel starts: the menu shows progress at once; the link lands here when DMs are refused", async () => {
    const h = rig(); h.discord.dm = "refused";
    const menu = await h.slash();
    await h.click(menu, "public");
    expect(h.manager.start).toHaveBeenCalledTimes(1);
    expect(menu.content, "the click is visible before the tunnel is up").toContain(t("dashboard.progress.tunnel"));
    expect(buttons(menu)).toBe(0);
    await vi.advanceTimersByTimeAsync(40_000); // a first-run cloudflared install
    h.tunnelUp(); await h.settle();
    const here = [...h.discord.messages.values()].filter(m => m.ephemeral && m.content.includes("https://sample.trycloudflare.com/signin"));
    expect(here, "the link and code go to the clicker only").toHaveLength(1);
    expect(here[0].content).toMatch(CODE);
    expect(menu.content.endsWith(`\n\n${t("dashboard.private_sent_here")}`)).toBe(true);
    expect(h.s.publicWebLink.status().state).toBe("open");
    expect(h.discord.publicIn("T0")).toEqual([]);
    expect(h.discord.channelFetches).toBe(0);
    expect(logs.some(l => l.msg === "Dashboard DM not delivered; answering privately where the command was used" && (l.obj as { code?: number }).code === 50007),
      "the DM refusal is logged with Discord's code").toBe(true);
    // Its close button works on the private message itself.
    await h.click(here[0], "close"); await h.settle();
    expect(h.s.publicWebLink.status().state).toBe("closed");
    expect(here[0].content).toBe(t("dashboard.public_closed"));
    expect(buttons(here[0])).toBe(0);
    expect(h.discord.publicIn("T0")).toEqual([]);
  });

  it("an unused menu expires in place after 5 minutes (its interaction token is still good)", async () => {
    const h = rig();
    const menu = await h.slash();
    await vi.advanceTimersByTimeAsync(5 * 60_000); await h.settle();
    expect(menu.content).toBe(t("buttons.stale"));
    expect(buttons(menu)).toBe(0);
    expect(h.discord.channelFetches).toBe(0);
    expect(h.discord.publicIn("T0")).toEqual([]);
  });

  it("the private link message (DMs refused) collapses in place when its close button lapses", async () => {
    const h = rig(); h.discord.dm = "refused";
    const menu = await h.slash();
    await h.click(menu, "public"); h.tunnelUp(); await h.settle();
    const here = [...h.discord.messages.values()].find(m => m.ephemeral && m.content.includes("https://sample.trycloudflare.com/signin"))!;
    expect(buttons(here)).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000); await h.settle();
    expect(here.content).toBe(t("buttons.stale"));
    expect(buttons(here)).toBe(0);
    expect(h.discord.channelFetches).toBe(0);
    expect(h.discord.publicIn("T0")).toEqual([]);
  });

  it("a stale button (its nonce is gone) collapses on the clicked ephemeral message and tells the clicker", async () => {
    const h = rig();
    const menu = await h.slash();
    for (const e of h.s.pendingNonceButtons.values()) clearTimeout(e.timer);
    h.s.pendingNonceButtons.clear(); // e.g. a fleet restart since the menu was posted
    await h.click(menu, "local"); await h.settle();
    expect(menu.content).toBe(t("buttons.stale"));
    expect(buttons(menu)).toBe(0);
    expect([...h.discord.messages.values()].some(m => m.ephemeral && m.content === t("buttons.stale_notice"))).toBe(true);
    expect(h.discord.channelFetches).toBe(0);
    expect(h.discord.dms()).toEqual([]);
  });

  it("a menu Discord refuses still answers the deferred reply (never 'the application did not respond')", async () => {
    const h = rig();
    const original = h.discord.slash.bind(h.discord);
    vi.spyOn(h.discord, "slash").mockImplementation((...args: Parameters<FakeDiscord["slash"]>) => {
      const i = original(...args), edit = i.editReply;
      i.editReply = async (p: any) => { if (typeof p === "object" && p.components?.length) throw apiError(50035, "Invalid Form Body"); return edit(p); };
      return i;
    });
    const reply = await h.slash();
    expect(reply.content).toBe(t("dashboard.menu_failed"));
    expect(h.s.pendingNonceButtons.size).toBe(0);
  });

  it("/dashboard outside General: DM refused → the code comes back privately in the command's own reply", async () => {
    const h = rig(); h.discord.dm = "refused";
    const reply = await h.slash("dashboard", "T1");
    expect(reply.content).toMatch(CODE);
    expect(h.discord.publicIn("T1")).toEqual([]);
    const ok = rig();
    const sent = await ok.slash("dashboard", "T1");
    expect(sent.content).toBe(t("dashboard.private_sent_dm"));
    expect(ok.discord.dms()[0].content).toMatch(CODE);
  });
});

/** Waits on the fake clock, as the real install and tunnel wait on the network. */
const after = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const MB = 1024 * 1024;
/** A first-run install: 40 MB in 12 s (half-second chunks), then 1 s of verification. */
const downloading: EnsureStub = async ({ onProgress }) => {
  onProgress?.({ phase: "checked", download: true, version: "2026.9.3" });
  for (let i = 1; i <= 24; i++) { await after(500); onProgress?.({ phase: "downloading", received: Math.round(40 * MB * i / 24), total: 40 * MB }); }
  onProgress?.({ phase: "verifying" });
  await after(1_000);
  return { path: "/pinned", source: "downloaded" };
};
const installed: EnsureStub = async ({ onProgress }) => { onProgress?.({ phase: "checked", download: false, version: "2026.9.3" }); return { path: "/pinned", source: "agend" }; };
/** cloudflared hands out its address after `toAddress`, and the edge answers `toReady` later. */
const slowTunnel = (toAddress: number, toReady: number) => async (ctx: any) => {
  await after(toAddress); ctx.onCandidateHost("sample.trycloudflare.com");
  await after(toReady);
  return { ok: true, handle: { pageUrl: "https://sample.trycloudflare.com/signin", onUnexpectedExit: () => () => {} } };
};
const menuEdits = (h: ReturnType<typeof rig>, menu: Msg) => h.discord.history.filter(e => e.id === menu.id && e.components === 0);
const line = (text: string, marker: string, number: string) => text.split("\n").find(l => l.startsWith(`${marker} ${number} `));

describe("Discord /dashboard public link: each step on the clicked menu, throttled", () => {
  it("first run: check → download (MB) → verify → tunnel → address → delivered, one edit per ≥2 s, seconds on every step", async () => {
    const h = rig({ ensure: downloading, start: slowTunnel(3_000, 4_000) });
    const menu = await h.slash();
    await h.click(menu, "public");
    await vi.advanceTimersByTimeAsync(30_000); await h.settle();
    const edits = menuEdits(h, menu);
    const final = edits.at(-1)!.content;
    const progress = edits.slice(0, -1);
    for (let i = 1; i < progress.length; i++) expect(progress[i].at - progress[i - 1].at, "throttled").toBeGreaterThanOrEqual(2_000);
    expect(progress.length, "a burst of download chunks is not an edit each").toBeLessThanOrEqual(12);
    const seen = (marker: string, number: string) => progress.some(e => line(e.content, marker, number));
    expect(seen("⏳", "②") && seen("⏳", "④") && seen("⏳", "⑤"), "download, tunnel and address were each shown running").toBe(true);
    expect(progress.some(e => /⏳ ② Download cloudflared: \d+\.\d \/ 40\.0 MB · \d+ s/.test(e.content)), "bytes of the total").toBe(true);
    expect(line(final, "✅", "①")).toContain("2026.9.3");
    expect(line(final, "✅", "②")).toBe("✅ ② Download cloudflared: 40.0 / 40.0 MB · 12 s");
    expect(line(final, "✅", "③")).toBe(`✅ ③ ${t("dashboard.progress.verify")} · 1 s`);
    expect(line(final, "✅", "④")).toBe(`✅ ④ ${t("dashboard.progress.tunnel")} · 3 s`);
    expect(line(final, "✅", "⑤")).toBe(`✅ ⑤ ${t("dashboard.progress.address")} · 4 s`);
    expect(line(final, "✅", "⑥")).toMatch(/^✅ ⑥ /);
    expect(final.split("\n")[0]).toBe(t("dashboard.progress.title", 20));
    expect(final.endsWith(`\n\n${t("dashboard.private_sent_dm")}`)).toBe(true);
    for (const e of edits) { expect(e.content).not.toContain("trycloudflare"); expect(e.content).not.toMatch(CODE); }
    expect(h.discord.dms()[0].content).toContain("https://sample.trycloudflare.com/signin");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(menuEdits(h, menu).length, "no step edit after the outcome").toBe(edits.length);
  });

  it("already installed: only ④–⑥", async () => {
    const h = rig({ ensure: installed, start: slowTunnel(3_000, 2_000) });
    const menu = await h.slash();
    await h.click(menu, "public");
    await vi.advanceTimersByTimeAsync(10_000); await h.settle();
    const final = menuEdits(h, menu).at(-1)!.content;
    expect(final).not.toMatch(/[①②③]/);
    expect(["④", "⑤", "⑥"].every(n => line(final, "✅", n))).toBe(true);
  });

  it("a long wait still moves: the running step's seconds are refreshed while nothing else changes", async () => {
    const h = rig({ ensure: installed, start: slowTunnel(20_000, 1_000) });
    const menu = await h.slash();
    await h.click(menu, "public");
    await vi.advanceTimersByTimeAsync(16_000);
    const running = menuEdits(h, menu).map(e => line(e.content, "⏳", "④")).filter(Boolean);
    expect(running.length, "a refresh every 5 s").toBeGreaterThanOrEqual(3);
    expect(new Set(running).size).toBe(running.length);
    await vi.advanceTimersByTimeAsync(10_000); await h.settle();
  });

  it("the download fails its checksum: ③ is marked with the reason, nothing after it ran, the link is closed and a retry is offered", async () => {
    const { CloudflaredInstallError } = await import("../src/tunnel/cloudflared-install.js");
    const h = rig({ start: slowTunnel(1_000, 1_000), ensure: async ({ onProgress }) => {
      onProgress?.({ phase: "checked", download: true, version: "2026.9.3" });
      await after(2_000); onProgress?.({ phase: "downloading", received: 40 * MB, total: 40 * MB });
      onProgress?.({ phase: "verifying" }); await after(500);
      throw new CloudflaredInstallError("checksum-mismatch", "secret detail /home/x/.agend/bin");
    } });
    const menu = await h.slash();
    await h.click(menu, "public");
    await vi.advanceTimersByTimeAsync(10_000); await h.settle();
    const final = menuEdits(h, menu).at(-1)!.content;
    expect(line(final, "❌", "③")).toBe(`❌ ③ ${t("dashboard.progress.verify")} · 0 s — ${t("dashboard.progress.fail.checksum-mismatch")}`);
    expect(line(final, "▫️", "④")).toBeTruthy();
    expect(final).not.toContain("secret detail");
    expect(final.endsWith(`\n\n${t("dashboard.private_failed")}`), "the retry hint").toBe(true);
    expect(h.manager.start).not.toHaveBeenCalled();
    expect(h.s.publicWebLink.status().state).toBe("closed");
    expect(h.discord.dms()).toEqual([]);
  });

  it("cloudflared gives no address: ④ is marked with that reason", async () => {
    const h = rig({ ensure: installed, start: async () => { await after(5_000); return { ok: false, errorKind: "timeout", message: "no URL", leaseHeld: false }; } });
    const menu = await h.slash();
    await h.click(menu, "public");
    await vi.advanceTimersByTimeAsync(10_000); await h.settle();
    const final = menuEdits(h, menu).at(-1)!.content;
    expect(line(final, "❌", "④")).toBe(`❌ ④ ${t("dashboard.progress.tunnel")} · 5 s — ${t("dashboard.progress.fail.no-address")}`);
    expect(h.s.publicWebLink.status().state).toBe("closed");
  });

  it("the tunnel is another purpose's (a /login link): refused at once, with that reason", async () => {
    const h = rig({ ensure: installed });
    const login = h.s.tunnelPurposeLane.reserve("login", "login-1");
    expect(login).toBeTruthy();
    const menu = await h.slash();
    await h.click(menu, "public"); await h.settle();
    const final = menuEdits(h, menu).at(-1)!.content;
    expect(final).toContain(`— ${t("dashboard.progress.fail.lease-held")}`);
    expect(h.manager.start).not.toHaveBeenCalled();
  });
});

describe("Discord /dashboard public link: an unexpected throw", () => {
  it("still ends the step edits and tells the clicker it failed", async () => {
    const h = rig({ ensure: async ({ onProgress }) => { onProgress?.({ phase: "checked", download: false, version: "2026.9.3" }); return { path: "/pinned", source: "agend" }; },
      start: slowTunnel(1_000, 1_000) });
    const menu = await h.slash();
    const deliver = h.s.publicWebLink.deliver.bind(h.s.publicWebLink);
    vi.spyOn(h.s.publicWebLink, "deliver").mockImplementation(async (...args: any[]) => {
      const [owner, , onProgress] = args;
      await deliver(owner, async () => false, onProgress); // the steps ran, then …
      throw new Error("unexpected");
    });
    await h.click(menu, "public");
    await vi.advanceTimersByTimeAsync(10_000); await h.settle();
    const edits = menuEdits(h, menu);
    expect(edits.at(-1)!.content.endsWith(`\n\n${t("dashboard.private_failed")}`)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(menuEdits(h, menu).length, "no refresh after the outcome").toBe(edits.length);
  });
});
