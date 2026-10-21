import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { PUBLIC_TUNNEL_SECRET_ID as ID } from "../src/public-tunnel-config.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

function request(path: string, ctx: SettingsApiContext, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as EventEmitter & { method: string; headers: Record<string, string>; destroy(): void };
    req.method = method; req.headers = headers; req.destroy = () => undefined;
    let status = 0; let payload = "";
    const res = { writeHead(code: number) { status = code; }, end(text?: string) { payload = text ?? ""; resolve({ status, body: payload ? JSON.parse(payload) : null }); } };
    try {
      expect(handleSettingsRequest(req as never, res as never, new URL(`http://localhost${path}`), ctx)).toBe(true);
      if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      else queueMicrotask(() => req.emit("end"));
    } catch (err) { reject(err); }
  });
}


const TOKEN = "eyJNamedConnectorPrivateValue2307Token";
function context() {
  return { fleetConfig: { defaults: {}, instances: {}, web: { public_link: { hostname: "agend.example.com", tunnel_token: TOKEN } } },
    logger: { error: vi.fn(), warn: vi.fn() }, providerSecretsEnabled: () => false,
    getRawFleetConfig: () => ({ web: { public_link: { tunnel_token: TOKEN } } }),
    listProviderSecrets: () => [{ id: ID, kind: "tunnel_token", display_name: "Cloudflare connector token", token_present: true, verifier: "available", activation: "reload_hook", stale_consumers: [], secret: TOKEN }],
    verifyProviderSecret: vi.fn(async () => ({ ok: true, verification_id: "opaque-id", expires_at: Date.now()+60000, spec_id: ID, activation: "reload_hook", secret: TOKEN })),
    startProviderSecretApply: vi.fn(() => ({ job: { id: "job-id", result: "applying", secret: TOKEN }, reused: false })),
  } as unknown as SettingsApiContext;
}
it("connector endpoints work without enabling API-key editing and return metadata/opaque proof only", async () => {
  const ctx = context();
  const metadata = await request("/api/settings/public-tunnel-token", ctx, "GET");
  expect(metadata.status).toBe(200); expect(metadata.body).toHaveLength(1);
  expect(metadata.body[0].token_present).toBe(true); expect(JSON.stringify(metadata.body)).not.toContain(TOKEN);
  const verified = await request("/api/settings/public-tunnel-token/verify", ctx, "POST", { secret: TOKEN, idempotency_key: "named-key" });
  expect(verified.status).toBe(200); expect(JSON.stringify(verified.body)).not.toContain(TOKEN);
  expect(ctx.verifyProviderSecret).toHaveBeenCalledWith(expect.objectContaining({ specId: ID, secret: TOKEN, clear: false }));
  const applied = await request("/api/settings/public-tunnel-token/apply", ctx, "POST", { verification_id: "opaque-id", idempotency_key: "named-key" });
  expect(applied.status).toBe(202); expect(JSON.stringify(applied.body)).not.toContain(TOKEN);
  expect((await request("/api/settings/secrets", ctx, "GET")).status).toBe(404);
});
it("clear prepares an empty secret only for this code-owned connector slot", async () => {
  const ctx = context();
  const cleared = await request("/api/settings/public-tunnel-token/verify", ctx, "POST", { clear: true, idempotency_key: "clear-key" });
  expect(cleared.status).toBe(200);
  expect(ctx.verifyProviderSecret).toHaveBeenCalledWith(expect.objectContaining({ specId: ID, clear: true, secret: "" }));
});
it("raw and parsed settings defensively redact an inline connector token", async () => {
  const ctx = context();
  for (const path of ["/api/settings/fleet", "/api/settings/fleet/raw"]) {
    const response = await request(path, ctx, "GET"); expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  }
});
it("public gateway requests cannot even prepare a token mutation", () => {
  const ctx = context();
  const req: any = Object.assign(new EventEmitter(), { method: "POST", headers: {}, destroy: vi.fn() });
  bindGatewayRequest(req, { surface: "gateway", exposureId: "old", expectedOrigin: "https://agend.example.com", isCurrent: () => true });
  const res: any = { writeHead: vi.fn(), end: vi.fn() };
  expect(handleSettingsRequest(req, res, new URL("http://localhost/api/settings/public-tunnel-token/verify"), ctx)).toBe(true);
  expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  expect(ctx.verifyProviderSecret).not.toHaveBeenCalled();
});
