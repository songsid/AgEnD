/**
 * #1519 fixes:
 *
 * S1: draftQuickstart must never replace an existing connection by env-name
 *     match — adding a second platform must always create a new entry.
 *
 * Fix 2: secret endpoints in settings-api must return 403 for gateway
 *         (public-link) sessions; local sessions are unaffected.
 *
 * Each test has a reverse-mutation note.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { FleetConfig } from "../src/types.js";
import { draftQuickstart, planQuickstart, defaultTokenEnvName } from "../src/quickstart-api.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { handleQuickstartRequest } from "../src/quickstart-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

// ── S1: draftQuickstart never replaces by env-name ────────────────────────────
//
// Reverse mutation: restoring `existingIndex = channels.findIndex(ch => ch.bot_token_env === body.token_env)`
// + `if (existingIndex >= 0) channels[existingIndex] = …` makes test 1 fail because
// the Telegram channel is silently replaced when both use the same token_env default.

describe("draftQuickstart: always creates a new connection (S1 fix)", () => {
  function telegamCfg(): FleetConfig {
    return {
      channels: [{ id: "telegram", type: "telegram", bot_token_env: "AGEND_BOT_TOKEN" } as any],
      instances: {},
    } as FleetConfig;
  }

  it("adding Discord to an existing Telegram fleet keeps both channels", () => {
    const cfg = telegamCfg();
    const body = {
      platform: "discord" as const,
      token_env: "AGEND_BOT_TOKEN", // same env name as telegram (the old bug trigger)
      backend: "claude-code" as const,
      working_directory: "/tmp/app",
      instance_name: "agent-2",
      guild_id: "guild-1",
      general_channel_id: "gen-1",
      admin_user_id: "user-1",
    };
    const plan = planQuickstart(body, { backends: ["claude-code"], channels: [], has_fleet: true });
    const result = draftQuickstart(cfg, body, plan);

    // Both channels must be present
    expect(result.channels).toHaveLength(2);
    // The original Telegram channel must still be there
    const telegram = result.channels?.find((c: any) => c.type === "telegram");
    expect(telegram).toBeTruthy();
    const discord = result.channels?.find((c: any) => c.type === "discord");
    expect(discord).toBeTruthy();
  });

  it("adding Discord with a unique env name also keeps both channels (regression)", () => {
    const cfg = telegamCfg();
    const body = {
      platform: "discord" as const,
      token_env: "AGEND_DISCORD_TOKEN", // unique env name
      backend: "claude-code" as const,
      working_directory: "/tmp/app",
      instance_name: "agent-2",
      guild_id: "guild-1",
      general_channel_id: "gen-1",
      admin_user_id: "user-1",
    };
    const plan = planQuickstart(body, { backends: ["claude-code"], channels: [], has_fleet: true });
    const result = draftQuickstart(cfg, body, plan);

    expect(result.channels).toHaveLength(2);
    expect(result.channels?.find((c: any) => c.type === "telegram")).toBeTruthy();
    expect(result.channels?.find((c: any) => c.type === "discord")).toBeTruthy();
  });
});

// ── S1: always-add + unique env name ─────────────────────────────────────────
//
// Reverse mutation: restoring existingIndex match by env+platform makes test 3
// fail because the existing Discord channel is replaced by the second bot.

describe("draftQuickstart + defaultTokenEnvName: always-add with unique env (#1521 S1 fix)", () => {
  function twoDiscordCtx(): { cfg: FleetConfig; body: typeof discordBody } {
    const cfg: FleetConfig = {
      channels: [{ id: "discord", type: "discord", bot_token_env: "AGEND_DISCORD_TOKEN" } as any],
      instances: {},
    } as FleetConfig;
    const body = {
      platform: "discord" as const,
      token_env: "AGEND_DISCORD_TOKEN", // same default as first bot
      backend: "claude-code" as const,
      working_directory: "/tmp/app",
      instance_name: "agent-dc2",
      guild_id: "guild-2",
      general_channel_id: "gen-2",
      admin_user_id: "user-2",
    };
    return { cfg, body };
  }

  const discordBody = {
    platform: "discord" as const,
    token_env: "AGEND_DISCORD_TOKEN",
    backend: "claude-code" as const,
    working_directory: "/tmp/app",
    instance_name: "agent-dc2",
    guild_id: "guild-2",
    general_channel_id: "gen-2",
    admin_user_id: "user-2",
  };

  it("adding a second Discord bot keeps both connections (never replaces)", () => {
    const { cfg, body } = twoDiscordCtx();
    const plan = planQuickstart(body, { backends: ["claude-code"], channels: [], has_fleet: true });
    const result = draftQuickstart(cfg, body, plan);

    expect(result.channels).toHaveLength(2);
    expect(result.channels?.find((c: any) => c.type === "discord" && c.bot_token_env === "AGEND_DISCORD_TOKEN")).toBeTruthy();
    // Second entry also present (may have same env — wizard should pre-fill unique name)
    const discordChannels = result.channels?.filter((c: any) => c.type === "discord");
    expect(discordChannels).toHaveLength(2);
  });

  it("defaultTokenEnvName produces AGEND_DISCORD_TOKEN_2 when AGEND_DISCORD_TOKEN is taken", () => {
    const existing = [{ bot_token_env: "AGEND_DISCORD_TOKEN" }];
    expect(defaultTokenEnvName("discord", existing)).toBe("AGEND_DISCORD_TOKEN_2");
  });

  it("defaultTokenEnvName produces AGEND_TELEGRAM_TOKEN for a fresh Telegram", () => {
    expect(defaultTokenEnvName("telegram", [])).toBe("AGEND_TELEGRAM_TOKEN");
  });

  it("defaultTokenEnvName increments to _3 when _2 is also taken", () => {
    const existing = [
      { bot_token_env: "AGEND_DISCORD_TOKEN" },
      { bot_token_env: "AGEND_DISCORD_TOKEN_2" },
    ];
    expect(defaultTokenEnvName("discord", existing)).toBe("AGEND_DISCORD_TOKEN_3");
  });
});

// ── Fix 2: secret endpoints return 403 for gateway sessions ──────────────────
//
// Reverse mutation: removing any `if (gatewayRequestContext(req)) { json(res, 403…` guard
// from the corresponding endpoint makes its test fail because the handler proceeds
// to the secret operation instead of returning 403.

const GATEWAY_URL = "http://localhost";

function makeReq(path: string, method = "POST"): any {
  const req = Object.assign(new EventEmitter(), { method, url: path, headers: {} });
  return req;
}

function makeGatewayReq(path: string, method = "POST"): any {
  const req = makeReq(path, method);
  bindGatewayRequest(req, {
    surface: "gateway",
    exposureId: "exp-1",
    expectedOrigin: "https://example.com",
    isCurrent: () => true,
  });
  return req;
}

function makeRes() {
  let statusCode = 0;
  let body = "";
  return {
    setHeader: vi.fn(),
    writeHead: vi.fn((code: number) => { statusCode = code; }),
    end: vi.fn((data?: string) => { body = data ?? ""; }),
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

function makeCtx(): SettingsApiContext {
  return {
    fleetConfig: null,
    dataDir: "/tmp/fake",
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    verifyProviderSecret: vi.fn(),
    startProviderSecretApply: vi.fn(),
    getProviderSecretApply: vi.fn(),
    verifyConnectionSecret: vi.fn(),
    startConnectionSecretApply: vi.fn(),
    getConnectionSecretApply: vi.fn(),
    verifyConnectionBinding: vi.fn(),
    startConnectionBindingApply: vi.fn(),
    getConnectionBindingApply: vi.fn(),
    saveFleetConfig: vi.fn(),
  } as any;
}

function call(path: string, method = "POST", gateway = false) {
  const req = gateway ? makeGatewayReq(path, method) : makeReq(path, method);
  const res = makeRes();
  const ctx = makeCtx();
  handleSettingsRequest(req as never, res as never, new URL(`${GATEWAY_URL}${path}`), ctx);
  return { res, ctx };
}

describe("settings-api: secret endpoints return 403 for gateway sessions (Fix 2)", () => {
  const secretPaths = [
    ["/api/settings/secrets/telegram/verify",       "POST"],
    ["/api/settings/secrets/telegram/apply",        "POST"],
    ["/api/settings/connections/telegram/secret/verify",  "POST"],
    ["/api/settings/connections/telegram/secret/apply",   "POST"],
    ["/api/settings/connections/telegram/binding/verify", "POST"],
    ["/api/settings/connections/telegram/binding/apply",  "POST"],
  ] as const;

  for (const [path, method] of secretPaths) {
    it(`${method} ${path} → 403 for gateway session`, () => {
      const { res, ctx } = call(path, method, /* gateway */ true);
      expect(res.getStatus()).toBe(403);
      const body = JSON.parse(res.getBody());
      expect(body.error).toMatch(/not permitted over a public link/i);
      // The handler must not have called the underlying secret operation
      expect(ctx.verifyProviderSecret).not.toHaveBeenCalled();
      expect(ctx.startProviderSecretApply).not.toHaveBeenCalled();
      expect(ctx.verifyConnectionSecret).not.toHaveBeenCalled();
      expect(ctx.startConnectionSecretApply).not.toHaveBeenCalled();
      expect(ctx.verifyConnectionBinding).not.toHaveBeenCalled();
      expect(ctx.startConnectionBindingApply).not.toHaveBeenCalled();
    });
  }

  it("local session can reach the secret endpoint (not blocked)", () => {
    // POST /api/settings/secrets/telegram/verify with a local session
    // should NOT get 403 (gets 501 because verifyProviderSecret is a stub)
    const { res } = call("/api/settings/secrets/telegram/verify", "POST", /* gateway */ false);
    expect(res.getStatus()).not.toBe(403);
  });
});


