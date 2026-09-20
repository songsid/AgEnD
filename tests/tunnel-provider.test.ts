import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflaredProvider, extractTunnelUrl, minimalChildEnv, validateQuickTunnelUrl } from "../src/tunnel/cloudflared.js";
import { ManagedTunnel } from "../src/tunnel/manager.js";
import { clearLease, leasePath, manualCleanupMessage, reapStaleTunnel, readLease, writeLease } from "../src/tunnel/lease.js";
import { TunnelStartError, type TunnelProvider, type TunnelStartContext } from "../src/tunnel/types.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-tunnel-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── What the child says is not evidence until it validates ──────────────────

describe("the only URL shape this accepts", () => {
  it("accepts a plain quick-tunnel URL", () => {
    expect(validateQuickTunnelUrl("https://calm-river-1234.trycloudflare.com/"))
      .toBe("https://calm-river-1234.trycloudflare.com");
    expect(validateQuickTunnelUrl("https://abc.trycloudflare.com"))
      .toBe("https://abc.trycloudflare.com");
  });

  it("refuses everything else a child could print", () => {
    for (const bad of [
      "http://abc.trycloudflare.com/",                      // not https
      "https://abc.trycloudflare.com:8443/",                // explicit port
      "https://user:pw@abc.trycloudflare.com/",             // userinfo
      "https://abc.trycloudflare.com/?x=1",                 // query
      "https://abc.trycloudflare.com/#frag",                // fragment
      "https://abc.trycloudflare.com/extra",                // extra path
      "https://a.b.trycloudflare.com/",                     // two labels
      "https://trycloudflare.com/",                         // no label
      "https://abc.trycloudflare.com.evil.example/",        // suffix trick
      "https://evil.example/?next=https://abc.trycloudflare.com/", // nested
      `https://abc.trycloudflare.com/\u0000`,               // control byte
      `https://${"a".repeat(300)}.trycloudflare.com/`,      // absurd length
      "not a url at all",
    ]) {
      expect(validateQuickTunnelUrl(bad), bad).toBeNull();
    }
  });
});

describe("finding the URL in child output", () => {
  it("reads it out of the box cloudflared draws", () => {
    const output = [
      "2026-09-20T13:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "+--------------------------------------------------------+",
      "|  Your quick Tunnel has been created! Visit it at:        |",
      "|  https://calm-river-1234.trycloudflare.com               |",
      "+--------------------------------------------------------+",
    ].join("\n");

    expect(extractTunnelUrl(output)).toBe("https://calm-river-1234.trycloudflare.com");
  });

  it("reads it out of a JSON log line", () => {
    const line = `{"level":"info","msg":"registered tunnel","url":"https://tidy-bird-77.trycloudflare.com"}`;
    expect(extractTunnelUrl(line)).toBe("https://tidy-bird-77.trycloudflare.com");
  });

  it("is not fooled by a valid URL hidden inside a hostile one", () => {
    // The whole token is validated, never a match inside it: what the child
    // actually printed here is a link to evil.example.
    expect(extractTunnelUrl("Visit https://evil.example/?u=https://abc.trycloudflare.com/ now")).toBeNull();
    expect(extractTunnelUrl("https://abc.trycloudflare.com.evil.example/")).toBeNull();
  });

  it("does not let a quote or a comma shorten a hostile token", () => {
    // Splitting on quotes and commas — which can appear in a URL — is how
    // `?u="https://x.trycloudflare.com/"` becomes an acceptable token.
    expect(extractTunnelUrl('https://evil.example/?u="https://abc.trycloudflare.com/"')).toBeNull();
    expect(extractTunnelUrl("https://evil.example/?a=1,https://abc.trycloudflare.com/")).toBeNull();
  });

  it("reads a JSON line as JSON, so a query string is not a hostname", () => {
    const hostile = JSON.stringify({ level: "info", msg: "https://evil.example/?u=https://abc.trycloudflare.com/" });
    expect(extractTunnelUrl(hostile)).toBeNull();

    const real = JSON.stringify({ level: "info", url: "https://tidy-bird-78.trycloudflare.com" });
    expect(extractTunnelUrl(real)).toBe("https://tidy-bird-78.trycloudflare.com");
  });

  it("sees through ANSI colouring but not through a different host", () => {
    expect(extractTunnelUrl("\u001b[32mhttps://abc.trycloudflare.com\u001b[0m")).toBe("https://abc.trycloudflare.com");
    expect(extractTunnelUrl("\u001b[32mhttps://abc.example.com\u001b[0m")).toBeNull();
  });
});

