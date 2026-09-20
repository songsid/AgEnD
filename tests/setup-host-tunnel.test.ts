import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePort, SetupHost } from "../src/setup-host.js";
import { leasePath, readLease } from "../src/tunnel/lease.js";
import { TunnelStartError, type TunnelHandle, type TunnelProvider, type TunnelStartContext, type TunnelStopResult } from "../src/tunnel/types.js";

const dirs: string[] = [];
const hosts: SetupHost[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-setup-tunnel-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown(false, "test cleanup").catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface Res { status: number; headers: IncomingHttpHeaders; body: string }

function call(port: number, method: string, path: string, opts: { headers?: Record<string, string>; json?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.json === undefined ? null : JSON.stringify(opts.json);
    const headers: Record<string, string> = { ...opts.headers };
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

const EXTERNAL_HOST = "calm-river-77.trycloudflare.com";

/**
 * A tunnel that does whatever the test needs, including the things a real one
 * does badly: refuse to die, die on its own, never start.
 */
function fakeProvider(opts: {
  stop?: () => Promise<TunnelStopResult>;
  fail?: TunnelStartError;
  onExit?: (fire: () => void) => void;
} = {}): TunnelProvider & { started: TunnelStartContext[]; stops: number } {
  const started: TunnelStartContext[] = [];
  let stops = 0;
  const provider = {
    name: "fake",
    started,
    get stops() { return stops; },
    preflight: async () => ({ ok: true as const, binaryPath: "/bin/true" }),
    async start(ctx: TunnelStartContext): Promise<TunnelHandle> {
      started.push(ctx);
      if (opts.fail) throw opts.fail;
      let exitListener: (() => void) | null = null;
      opts.onExit?.(() => exitListener?.());
      return {
        provider: "fake", visibility: "public" as const,
        baseUrl: `https://${EXTERNAL_HOST}`,
        pageUrl: `https://${EXTERNAL_HOST}${ctx.pagePath}`,
        pid: 4242, identity: "linux:111",
        stop: async () => { stops += 1; return opts.stop ? opts.stop() : { confirmed: true as const }; },
        onUnexpectedExit: listener => { exitListener = () => listener({ code: 1, signal: null }); return () => { exitListener = null; }; },
      };
    },
  };
  return provider as never;
}

async function startHost(over: Partial<ConstructorParameters<typeof SetupHost>[0]> = {}) {
  const dir = over.dataDir ?? tempDir();
  const spawnFleet = vi.fn();
  const logs: string[] = [];
  const host = new SetupHost({
    dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0,
    spawnFleet, log: m => logs.push(m), ...over,
  });
  hosts.push(host);
  const started = await host.start();
  return { host, dir, spawnFleet, logs, ...started };
}

async function signIn(port: number, path: string, code: string): Promise<string> {
  const res = await call(port, "POST", `${path}open`, { json: { code } });
  expect(res.status, res.body).toBe(200);
  return String(res.headers["set-cookie"]).split(";")[0]!;
}

// ── The port is the whole structural defence ────────────────────────────────

describe("a tunnelled setup page never sits on the port the fleet will take", () => {
  it("ignores the health port and the default, not just --port", async () => {
    // The dangerous case needs no flag at all: an installation with a
    // health_port in fleet.yaml, a user who passes nothing, and `--tunnel`.
    expect(resolvePort({ tunnel: true, healthPort: 19280 })).toBe(0);
    expect(resolvePort({ tunnel: true, port: 8080, healthPort: 19280 })).toBe(0);
    expect(resolvePort({ tunnel: true })).toBe(0);

    // Without a tunnel the old precedence is untouched.
    expect(resolvePort({ port: 8080, healthPort: 19280 })).toBe(8080);
    expect(resolvePort({ healthPort: 19280 })).toBe(19280);
    expect(resolvePort({})).toBe(19280);
  });

  it("binds an ephemeral port even when told to use a fixed one", async () => {
    // Belt as well as braces: `resolvePort` is what the CLI calls, and this is
    // what the host does regardless of what it was handed.
    const { port } = await startHost({ tunnel: true, port: 19280, tunnelProvider: fakeProvider() });

    expect(port).not.toBe(19280);
    expect(port).toBeGreaterThan(0);
  });

  it("refuses --tunnel together with --port in the CLI", () => {
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

    expect(cli).toContain("--tunnel and --port cannot be combined");
    // And the port it passes must come from resolvePort, not from the old
    // `opts.port ?? fleet.health_port ?? 19280` chain.
    expect(cli).toContain("resolvePort({");
    expect(cli).not.toContain("Number(opts.port ?? fleet.health_port ?? 19280)");
  });
});

// ── What the tunnel is given, and what it hands back ────────────────────────

describe("opening the door", () => {
  it("exposes exactly the loopback origin it bound, and the page path", async () => {
    const provider = fakeProvider();
    const { port, path, publicUrl } = await startHost({ tunnel: true, tunnelProvider: provider });

    const ctx = provider.started[0]!;
    expect(ctx.origin.href).toBe(`http://127.0.0.1:${port}/`);
    expect(ctx.pagePath).toBe(path);
    // Readiness has to prove the edge reaches THIS listener, so the marker is
    // something only this page serves.
    expect(ctx.readinessMarker).toContain(path.split("/")[2]);
    expect(publicUrl).toBe(`https://${EXTERNAL_HOST}${path}`);
  });

  it("serves the marker the readiness probe looks for", async () => {
    const provider = fakeProvider();
    const { port, path } = await startHost({ tunnel: true, tunnelProvider: provider });

    const page = await call(port, "GET", path);

    expect(page.body).toContain(provider.started[0]!.readinessMarker);
    expect(page.body).not.toContain("__AGEND_SETUP_MARKER__");
  });

  it("answers the tunnel's host, and only that one", async () => {
    const { port, path, code } = await startHost({ tunnel: true, tunnelProvider: fakeProvider() });
    const cookie = await signIn(port, path, code);

    const ours = await call(port, "GET", `${path}setup/status`, {
      headers: { cookie, host: EXTERNAL_HOST, origin: `https://${EXTERNAL_HOST}` },
    });
    const zombie = await call(port, "GET", `${path}setup/status`, {
      headers: { cookie, host: "some-other-tunnel.trycloudflare.com", origin: "https://some-other-tunnel.trycloudflare.com" },
    });

    expect(ours.status).toBe(200);
    // An ephemeral port can be handed to a later listener; a tunnel nobody
    // cleaned up would then be pointed at it. Its host is not on this list.
    expect(zombie.status).toBe(403);
  });

  it("marks the cookie Secure once it is served over a tunnel", async () => {
    const plain = await startHost({ tunnelProvider: fakeProvider() });
    const tunnelled = await startHost({ tunnel: true, tunnelProvider: fakeProvider() });

    const withoutTunnel = await call(plain.port, "POST", `${plain.path}open`, { json: { code: plain.code } });
    const withTunnel = await call(tunnelled.port, "POST", `${tunnelled.path}open`, { json: { code: tunnelled.code } });

    expect(String(withoutTunnel.headers["set-cookie"])).not.toContain("Secure");
    expect(String(withTunnel.headers["set-cookie"])).toContain("Secure");
  });

  it("falls back to loopback when the tunnel could not start cleanly", async () => {
    const { publicUrl, port, logs } = await startHost({
      tunnel: true,
      tunnelProvider: fakeProvider({ fail: new TunnelStartError("binary-missing", "cloudflared is not installed") }),
    });

    expect(publicUrl).toBeNull();
    // Still up, still on an ephemeral port, and honest that a phone cannot
    // reach it.
    expect((await call(port, "GET", "/nope")).status).toBe(404);
    expect(logs.join(" ")).toContain("phone will not be able to open it");
  });

  it("refuses to carry on when a failed start left a process it cannot account for", async () => {
    // There is no honest "falling back to localhost" here: something we cannot
    // see may still be exposing this listener.
    const dir = tempDir();
    const failed = new TunnelStartError("timeout", "no url", { pid: 4242, identity: "linux:111" });

    await expect(startHost({
      dataDir: dir, tunnel: true, tunnelProvider: fakeProvider({ fail: failed }),
    })).rejects.toThrow(/could not confirm it was cleaned up/);
    expect(existsSync(leasePath(dir))).toBe(true);
  });

  it("closes the page when the tunnel dies under it", async () => {
    let fireExit: (() => void) | null = null;
    const { port, logs } = await startHost({
      tunnel: true,
      tunnelProvider: fakeProvider({ onExit: fire => { fireExit = fire; } }),
    });

    fireExit!();
    await vi.waitFor(async () => {
      await expect(call(port, "GET", "/")).rejects.toThrow();
    }, { timeout: 4_000 });
    expect(logs.join(" ")).toContain("tunnel closed unexpectedly");
  }, 10_000);
});

// ── The handover, in the only order that is safe ────────────────────────────

describe("finishing: revoke, close, prove, then hand over", () => {
  it("does each step in order, and the fleet last", async () => {
    const order: string[] = [];
    const dir = tempDir();
    const provider = fakeProvider({
      stop: async () => { order.push("tunnel stopped"); return { confirmed: true }; },
    });
    const { host, port, path, code, spawnFleet } = await startHost({
      dataDir: dir, tunnel: true, tunnelProvider: provider,
    });
    // The host holds this exact mock, so giving it a body now still records
    // the real call — overriding it through the options would hand the host a
    // different function from the one asserted on.
    spawnFleet.mockImplementation(() => { order.push("fleet spawned"); });
    const cookie = await signIn(port, path, code);

    await host.shutdown(true, "finished");

    // The listener is gone before the tunnel is asked to stop, so the public
    // URL reaches nothing even while the tunnel is still up.
    await expect(call(port, "GET", path, { headers: { cookie } })).rejects.toThrow();
    expect(order).toEqual(["tunnel stopped", "fleet spawned"]);
    expect(spawnFleet).toHaveBeenCalledTimes(1);
    expect(existsSync(leasePath(dir))).toBe(false);
  });

  it("revokes the credentials before anything else, so a request in flight is too late", async () => {
    const source = readFileSync(new URL("../src/setup-host.ts", import.meta.url), "utf8");
    const shutdown = source.slice(source.indexOf("async shutdown("));
    const revokeAt = shutdown.indexOf("this.credentials.revoke()");
    const closeAt = shutdown.indexOf("closeAllConnections");
    const stopAt = shutdown.indexOf("this.managedTunnel.stop(");
    const spawnAt = shutdown.indexOf("spawnFleet ??");

    expect(revokeAt).toBeGreaterThan(-1);
    expect(closeAt, "listener closed before the credentials were revoked").toBeGreaterThan(revokeAt);
    expect(stopAt, "tunnel stopped before the listener was closed").toBeGreaterThan(closeAt);
    expect(spawnAt, "fleet spawned before the tunnel was stopped").toBeGreaterThan(stopAt);
  });

  it("keeps the fleet un-started when the config was never committed", async () => {
    const { host, dir, spawnFleet } = await startHost({ tunnel: true, tunnelProvider: fakeProvider() });

    await host.shutdown(false, "ttl");

    expect(spawnFleet).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "setup-complete"))).toBe(false);
  });
});