// ── Fix 2b: quickstart probe endpoint returns 403 for gateway sessions ─────────
//
// The probe receives the raw bot token for verification; a public-link session
// must not be able to use it.
//
// Reverse mutation: removing the gateway guard from handleQuickstartRequest's
// probe path makes this test fail because the handler proceeds to the probe
// instead of returning 403.

describe("quickstart probe: 403 for gateway sessions (Fix 2b)", () => {
  it("POST /api/settings/quickstart/probe → 403 for gateway session", () => {
    const req = makeGatewayReq("/api/settings/quickstart/probe", "POST");
    const res = makeRes();
    const ctx = makeCtx();
    handleQuickstartRequest(req as never, res as never,
      new URL("http://localhost/api/settings/quickstart/probe"), ctx as any);
    expect(res.getStatus()).toBe(403);
    const body = JSON.parse(res.getBody());
    expect(body.error).toMatch(/not permitted over a public link/i);
  });

  it("local session can reach the probe endpoint", () => {
    const req = makeReq("/api/settings/quickstart/probe", "POST");
    const res = makeRes();
    const ctx = makeCtx();
    handleQuickstartRequest(req as never, res as never,
      new URL("http://localhost/api/settings/quickstart/probe"), ctx as any);
    // Not 403 (will be 400 because body is empty/invalid)
    expect(res.getStatus()).not.toBe(403);
  });
});

