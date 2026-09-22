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
  const bindingVerify = vi.fn(async (input: any) => ({ ok: true as const, verification_id: "binding_verify_test", expires_at: Date.now() + 60_000,
    binding: { group_id: String(input.binding.group_id), general_channel_id: input.binding.general_channel_id ?? null },
    probe: { group_id: String(input.binding.group_id), group_name: "Target", channel_id: String(input.binding.general_channel_id || ""), channel_name: "general", can_view: true, can_send: true } }));
  const bindingApply = vi.fn(() => ({ job: { id: "binding_job_test", connectionId: "primary", idempotencyKey: "key_test", result: "applying", status: "running", startedAt: Date.now() }, reused: false }));
  const ctx = {
    fleetConfig: { defaults: {}, instances: {}, channels: [{ id: "primary", type: "discord", mode: "topic", bot_token_env: "DISCORD_BOT_TOKEN", group_id: "1", access: { mode: "open", allowed_users: [] } }] }, dataDir: "/tmp", configPath: null,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }, getRawFleetConfig: () => ({}), saveFleetConfig: vi.fn(),
    lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() },
    listSecureConnections: () => [{ id: "primary", type: "discord", token_env: "DISCORD_BOT_TOKEN", token_present: true, group_id: "1", status: "connected" }],
    verifyConnectionSecret: verify, startConnectionSecretApply: apply,
    providerSecretsEnabled: () => true,
    verifyConnectionBinding: bindingVerify, startConnectionBindingApply: bindingApply,
    getConnectionSecretApply: () => null,
  } as unknown as SettingsApiContext;
  return { ctx, verify, apply, bindingVerify, bindingApply };
}

describe("Settings secure connection endpoints", () => {
  it("lists only masked connection metadata", async () => {
    const { ctx } = context();
    const response = await request("/api/settings/connections", ctx, "GET");
    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ id: "primary", token_present: true })]);
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("exposes provider secret specs without env keys or accepting URL input", async () => {
    const { ctx } = context();
    ctx.listProviderSecrets = () => [{ id: "groq.api_key", display_name: "Groq API key", kind: "api_key", token_present: false, verifier: "available", activation: "reload_hook", stale_consumers: [] }];
    const response = await request("/api/settings/provider-secrets", ctx, "GET");
    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ id: "groq.api_key", verifier: "available" })]);
    expect(JSON.stringify(response.body)).not.toContain("GROQ_API_KEY");
  });

  it("preserves unsupported-verifier status without offering an unverified write", async () => {
    const { ctx } = context();
    ctx.listProviderSecrets = () => [{ id: "test.unsupported", display_name: "Test provider", kind: "api_key", token_present: false, verifier: "unsupported", activation: "next_use", stale_consumers: [] }];
    const response = await request("/api/settings/provider-secrets", ctx, "GET");
    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ id: "test.unsupported", verifier: "unsupported" })]);
    expect(JSON.stringify(response.body)).not.toContain("input");
  });

  it("uses the server-resolved spec id for provider verify/apply", async () => {
    const { ctx } = context();
    ctx.verifyProviderSecret = vi.fn(async () => ({ ok: true as const, verification_id: "provider_verify", expires_at: Date.now() + 60_000, spec_id: "openai.api_key", activation: "next_use" as const }));
    ctx.startProviderSecretApply = vi.fn(() => ({ job: { id: "provider_job", specId: "openai.api_key", envKey: "OPENAI_API_KEY", idempotencyKey: "provider_key", result: "applying" as const, status: "running" as const, startedAt: Date.now(), stale_consumers: [] }, reused: false }));
    ctx.getProviderSecretApply = vi.fn(() => null);
    const verified = await request("/api/settings/secrets/openai.api_key/verify", ctx, "POST", { secret: "sk-realistic", envKey: "PATH", url: "https://evil.invalid", idempotency_key: "provider_key" }, { cookie: "agend_session=session" });
    expect(verified.status).toBe(200);
    expect(verified.body).not.toHaveProperty("secret");
    expect((ctx.verifyProviderSecret as any).mock.calls[0][0]).not.toHaveProperty("envKey");
    expect((ctx.verifyProviderSecret as any).mock.calls[0][0]).not.toHaveProperty("url");
    const applied = await request("/api/settings/secrets/openai.api_key/apply", ctx, "POST", { verification_id: "provider_verify", idempotency_key: "provider_key", envKey: "PATH" }, { cookie: "agend_session=session" });
    expect(applied.status).toBe(202);
    expect(applied.body).not.toHaveProperty("envKey");
  });

  it("keeps provider secret endpoints dark when the feature flag is off", async () => {
    const { ctx } = context();
    ctx.providerSecretsEnabled = () => false;
    ctx.listProviderSecrets = vi.fn();
    ctx.verifyProviderSecret = vi.fn();
    const listed = await request("/api/settings/provider-secrets", ctx, "GET");
    expect(listed.status).toBe(404);
    const verified = await request("/api/settings/provider-secrets/openai.api_key/verify", ctx, "POST", {
      secret: "sk-never-written", idempotency_key: "flag-off",
    });
    expect(verified.status).toBe(404);
    expect(ctx.listProviderSecrets).not.toHaveBeenCalled();
    expect(ctx.verifyProviderSecret).not.toHaveBeenCalled();
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

  it("verifies a binding before returning a challenge and exposes only the probe", async () => {
    const { ctx, bindingVerify } = context();
    const response = await request("/api/settings/connections/primary/binding/verify", ctx, "POST",
      { group_id: "123456789012345678", general_channel_id: "987654321098765432", idempotency_key: "key_test" },
      { cookie: "agend_session=session" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, result: "verified", verification_id: "binding_verify_test", probe: { can_view: true, can_send: true } });
    expect(response.body).not.toHaveProperty("secret");
    expect(bindingVerify).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "primary", binding: { group_id: "123456789012345678", general_channel_id: "987654321098765432" } }));
  });

  it("rejects JSON-number binding IDs before provider verification", async () => {
    const { ctx, bindingVerify } = context();
    const response = await request("/api/settings/connections/primary/binding/verify", ctx, "POST", {
      group_id: 999999999999999999,
      general_channel_id: 123,
      idempotency_key: "key_number",
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("binding IDs must be strings");
    expect(bindingVerify).not.toHaveBeenCalled();
  });

  it("applies a binding only with the verified challenge", async () => {
    const { ctx, bindingApply } = context();
    const response = await request("/api/settings/connections/primary/binding/apply", ctx, "POST",
      { verification_id: "binding_verify_test" }, { cookie: "agend_session=session", "idempotency-key": "key_test" });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ ok: true, result: "applying", job_id: "binding_job_test" });
    expect(bindingApply).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "primary", verificationId: "binding_verify_test", idempotencyKey: "key_test" }));
  });

  it("does not let broad channel CRUD bypass binding verification", async () => {
    const { ctx } = context();
    const response = await request("/api/settings/fleet/channels", ctx, "PUT", [{
      id: "primary", type: "discord", mode: "topic", bot_token_env: "DISCORD_BOT_TOKEN", group_id: "999999999999999999",
      access: { mode: "open", allowed_users: [] },
    }]);
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("verified rebind");
  });

  it("rejects provider API-key env collisions in broad channel CRUD", async () => {
    const { ctx } = context();
    const response = await request("/api/settings/fleet/channels", ctx, "PUT", [{
      id: "primary", type: "discord", mode: "topic", bot_token_env: "GROQ_API_KEY", group_id: "1",
      access: { mode: "open", allowed_users: [] },
    }]);
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("protected provider secret key");
  });
});
