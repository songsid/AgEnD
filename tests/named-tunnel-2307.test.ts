import { syntheticTunnelToken } from "./helpers/named-tunnel-token.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflaredProvider, minimalChildEnv, validateQuickTunnelUrl } from "../src/tunnel/cloudflared.js";
import { createPublicWebGateway, isPublicWebRoute } from "../src/public-web-gateway.js";
import { PublicWebLink, namedPublicLinkSettings, validPublicLinkPatch } from "../src/public-web-link.js";
import { PUBLIC_TUNNEL_TOKEN_ENV as ENV, PUBLIC_TUNNEL_SECRET_ID as ID, publicTunnelHostname } from "../src/public-tunnel-config.js";
import { FleetManager } from "../src/fleet-manager.js";
import { isSettingsMutation, prepareSettingsEffect } from "../src/settings-effect.js";
import { SecretStore } from "../src/secret-store.js";
import type { TunnelStartContext } from "../src/tunnel/types.js";

const TOKEN = syntheticTunnelToken();
const roots: string[] = [], managers: FleetManager[] = [];
const previous = process.env[ENV];
function root() { const dir = mkdtempSync(join(tmpdir(), "agend-named2307-")); roots.push(dir); return dir; }
afterEach(() => {
  for (const fm of managers.splice(0)) { fm.memoryPressure.stop(); fm.spawnGate.shutdown(); fm.stormWindow.shutdown(); }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env[ENV]; else process.env[ENV] = previous;
  vi.restoreAllMocks();
});
class Child extends EventEmitter {
  stdout = new Readable({ read() {} }); stderr = new Readable({ read() {} }); pid = 4321;
  kill = vi.fn(() => { this.emit("exit", 0, null); return true; });
}
function context(): TunnelStartContext {
  return { sid: "inert2307", origin: new URL("http://127.0.0.1:19282"), pagePath: "/signin", readinessMarker: "exact2307marker", expiresAt: Date.now() + 60_000, signal: new AbortController().signal };
}
function provider(over: Record<string, unknown> = {}) {
  const bin = join(root(), "cloudflared-stub"); writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  const child = new Child();
  const spawn = vi.fn(() => child);
  const fetch = vi.fn(async () => ({ status: 200, contentType: "text/html", body: "exact2307marker" }));
  const p = new CloudflaredProvider({ binaryName: bin, named: { hostname: "agend.example.com", token: TOKEN }, spawnProcess: spawn as never,
    fetchPage: fetch, probe: () => ({ kind: "gone" }), deadlineMs: 40, graceMs: 1, ...over });
  return { p, child, spawn, fetch };
}

