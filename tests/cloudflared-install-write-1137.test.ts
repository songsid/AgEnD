/**
 * #1141 review round 2: a write may put down fewer bytes than it was given.
 * The installer writes the rest, fails a write that makes no progress, and
 * installs nothing whose bytes on disk differ from the pin.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const writer = vi.hoisted(() => ({ mode: "real" as "real" | "short" | "stuck" | "lying" }));
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: (async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (!String(args[0]).endsWith(".part") || writer.mode === "real") return handle;
      const write = (data: Uint8Array, offset = 0, length = data.byteLength - offset) => {
        // Settles on a later turn, as a real write does, so a loop that never gives up still lets the test time out.
        if (writer.mode === "stuck") return new Promise(r => setImmediate(() => r({ bytesWritten: 0, buffer: data })));
        // At most 7 bytes land per call.
        const n = Math.min(7, length);
        return handle.write(data, offset, n).then(r => writer.mode === "lying" ? { ...r, bytesWritten: length } : r);
      };
      return new Proxy(handle, { get: (t, k) => k === "write" ? write : (typeof (t as any)[k] === "function" ? (t as any)[k].bind(t) : (t as any)[k]) });
    }) as typeof real.open,
  };
});

import { ensureCloudflared } from "../src/tunnel/cloudflared-install.js";

const BINARY = Buffer.from("#!/bin/sh\necho 'cloudflared version test, long enough to need several writes'\n");
const pin = { version: "1", assets: { "linux-x64": { name: "cloudflared-linux-amd64", sha256: createHash("sha256").update(BINARY).digest("hex"), archive: "binary" as const } } };
const dirs: string[] = [];
afterEach(() => { writer.mode = "real"; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const run = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-cf-write-"));
  dirs.push(dataDir);
  const result = ensureCloudflared({ dataDir, env: { PATH: "/nonexistent" }, platform: "linux", arch: "x64", pin, fetchImpl: async () => new Response(new Uint8Array(BINARY)) });
  return { dataDir, result };
};

describe("short writes", () => {
  it("are completed: the installed file is the whole download", async () => {
    writer.mode = "short";
    const { dataDir, result } = run();
    expect(await result).toMatchObject({ source: "downloaded" });
    expect(readFileSync(join(dataDir, "bin", "cloudflared"))).toEqual(BINARY);
  });

  it("a write that makes no progress fails the install; nothing is installed", { timeout: 2_000 }, async () => {
    writer.mode = "stuck";
    const { dataDir, result } = run();
    expect((await result.catch(e => e)).kind).toBe("install-failed");
    expect(readdirSync(join(dataDir, "bin"))).toEqual([]);
  });

  it("bytes on disk that differ from the pin are never installed, whatever the writer reported", async () => {
    writer.mode = "lying";
    const { dataDir, result } = run();
    expect((await result.catch(e => e)).kind).toBe("install-failed");
    expect(readdirSync(join(dataDir, "bin"))).toEqual([]);
  });
});
