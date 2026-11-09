/**
 * #3009: a login's public link must never stop the fleet's event loop. Its filesystem checks — the PATH lookup for the
 * user's own cloudflared, preflight's executability check, the tunnel lease — are asynchronous now: a filesystem that
 * never answers (a stalled network or automount PATH entry) holds one threadpool request, not the loop, and is bounded.
 *
 * "Never answers" is modelled by an `access` that never settles for one directory, as a stat on a stale mount does.
 * A synchronous accessSync could not be made to hang here, which is the point: reverting to it makes these lookups
 * succeed at once (the hanging mock is never consulted) and the bounded outcomes below fail.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const HANG = join(tmpdir(), `agend-3009-stale-mount-${process.pid}`);
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const access = (path: string, mode?: number) => String(path).startsWith(HANG) ? new Promise<void>(() => {}) : real.access(path, mode);
  return { ...real, access, default: { ...real, access } };
});

import { ensureCloudflared } from "../src/tunnel/cloudflared-install.js";
import { CloudflaredProvider } from "../src/tunnel/cloudflared.js";
import { TunnelStartError } from "../src/tunnel/types.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-3009-")); dirs.push(d); return d; };
const BINARY = Buffer.from("#!/bin/sh\necho 'cloudflared version test'\n");
const pin = { version: "2026.9.3", assets: { "linux-x64": { name: "cloudflared-linux-amd64", sha256: createHash("sha256").update(BINARY).digest("hex"), archive: "binary" as const } } };

/** Count 10 ms ticks while `work` runs: a blocked loop would get almost none. */
async function ticksDuring<T>(work: Promise<T>): Promise<{ result: T; ticks: number; ms: number }> {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  const t0 = performance.now();
  try { return { result: await work, ticks, ms: performance.now() - t0 }; } finally { clearInterval(timer); }
}

describe("a PATH entry on a filesystem that never answers (#3009)", () => {
  it("ensureCloudflared: the lookup is bounded and the loop keeps running; AgEnD's own copy is used instead", async () => {
    const dataDir = scratch();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(BINARY), { status: 200 }));
    const { result, ticks, ms } = await ticksDuring(ensureCloudflared({
      dataDir, env: { PATH: `${HANG}:/nonexistent` }, platform: "linux", arch: "x64", fetchImpl, pin, pathLookupMs: 300,
    } as never));
    expect(result).toMatchObject({ source: "downloaded" });
    expect(ms).toBeGreaterThanOrEqual(280);                         // it waited for the bound…
    expect(ticks).toBeGreaterThanOrEqual(15);                       // …while the loop ran
  });

  it("preflight: a binary on such a filesystem ends the start at its deadline with `timeout`, the loop running", async () => {
    mkdirSync(HANG, { recursive: true });
    const binary = join(HANG, "cloudflared");
    writeFileSync(binary, "#!/bin/sh\n"); chmodSync(binary, 0o755);
    try {
      const spawn = vi.fn();
      const provider = new CloudflaredProvider({ binaryName: binary, spawnProcess: spawn as never, deadlineMs: 300, graceMs: 1, probe: () => ({ kind: "gone" }) });
      const start = provider.start({ sid: "s3009", origin: new URL("http://127.0.0.1:19309"), pagePath: "/t/x/", readinessMarker: "m",
        expiresAt: Date.now() + 60_000, signal: new AbortController().signal } as never).then(() => null, (e: unknown) => e);
      const { result, ticks } = await ticksDuring(start);
      expect(result).toBeInstanceOf(TunnelStartError);
      expect((result as TunnelStartError).errorKind).toBe("timeout");
      expect(spawn).not.toHaveBeenCalled();                         // nothing was started
      expect(ticks).toBeGreaterThanOrEqual(15);
    } finally { rmSync(HANG, { recursive: true, force: true }); }
  });

  it("a healthy PATH still finds the user's own cloudflared at once", async () => {
    const bin = scratch();
    writeFileSync(join(bin, "cloudflared"), "#!/bin/sh\n"); chmodSync(join(bin, "cloudflared"), 0o755);
    expect(await ensureCloudflared({ dataDir: scratch(), env: { PATH: bin }, platform: "linux", arch: "x64", pathLookupMs: 300 } as never))
      .toEqual({ path: join(bin, "cloudflared"), source: "path" });
  });
});

