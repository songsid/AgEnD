/**
 * #1519 P3 (docs/design/ux-onboarding-walkthrough.md §5.3): one permission set for every Discord invite, each bit tied to
 * the adapter calls that need it, never Administrator; a channel picker probe; the invite link with a verify; a gateway
 * 4014 (disallowed intents) as the connection's problem.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISCORD_ADMINISTRATOR_BIT, DISCORD_BOT_PERMISSIONS, DISCORD_PERMISSION_BITS, discordBotPortalUrl, discordInviteUrl, isDisallowedIntentsError } from "../src/discord-permissions.js";
import { listDiscordTextChannels } from "../src/provider-probe.js";
import { runProviderProbe } from "../src/quickstart-api.js";

const ADAPTER = readFileSync(join(process.cwd(), "src", "channel", "adapters", "discord.ts"), "utf8");
const P = BigInt(DISCORD_BOT_PERMISSIONS);
const has = (bit: bigint) => (P & (1n << bit)) !== 0n;
const B = DISCORD_PERMISSION_BITS;

/**
 * Every kind of guild call the adapter makes (its source pattern) and the bits it needs. A pattern that is no longer in
 * the adapter fails the table (so it stays true), and every bit it names must be in the set.
 */
const CALLS: Array<[string, RegExp, bigint[]]> = [
  ["send a message (replies, prompts, approvals, alerts, stickers)", /channel\.send\(/, [B.VIEW_CHANNEL, B.SEND_MESSAGES]],
  ["send a file", /send\(\{ files: \[filePath\] \}\)/, [B.VIEW_CHANNEL, B.SEND_MESSAGES, B.ATTACH_FILES]],
  ["fetch its own message to edit / delete / react", /messages\.fetch\(/, [B.VIEW_CHANNEL, B.READ_MESSAGE_HISTORY]],
  ["edit its own message", /msg\.edit\(/, [B.VIEW_CHANNEL, B.READ_MESSAGE_HISTORY]],
  ["delete its own message", /msg\.delete\(\)/, [B.VIEW_CHANNEL, B.READ_MESSAGE_HISTORY]],
  ["react / unreact (REST reactions/@me)", /reactions\/\$\{encoded\}\/@me/, [B.VIEW_CHANNEL, B.READ_MESSAGE_HISTORY, B.ADD_REACTIONS, B.USE_EXTERNAL_EMOJIS]],
  ["create the topic category and topic channels", /guild\.channels\.create\(/, [B.MANAGE_CHANNELS]],
  ["delete a topic channel it created", /\(channel as \{ delete\(\): Promise<unknown> \}\)\.delete\(\)/, [B.MANAGE_CHANNELS]],
];

describe("the one Discord permission set", () => {
  it.each(CALLS)("%s: the call is in the adapter, and every bit it needs is in the set", (_name, pattern, bits) => {
    expect(pattern.test(ADAPTER), "the adapter still makes this call").toBe(true);
    expect(bits.filter(bit => !has(bit)), "missing from the invite").toEqual([]);
  });
  it("every bit in the set is needed by some call (nothing just in case), and Administrator is never in it", () => {
    const needed = new Set(CALLS.flatMap(([, , bits]) => bits));
    expect(Object.entries(B).filter(([, bit]) => !needed.has(bit)).map(([name]) => name), "replies in threads need SEND_MESSAGES_IN_THREADS").toEqual(["SEND_MESSAGES_IN_THREADS"]);
    expect(has(DISCORD_ADMINISTRATOR_BIT)).toBe(false);
    expect(DISCORD_BOT_PERMISSIONS, "bits 4, 6, 10, 11, 15, 16, 18, 38").toBe("274878270544");
    // Slash commands: no bit — registering them is authorized by the applications.commands scope (#1533 review).
    expect([has(31n), /application\?\.commands\.set\(/.test(ADAPTER), discordInviteUrl("1").includes("scope=bot%20applications.commands")]).toEqual([false, true, true]);
  });
  it("the invite and the portal page", () => {
    expect(discordInviteUrl("123456789")).toBe(`https://discord.com/oauth2/authorize?client_id=123456789&scope=bot%20applications.commands&permissions=${DISCORD_BOT_PERMISSIONS}`);
    expect(discordBotPortalUrl("123456789")).toBe("https://discord.com/developers/applications/123456789/bot");
  });
  it("the CLI's persona invite uses the same set (no permission integer of its own)", () => {
    const cli = readFileSync(join(process.cwd(), "src", "quickstart.ts"), "utf8");
    expect([cli.includes("discordInviteUrl(appId)"), /permissions=\$\{|1n << \d+n/.test(cli)]).toEqual([true, false]);
  });
});

describe("the probes", () => {
  const fakeFetch = (routes: Record<string, { status: number; body: unknown }>) => (async (url: string) => {
    const r = routes[url] ?? { status: 404, body: {} };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
  it("text channels in Discord's order; other channel types left out; a refusal is said so", async () => {
    const f = fakeFetch({ "https://discord.com/api/v10/guilds/555/channels": { status: 200, body: [
      { id: "3", name: "random", type: 0, position: 2 }, { id: "1", name: "Voice", type: 2, position: 0 },
      { id: "2", name: "general", type: 0, position: 1 }, { id: "4", name: "Topics", type: 4, position: 3 }] } });
    expect(await listDiscordTextChannels("t", "555", f)).toEqual({ ok: true, channels: [{ id: "2", name: "general" }, { id: "3", name: "random" }] });
    expect(await listDiscordTextChannels("t", "999", f)).toEqual({ ok: false, error: "Discord replied 404" });
    expect(await listDiscordTextChannels("t", "../x", f)).toEqual({ ok: false, error: "guild id must be numeric" });
  });
  it("a verified Discord bot comes with its invite and portal page; a Telegram one does not", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => ({ ok: true, status: 200, json: async () => (String(url).includes("telegram")
      ? { ok: true, result: { id: 5, username: "tg_bot" } } : { id: "777", username: "dc_bot" }) })) as unknown as typeof fetch;
    try {
      const dc = await runProviderProbe({ action: "verify", platform: "discord", token: "x" });
      expect(dc).toMatchObject({ ok: true, invite_url: discordInviteUrl("777"), portal_url: discordBotPortalUrl("777") });
      const tg = await runProviderProbe({ action: "verify", platform: "telegram", token: "x" });
      expect(tg).not.toHaveProperty("invite_url");
    } finally { globalThis.fetch = realFetch; }
  });
});

describe("a gateway 4014 is the connection's problem", () => {
  it("disallowed intents, from the login error or the close code", () => {
    expect(["Used disallowed intents", "Used disallowed intents (4014)", "gateway closed 4014"].map(isDisallowedIntentsError)).toEqual([true, true, true]);
    expect(["Invalid token", "4004", null].map(isDisallowedIntentsError)).toEqual([false, false, false]);
  });
  it("listSecureConnections names it while the connection is down, not once it connects", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "agend-4014-"));
    try {
      const fm = new FleetManager(dir) as any;
      fm.fleetConfig = { defaults: {}, instances: {}, channels: [{ id: "dc", type: "discord", bot_token_env: "AGEND_TEST_DC_TOKEN" }] };
      fm.adapterState.set("dc", { status: "retrying", retryCount: 1, lastError: "Used disallowed intents" });
      expect(fm.listSecureConnections()[0]).toMatchObject({ id: "dc", status: "retrying", problem: "missing_intent" });
      fm.adapterState.set("dc", { status: "connected", retryCount: 0, lastError: "Used disallowed intents" });
      expect(fm.listSecureConnections()[0]).not.toHaveProperty("problem");
      fm.adapterState.set("dc", { status: "retrying", retryCount: 1, lastError: "Invalid token" });
      expect(fm.listSecureConnections()[0]).not.toHaveProperty("problem");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
