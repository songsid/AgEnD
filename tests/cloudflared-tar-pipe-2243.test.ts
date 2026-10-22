/**
 * #2243: the macOS `/login` public link unpacks cloudflared with the system tar. A read error on tar's stderr pipe
 * must fail that install with a typed reason (the chat's "could not be installed"), never escape as an uncaught
 * EventEmitter error that stops the fleet.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const tar = vi.hoisted(() => ({ children: [] as Array<{ argv: string[]; child: unknown }>, make: null as null | (() => unknown) }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: vi.fn((cmd: string, argv: string[], opts: unknown) => {
      if (cmd !== "tar" || !tar.make) return real.spawn(cmd, argv, opts as never);
      const child = tar.make();
      tar.children.push({ argv, child });
      return child;
    }),
  };
});

const { CloudflaredInstallError, ensureCloudflared } = await import("../src/tunnel/cloudflared-install.js");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); tar.children.length = 0; tar.make = null; });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-cf2243-")); dirs.push(d); return d; };
const ARCHIVE = Buffer.from("the pinned archive");
const pin = { version: "2026.9.3", assets: { "linux-x64": { name: "cloudflared-linux-amd64.tgz", sha256: createHash("sha256").update(ARCHIVE).digest("hex"), archive: "tgz" as const } } };
const fetchImpl = vi.fn(async () => new Response(new Uint8Array(ARCHIVE), { status: 200 }));

/** A tar that never exits by itself; its stderr pipe fails with a read error once it is running. */
function failingStderrTar() {
  const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), killed: false, kill: vi.fn(() => { child.killed = true; return true; }) });
  setImmediate(() => child.stderr.destroy(Object.assign(new Error("read EIO"), { code: "EIO" })));
  return child;
}

describe("#2243 the tar unpack on the /login public-link install", () => {
  it("a stderr pipe error fails the install as install-failed, stops tar, and nothing goes uncaught", async () => {
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      tar.make = failingStderrTar;
      const err = await ensureCloudflared({ dataDir: scratch(), env: { PATH: "/nonexistent" }, platform: "linux", arch: "x64", fetchImpl, pin } as never)
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(CloudflaredInstallError);
      expect((err as InstanceType<typeof CloudflaredInstallError>).kind).toBe("install-failed");
      expect((err as Error).message).toContain("read EIO");
      expect(tar.children).toHaveLength(1);
      expect(tar.children[0].argv.slice(0, 1)).toEqual(["-xzf"]);
      expect((tar.children[0].child as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalled();
      await new Promise(r => setImmediate(r));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", uncaught);
    }
  });

  it("control: tar exiting non-zero is still install-failed with its stderr", async () => {
    tar.make = () => {
      const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn() });
      setImmediate(() => { child.stderr.write("tar: bad archive"); setImmediate(() => child.emit("exit", 2)); });
      return child;
    };
    const err = await ensureCloudflared({ dataDir: scratch(), env: { PATH: "/nonexistent" }, platform: "linux", arch: "x64", fetchImpl, pin } as never)
      .then(() => null, (e: unknown) => e);
    expect((err as InstanceType<typeof CloudflaredInstallError>).kind).toBe("install-failed");
    expect((err as Error).message).toContain("tar exited 2: tar: bad archive");
  });
});
