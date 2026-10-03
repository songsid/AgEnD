/**
 * #1137: AgEnD installs its own cloudflared for the one-tap public /login link —
 * pinned version, pinned SHA256, into <AGEND_HOME>/bin, never system-wide.
 * Every failure is a typed error the caller turns into "nothing was opened".
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARED_PIN, CloudflaredInstallError, assetFor, ensureCloudflared, releaseUrl, type CloudflaredAsset,
} from "../src/tunnel/cloudflared-install.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-cf-")); dirs.push(d); return d; };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const BINARY = Buffer.from("#!/bin/sh\necho 'cloudflared version test'\n");
function pinFor(body: Buffer, archive: CloudflaredAsset["archive"] = "binary", version = "2026.9.3") {
  return { version, assets: { "linux-x64": { name: archive === "tgz" ? "cloudflared-linux-amd64.tgz" : "cloudflared-linux-amd64", sha256: sha(body), archive } } };
}
function fakeFetch(body: Buffer | (() => Promise<Response>), status = 200) {
  return vi.fn(async (_url: string, _init: unknown) => typeof body === "function" ? body() : new Response(new Uint8Array(body), { status }));
}
const base = (dataDir: string, extra: Record<string, unknown> = {}) => ({
  dataDir, env: { PATH: "/nonexistent" }, platform: "linux" as NodeJS.Platform, arch: "x64", ...extra,
});
const leftovers = (dataDir: string) => readdirSync(join(dataDir, "bin")).filter(f => f !== "cloudflared" && f !== "cloudflared.sha256");

describe("the pinned assets", () => {
  it("map each supported platform to Cloudflare's asset, and nothing else", () => {
    expect(assetFor("linux", "x64")?.name).toBe("cloudflared-linux-amd64");
    expect(assetFor("linux", "arm64")?.name).toBe("cloudflared-linux-arm64");
    expect(assetFor("linux", "arm")?.name).toBe("cloudflared-linux-arm");
    expect(assetFor("linux", "ia32")?.name).toBe("cloudflared-linux-386");
    expect(assetFor("darwin", "x64")).toMatchObject({ name: "cloudflared-darwin-amd64.tgz", archive: "tgz" });
    expect(assetFor("darwin", "arm64")).toMatchObject({ name: "cloudflared-darwin-arm64.tgz", archive: "tgz" });
    for (const [p, a] of [["win32", "x64"], ["freebsd", "x64"], ["linux", "s390x"], ["darwin", "ia32"]] as const) expect(assetFor(p, a)).toBeNull();
    for (const asset of Object.values(CLOUDFLARED_PIN.assets)) expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("are fetched from Cloudflare's official release, at the pinned version", () => {
    expect(releaseUrl(assetFor("linux", "x64")!)).toBe(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_PIN.version}/cloudflared-linux-amd64`);
  });
});

describe("ensureCloudflared", () => {
  it("prefers the user's own cloudflared on PATH, and downloads nothing", async () => {
    const dataDir = scratch();
    const bin = scratch();
    writeFileSync(join(bin, "cloudflared"), BINARY);
    chmodSync(join(bin, "cloudflared"), 0o755);
    const fetchImpl = fakeFetch(BINARY);
    expect(await ensureCloudflared({ ...base(dataDir, { fetchImpl }), env: { PATH: bin } })).toEqual({ path: join(bin, "cloudflared"), source: "path" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("downloads, verifies and installs AgEnD's copy (0755, in <dataDir>/bin, stamped), telling the caller first", async () => {
    const dataDir = scratch();
    const fetchImpl = fakeFetch(BINARY);
    const onDownloading = vi.fn();
    const got = await ensureCloudflared(base(dataDir, { fetchImpl, pin: pinFor(BINARY), onDownloading }));
    const target = join(dataDir, "bin", "cloudflared");
    expect(got).toEqual({ path: target, source: "downloaded" });
    expect(readFileSync(target)).toEqual(BINARY);
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(statSync(join(dataDir, "bin")).mode & 0o777).toBe(0o700);
    expect(readFileSync(`${target}.sha256`, "utf8").trim()).toBe(`2026.9.3 ${sha(BINARY)} ${sha(BINARY)}`);
    expect(onDownloading).toHaveBeenCalledWith({ version: "2026.9.3", asset: "cloudflared-linux-amd64" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-linux-amd64");
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("reuses a verified copy without fetching; a damaged one, or one from an older pin, is replaced", async () => {
    const dataDir = scratch();
    const fetchImpl = fakeFetch(BINARY);
    await ensureCloudflared(base(dataDir, { fetchImpl, pin: pinFor(BINARY) }));
    expect(await ensureCloudflared(base(dataDir, { fetchImpl, pin: pinFor(BINARY) }))).toMatchObject({ source: "agend" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    writeFileSync(join(dataDir, "bin", "cloudflared"), "tampered");
    expect(await ensureCloudflared(base(dataDir, { fetchImpl, pin: pinFor(BINARY) }))).toMatchObject({ source: "downloaded" });
    expect(readFileSync(join(dataDir, "bin", "cloudflared"))).toEqual(BINARY);

    // A new pin is a new asset (new bytes, new hash): the old copy no longer verifies.
    const NEXT = Buffer.from("#!/bin/sh\necho next\n");
    expect(await ensureCloudflared(base(dataDir, { fetchImpl: fakeFetch(NEXT), pin: pinFor(NEXT, "binary", "2026.10.0") }))).toMatchObject({ source: "downloaded" });
    expect(readFileSync(join(dataDir, "bin", "cloudflared"))).toEqual(NEXT);
  });

  it("a download that does not match the pinned SHA256 is deleted, and nothing is installed", async () => {
    const dataDir = scratch();
    const err = await ensureCloudflared(base(dataDir, { fetchImpl: fakeFetch(Buffer.from("evil")), pin: pinFor(BINARY) })).catch(e => e);
    expect(err).toBeInstanceOf(CloudflaredInstallError);
    expect(err.kind).toBe("checksum-mismatch");
    expect(existsSync(join(dataDir, "bin", "cloudflared"))).toBe(false);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it.each([
    ["offline", () => fakeFetch(async () => { throw new TypeError("fetch failed"); })],
    ["HTTP 404", () => fakeFetch(BINARY, 404)],
  ])("%s: download-failed, nothing installed", async (_name, make) => {
    const dataDir = scratch();
    const err = await ensureCloudflared(base(dataDir, { fetchImpl: make(), pin: pinFor(BINARY) })).catch(e => e);
    expect(err.kind).toBe("download-failed");
    expect(existsSync(join(dataDir, "bin", "cloudflared"))).toBe(false);
  });

  it("a download that never finishes times out", async () => {
    const dataDir = scratch();
    const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const err = await ensureCloudflared(base(dataDir, { fetchImpl, pin: pinFor(BINARY), timeoutMs: 20 })).catch(e => e);
    expect(err).toMatchObject({ kind: "download-failed", message: "timed out" });
  });

  it("a response larger than any cloudflared is refused", async () => {
    const dataDir = scratch();
    const err = await ensureCloudflared(base(dataDir, { fetchImpl: fakeFetch(BINARY), pin: pinFor(BINARY), maxBytes: 8 })).catch(e => e);
    expect(err.kind).toBe("download-failed");
    expect(existsSync(join(dataDir, "bin", "cloudflared"))).toBe(false);
  });

  it("an unsupported platform downloads nothing", async () => {
    const dataDir = scratch();
    const fetchImpl = fakeFetch(BINARY);
    const err = await ensureCloudflared({ ...base(dataDir, { fetchImpl }), platform: "win32" }).catch(e => e);
    expect(err.kind).toBe("unsupported-platform");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("macOS .tgz: the binary inside is installed and stamped with its own hash (real tar)", async () => {
    const dataDir = scratch();
    const src = scratch();
    writeFileSync(join(src, "cloudflared"), BINARY);
    const archive = join(src, "cf.tgz");
    expect(spawnSync("tar", ["-czf", archive, "-C", src, "cloudflared"]).status).toBe(0);
    const tgz = readFileSync(archive);
    const got = await ensureCloudflared(base(dataDir, { fetchImpl: fakeFetch(tgz), pin: pinFor(tgz, "tgz") }));
    expect(got.source).toBe("downloaded");
    expect(readFileSync(got.path)).toEqual(BINARY);
    expect(statSync(got.path).mode & 0o777).toBe(0o755);
    expect(readFileSync(`${got.path}.sha256`, "utf8").trim()).toBe(`2026.9.3 ${sha(tgz)} ${sha(BINARY)}`);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("concurrent requests share one download", async () => {
    const dataDir = scratch();
    const fetchImpl = fakeFetch(BINARY);
    const [a, b] = await Promise.all([
      ensureCloudflared(base(dataDir, { fetchImpl, pin: pinFor(BINARY) })),
      ensureCloudflared(base(dataDir, { fetchImpl, pin: pinFor(BINARY) })),
    ]);
    expect(a).toEqual(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("two processes installing at once each land the verified bytes; neither undoes the other, nothing is left", async () => {
    // A second module instance has its own in-process promise, as another process would.
    vi.resetModules();
    const other = (await import("../src/tunnel/cloudflared-install.js")).ensureCloudflared;
    const dataDir = scratch();
    let releaseA!: () => void;
    const gateA = new Promise<void>(r => { releaseA = r; });
    let startedA!: () => void;
    const aWriting = new Promise<void>(r => { startedA = r; });
    // A's body: half now, the rest only once B is done — A's temp file is on disk meanwhile.
    const fetchA = fakeFetch(async () => new Response(new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new Uint8Array(BINARY.subarray(0, 10)));
        startedA();
        await gateA;
        c.enqueue(new Uint8Array(BINARY.subarray(10)));
        c.close();
      },
    })));
    const a = ensureCloudflared(base(dataDir, { fetchImpl: fetchA, pin: pinFor(BINARY) }));
    await aWriting;
    await vi.waitFor(() => expect(readdirSync(join(dataDir, "bin")).some(f => f.endsWith(".part"))).toBe(true));
    // B runs its whole install while A is mid-download.
    expect(await other(base(dataDir, { fetchImpl: fakeFetch(BINARY), pin: pinFor(BINARY) }))).toMatchObject({ source: "downloaded" });
    releaseA();
    expect(await a).toMatchObject({ source: "downloaded" });
    expect(readFileSync(join(dataDir, "bin", "cloudflared"))).toEqual(BINARY);
    expect(leftovers(dataDir)).toEqual([]);
    expect(await ensureCloudflared(base(dataDir, { fetchImpl: fakeFetch(BINARY), pin: pinFor(BINARY) }))).toMatchObject({ source: "agend" });
  });

  it("after a failed install the next attempt runs, from nothing", async () => {
    const dataDir = scratch();
    await ensureCloudflared(base(dataDir, { fetchImpl: fakeFetch(Buffer.from("evil")), pin: pinFor(BINARY) })).catch(() => {});
    expect(leftovers(dataDir)).toEqual([]);
    expect(await ensureCloudflared(base(dataDir, { fetchImpl: fakeFetch(BINARY), pin: pinFor(BINARY) }))).toMatchObject({ source: "downloaded" });
  });
});

describe("review round 1 (#1141): failures stay contained", () => {
  it("a disk error while writing the download is a typed failure, not a crash; nothing is left", async () => {
    const dataDir = scratch();
    const bin = join(dataDir, "bin");
    const fetchImpl = vi.fn(async () => {
      chmodSync(bin, 0o500);   // the disk refuses the write from here on
      return new Response(new Uint8Array(BINARY));
    });
    const err = await ensureCloudflared(base(dataDir, { fetchImpl, pin: pinFor(BINARY) })).catch(e => e);
    chmodSync(bin, 0o700);
    expect(err).toBeInstanceOf(CloudflaredInstallError);
    expect(err.kind).toBe("install-failed");
    expect(existsSync(join(bin, "cloudflared"))).toBe(false);
  });

  it("the same, in a real child process: it exits normally with the typed error (no unhandled 'error' event)", async () => {
    const dataDir = scratch();
    const built = join(process.cwd(), "dist", "tunnel", "cloudflared-install.js");
    expect(existsSync(built), "build first: this test runs the built module").toBe(true);
    const script = `
      import { chmodSync } from "node:fs";
      import { join } from "node:path";
      import { createHash } from "node:crypto";
      const { ensureCloudflared } = await import(${JSON.stringify(built)});
      const body = Buffer.from("payload");
      const pin = { version: "1", assets: { "linux-x64": { name: "cloudflared-linux-amd64", sha256: createHash("sha256").update(body).digest("hex"), archive: "binary" } } };
      try {
        await ensureCloudflared({ dataDir: ${JSON.stringify(dataDir)}, env: { PATH: "/nonexistent" }, platform: "linux", arch: "x64", pin,
          fetchImpl: async () => { chmodSync(join(${JSON.stringify(dataDir)}, "bin"), 0o500); return new Response(body); } });
        console.log("installed");
      } catch (e) { console.log("typed:" + e.kind); }
      chmodSync(join(${JSON.stringify(dataDir)}, "bin"), 0o700);`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("typed:install-failed");
  });

  it("a cancel stops the download (typed 'cancelled'); one before it starts fetches nothing", async () => {
    const dataDir = scratch();
    const ac = new AbortController();
    const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(() => ac.abort(), 5);
    }));
    expect(await ensureCloudflared(base(dataDir, { fetchImpl, pin: pinFor(BINARY), signal: ac.signal })).catch(e => e.kind)).toBe("cancelled");
    expect(existsSync(join(dataDir, "bin", "cloudflared"))).toBe(false);
    const early = vi.fn();
    expect(await ensureCloudflared(base(scratch(), { fetchImpl: early, pin: pinFor(BINARY), signal: ac.signal })).catch(e => e.kind)).toBe("cancelled");
    expect(early).not.toHaveBeenCalled();
  });

  it("a response we stop reading is ended: bad status and size cap both cancel the body", async () => {
    for (const [status, maxBytes] of [[404, undefined], [200, 4]] as const) {
      let cancelled = 0;
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(16)); },
        cancel() { cancelled++; },
      });
      const err = await ensureCloudflared(base(scratch(), { fetchImpl: vi.fn(async () => new Response(endless, { status })), pin: pinFor(BINARY), maxBytes })).catch(e => e);
      expect(err.kind).toBe("download-failed");
      expect(cancelled, `status ${status}`).toBe(1);
    }
  });

  it("a stamp that cannot be put in place leaves no temporary stamp behind", async () => {
    const dataDir = scratch();
    mkdirSync(join(dataDir, "bin", "cloudflared.sha256"), { recursive: true });   // the stamp's place is a directory
    chmodSync(join(dataDir, "bin"), 0o700);
    await ensureCloudflared(base(dataDir, { fetchImpl: fakeFetch(BINARY), pin: pinFor(BINARY) })).catch(() => {});
    expect(readdirSync(join(dataDir, "bin")).filter(f => f.startsWith("cloudflared.sha256."))).toEqual([]);
  });
});

describe("review round 1 (#1141): nothing in a directory others could write is trusted", () => {
  it("an open bin is closed, and what it held is fetched again (a planted payload is never used)", async () => {
    const dataDir = scratch();
    const bin = join(dataDir, "bin");
    mkdirSync(bin);
    chmodSync(bin, 0o777);
    // A macOS-style install: the stamp names the pinned archive, so in a private bin it would be believed.
    const archive = Buffer.from("the pinned archive");
    const payload = Buffer.from("#!/bin/sh\necho planted\n");
    writeFileSync(join(bin, "cloudflared"), payload, { mode: 0o755 });
    writeFileSync(join(bin, "cloudflared.sha256"), `2026.9.3 ${sha(archive)} ${sha(payload)}\n`);
    const fetchImpl = fakeFetch(archive);
    const got = await ensureCloudflared(base(dataDir, {
      fetchImpl, pin: pinFor(archive, "tgz"),
      extractTgz: async (_a: string, into: string) => { writeFileSync(join(into, "cloudflared"), BINARY); },
    }));
    expect(got.source).toBe("downloaded");
    expect(readFileSync(join(bin, "cloudflared"))).toEqual(BINARY);
    expect(statSync(bin).mode & 0o777).toBe(0o700);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });


  it("a bare binary is checked against the compiled pin, whatever the stamp says", async () => {
    const dataDir = scratch();
    const bin = join(dataDir, "bin");
    mkdirSync(bin, { mode: 0o700 });
    chmodSync(bin, 0o700);
    const payload = Buffer.from("not cloudflared");
    writeFileSync(join(bin, "cloudflared"), payload, { mode: 0o755 });
    writeFileSync(join(bin, "cloudflared.sha256"), `2026.9.3 ${sha(payload)} ${sha(payload)}\n`, { mode: 0o600 });
    const fetchImpl = fakeFetch(BINARY);
    expect(await ensureCloudflared(base(dataDir, { fetchImpl, pin: pinFor(BINARY) }))).toMatchObject({ source: "downloaded" });
    expect(readFileSync(join(bin, "cloudflared"))).toEqual(BINARY);
  });

  it("a bin that is a symlink, belongs to someone else, or sits in a home others can write: refused, nothing written", async () => {
    const outside = scratch();
    const linked = scratch();
    symlinkSync(outside, join(linked, "bin"));
    expect((await ensureCloudflared(base(linked, { fetchImpl: fakeFetch(BINARY), pin: pinFor(BINARY) })).catch(e => e)).kind).toBe("install-failed");
    expect(readdirSync(outside)).toEqual([]);

    const foreign = scratch();
    expect((await ensureCloudflared(base(foreign, { fetchImpl: fakeFetch(BINARY), pin: pinFor(BINARY), uid: (process.getuid?.() ?? 0) + 1 })).catch(e => e)).kind).toBe("install-failed");

    const shared = scratch();
    chmodSync(shared, 0o777);
    const fetchImpl = fakeFetch(BINARY);
    expect((await ensureCloudflared(base(shared, { fetchImpl, pin: pinFor(BINARY) })).catch(e => e)).kind).toBe("install-failed");
    expect(fetchImpl).not.toHaveBeenCalled();
    chmodSync(shared, 0o700);
  });
});

describe("review round 2 (#1141)", () => {
  it("a cancel while the download notice is being posted starts no download, and leaves nothing", async () => {
    const dataDir = scratch();
    const ac = new AbortController();
    const fetchImpl = fakeFetch(BINARY);
    const onDownloading = vi.fn(async () => { ac.abort(); });
    const err = await ensureCloudflared(base(dataDir, { fetchImpl, pin: pinFor(BINARY), signal: ac.signal, onDownloading })).catch(e => e);
    expect(err.kind).toBe("cancelled");
    expect(onDownloading).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readdirSync(join(dataDir, "bin"))).toEqual([]);
  });

  it("a file-size limit that cuts the download short fails the install in a real child process; no short binary is installed", async () => {
    const dataDir = scratch();
    const built = join(process.cwd(), "dist", "tunnel", "cloudflared-install.js");
    expect(existsSync(built), "build first: this test runs the built module").toBe(true);
    const script = `
      import { createHash } from "node:crypto";
      const { ensureCloudflared } = await import(${JSON.stringify(built)});
      const body = Buffer.alloc(4096, 7);
      const pin = { version: "1", assets: { "linux-x64": { name: "cloudflared-linux-amd64", sha256: createHash("sha256").update(body).digest("hex"), archive: "binary" } } };
      try {
        const r = await ensureCloudflared({ dataDir: ${JSON.stringify(dataDir)}, env: { PATH: "/nonexistent" }, platform: "linux", arch: "x64", pin,
          fetchImpl: async () => new Response(body) });
        console.log("installed:" + r.source);
      } catch (e) { console.log("typed:" + e.kind); }`;
    // RLIMIT_FSIZE 1 KiB for this child only: its writes stop short at 1024 bytes.
    const r = spawnSync("bash", ["-c", 'ulimit -f 1 && exec "$0" --input-type=module -e "$1"', process.execPath, script], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("typed:install-failed");
    expect(existsSync(join(dataDir, "bin", "cloudflared"))).toBe(false);
    expect(leftovers(dataDir)).toEqual([]);
  });
});
