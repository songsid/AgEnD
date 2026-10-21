import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflaredProvider } from "../src/tunnel/cloudflared.js";
import { classifyNamedTunnelOutput, NAMED_TUNNEL_FAILURE_MESSAGES } from "../src/tunnel/named-diagnostics.js";
import { PublicWebLink } from "../src/public-web-link.js";
import { failureOf, renderPublicLinkProgress, type PublicLinkProgress } from "../src/public-link-progress.js";
import { PUBLIC_TUNNEL_TOKEN_ENV } from "../src/public-tunnel-config.js";
import { getLocale, setLocale } from "../src/locale.js";
import type { TunnelProvider, TunnelStartContext } from "../src/tunnel/types.js";

const TOKEN = "eyJ2344NamedConnectorSecretDoNotExpose";
const OTHER = "sk-other2344SecretDoNotExposeEver";
const PRIVATE = "PRIVATE_VENDOR_DETAIL_2344";
const roots: string[] = [];
const locale = getLocale();
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setLocale(locale); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const r = mkdtempSync(join(tmpdir(), "agend-2344-diag-")); roots.push(r); return r; };
class Child extends EventEmitter {
  stdout = new Readable({ read() {} }); stderr = new Readable({ read() {} }); pid = 2344001;
  kill = vi.fn(() => { this.emit("exit", 0, null); this.emit("close"); return true; });
}
function fixture(log: string, response = { status: 503, contentType: "text/html", body: "not ready" }, lateExit = false) {
  const binary = join(tmp(), "inert-cloudflared"); writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
  const child = new Child();
  const spawn = vi.fn(() => child);
  const output = `${log}\n${PRIVATE} ${TOKEN} ${OTHER} Bearer ${OTHER}`;
  const p = new CloudflaredProvider({ binaryName: binary, named: { hostname: "agend.example.com", token: TOKEN }, spawnProcess: spawn as never,
    probe: () => ({ kind: "gone" }), deadlineMs: 5, graceMs: 1,
    fetchPage: async () => {
      if (lateExit) {
        child.emit("exit", 1, null);
        setTimeout(() => { child.stderr.emit("data", Buffer.from(output)); child.emit("close"); }, 510);
      } else {
        child.stdout.emit("data", Buffer.from(output.slice(0, 15)));
        child.stderr.emit("data", Buffer.from(output.slice(15)));
      }
      return response;
    } });
  const ctx: TunnelStartContext = { sid: "inert2344", origin: new URL("http://127.0.0.1:19282"), pagePath: "/signin", readinessMarker: "marker2344", expiresAt: Date.now() + 60_000, signal: new AbortController().signal };
  return { p, child, spawn, ctx };
}
const cases = [
  ["Provided Tunnel token is not valid (unexpected end of JSON input)", 503, "named-auth-failed"],
  ["Unauthorized tunnel credentials", 503, "named-auth-failed"],
  ['{"level":"error","message":"Provided Tunnel token is not valid."}', 503, "named-auth-failed"],
  ["No ingress rules were defined", 503, "named-route-missing"],
  ["", 404, "named-route-missing"],
  ["", 200, "named-hostname-mismatch"],
  ["Unable to reach the origin service", 502, "named-origin-unreachable"],
  ["Failed to dial a quic connection: i/o timeout", 503, "named-connection-failed"],
] as const;

async function startFailure(f: ReturnType<typeof fixture>) {
  const result = f.p.start(f.ctx).then(() => null, error => error);
  await vi.runAllTimersAsync();
  return result;
}

