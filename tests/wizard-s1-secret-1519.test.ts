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
import type { FleetConfig } from "../src/config.js";
import { draftQuickstart, planQuickstart } from "../src/quickstart-api.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
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