describe("#3017 review (Prism): nothing on the main thread, and a cancel is the last word", () => {
  it("P1: writeLease checks the home off the main thread — a slow lstat there never runs in the caller's turn", async () => {
    // The CommonJS `fs` object (what launcher/private-home.cjs requires) is writable: patch THIS thread's copy, a slow
    // filesystem as seen by the fleet's own thread. The worker loads its own module and is not affected.
    const fs = createRequire(import.meta.url)("node:fs") as { lstatSync: typeof import("node:fs").lstatSync };
    const { writeLease, readLease } = await import("../src/tunnel/lease.js");
    const dir = scratch();
    const real = fs.lstatSync;
    let mainThreadCalls = 0;
    fs.lstatSync = ((...args: Parameters<typeof real>) => {
      mainThreadCalls++;
      const until = Date.now() + 120; while (Date.now() < until) { /* stalled */ }
      return real(...args);
    }) as typeof real;
    const spy = { mockRestore: () => { fs.lstatSync = real; } };
    try {
      const t0 = performance.now();
      const pending = writeLease(dir, { sid: "s", provider: "cloudflared", originPort: 1, providerPid: null, strongIdentity: null,
        expiresAt: Date.now() + 60_000, ownerPid: process.pid, ownerIdentity: null });
      const syncMs = performance.now() - t0;
      await pending;
      expect(syncMs).toBeLessThan(50);                              // it returned at once: nothing slow ran in this turn
      expect(mainThreadCalls).toBe(0);                              // the home's lstat never ran on this thread
      expect(await readLease(dir)).toMatchObject({ sid: "s" });
    } finally { spy.mockRestore(); }
  });

  it("P2: a cancel while preflight's check is answering — zero spawns, cancelled", async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const spawn = vi.fn();
    const provider = new CloudflaredProvider({ binaryName: "/opt/cloudflared", spawnProcess: spawn as never, deadlineMs: 10_000, graceMs: 1,
      probe: () => ({ kind: "gone" }), access: () => held });
    const abort = new AbortController();
    const start = provider.start({ sid: "c3017", origin: new URL("http://127.0.0.1:19317"), pagePath: "/t/x/", readinessMarker: "m",
      expiresAt: Date.now() + 60_000, signal: abort.signal } as never).then(() => null, (e: unknown) => e);
    await new Promise(r => setTimeout(r, 20));
    abort.abort();
    release();                                                      // the check answers after the cancel
    const err = await start;
    expect((err as TunnelStartError).errorKind).toBe("cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("P2: a cancel during the installer's PATH lookup is carried out at once, not after the lookup's bound", async () => {
    const abort = new AbortController();
    const pending = ensureCloudflared({ dataDir: scratch(), env: { PATH: `${HANG}:/nonexistent` }, platform: "linux", arch: "x64",
      fetchImpl: vi.fn(), pin, pathLookupMs: 10_000, signal: abort.signal } as never).then(() => null, (e: unknown) => e);
    await new Promise(r => setTimeout(r, 30));
    const t0 = performance.now();
    abort.abort();
    const err = await pending;
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect((err as { kind?: string }).kind).toBe("cancelled");
  });
});

describe("#3017 review (Prism P2): each bound of preflight on its own", () => {
  const ctxWith = (signal: AbortSignal) => ({ sid: "d3017", origin: new URL("http://127.0.0.1:19318"), pagePath: "/t/x/", readinessMarker: "m",
    expiresAt: Date.now() + 60_000, signal }) as never;
  it("a check that never answers: a cancel ends the wait at once (not at the deadline), zero spawns", async () => {
    const spawn = vi.fn();
    const provider = new CloudflaredProvider({ binaryName: "/opt/cloudflared", spawnProcess: spawn as never, deadlineMs: 10_000, graceMs: 1,
      probe: () => ({ kind: "gone" }), access: () => new Promise<void>(() => {}) });
    const abort = new AbortController();
    const start = provider.start(ctxWith(abort.signal)).then(() => null, (e: unknown) => e);
    await new Promise(r => setTimeout(r, 20));
    const t0 = performance.now();
    abort.abort();
    const err = await start;
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect((err as TunnelStartError).errorKind).toBe("cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("the deadline passes while the check answers: `timeout`, zero spawns", async () => {
    const spawn = vi.fn();
    let clock = 1_000_000;
    const provider = new CloudflaredProvider({ binaryName: "/opt/cloudflared", spawnProcess: spawn as never, deadlineMs: 5_000, graceMs: 1,
      probe: () => ({ kind: "gone" }), now: () => clock,
      access: async () => { clock += 6_000; } });                   // answers OK — but only after the budget is spent
    const err = await provider.start(ctxWith(new AbortController().signal)).then(() => null, (e: unknown) => e);
    expect((err as TunnelStartError).errorKind).toBe("timeout");
    expect(spawn).not.toHaveBeenCalled();
  });
});