// ── T2: what happens when the tunnel will not confirm it is dead ────────────

describe("an unconfirmed tunnel death", () => {
  const unconfirmed = async (): Promise<TunnelStopResult> => ({
    confirmed: false, reason: "did not exit after SIGTERM and SIGKILL", pid: 4242, identity: "linux:111",
  });

  async function finishWithUnconfirmedStop(over: Partial<ConstructorParameters<typeof SetupHost>[0]> = {}) {
    const dir = (over.dataDir as string | undefined) ?? tempDir();
    const started = await startHost({
      dataDir: dir, tunnel: true, port: 0,
      tunnelProvider: fakeProvider({ stop: unconfirmed }), ...over,
    });
    await started.host.shutdown(true, "finished");
    return started;
  }

  it("starts the fleet anyway — but only with all five conditions met", async () => {
    const { spawnFleet, logs, dir } = await finishWithUnconfirmedStop();

    // 1. ephemeral port: the leftover tunnel points at a port nothing will
    //    deliberately bind again, which is the whole basis of this ruling.
    // 2. listener confirmed closed; 3. credentials revoked — both asserted by
    //    the ordering test above and by the page being unreachable.
    expect(spawnFleet).toHaveBeenCalledTimes(1);
    // 4. the lease is kept, so nothing opens another tunnel before the fleet is up.
    expect(existsSync(leasePath(dir))).toBe(true);
    expect(readLease(dir)).toMatchObject({ providerPid: 4242 });
    // 5. the message is honest.
    const said = logs.join(" ");
    expect(said).toContain("could not be confirmed closed");
    expect(said).toContain("pid 4242");
    expect(said).toContain("No new tunnel will be opened");
    expect(said).not.toMatch(/closed safely|safely closed/);
  });

  it("refuses the handover the moment the host is not on an ephemeral port", async () => {
    // The ruling's first condition, as a guard rather than a comment: put this
    // host back on a fixed port and the reasoning collapses, because a leftover
    // tunnel would then be pointed at whatever binds that port next.
    const { spawnFleet, logs, dir } = await finishWithUnconfirmedStop({ port: 19280 });

    expect(spawnFleet).not.toHaveBeenCalled();
    expect(logs.join(" ")).toContain("NOT started");
    expect(logs.join(" ")).toContain("agend start");
    // Not marked complete either: nothing was handed over.
    expect(existsSync(join(dir, "setup-complete"))).toBe(false);
  });

  it("says nothing about being safely closed", async () => {
    const { logs } = await finishWithUnconfirmedStop();

    for (const line of logs) expect(line.toLowerCase()).not.toContain("safely");
  });
});