describe("named connector credentials and exact host policy", () => {
  it("normalizes quoted credentials for both configuration and child env, never argv", async () => {
    process.env[ENV] = ` \n'${TOKEN}'\t`;
    expect(namedPublicLinkSettings({ public_link: { hostname: "agend.example.com" } })?.token).toBe(TOKEN);
    const f = provider({ named: { hostname: "agend.example.com", token: ` \n"${TOKEN}"\t` } });
    const handle = await f.p.start(context());
    const call = f.spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(call[2].env.TUNNEL_TOKEN).toBe(TOKEN);
    expect(JSON.stringify(call.slice(0, 2))).not.toContain(TOKEN);
    await handle.stop("end");
  });
  it("rejects a malformed credential before spawning, without echoing decoded fields", async () => {
    const bad = syntheticTunnelToken({ a: "private-account", t: "private-tunnel" });
    const f = provider({ named: { hostname: "agend.example.com", token: bad } });
    const error = await f.p.start(context()).catch(e => e);
    expect(error.errorKind).toBe("bad-url");
    expect(String(error)).not.toContain(bad);
    expect(String(error)).not.toContain("private-account");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("runs with only child env credentials, validates the configured host before probing, and preserves stop ownership", async () => {
    const f = provider({ env: { TUNNEL_TOKEN: "foreign", AWS_SECRET_ACCESS_KEY: "other", HTTPS_PROXY: "http://proxy:3128" } });
    const host = vi.fn(); const ctx = { ...context(), onCandidateHost: host };
    const handle = await f.p.start(ctx);
    const call = f.spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string>; shell: boolean }];
    expect(call[1]).toEqual(["tunnel", "--no-autoupdate", "--config", "/dev/null", "--protocol", "http2", "run"]);
    expect(JSON.stringify(call[1])).not.toContain(TOKEN);
    expect(call[2]).toMatchObject({ shell: false, env: { TUNNEL_TOKEN: TOKEN, HTTPS_PROXY: "http://proxy:3128" } });
    expect(call[2].env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(host).toHaveBeenCalledWith("agend.example.com");
    expect(f.fetch).toHaveBeenCalledWith("https://agend.example.com/signin", expect.any(AbortSignal));
    expect(handle.pageUrl).toBe("https://agend.example.com/signin");
    expect(await handle.stop("end")).toEqual({ confirmed: true });
    expect(minimalChildEnv({ TUNNEL_TOKEN: TOKEN, [ENV]: TOKEN })).toEqual({});
  });
  it("discards vendor stdout/stderr and spawn errors that echo the token", async () => {
    const f = provider({ fetchPage: async () => { f.child.stderr.push(`invalid token ${TOKEN}`); throw Error(TOKEN); } });
    const rejected = await f.p.start(context()).then(() => null, err => err);
    expect(rejected).toMatchObject({ errorKind: "named-auth-failed" }); expect(String(rejected)).not.toContain(TOKEN);
    const error = await provider({ spawnProcess: () => { throw Error(TOKEN); } }).p.start(context()).then(() => null, err => err);
    expect(error).not.toBeNull(); expect(String(error)).not.toContain(TOKEN); expect(String(error)).toContain("could not start named");
  });
  it("requires this exposure's marker and refuses a wrong page", async () => {
    const f = provider({ fetchPage: async () => ({ status: 200, contentType: "text/html", body: "another exposure" }) });
    await expect(f.p.start(context())).rejects.toMatchObject({ errorKind: "named-hostname-mismatch" });
    expect(f.child.kill).toHaveBeenCalled();
  });
  it.each(["foreign.example.com", "agend.example.com.evil.invalid", "*.example.com", "127.0.0.1", "https://agend.example.com:443", "https://agend.example.com/signin"])("does not broaden host trust for %s", value => {
    if (!value.startsWith("https:") && !value.includes("*") && value !== "127.0.0.1") {
      expect(validateQuickTunnelUrl(`https://${value}`, "agend.example.com")).toBeNull();
    } else expect(publicTunnelHostname(value)).toBeNull();
  });
  it("accepts only an exact named root; quick validation remains strict", () => {
    expect(publicTunnelHostname("https://Agend.Example.com/")).toBe("agend.example.com");
    expect(validateQuickTunnelUrl("https://agend.example.com", "agend.example.com")).toBe("https://agend.example.com");
    expect(validateQuickTunnelUrl("https://agend.example.com")).toBeNull();
    expect(validateQuickTunnelUrl("https://a.trycloudflare.com")).toBe("https://a.trycloudflare.com");
    for (const suffix of ["/path", "?q=x", "#x", ":8443"]) expect(validateQuickTunnelUrl(`https://agend.example.com${suffix}`, "agend.example.com")).toBeNull();
  });
  it("gateway binds the named loopback port, accepts only its pinned host and excludes token endpoints", async () => {
    let dispatchRequest: any;
    const server = Object.assign(new EventEmitter(), { listen: vi.fn((_port, _host, ready) => ready()), address: () => ({ port: 19282 }), setTimeout: vi.fn(), close: vi.fn(), closeAllConnections: vi.fn() });
    const dispatch = vi.fn();
    const gateway = createPublicWebGateway({ exposureId: "inert", hostname: "agend.example.com", port: 19282,
      isCurrent: () => true, isOpen: () => true, dispatch, create: ((cb: any) => { dispatchRequest = cb; return server; }) as never });
    await gateway.listen(); expect(server.listen).toHaveBeenCalledWith(19282, "127.0.0.1", expect.any(Function));
    gateway.setHost("agend.example.com");
    expect(() => gateway.setHost("other.example.com")).toThrow();
    const res = () => ({ setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() });
    const denied = res(); dispatchRequest({ url: "/signin", headers: { host: "other.example.com" }, method: "GET" }, denied);
    expect(denied.writeHead).toHaveBeenCalledWith(403);
    dispatchRequest({ url: "/signin", headers: { host: "agend.example.com" }, method: "GET" }, res());
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(isPublicWebRoute("POST", "/api/settings/public-tunnel-token/apply")).toBe(false);
    gateway.close();
  });
  it.runIf(process.platform === "linux")("an actual stub receives env but /proc cmdline contains no token", async () => {
    const bin = join(root(), "cloudflared-stub.cjs");
    const receipt = join(root(), "child-receipt.json");
    writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({token:process.env.TUNNEL_TOKEN,args:process.argv}),{mode:0o600});process.stdout.write(process.env.TUNNEL_TOKEN||'');setInterval(()=>{},1000);`, { mode: 0o755 });
    const p = new CloudflaredProvider({ binaryName: bin, named: { hostname: "agend.example.com", token: TOKEN },
      fetchPage: async () => ({ status: 200, contentType: "text/html", body: "exact2307marker" }), graceMs: 100 });
    const handle = await p.start(context());
    try {
      let observed: any;
      for (let i = 0; i < 100; i++) {
        try { observed = JSON.parse(readFileSync(receipt, "utf8")); break; } catch { await new Promise(r => setTimeout(r, 5)); }
      }
      expect(observed?.token).toBe(TOKEN);
      expect(observed.args.length).toBeGreaterThan(2);
      expect(observed.args).not.toContain("--token");
      expect(handle.pid).toBeTypeOf("number");
      const cmdline = readFileSync(`/proc/${handle.pid}/cmdline`, "utf8");
      expect(cmdline).toContain("cloudflared-stub.cjs"); expect(cmdline).not.toContain(TOKEN);
    }
    finally { expect(await handle.stop("end")).toEqual({ confirmed: true }); }
  });
});

describe("write-only connector secret transaction", () => {
  function manager() {
    const dir = root(), fm: any = new FleetManager(dir); managers.push(fm);
    fm.fleetConfig = { defaults: {}, instances: {}, channels: [{ id: "discord", bot_token_env: "DISCORD_TOKEN" }] };
    fm.publicWebLink = { close: vi.fn(async () => ({ confirmed: true })) };
    fm.providerSecretHttpClient = { request: vi.fn(() => { throw Error("unexpected network"); }) };
    return { fm, dir };
  }
  async function apply(fm: any, clear = false, key = "tunnel-key", secret = TOKEN) {
    const verification = await fm.verifyProviderSecret({ specId: ID, secret: clear ? "" : secret, clear, sessionBinding: "session", idempotencyKey: key });
    expect(verification.ok).toBe(true); expect(JSON.stringify(verification)).not.toContain(TOKEN);
    const accepted = fm.startProviderSecretApply({ specId: ID, verificationId: verification.verification_id, sessionBinding: "session", idempotencyKey: key });
    expect(accepted.job).toBeDefined();
    for (let i = 0; i < 100 && accepted.job.status === "running"; i++) await new Promise(r => setTimeout(r, 5));
    expect(accepted.job.result).toBe("reloaded"); expect(JSON.stringify(accepted.job)).not.toContain(TOKEN);
    return accepted;
  }
  it("sets and clears only its allowlisted .env entry at 0600, never calls Cloudflare, and closes current exposure", async () => {
    const { fm, dir } = manager();
    writeFileSync(join(dir, ".env"), "UNRELATED=retained\n", { mode: 0o644 });
    await apply(fm);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(`${ENV}=${TOKEN}`);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(process.env[ENV]).toBe(TOKEN);
    await apply(fm, true, "clear-key");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`UNRELATED=retained\n${ENV}=\n`);
    expect(process.env[ENV]).toBeUndefined();
    // The real startup reader must override a stale value inherited from the service.
    process.env[ENV] = TOKEN;
    fm.loadEnvFile();
    expect(process.env[ENV]).toBe("");
    expect(fm.listProviderSecrets().find((s: any) => s.id === ID)?.token_present).toBe(false);
    expect(fm.publicWebLink.close).toHaveBeenCalledTimes(2);
    expect(fm.providerSecretHttpClient.request).not.toHaveBeenCalled();
  });
  it("stores only the normalized token after verification and confirmed apply", async () => {
    const { fm, dir } = manager();
    await apply(fm, false, "normalized-key", ` \n'${TOKEN}'\t`);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`${ENV}=${TOKEN}\n`);
    expect(process.env[ENV]).toBe(TOKEN);
    expect(fm.providerSecretHttpClient.request).not.toHaveBeenCalled();
  });
  it("refuses malformed tokens with only a fixed hint, no challenge, log, disk write or network", async () => {
    const { fm, dir } = manager();
    const warn = vi.spyOn(fm.logger, "warn"), error = vi.spyOn(fm.logger, "error");
    const bad = syntheticTunnelToken({ a: "private-account", s: "private-secret" });
    for (const secret of [bad, `cloudflared.exe service install ${TOKEN}`, `--token ${TOKEN}`, "eyJ", "x".repeat(4097)]) {
      const result = await fm.verifyProviderSecret({ specId: ID, secret, sessionBinding: "session", idempotencyKey: "malformed-key" });
      expect(result).toEqual({ ok: false, status: "invalid", error: "Paste only the long string that starts with eyJ." });
      if (secret.length > 4) expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(fm.providerSecretChallenges.size).toBe(0);
    expect(fm.providerSecretHttpClient.request).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    expect(() => readFileSync(join(dir, ".env"))).toThrow();
  });
  it("rolls back disk and process on activation failure without logging either token", async () => {
    const { fm, dir } = manager();
    const old = "eyJPreviousConnectorPrivateValue2307";
    process.env[ENV] = old;
    writeFileSync(join(dir, ".env"), `${ENV}=${old}\n`, { mode: 0o600 });
    fm.publicWebLink.close.mockRejectedValue(new Error(`${TOKEN} ${old}`));
    const warn = vi.spyOn(fm.logger, "warn");
    const verified = await fm.verifyProviderSecret({ specId: ID, secret: TOKEN, sessionBinding: "session", idempotencyKey: "rollback-key" });
    expect(verified.ok).toBe(true);
    const accepted = fm.startProviderSecretApply({ specId: ID, verificationId: verified.verification_id, sessionBinding: "session", idempotencyKey: "rollback-key" });
    for (let i = 0; i < 100 && accepted.job.status === "running"; i++) await new Promise(r => setTimeout(r, 5));
    expect(accepted.job.result).toBe("rolled_back");
    expect(process.env[ENV]).toBe(old);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`${ENV}=${old}\n`);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(old);
  });
  it("rejects bot env collisions, ambiguous clear and embedded newline tokens before storing", async () => {
    const { fm } = manager();
    for (const input of [{ secret: TOKEN.slice(0, 20) + "\n" + TOKEN.slice(20) }, { clear: true, secret: TOKEN }]) {
      expect(await fm.verifyProviderSecret({ specId: ID, sessionBinding: "session", idempotencyKey: "test-key", ...input })).toMatchObject({ ok: false });
    }
    fm.fleetConfig.channels[0].bot_token_env = ENV;
    expect(await fm.verifyProviderSecret({ specId: ID, secret: TOKEN, sessionBinding: "session", idempotencyKey: "collision" })).toMatchObject({ ok: false });
  });
  it("secret clearing removes duplicate/export assignments without touching other entries", () => {
    const path = join(root(), ".env"); writeFileSync(path, `# note\n${ENV}=old\nexport ${ENV}=second\nOTHER=keep\n`);
    new SecretStore(path, new Set([ENV])).clear(ENV);
    expect(readFileSync(path, "utf8")).toBe(`# note\nOTHER=keep\n${ENV}=\n`);
  });
  it("set/clear uses the normal confirmation gate and only fingerprints appear in its summary", () => {
    const path = "/api/settings/public-tunnel-token/apply";
    expect(isSettingsMutation("POST", path)).toBe(true);
    const effect = prepareSettingsEffect("POST", path, { verification_id: "opaque" }, { config: {} as any, classic: {},
      proof: (kind, id) => { expect(kind).toBe("provider"); expect(id).toBe(ID); return { key: ENV, secret: TOKEN, previous: "old", remainingMs: 1000, discard() {} }; } });
    expect(JSON.stringify(effect.diff)).toContain("fingerprint");
    expect(JSON.stringify(effect.diff)).not.toContain(TOKEN);
    expect(() => prepareSettingsEffect("POST", path, { verification_id: "missing" }, { config: {} as any, classic: {} })).toThrow();
  });
  it("allows only the fixed secret reference, never inline token config; incomplete named config fails closed", () => {
    expect(validPublicLinkPatch({ hostname: "agend.example.com", tunnel_token_env: ENV, origin_port: 19282 })).toBe(true);
    for (const config of [{ tunnel_token: TOKEN }, { tunnel_token_env: "DISCORD_TOKEN" }, { origin_port: 80 }, { hostname: "*.example.com" }]) expect(validPublicLinkPatch(config)).toBe(false);
    delete process.env[ENV]; expect(() => namedPublicLinkSettings({ public_link: { hostname: "agend.example.com" } })).toThrow(/incomplete/);
    expect(namedPublicLinkSettings(undefined)).toBeUndefined();
  });
});

