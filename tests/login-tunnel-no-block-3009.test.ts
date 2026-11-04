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