// ── The page stops promising things it cannot deliver ───────────────────────

describe("what the page says when it is done", () => {
  it("tells a tunnelled session to use the channel, not to watch this URL", async () => {
    const { port, path, code } = await startHost({ tunnel: true, tunnelProvider: fakeProvider() });
    const cookie = await signIn(port, path, code);

    const res = await call(port, "POST", `${path}setup/finish`, { headers: { cookie } });

    // `watch: false` is the page's cue that neither this URL nor a dashboard
    // link is worth offering — the dashboard binds loopback, so a phone cannot
    // open it either.
    expect(JSON.parse(res.body)).toMatchObject({ starting: true, watch: false });
    const form = readFileSync(new URL("../src/setup-form.ts", import.meta.url), "utf8");
    expect(form).toContain("Talk to it in the channel you just set up");
    expect(form).not.toContain("Open /settings from the link");
  });

  it("still lets a local session watch the port change hands", async () => {
    const { port, path, code } = await startHost({ tunnelProvider: fakeProvider() });
    const cookie = await signIn(port, path, code);

    const res = await call(port, "POST", `${path}setup/finish`, { headers: { cookie } });

    expect(JSON.parse(res.body)).toMatchObject({ watch: true });
  });
});

// ── Two leftovers from the S2 review ────────────────────────────────────────

