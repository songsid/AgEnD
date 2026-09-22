import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";

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

function context() {
  const verify = vi.fn(async (input: any) => ({ ok: true as const, verification_id: "verify_test", expires_at: Date.now() + 60_000, identity: { id: "1", username: "bot" } }));
  const apply = vi.fn(() => ({ job: { id: "job_test", connectionId: "primary", idempotencyKey: "key_test", result: "applying", status: "running", startedAt: Date.now() }, reused: false }));
  const ctx = {
    fleetConfig: { defaults: {}, instances: {} }, dataDir: "/tmp", configPath: null,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }, getRawFleetConfig: () => ({}), saveFleetConfig: vi.fn(),
    lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() },
    listSecureConnections: () => [{ id: "primary", type: "discord", token_env: "DISCORD_BOT_TOKEN", token_present: true, group_id: "1", status: "connected" }],
    verifyConnectionSecret: verify, startConnectionSecretApply: apply,
    getConnectionSecretApply: () => null,
  } as unknown as SettingsApiContext;
  return { ctx, verify, apply };
}

describe("Settings secure connection endpoints", () => {
  it("lists only masked connection metadata", async () => {
    const { ctx } = context();
    const response = await request("/api/settings/connections", ctx, "GET");
    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ id: "primary", token_present: true })]);
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("accepts a token only in the verify body and binds the request session", async () => {
    const { ctx, verify } = context();
    const response = await request("/api/settings/connections/primary/secret/verify", ctx, "POST", { secret: "super-secret", idempotency_key: "key_test" }, { cookie: "agend_session=session" });
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("secret");
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "primary", secret: "super-secret", idempotencyKey: "key_test" }));
  });

  it("requires idempotency on apply and returns an applying job", async () => {
    const { ctx, apply } = context();
    const response = await request("/api/settings/connections/primary/secret/apply", ctx, "POST", { verification_id: "verify_test" }, { cookie: "agend_session=session", "idempotency-key": "key_test" });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ ok: true, result: "applying", job_id: "job_test" });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "primary", verificationId: "verify_test", idempotencyKey: "key_test" }));
  });

  it("does not relay a provider error returned by the secure callback", async () => {
    const { ctx } = context();
    ctx.verifyConnectionSecret = vi.fn(async () => ({ ok: false as const, error: "https://api.telegram.org/bot123456:secret/getMe failed" }));
    const response = await request("/api/settings/connections/primary/secret/verify", ctx, "POST", { secret: "123456:secret", idempotency_key: "key_test" });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).not.toContain("123456:secret");
  });
});