describe("what the child is allowed to inherit", () => {
  it("passes proxy and CA settings and nothing else", () => {
    const env = minimalChildEnv({
      HTTPS_PROXY: "http://proxy:3128",
      SSL_CERT_FILE: "/etc/ca.pem",
      AWS_SECRET_ACCESS_KEY: "very secret",
      GITHUB_TOKEN: "also secret",
      HOME: "/home/someone",
      PATH: "/usr/bin",
    });

    expect(env).toEqual({ HTTPS_PROXY: "http://proxy:3128", SSL_CERT_FILE: "/etc/ca.pem" });
  });
});

// ── Starting: nothing counts as ready until the page comes back ─────────────

/** A stand-in for cloudflared that we can make behave badly on purpose. */
class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  /** Null is not hypothetical: a spawn that fails never gets one. */
  pid: number | null = 4242;
  killed: NodeJS.Signals[] = [];
  kill(signal?: NodeJS.Signals): boolean { this.killed.push(signal ?? "SIGTERM"); return true; }
  say(text: string): void { this.stdout.push(text); }
  die(code = 0): void { this.emit("exit", code, null); }
}

interface SpawnCall { file: string; args: string[]; options: Record<string, unknown> }

function providerWith(child: FakeChild, over: Record<string, unknown> = {}) {
  const bin = join(tempDir(), "cloudflared");
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  const calls: SpawnCall[] = [];
  const provider = new CloudflaredProvider({
    binaryName: bin,
    env: { PATH: "/nonexistent", AWS_SECRET_ACCESS_KEY: "secret", HTTPS_PROXY: "http://proxy:3128" },
    spawnProcess: ((file: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options });
      return child;
    }) as never,
    deadlineMs: 300,
    graceMs: 10,
    probe: () => ({ kind: "gone" }),
    ...over,
  });
  return Object.assign(provider, { spawnCalls: calls, binaryPath: bin });
}

function context(over: Partial<TunnelStartContext> = {}): TunnelStartContext {
  return {
    sid: "s".repeat(32),
    origin: new URL("http://127.0.0.1:45678"),
    pagePath: "/s/abc/",
    readinessMarker: "agend-setup-marker",
    expiresAt: Date.now() + 600_000,
    signal: new AbortController().signal,
    ...over,
  };
}