describe("carried over from the last review", () => {
  it("will not mint a new session once the credentials are revoked", async () => {
    // Revocation happens before the listener closes, so there is a window where
    // a request is still being served. Without the guard, the correct code
    // would be exchanged for a brand new session inside that window — the one
    // thing revocation exists to prevent.
    const { SetupCredentials } = await import("../src/setup-auth.js");
    const creds = new SetupCredentials({ code: "ABCD2345" });

    creds.revoke();

    expect(creds.redeem("ABCD2345")).toEqual({ kind: "locked" });
    expect(creds.redeemed).toBe(false);
  });

  it("compares the session cookie in constant time", () => {
    const source = readFileSync(new URL("../src/setup-auth.ts", import.meta.url), "utf8");
    const method = source.slice(source.indexOf("checkCookie("));

    expect(method).toContain("constantTimeMatches(presented, setupCookieValue(this.secret))");
    expect(method).not.toMatch(/presented\s*===\s*setupCookieValue/);
  });

  it("does not let an anonymous reload hold the page open", async () => {
    // Reloading the code prompt is not use of the page. Treating it as such let
    // anyone holding the link keep the window open for as long as they liked.
    const { port, path, host } = await startHost({ ttlMs: 60_000, idleMs: 150, tunnelProvider: fakeProvider() });

    const keepReloading = setInterval(() => { void call(port, "GET", path).catch(() => {}); }, 30);
    await new Promise(r => setTimeout(r, 500));
    clearInterval(keepReloading);

    await expect(call(port, "GET", path)).rejects.toThrow();
    await host.shutdown(false, "already stopped");
  }, 10_000);

  it("keeps the window open for a session that is actually using it", async () => {
    const { port, path, code, host } = await startHost({ ttlMs: 60_000, idleMs: 400, tunnelProvider: fakeProvider() });
    const cookie = await signIn(port, path, code);

    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 100));
      expect((await call(port, "GET", `${path}setup/status`, { headers: { cookie } })).status).toBe(200);
    }
    await host.shutdown(false, "done");
  }, 10_000);
});

// ── The zombie, for real ────────────────────────────────────────────────────

describe("a tunnel nobody cleaned up", () => {
  it("cannot reach a later listener that was handed the same port", async () => {
    // The ephemeral port is not sacred: the next `bind(0)` can be given it.
    // What keeps a leftover tunnel from fronting that listener is the host
    // allowlist, which belongs to the session, not to the port.
    const first = await startHost({ tunnel: true, tunnelProvider: fakeProvider() });
    const port = first.port;
    await first.host.shutdown(false, "gone");

    const successor = createServer((req, res) => {
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowed.includes(req.headers.host ?? "")) { res.writeHead(403); res.end("no"); return; }
      res.writeHead(200); res.end("successor");
    });
    await new Promise<void>(resolve => successor.listen(port, "127.0.0.1", () => resolve()));
    try {
      const zombie = await call(port, "GET", "/", { headers: { host: EXTERNAL_HOST } });
      const local = await call(port, "GET", "/");

      expect(zombie.status).toBe(403);
      expect(local.status).toBe(200);
    } finally {
      await new Promise<void>(resolve => successor.close(() => resolve()));
    }
  }, 10_000);
});
