import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import {
  PROVIDER_SECRET_SPECS,
  validateProviderSecretRegistry,
  validateSecretHeaderValue,
  verifyProviderSecret,
  type ProviderSecretSpec,
} from "../src/provider-secret-registry.js";

const dirs: string[] = [];
const envBefore = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of ["GROQ_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    if (!envBefore.has(key)) envBefore.set(key, process.env[key]);
    const previous = envBefore.get(key);
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("provider API-key verifier registry", () => {
  it("keeps fixed HTTPS origins, exact hosts, and unique env keys", () => {
    validateProviderSecretRegistry();
    expect(PROVIDER_SECRET_SPECS.map(s => s.id)).toEqual(["groq.api_key", "openai.api_key", "anthropic.api_key"]);
    for (const spec of PROVIDER_SECRET_SPECS) {
      expect(spec.verifier?.origin).toMatch(/^https:\/\//);
      expect(spec.allowedHosts).toContain(spec.verifier?.origin);
      expect(spec.verifier?.path).not.toMatch(/[?#\\]/);
    }
    expect(() => validateProviderSecretRegistry([
      { ...PROVIDER_SECRET_SPECS[0]!, id: "a", envKey: "SAME" },
      { ...PROVIDER_SECRET_SPECS[1]!, id: "b", envKey: "SAME" },
    ])).toThrow(/duplicate env key/);
  });

  it("fails closed for unsupported verifiers and header injection", async () => {
    const unsupported: ProviderSecretSpec = {
      id: "unsupported", kind: "api_key", envKey: "UNSUPPORTED_KEY", displayName: "Unsupported",
      allowedHosts: ["https://example.com"], activation: "next_use",
    };
    expect((await verifyProviderSecret(unsupported, "secret", { request: vi.fn() })).status).toBe("unsupported_verifier");
    expect(() => validateSecretHeaderValue("abc\r\ndef")).toThrow(/header/);
    expect(() => validateSecretHeaderValue("é".repeat(2))).toThrow(/header/);
  });

  it("requires the positive response predicate and never follows a redirect", async () => {
    const client = { request: vi.fn(async () => ({ status: 302, body: { location: "https://evil.invalid" }, detail: "redirect" })) };
    const result = await verifyProviderSecret(PROVIDER_SECRET_SPECS[0], "secret", client);
    expect(result).toMatchObject({ ok: false, status: "provider_unavailable" });
    expect(client.request).toHaveBeenCalledTimes(1);
    const malformed = { request: vi.fn(async () => ({ status: 200, body: "not-a-model-list", detail: "" })) };
    expect(await verifyProviderSecret(PROVIDER_SECRET_SPECS[0], "secret", malformed)).toMatchObject({ ok: false, status: "provider_unavailable" });
  });

  function manager() {
    const dir = mkdtempSync(join(tmpdir(), "agend-provider-secret-")); dirs.push(dir);
    const fm = new FleetManager(dir) as any;
    fm.fleetConfig = {
      channels: [{ id: "primary", type: "discord", mode: "topic", bot_token_env: "DISCORD_BOT_TOKEN", group_id: "1", access: { mode: "open", allowed_users: [] } }],
      defaults: {}, instances: {},
    };
    return { fm, dir };
  }

  async function verify(fm: any, specId = "openai.api_key", key = "provider-key") {
    fm.providerSecretHttpClient = { request: vi.fn(async () => ({ status: 200, body: { data: [] }, detail: "" })) };
    return fm.verifyProviderSecret({ specId, secret: "sk-test-secret", sessionBinding: "session", idempotencyKey: key });
  }

  it("verifies before writing, updates process.env, reports stale consumers, and keeps children unchanged", async () => {
    const { fm, dir } = manager();
    fm.children.set("claude-1", {});
    const verified = await verify(fm);
    expect(verified.ok).toBe(true);
    expect(() => readFileSync(join(dir, ".env"), "utf8")).toThrow();
    const accepted = fm.startProviderSecretApply({ specId: "openai.api_key", verificationId: verified.verification_id, sessionBinding: "session", idempotencyKey: "provider-key" });
    for (let i = 0; i < 40 && accepted.job.status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(accepted.job.result).toBe("applied_next_use");
    expect(accepted.job.stale_consumers).toEqual(["claude-1"]);
    expect(process.env.OPENAI_API_KEY).toBe("sk-test-secret");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("OPENAI_API_KEY=sk-test-secret");
    if (process.platform !== "win32") expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(accepted.job)).not.toContain("sk-test-secret");
  });

  it("uses a code-owned Groq hook and rolls back both file and process snapshot on hook failure", async () => {
    const { fm, dir } = manager();
    writeFileSync(join(dir, ".env"), "GROQ_API_KEY=old-key\n", { mode: 0o600 });
    process.env.GROQ_API_KEY = "old-key";
    const verified = await verify(fm, "groq.api_key", "groq-key");
    fm.providerSecretReloadHooks.set("groq.voice", vi.fn(async () => { throw new Error("hook failed"); }));
    const accepted = fm.startProviderSecretApply({ specId: "groq.api_key", verificationId: verified.verification_id, sessionBinding: "session", idempotencyKey: "groq-key" });
    for (let i = 0; i < 40 && accepted.job.status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(accepted.job.result).toBe("rolled_back");
    expect(process.env.GROQ_API_KEY).toBe("old-key");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("GROQ_API_KEY=old-key\n");
  });

  it("settles a symlink refusal without leaving an applying job", async () => {
    const { fm, dir } = manager();
    const target = join(dir, "target");
    writeFileSync(target, "ORIGINAL\n", { mode: 0o600 });
    symlinkSync(target, join(dir, ".env"));
    const verified = await verify(fm, "openai.api_key", "symlink-key");
    const accepted = fm.startProviderSecretApply({ specId: "openai.api_key", verificationId: verified.verification_id, sessionBinding: "session", idempotencyKey: "symlink-key" });
    for (let i = 0; i < 40 && accepted.job.status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(accepted.job.status).toBe("done");
    expect(accepted.job.result).toBe("rolled_back");
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL\n");
  });

  it("rejects a bot token env collision before verification or writing", async () => {
    const { fm } = manager();
    fm.fleetConfig.channels[0].bot_token_env = "GROQ_API_KEY";
    fm.providerSecretHttpClient = { request: vi.fn() };
    const result = await fm.verifyProviderSecret({ specId: "groq.api_key", secret: "secret", sessionBinding: "session", idempotencyKey: "collision" });
    expect(result).toMatchObject({ ok: false, status: "invalid" });
    expect(fm.providerSecretHttpClient.request).not.toHaveBeenCalled();
  });

  it("fences a challenge to its generation and consumes it once", async () => {
    const { fm } = manager();
    const verified = await verify(fm, "openai.api_key", "generation-key");
    fm.providerSecretGenerations.set("OPENAI_API_KEY", 1);
    expect(fm.startProviderSecretApply({ specId: "openai.api_key", verificationId: verified.verification_id, sessionBinding: "session", idempotencyKey: "generation-key" })).toEqual({ error: expect.stringContaining("does not match") });

    const fresh = await verify(fm, "openai.api_key", "replay-key");
    fm.runProviderSecretApply = vi.fn(async () => {});
    const input = { specId: "openai.api_key", verificationId: fresh.verification_id, sessionBinding: "session", idempotencyKey: "replay-key" };
    const accepted = fm.startProviderSecretApply(input);
    expect(accepted.job.result).toBe("applying");
    fm.providerSecretJobs.clear(); fm.providerSecretJobSession.clear(); fm.providerSecretInFlight.clear();
    expect(fm.startProviderSecretApply(input)).toEqual({ error: expect.stringContaining("expired") });
  });

  it("rejects header injection before any provider request", async () => {
    const { fm } = manager();
    const request = vi.fn();
    fm.providerSecretHttpClient = { request };
    const result = await fm.verifyProviderSecret({ specId: "openai.api_key", secret: "bad\nkey", sessionBinding: "session", idempotencyKey: "header-key" });
    expect(result).toMatchObject({ ok: false, status: "invalid" });
    expect(request).not.toHaveBeenCalled();
  });
});