describe("public link exposure with named settings", () => {
  function rig() {
    process.env[ENV] = TOKEN;
    let web: any = { public_link: { hostname: "agend.example.com", tunnel_token_env: ENV, origin_port: 19282 } };
    const gateway = { listen: vi.fn(async () => new URL("http://127.0.0.1:19282")), setHost: vi.fn(), close: vi.fn(), readinessMarker: "marker", server: {} };
    const createGateway = vi.fn(() => gateway);
    const handle = { pageUrl: "https://agend.example.com/signin", onUnexpectedExit: () => () => {} };
    const reservation = { start: vi.fn(async () => ({ ok: true, handle })), stop: vi.fn(async () => ({ confirmed: true })) };
    const log = vi.fn(), revoke = vi.fn(), factory = vi.fn(() => ({}) as any);
    const link = new PublicWebLink({ dataDir: root(), web: () => web, permitted: () => true, reserve: () => reservation as any,
      createGateway: createGateway as any, provider: factory, ensure: async () => ({ path: "/inert", source: "agend" }), log, revoke });
    return { link, gateway, createGateway, reservation, factory, log, revoke, settings: (v: any) => { web = v; } };
  }
  const owner = { adapterId: "discord", userId: "admin", chatId: "admin", binding: {} };
  it("passes only host/port to the gateway, only token/host to the provider, and revokes on config/secret change", async () => {
    const f = rig(); let delivered: any;
    expect(await f.link.deliver(owner, async value => { delivered = value; return true; })).toBe(true);
    expect(f.createGateway.mock.calls[0]).toHaveLength(5);
    const gatewayArgs = f.createGateway.mock.calls[0] as unknown as any[];
    expect(gatewayArgs[4]).toEqual({ hostname: "agend.example.com", port: 19282 });
    expect(f.factory).toHaveBeenCalledWith("/inert", "http2", expect.objectContaining({ hostname: "agend.example.com", token: TOKEN }));
    expect(delivered.url).toBe("https://agend.example.com/signin");
    expect(delivered.isCurrent()).toBe(true);
    process.env[ENV] = "eyJReplacementConnectorSecret2307Value";
    expect(delivered.isCurrent()).toBe(false);
    f.link.refresh(); expect(f.revoke).toHaveBeenCalled();
    await f.link.close("end");
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(TOKEN);
  });
  it("never logs a token even when a provider failure object echoes it", async () => {
    const f = rig(); f.reservation.start.mockResolvedValue({ ok: false, errorKind: "spawn-failed", message: TOKEN } as any);
    expect(await f.link.deliver(owner, async () => true)).toBe(false);
    expect(f.gateway.close).toHaveBeenCalled();
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(TOKEN);
    await f.link.close("end");
  });
  it("fails before install/listen/spawn when named configuration is incomplete; never falls back to quick", async () => {
    const f = rig(); delete process.env[ENV];
    expect(await f.link.deliver(owner, async () => true)).toBe(false);
    expect(f.createGateway).not.toHaveBeenCalled(); expect(f.reservation.start).not.toHaveBeenCalled();
    await f.link.close("end");
  });
});