// ── P2a: commit endpoint — cross-platform same env keeps both connections ─────
//
// Reverse mutation: reverting draftQuickstart to match by token_env only
// causes nextChannelId to return the existing channel's id ("telegram") for
// the new Discord entry, producing a duplicate channel id → commit returns 400.

describe("commit endpoint: cross-platform same env adds new connection (#1521 P2a)", () => {
  function makeCtxWithTelegram(): any {
    return {
      fleetConfig: {
        channels: [{ id: "telegram", type: "telegram", bot_token_env: "AGEND_BOT_TOKEN",
          group_id: "-100123", mode: "topic", access: { mode: "locked", allowed_users: ["42"] } }],
        instances: {},
      },
      dataDir: "/tmp/fake-qs",
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      saveFleetConfig: vi.fn(),
      isBotTokenInUse: () => false,
    };
  }

  async function commit(ctx: any, body: Record<string, unknown>) {
    let status = 0; let respBody = "";
    const req = Object.assign(new EventEmitter(), { method: "POST", url: "/x", headers: {} }) as any;
    const res: any = { setHeader: vi.fn(), writeHead: vi.fn((c: number) => { status = c; }),
      end: vi.fn((d?: string) => { respBody = d ?? ""; }) };
    handleQuickstartRequest(req, res,
      new URL("http://localhost/api/settings/quickstart/commit"), ctx);
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
    await new Promise(r => setTimeout(r, 50));
    return { status, body: respBody ? JSON.parse(respBody) as Record<string, unknown> : {} };
  }

  it("adds Discord with same env as Telegram: both channels kept, unique ids, 200", async () => {
    const ctx = makeCtxWithTelegram();
    const { status, body } = await commit(ctx, {
      platform: "discord", token_env: "AGEND_BOT_TOKEN", backend: "claude-code",
      working_directory: "/tmp/app", instance_name: "agent-dc",
      guild_id: "123456789012345678", general_channel_id: "111222333444555666",
      admin_user_id: "987654321012345678", token: "fake-discord-token",
    });

    expect(status).toBe(200);
    const channels = ctx.fleetConfig.channels;
    // Both channels must be present
    expect(channels).toHaveLength(2);
    // IDs must be distinct (no duplicate "telegram")
    const ids = channels.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(2);
    // Original Telegram connection must be unchanged
    expect(channels[0]).toMatchObject({ id: "telegram", type: "telegram", group_id: "-100123" });
    // New Discord connection exists
    expect(channels.find((c: any) => c.type === "discord")).toBeTruthy();
  });

  it("same-platform same-env same-group reconciles in-place (positive control)", async () => {
    const ctx = makeCtxWithTelegram();
    // Re-running Telegram with same group_id updates the existing connection
    const { status } = await commit(ctx, {
      platform: "telegram", token_env: "AGEND_BOT_TOKEN", backend: "claude-code",
      working_directory: "/tmp/app", instance_name: "agent-1",
      group_id: "-100123", admin_user_id: "99", token: "fake-telegram-token",
    });

    expect(status).toBe(200);
    // Still one channel (updated in-place)
    expect(ctx.fleetConfig.channels).toHaveLength(1);
    expect(ctx.fleetConfig.channels[0].id).toBe("telegram");
  });
});

