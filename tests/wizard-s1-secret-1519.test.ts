/**
 * #1519 Fix 2: secret endpoints in settings-api and quickstart probe must
 * return 403 for gateway (public-link) sessions; local sessions are unaffected.
 *
 * S1 (wizard draftQuickstart behaviour) was moved to PR #1519 web-claude implementation.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { handleQuickstartRequest } from "../src/quickstart-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

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

// ── Fix 2: secret endpoints return 403 for gateway sessions ──────────────────
//
// Reverse mutation: removing any gateway guard from the corresponding endpoint
// makes its test fail because the handler proceeds to the secret operation
// instead of returning 403.

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
      expect(ctx.verifyProviderSecret).not.toHaveBeenCalled();
      expect(ctx.startProviderSecretApply).not.toHaveBeenCalled();
      expect(ctx.verifyConnectionSecret).not.toHaveBeenCalled();
      expect(ctx.startConnectionSecretApply).not.toHaveBeenCalled();
      expect(ctx.verifyConnectionBinding).not.toHaveBeenCalled();
      expect(ctx.startConnectionBindingApply).not.toHaveBeenCalled();
    });
  }

  it("local session can reach the secret endpoint (not blocked)", () => {
    const { res } = call("/api/settings/secrets/telegram/verify", "POST", /* gateway */ false);
    expect(res.getStatus()).not.toBe(403);
  });
});

// ── Fix 2b: quickstart probe endpoint returns 403 for gateway sessions ─────────

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
    expect(res.getStatus()).not.toBe(403);
  });
});