describe("a tunnel is not ready until the public URL serves this page", () => {
  it("returns a handle once the page comes back through the edge", async () => {
    const child = new FakeChild();
    const seen: string[] = [];
    const provider = providerWith(child, {
      fetchPage: async (url: string) => {
        seen.push(url);
        return { status: 200, contentType: "text/html; charset=utf-8", body: "<html>agend-setup-marker</html>" };
      },
    });
    setTimeout(() => child.say("| https://calm-river-1.trycloudflare.com |\n"), 5);

    const handle = await provider.start(context());

    expect(handle.baseUrl).toBe("https://calm-river-1.trycloudflare.com");
    // The trailing slash survives, or the page's relative assets resolve out of
    // its own path.
    expect(handle.pageUrl).toBe("https://calm-river-1.trycloudflare.com/s/abc/");
    expect(seen).toEqual(["https://calm-river-1.trycloudflare.com/s/abc/"]);
  });

  it("announces the host before it probes, because the probe arrives under it", async () => {
    // cloudflared forwards the public Host to the origin, so the readiness
    // probe is the first request that arrives as `xxx.trycloudflare.com`. An
    // origin with a host allowlist refuses it unless it has been told first —
    // which is why the order here is the difference between a tunnel that
    // works and one that reports itself unreachable.
    const child = new FakeChild();
    const order: string[] = [];
    const provider = providerWith(child, {
      fetchPage: async () => {
        order.push("probe");
        return { status: 200, contentType: "text/html", body: "agend-setup-marker" };
      },
    });
    setTimeout(() => child.say("https://calm-river-8.trycloudflare.com\n"), 5);

    await provider.start(context({ onCandidateHost: host => order.push(`candidate:${host}`) }));

    expect(order).toEqual(["candidate:calm-river-8.trycloudflare.com", "probe"]);
  });

  it("is not ready just because the page loaded — the marker has to be in it", async () => {
    const child = new FakeChild();
    const provider = providerWith(child, {
      // A 200 from someone else's page is exactly the wrong-origin case the
      // probe exists to catch.
      fetchPage: async () => ({ status: 200, contentType: "text/html", body: "<html>somebody else</html>" }),
    });
    setTimeout(() => child.say("https://calm-river-2.trycloudflare.com\n"), 5);

    await expect(provider.start(context())).rejects.toThrow(/never served this page/);
  });

  it("refuses to expose anything that is not the loopback origin", async () => {
    const provider = providerWith(new FakeChild());

    await expect(provider.start(context({ origin: new URL("http://0.0.0.0:8080") })))
      .rejects.toThrow(/only http:\/\/127\.0\.0\.1/);
  });

  it("never outlives the thing it is fronting", async () => {
    // The budget is `min(now + deadline, expiresAt)`. Without the cap a tunnel
    // could still be starting after the session it fronts has expired — and
    // then succeed, publishing a URL onto a listener that is already closing.
    const child = new FakeChild();
    const provider = providerWith(child, { deadlineMs: 10_000 });

    const started = Date.now();
    await expect(provider.start(context({ expiresAt: Date.now() + 80 })))
      .rejects.toThrow(/did not print a usable tunnel URL/);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 15_000);

  it("settles at the deadline when the child prints nothing at all", async () => {
    const child = new FakeChild();
    const provider = providerWith(child, { deadlineMs: 120 });

    await expect(provider.start(context())).rejects.toThrow(/did not print a usable tunnel URL/);
  });

  it("reports a child that exited before printing anything", async () => {
    const child = new FakeChild();
    const provider = providerWith(child);
    setTimeout(() => child.die(1), 5);

    await expect(provider.start(context())).rejects.toThrow(/exited before printing a tunnel URL/);
  });

  it("does not report a clean failure while its child may still be running", async () => {
    const child = new FakeChild();
    // Ignores every signal, and the probe keeps finding it under its original
    // identity — so its death cannot be proven.
    child.kill = () => true;
    const provider = providerWith(child, {
      deadlineMs: 60,
      probe: () => ({ kind: "identified", identity: "linux:999", comm: "cloudflared" }),
    });

    const err = await provider.start(context()).catch(e => e as TunnelStartError);

    expect(err).toBeInstanceOf(TunnelStartError);
    expect((err as TunnelStartError).unconfirmed).toEqual({ pid: 4242, identity: "linux:999" });
    expect((err as TunnelStartError).message).toContain("could not be confirmed stopped");
  });
});

/** A handle for a provider that never really started anything. */
function handleStub(pid: number | null, identity: string | null, stop = async () => ({ confirmed: true as const })) {
  return {
    provider: "fake", visibility: "public" as const,
    baseUrl: "https://x.trycloudflare.com", pageUrl: "https://x.trycloudflare.com/s/abc/",
    pid, identity, stop, onUnexpectedExit: () => () => {},
  };
}

describe("a spawn that never produced a process", () => {
  it("fails fast and does not pretend a process might be out there", async () => {
    // Node reports a failed spawn as `error`, never as `exit`, and leaves pid
    // undefined. Waiting it out and then reporting "could not confirm" would
    // hold the lease against a child that was never created — and block every
    // later tunnel until a human deleted the file.
    const child = new FakeChild();
    child.pid = null;
    const provider = providerWith(child, { deadlineMs: 10_000 });
    setTimeout(() => child.emit("error", new Error("spawn ENOENT")), 5);

    const started = Date.now();
    const err = await provider.start(context()).catch(e => e as TunnelStartError);

    expect(err).toBeInstanceOf(TunnelStartError);
    expect((err as TunnelStartError).errorKind).toBe("spawn-failed");
    // No `unconfirmed`, so the manager clears the lease instead of blocking.
    expect((err as TunnelStartError).unconfirmed).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 15_000);

  it("leaves no lease behind, because there is nothing to clean up", async () => {
    const dir = tempDir();
    const managed = new ManagedTunnel({ dataDir: dir, probe: () => ({ kind: "gone" }) });
    const child = new FakeChild();
    child.pid = null;
    const provider = providerWith(child, { deadlineMs: 10_000 });
    setTimeout(() => child.emit("error", new Error("spawn EAGAIN")), 5);

    const result = await managed.start(provider, context());

    expect(result).toMatchObject({ ok: false, errorKind: "spawn-failed", leaseHeld: false });
    expect(existsSync(leasePath(dir))).toBe(false);
    // And the next attempt is not blocked by the one that never started.
    const next = await managed.start(
      fakeProvider({ start: async () => handleStub(1, null) }), context(),
    );
    expect(next.ok).toBe(true);
  }, 15_000);
});

describe("how the child is started", () => {
  async function spawnOptionsFor(): Promise<SpawnCall> {
    const child = new FakeChild();
    const provider = providerWith(child, {
      fetchPage: async () => ({ status: 200, contentType: "text/html", body: "agend-setup-marker" }),
    });
    setTimeout(() => child.say("https://calm-river-9.trycloudflare.com\n"), 5);
    await provider.start(context());
    return provider.spawnCalls[0]!;
  }

  it("uses a fixed argument list and no shell", async () => {
    const call = await spawnOptionsFor();

    // Fixed argv is the whole defence against command injection here — one of
    // these arguments is an origin, and a shell would make it a command.
    expect(call.args).toEqual([
      "tunnel", "--no-autoupdate", "--config", "/dev/null", "--url", "http://127.0.0.1:45678",
    ]);
    expect(call.options.shell).toBe(false);
  });

  it("hands the child only the variables on the allow list", async () => {
    const call = await spawnOptionsFor();

    // The shell that ran `agend setup` routinely holds cloud credentials.
    expect(Object.keys(call.options.env as object)).toEqual(["HTTPS_PROXY"]);
    expect(JSON.stringify(call.options.env)).not.toContain("secret");
  });
});

describe("stopping is a claim that needs proof", () => {
  async function running(over: Record<string, unknown> = {}) {
    const child = new FakeChild();
    const provider = providerWith(child, {
      fetchPage: async () => ({ status: 200, contentType: "text/html", body: "agend-setup-marker" }),
      ...over,
    });
    setTimeout(() => child.say("https://calm-river-3.trycloudflare.com\n"), 5);
    const handle = await provider.start(context());
    return { child, handle };
  }

  it("is confirmed when the process is observed to exit", async () => {
    const { child, handle } = await running();
    child.kill = (signal?: NodeJS.Signals) => { child.killed.push(signal ?? "SIGTERM"); child.die(0); return true; };

    await expect(handle.stop("ttl")).resolves.toEqual({ confirmed: true });
    expect(child.killed[0]).toBe("SIGTERM");
  });

  it("says so plainly when it cannot prove the process died", async () => {
    const { handle } = await running({
      probe: () => ({ kind: "identified", identity: "linux:777", comm: "cloudflared" }),
    });

    const result = await handle.stop("ttl");

    expect(result.confirmed).toBe(false);
    expect((result as { reason: string }).reason).toContain("did not exit");
    // The sentence a caller would otherwise write into a log.
    expect(JSON.stringify(result)).not.toContain("safely");
  });

  it("treats a reused pid as proof the original is gone, without signalling twice", async () => {
    let calls = 0;
    const { child, handle } = await running({
      probe: () => {
        calls += 1;
        // At spawn it is ours; by the time we stop, the pid is somebody else's.
        return calls === 1
          ? { kind: "identified", identity: "linux:111", comm: "cloudflared" }
          : { kind: "identified", identity: "linux:222", comm: "someone-else" };
      },
    });

    await expect(handle.stop("ttl")).resolves.toEqual({ confirmed: true });
    // SIGTERM went out once; SIGKILL must not, because the pid is no longer ours.
    expect(child.killed).toEqual(["SIGTERM"]);
  });

  it("joins a stop already in progress rather than signalling again", async () => {
    const { child, handle } = await running();
    child.kill = (signal?: NodeJS.Signals) => {
      child.killed.push(signal ?? "SIGTERM");
      setTimeout(() => child.die(0), 5);
      return true;
    };

    const [a, b] = await Promise.all([handle.stop("ttl"), handle.stop("cancel")]);

    expect([a, b]).toEqual([{ confirmed: true }, { confirmed: true }]);
    expect(child.killed).toEqual(["SIGTERM"]);
  });
});

// ── The lease, and the reaper that can run without a fleet ──────────────────

describe("the lease survives the process that wrote it", () => {
  const lease = (over: Record<string, unknown> = {}) => ({
    sid: "abc", provider: "cloudflared", originPort: 45678,
    providerPid: 4242, strongIdentity: "linux:111",
    expiresAt: Date.now() + 60_000, ownerPid: process.pid, ownerIdentity: null,
    ...over,
  });

  it("writes owner-only and reads back what it wrote", () => {
    const dir = tempDir();
    writeLease(dir, lease());

    expect(readLease(dir)).toMatchObject({ provider: "cloudflared", providerPid: 4242, strongIdentity: "linux:111" });
    expect(readFileSync(leasePath(dir), "utf8")).not.toContain("token");
  });

  it("treats a damaged lease as unresolved, not as absent", async () => {
    // "No lease" is the one answer a corrupt file cannot justify: it would let
    // a second tunnel start beside one we simply could not read.
    const dir = tempDir();
    writeFileSync(leasePath(dir), "{ this is not json");

    expect(readLease(dir)).not.toBeNull();
    const outcome = await reapStaleTunnel(dir, { probe: () => ({ kind: "gone" }) });
    expect(outcome.kind).toBe("manual");
    expect(existsSync(leasePath(dir))).toBe(true);
  });

  it("runs the reaper from a process that has no fleet at all", async () => {
    // The pre-fleet setup host calls this. It takes a directory and nothing
    // else on purpose — there is no FleetManager in that process to pass.
    const dir = tempDir();
    writeLease(dir, lease());

    const outcome = await reapStaleTunnel(dir, { probe: () => ({ kind: "gone" }) });

    expect(outcome).toMatchObject({ kind: "reaped", how: "already-gone" });
    expect(existsSync(leasePath(dir))).toBe(false);
  });

  it("never signals a pid that now belongs to something else", async () => {
    const dir = tempDir();
    writeLease(dir, lease({ ownerPid: 999_999 }));
    const killed: number[] = [];

    const outcome = await reapStaleTunnel(dir, {
      probe: pid => pid === 999_999
        ? { kind: "gone" }
        : { kind: "identified", identity: "linux:222", comm: "postgres" },
      kill: pid => { killed.push(pid); },
    });

    expect(outcome).toMatchObject({ kind: "reaped", how: "pid-reused" });
    expect(killed).toEqual([]);
    expect(existsSync(leasePath(dir))).toBe(false);
  });

  it("kills a match and clears only once it is gone", async () => {
    const dir = tempDir();
    writeLease(dir, lease({ ownerPid: 999_999 }));
    const killed: NodeJS.Signals[] = [];
    let alive = true;

    const outcome = await reapStaleTunnel(dir, {
      probe: pid => pid === 999_999
        ? { kind: "gone" }
        : alive ? { kind: "identified", identity: "linux:111", comm: "cloudflared" } : { kind: "gone" },
      kill: (_pid, signal) => { killed.push(signal); alive = false; },
      wait: async () => {},
    });

    expect(outcome).toMatchObject({ kind: "reaped", how: "killed" });
    expect(killed).toEqual(["SIGTERM"]);
    expect(existsSync(leasePath(dir))).toBe(false);
  });

  it("keeps the lease when the process will not die, and says what to do", async () => {
    const dir = tempDir();
    writeLease(dir, lease({ ownerPid: 999_999 }));

    const outcome = await reapStaleTunnel(dir, {
      probe: pid => pid === 999_999 ? { kind: "gone" } : { kind: "identified", identity: "linux:111", comm: "cloudflared" },
      kill: () => {},
      wait: async () => {},
    });

    expect(outcome.kind).toBe("manual");
    expect(existsSync(leasePath(dir))).toBe(true);
    const message = manualCleanupMessage(outcome as never);
    expect(message).toContain("pid 4242");
    expect(message).toContain(leasePath(dir));
    expect(message).not.toContain("safely");
  });

  it("leaves a lease a live owner is using", async () => {
    const dir = tempDir();
    writeLease(dir, lease({ ownerPid: 4321 }));
    const killed: number[] = [];

    const outcome = await reapStaleTunnel(dir, {
      probe: () => ({ kind: "identified", identity: "linux:111", comm: "cloudflared" }),
      kill: pid => { killed.push(pid); },
    });

    expect(outcome).toEqual({ kind: "held", ownerPid: 4321 });
    expect(killed).toEqual([]);
    expect(existsSync(leasePath(dir))).toBe(true);
  });

  it("asks for a human when a lease names no process", async () => {
    // Reserved, then the owner died before the pid could be recorded: a child
    // may exist that nothing can identify, and guessing is what this refuses.
    const dir = tempDir();
    writeLease(dir, lease({ providerPid: null, strongIdentity: null, ownerPid: 999_999 }));

    const outcome = await reapStaleTunnel(dir, { probe: () => ({ kind: "gone" }) });

    expect(outcome.kind).toBe("manual");
    expect(existsSync(leasePath(dir))).toBe(true);
  });

  it("will not signal a pid the lease cannot identify", async () => {
    // An old lease with no fingerprint names a number and nothing else. Killing
    // on that basis is the same mistake as killing a reused pid — the reaper
    // simply cannot tell, so it must not act.
    const dir = tempDir();
    writeLease(dir, lease({ strongIdentity: null, ownerPid: 999_999 }));
    const killed: number[] = [];

    const outcome = await reapStaleTunnel(dir, {
      probe: pid => pid === 999_999
        ? { kind: "gone" }
        : { kind: "identified", identity: "linux:111", comm: "cloudflared" },
      kill: pid => { killed.push(pid); },
      wait: async () => {},
    });

    expect(outcome.kind).toBe("manual");
    expect(killed).toEqual([]);
    expect(existsSync(leasePath(dir))).toBe(true);
  });

  it("treats a lease that parses but is missing its fields as unresolved", async () => {
    // Valid JSON with a plausible-looking pid in it, but no provider and no
    // owner. Trusting the fields that happen to be there would send SIGTERM to
    // a number out of a damaged file — so the whole record is rejected instead.
    const dir = tempDir();
    writeFileSync(leasePath(dir), JSON.stringify({ providerPid: 4242, strongIdentity: "linux:111" }));
    const killed: number[] = [];

    expect(readLease(dir)).not.toBeNull();
    const outcome = await reapStaleTunnel(dir, {
      probe: () => ({ kind: "identified", identity: "linux:111", comm: "cloudflared" }),
      kill: pid => { killed.push(pid); },
      wait: async () => {},
    });

    expect(outcome.kind).toBe("manual");
    expect(killed).toEqual([]);
    expect(existsSync(leasePath(dir))).toBe(true);
  });

  it("does not let a reused owner pid hold the lease forever", async () => {
    // The owner crashed and its number was handed to something unrelated. With
    // only the number to go on, the reaper would call this "held" for as long
    // as that innocent process lives — the trap ticket 5 hit with fleet.lock.
    const dir = tempDir();
    writeLease(dir, lease({ ownerPid: 999_999, ownerIdentity: "linux:owner-1" }));

    const outcome = await reapStaleTunnel(dir, {
      probe: pid => pid === 999_999
        ? { kind: "identified", identity: "linux:somebody-else", comm: "postgres" }
        : { kind: "gone" },
      kill: () => { throw new Error("the provider pid was already gone"); },
    });

    expect(outcome).toMatchObject({ kind: "reaped", how: "already-gone" });
    expect(existsSync(leasePath(dir))).toBe(false);
  });

  it("still yields to an owner that really is the one that wrote the lease", async () => {
    const dir = tempDir();
    writeLease(dir, lease({ ownerPid: 999_999, ownerIdentity: "linux:owner-1" }));

    const outcome = await reapStaleTunnel(dir, {
      probe: pid => pid === 999_999
        ? { kind: "identified", identity: "linux:owner-1", comm: "node" }
        : { kind: "gone" },
    });

    expect(outcome).toEqual({ kind: "held", ownerPid: 999_999 });
  });

  it("cannot prove anything on a platform with no fingerprint", async () => {
    const dir = tempDir();
    writeLease(dir, lease({ ownerPid: 999_999 }));

    const outcome = await reapStaleTunnel(dir, {
      probe: pid => pid === 999_999 ? { kind: "gone" } : { kind: "unknown" },
      kill: () => { throw new Error("must not signal on an unknown probe"); },
    });

    expect(outcome.kind).toBe("manual");
    expect(existsSync(leasePath(dir))).toBe(true);
  });
});

// ── One at a time, and never one nobody is tracking ─────────────────────────

function fakeProvider(over: Partial<TunnelProvider> = {}): TunnelProvider & { starts: number } {
  const provider = {
    name: "fake",
    starts: 0,
    preflight: async () => ({ ok: true as const, binaryPath: "/bin/true" }),
    async start(): Promise<never> { throw new TunnelStartError("spawn-failed", "not implemented"); },
    ...over,
  };
  return provider as TunnelProvider & { starts: number };
}

describe("only one managed tunnel, and only one that is accounted for", () => {
  it("records the pid and fingerprint of the tunnel it started", async () => {
    const dir = tempDir();
    const managed = new ManagedTunnel({ dataDir: dir, probe: () => ({ kind: "gone" }) });
    const provider = fakeProvider({ start: async () => handleStub(777, "linux:555") });

    const result = await managed.start(provider, context());

    expect(result.ok).toBe(true);
    expect(readLease(dir)).toMatchObject({ providerPid: 777, strongIdentity: "linux:555", ownerPid: process.pid });
  });

  it("writes a lease before the provider can create anything", async () => {
    const dir = tempDir();
    const managed = new ManagedTunnel({ dataDir: dir, probe: () => ({ kind: "gone" }) });
    let leaseAtStart: unknown = "not read";
    const provider = fakeProvider({
      start: async () => { leaseAtStart = readLease(dir); return handleStub(777, "linux:555"); },
    });

    await managed.start(provider, context());

    // A crash between the spawn and the record must leave evidence, so the
    // lease has to exist before the provider is called at all.
    expect(leaseAtStart).toMatchObject({ ownerPid: process.pid, providerPid: null });
  });

  it("gives two concurrent callers one attempt, not two tunnels", async () => {
    const dir = tempDir();
    const managed = new ManagedTunnel({ dataDir: dir, probe: () => ({ kind: "gone" }) });
    let starts = 0;
    const provider = fakeProvider({
      start: async () => { starts += 1; await new Promise(r => setTimeout(r, 20)); return handleStub(777, "linux:555"); },
    });

    const [a, b] = await Promise.all([managed.start(provider, context()), managed.start(provider, context())]);

    expect(starts).toBe(1);
    expect(a).toBe(b);
  });

  it("clears the lease when a start failed with its child proven gone", async () => {
    const dir = tempDir();
    const managed = new ManagedTunnel({ dataDir: dir, probe: () => ({ kind: "gone" }) });
    const provider = fakeProvider({
      start: async () => { throw new TunnelStartError("readiness-failed", "edge never answered"); },
    });

    const result = await managed.start(provider, context());

    expect(result).toMatchObject({ ok: false, errorKind: "readiness-failed", leaseHeld: false });
    expect(existsSync(leasePath(dir))).toBe(false);
  });

  it("keeps the lease and refuses the next start when a child could not be proven gone", async () => {
    const dir = tempDir();
    const messages: string[] = [];
    const managed = new ManagedTunnel({ dataDir: dir, probe: () => ({ kind: "gone" }), log: m => messages.push(m) });
    const provider = fakeProvider({
      start: async () => {
        throw new TunnelStartError("timeout", "no url", { pid: 4242, identity: "linux:111" });
      },
    });

    const first = await managed.start(provider, context());
    const second = await managed.start(fakeProvider({ start: async () => handleStub(1, null) }), context());

    expect(first).toMatchObject({ ok: false, leaseHeld: true });
    expect(readLease(dir)).toMatchObject({ providerPid: 4242, strongIdentity: "linux:111" });
    // Fail closed: a fallback running beside a live tunnel is the thing this
    // whole file exists to prevent.
    expect(second).toMatchObject({ ok: false, errorKind: "lease-held", leaseHeld: true });
    expect(messages.join(" ")).toContain("4242");
  });

  it("refuses to start while another live process owns the lease", async () => {
    const dir = tempDir();
    writeLease(dir, {
      sid: "other", provider: "cloudflared", originPort: 1, providerPid: 5,
      strongIdentity: "linux:1", expiresAt: Date.now() + 60_000, ownerPid: 4321,
      ownerIdentity: null,
    });
    const managed = new ManagedTunnel({ dataDir: dir, probe: () => ({ kind: "identified", identity: "linux:1", comm: "x" }) });
    const provider = fakeProvider({ start: async () => { throw new Error("must not start"); } });

    const result = await managed.start(provider, context());

    expect(result).toMatchObject({ ok: false, errorKind: "lease-held" });
    expect(String((result as { message: string }).message)).toContain("4321");
  });

  it("releases the lease only on a confirmed stop", async () => {
    const dir = tempDir();
    const managed = new ManagedTunnel({ dataDir: dir, probe: () => ({ kind: "gone" }) });
    await managed.start(fakeProvider({
      start: async () => handleStub(777, "linux:555", async () => ({
        confirmed: false as const, reason: "did not exit", pid: 777, identity: "linux:555",
      })),
    }), context());

    const stopped = await managed.stop("ttl");

    expect(stopped.confirmed).toBe(false);
    expect(existsSync(leasePath(dir))).toBe(true);
    // And the block persists, so nothing new opens behind it.
    const next = await managed.start(fakeProvider({ start: async () => handleStub(1, null) }), context());
    expect(next).toMatchObject({ ok: false, errorKind: "lease-held" });
  });

  it("clears the lease on a confirmed stop", async () => {
    const dir = tempDir();
    const managed = new ManagedTunnel({ dataDir: dir, probe: () => ({ kind: "gone" }) });
    await managed.start(fakeProvider({ start: async () => handleStub(777, "linux:555") }), context());

    await expect(managed.stop("finished")).resolves.toEqual({ confirmed: true });
    expect(existsSync(leasePath(dir))).toBe(false);
    clearLease(dir);
  });
});

// ── The binary this never installs ──────────────────────────────────────────

describe("preflight looks, and does nothing else", () => {
  it("reports a missing binary without spawning anything", async () => {
    const provider = new CloudflaredProvider({
      binaryName: "definitely-not-installed-cloudflared",
      env: { PATH: tempDir() },
      spawnProcess: (() => { throw new Error("must not spawn"); }) as never,
    });

    const result = await provider.preflight(new AbortController().signal);

    expect(result).toMatchObject({ ok: false, errorKind: "binary-missing" });
    expect((result as { detail: string }).detail).toContain("never downloads it for you");
  });

  it("reports a binary that is there but not executable", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "cloudflared"), "", { mode: 0o644 });

    const result = await new CloudflaredProvider({ env: { PATH: dir } })
      .preflight(new AbortController().signal);

    expect(result).toMatchObject({ ok: false, errorKind: "binary-missing" });
  });

  it("finds an executable on PATH", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "cloudflared"), "#!/bin/sh\n", { mode: 0o755 });

    await expect(new CloudflaredProvider({ env: { PATH: dir } }).preflight(new AbortController().signal))
      .resolves.toEqual({ ok: true, binaryPath: join(dir, "cloudflared") });
  });
});