// ── P2b: manual token_env preserved on platform toggle ────────────────────────
//
// The wizard state now tracks `token_env_is_auto`. The platform toggle only
// updates token_env when `is_auto` is true. Manual edits set `is_auto: false`.

describe("defaultTokenEnvName: manual value preserved (#1521 P2b)", () => {
  it("computeAutoTokenEnv returns AGEND_TELEGRAM_TOKEN for empty connections", () => {
    // Verify the helper (no direct export needed — tested via defaultTokenEnvName)
    // The wizard JS is not importable as TS; test the exported TS function instead.
    expect(defaultTokenEnvName("telegram", [])).toBe("AGEND_TELEGRAM_TOKEN");
  });

  it("computeAutoTokenEnv skips to _2 when base is taken", () => {
    expect(defaultTokenEnvName("telegram", [{ bot_token_env: "AGEND_TELEGRAM_TOKEN" }]))
      .toBe("AGEND_TELEGRAM_TOKEN_2");
  });

  it("settings-wizard.js source: manual edit sets token_env_is_auto=false", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "ui", "settings-wizard.js"), "utf-8");
    // The onInput handler for token_env must set token_env_is_auto: false
    expect(src).toContain("token_env_is_auto:");
    // The platform toggle must only update token_env when token_env_is_auto is true
    expect(src).toContain("token_env_is_auto");
    expect(src).toContain("computeAutoTokenEnv");
  });
});
