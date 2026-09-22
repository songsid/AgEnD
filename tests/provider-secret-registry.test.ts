import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import {
  PROVIDER_SECRET_SPECS,
  createProviderHttpClientForTests,
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

  it("walks the real TLS transport for every registered provider and handles lookup all=true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-provider-tls-")); dirs.push(dir);
    const keyPath = join(dir, "server.key");
    const certPath = join(dir, "server.crt");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=api.openai.com",
      "-addext", "subjectAltName=DNS:api.openai.com,DNS:api.groq.com,DNS:api.anthropic.com",
    ], { stdio: "ignore" });
    const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const allFlags: boolean[] = [];
      const agentOptions: unknown[] = [];
      let dnsCalls = 0;
      const port = (server.address() as { port: number }).port;
      const client = createProviderHttpClientForTests({
        ca: readFileSync(certPath),
        allowPrivateAddress: true,
        dnsLookup: async () => { dnsCalls++; return { address: "127.0.0.1", family: 4 }; },
        onConnectLookup: options => allFlags.push(options.all === true),
        onRequest: options => agentOptions.push(options.agent),
      });
      for (const spec of PROVIDER_SECRET_SPECS) {
        const host = new URL(spec.verifier!.origin).hostname;
        const testSpec = {
          ...spec,
          allowedHosts: [`https://${host}:${port}`],
          verifier: { ...spec.verifier!, origin: `https://${host}:${port}` },
        } as ProviderSecretSpec;
        const result = await verifyProviderSecret(testSpec, "sk-test-secret", client);
        expect(result).toMatchObject({ ok: false, status: "provider_rejected" });
      }
      expect(allFlags).toContain(true);
      expect(dnsCalls).toBe(PROVIDER_SECRET_SPECS.length);
      expect(agentOptions.every(agent => agent === false)).toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("rejects header injection and disabled TLS before DNS or request", async () => {
    let dnsCalls = 0;
    let requests = 0;
    const client = createProviderHttpClientForTests({
      ca: "unused",
      dnsLookup: async () => { dnsCalls++; return { address: "127.0.0.1", family: 4 }; },
      allowPrivateAddress: true,
      onRequest: () => { requests++; },
    });
    expect((await verifyProviderSecret(PROVIDER_SECRET_SPECS[0], "bad\r\nkey", client)).status).toBe("provider_unavailable");
    expect(dnsCalls).toBe(0);
    expect(requests).toBe(0);

    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      expect((await verifyProviderSecret(PROVIDER_SECRET_SPECS[0], "sk-test-secret", client)).status).toBe("provider_unavailable");
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
    expect(dnsCalls).toBe(0);
    expect(requests).toBe(0);
  });

  it("cuts a streaming response at the registry body limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-provider-body-")); dirs.push(dir);
    const keyPath = join(dir, "server.key");
    const certPath = join(dir, "server.crt");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=api.openai.com", "-addext", "subjectAltName=DNS:api.openai.com",
    ], { stdio: "ignore" });
    const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }) + " ".repeat(128));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      const spec = {
        ...PROVIDER_SECRET_SPECS[1]!,
        allowedHosts: [`https://api.openai.com:${port}`],
        verifier: { ...PROVIDER_SECRET_SPECS[1]!.verifier!, origin: `https://api.openai.com:${port}`, maxResponseBytes: 32 },
      } as ProviderSecretSpec;
      const client = createProviderHttpClientForTests({
        ca: readFileSync(certPath),
        allowPrivateAddress: true,
        dnsLookup: async () => ({ address: "127.0.0.1", family: 4 }),
      });
      expect(await verifyProviderSecret(spec, "sk-test-secret", client)).toMatchObject({ ok: false, status: "provider_unavailable" });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("blocks hex IPv4-mapped private DNS answers before opening a socket", async () => {
    let requests = 0;
    const client = createProviderHttpClientForTests({
      ca: "unused",
      dnsLookup: async () => ({ address: "::ffff:7f00:1", family: 6 }),
      onRequest: () => { requests++; },
    });
    const result = await verifyProviderSecret(PROVIDER_SECRET_SPECS[0], "sk-test-secret", client);
    expect(result).toMatchObject({ ok: false, status: "provider_unavailable" });
    expect(requests).toBe(0);
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

  it("rejects provider env collisions while loading fleet config", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-provider-config-")); dirs.push(dir);
    const configPath = join(dir, "fleet.yaml");
    writeFileSync(configPath, [
      "channels:",
      "  - id: discord",
      "    type: discord",
      "    bot_token_env: GROQ_API_KEY",
      "    group_id: '1'",
      "defaults: {}",
      "instances: {}",
      "web:",
      "  provider_secrets: true",
      "",
    ].join("\n"));
    expect(() => new FleetManager(dir).loadConfig(configPath)).toThrow(/conflicts with a protected provider secret key/);
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