describe("named tunnel closed failure classifications", () => {
  it.each(cases)("classifies %s / HTTP %i as %s without releasing child output", async (line, status, expected) => {
    vi.useFakeTimers();
    const f = fixture(line, { status, contentType: "text/html", body: `wrong page ${TOKEN} ${OTHER}` });
    const error = await startFailure(f);
    expect(error).not.toBeNull();
    expect(error.errorKind).toBe(expected);
    expect(error.message).toBe(NAMED_TUNNEL_FAILURE_MESSAGES[expected]);
    expect(f.child.kill).toHaveBeenCalled();
    const publicValues = JSON.stringify({ error, message: String(error), argv: f.spawn.mock.calls.map(c => (c as unknown[])[1]) });
    for (const value of [TOKEN, OTHER, PRIVATE]) expect(publicValues).not.toContain(value);
  });
  it("still succeeds only on this exposure's marker even if prior diagnostic output contains errors", async () => {
    const f = fixture("Unauthorized tunnel credentials", { status: 200, contentType: "text/html", body: "marker2344" });
    const handle = await f.p.start(f.ctx);
    expect(handle.pageUrl).toBe("https://agend.example.com/signin");
    expect(await handle.stop("end")).toEqual({ confirmed: true });
  });
  it("absorbs trailing error output after the exit event without treating it as a timeout", async () => {
    vi.useFakeTimers();
    const f = fixture("Provided Tunnel token is not valid", undefined, true);
    const error = await startFailure(f);
    expect(error.errorKind).toBe("named-auth-failed");
    expect(String(error)).not.toContain(TOKEN);
  });
  it("keeps unknown errors generic instead of returning a sanitized last line", async () => {
    vi.useFakeTimers();
    const f = fixture(`unrecognized ${PRIVATE}`);
    const error = await startFailure(f);
    expect(error.errorKind).toBe("readiness-failed");
    expect(error.message).toMatch(/^named tunnel failed;/);
    for (const value of [TOKEN, OTHER, PRIVATE]) expect(String(error)).not.toContain(value);
  });
  it("never treats a redacted credential's contents as evidence", () => {
    expect(classifyNamedTunnelOutput(TOKEN, TOKEN)).toBeUndefined();
    for (let i = 0; i < 40; i++) {
      const value = `eyJ${"x".repeat(i + 24)}.${"y".repeat(20)}.${"z".repeat(30)}`;
      const reason = classifyNamedTunnelOutput(`Unauthorized tunnel credentials ${value} ${TOKEN}`, TOKEN);
      expect(reason).toBe("named-auth-failed");
      expect(Object.hasOwn(NAMED_TUNNEL_FAILURE_MESSAGES, reason!)).toBe(true);
    }
  });
});

function publicLink(provider: TunnelProvider, portConflict = false) {
  vi.stubEnv(PUBLIC_TUNNEL_TOKEN_ENV, TOKEN);
  const progress: PublicLinkProgress[] = [], log = vi.fn(), send = vi.fn(async () => true);
  const gateway = { listen: vi.fn(async () => { if (portConflict) throw Object.assign(Error(TOKEN), { code: "EADDRINUSE" }); return new URL("http://127.0.0.1:19282"); }), setHost: vi.fn(), close: vi.fn(), readinessMarker: "marker2344", server: {} };
  const reservation = { start: async (p: TunnelProvider, ctx: TunnelStartContext) => {
    try { return { ok: true, handle: await p.start(ctx) }; } catch (e) { const error = e as { errorKind: string; message: string }; return { ok: false, errorKind: error.errorKind, message: error.message }; }
  }, stop: async () => ({ confirmed: true as const }) };
  const link = new PublicWebLink({ dataDir: tmp(), web: () => ({ public_link: { hostname: "agend.example.com", tunnel_token_env: PUBLIC_TUNNEL_TOKEN_ENV } }), permitted: () => true,
    reserve: () => reservation as never, createGateway: (() => gateway) as never, revoke: vi.fn(), provider: (() => provider) as never,
    ensure: async () => ({ path: "/inert", source: "agend" }), log });
  const owner = { adapterId: "discord", userId: "admin", chatId: "admin", binding: {} };
  return { link, log, send, progress, run: () => link.deliver(owner, send, p => progress.push(p)) };
}

describe("public link log/chat/API progress receives only static reasons", () => {
  it.each(cases)("surfaces %s as %s through the existing progress protocol", async (line, status, expected) => {
    vi.useFakeTimers();
    const f = fixture(line, { status, contentType: "text/html", body: "wrong page" });
    const link = publicLink(f.p);
    const result = link.run();
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
    expect(link.send).not.toHaveBeenCalled();
    const last = link.progress.at(-1)!;
    expect(last.failed?.reason).toBe(expected);
    expect(failureOf(expected)).toBe(expected);
    for (const language of ["en", "zh-TW"] as const) {
      setLocale(language);
      const rendered = renderPublicLinkProgress(last, 0);
      expect(rendered).not.toContain("dashboard.progress.fail.");
      expect(rendered).not.toContain("cloudflared stopped before");
      const exposed = JSON.stringify({ api: last, chat: rendered, logs: link.log.mock.calls });
      for (const value of [TOKEN, OTHER, PRIVATE]) expect(exposed).not.toContain(value);
    }
    expect(link.log).toHaveBeenCalledWith(`startup failed: ${expected}`, expect.any(String), NAMED_TUNNEL_FAILURE_MESSAGES[expected]);
    await link.link.close("end");
  });
  it("reports a local fixed origin-port conflict before starting cloudflared", async () => {
    const start = vi.fn();
    const link = publicLink({ name: "inert", preflight: vi.fn(), start } as never, true);
    expect(await link.run()).toBe(false);
    expect(link.progress.at(-1)!.failed?.reason).toBe("origin-port-in-use");
    expect(start).not.toHaveBeenCalled();
    expect(JSON.stringify(link.log.mock.calls)).not.toContain(TOKEN);
    await link.link.close("end");
  });
});
