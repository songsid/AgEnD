/**
 * #1554: the cloudflared download on slow links. A stall timeout instead of a fixed total cap; Cloudflare's package
 * (pkg.cloudflare.com .deb) first on Linux and GitHub as the fallback; every source verified against the same pin.
 * Design baseline: #1554 issuecomment-6093879143. No network: every fetch is a URL-routed fake, every .deb is built
 * here in the exact shape of cloudflared 2026.9.3's packages (ar → data.tar.gz → old-GNU tar ./usr/bin/cloudflared).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
// #1555 review: a fault injected into reading our own downloaded package (and nothing else).
const fsFault = vi.hoisted(() => ({ code: null as string | null }));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, readFile: (async (path: unknown, ...rest: unknown[]) => {
    if (fsFault.code && String(path).endsWith(".deb.part")) throw Object.assign(new Error(`${fsFault.code}: injected`), { code: fsFault.code });
    return (real.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
  }) as typeof real.readFile };
});
import { CLOUDFLARED_PIN, CloudflaredInstallError, ensureCloudflared, packageUrl, releaseUrl, type CloudflaredAsset, type CloudflaredInstallProgress } from "../src/tunnel/cloudflared-install.js";
import { arMember, extractDebFile, tarFile, DebExtractError } from "../src/tunnel/deb-extract.js";
import { PublicLinkProgressTracker, failureOf, renderPublicLinkProgress } from "../src/public-link-progress.js";
import { applyInstallProgress } from "../src/public-web-link.js";
import { setLocale, t } from "../src/locale.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); setLocale("en"); fsFault.code = null; });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-cf1554-")); dirs.push(d); return d; };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const BINARY = Buffer.from("#!/bin/sh\necho 'cloudflared version 2026.9.3'\n".repeat(50));
const OTHER = Buffer.from("#!/bin/sh\necho tampered\n");

/* ---- building packages in the recorded shape ---- */
function tarHeader(name: string, size: number, type = "0", magic: "gnu" | "ustar" = "gnu", prefix = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, "utf8");
  h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write(type, 156);
  if (magic === "gnu") h.write("ustar  \0", 257, "latin1"); else { h.write("ustar\0", 257, "latin1"); h.write("00", 263); h.write(prefix, 345); }
  h.fill(0x20, 148, 156);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return h;
}
function tar(entries: Array<{ name: string; data?: Buffer; type?: string; magic?: "gnu" | "ustar"; prefix?: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    parts.push(tarHeader(e.name, data.length, e.type ?? (e.data ? "0" : "5"), e.magic, e.prefix), data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
function ar(members: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [Buffer.from("!<arch>\n", "latin1")];
  for (const m of members) {
    const header = `${(m.name + "/").padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"644".padEnd(8)}${String(m.data.length).padEnd(10)}\`\n`;
    parts.push(Buffer.from(header, "latin1"), m.data);
    if (m.data.length % 2) parts.push(Buffer.from("\n"));
  }
  return Buffer.concat(parts);
}
const dataTar = (binary: Buffer) => tar([{ name: "./" }, { name: "./usr/" }, { name: "./usr/bin/" }, { name: "./usr/bin/cloudflared", data: binary },
  { name: "./usr/share/doc/cloudflared/changelog.gz", data: Buffer.from("x") }]);
const deb = (binary: Buffer) => ar([{ name: "debian-binary", data: Buffer.from("2.0\n") }, { name: "control.tar.gz", data: gzipSync(tar([{ name: "./control", data: Buffer.from("Package: cloudflared\n") }])) },
  { name: "data.tar.gz", data: gzipSync(dataTar(binary)) }]);

/* ---- a URL-routed fake network ---- */
type Route = Buffer | number | ((signal: AbortSignal) => Response | Promise<Response>);
function network(routes: { pkg?: Route; github?: Route }) {
  const calls: string[] = [];
  const respond = (route: Route | undefined, signal: AbortSignal): Promise<Response> => {
    if (route === undefined) return Promise.reject(new TypeError("fetch failed"));
    if (typeof route === "function") return Promise.resolve(route(signal));
    if (typeof route === "number") return Promise.resolve(new Response("not found", { status: route }));
    return Promise.resolve(new Response(new Uint8Array(route), { status: 200, headers: { "content-length": String(route.length) } }));
  };
  const fetchImpl = vi.fn((url: string, init: { signal: AbortSignal }) => {
    calls.push(url.includes("pkg.cloudflare.com") ? "pkg" : url.includes("github.com") ? "github" : url);
    return respond(url.includes("pkg.cloudflare.com") ? routes.pkg : routes.github, init.signal);
  });
  return { fetchImpl, calls };
}
/** A body that sends `chunks` pieces of `bytes` with `gapMs` between them, honouring the abort signal. */
function trickle(bytes: Buffer, chunks: number, gapMs: number, opts: { stallAfter?: number; contentLength?: boolean } = {}) {
  return (signal: AbortSignal) => {
    const size = Math.ceil(bytes.length / chunks);
    let i = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve, reject) => {
          if (opts.stallAfter !== undefined && i >= opts.stallAfter) { signal.addEventListener("abort", () => reject(new Error("aborted"))); return; }
          timer = setTimeout(() => {
            const piece = bytes.subarray(i * size, (i + 1) * size); i++;
            if (piece.length) controller.enqueue(new Uint8Array(piece));
            if (i * size >= bytes.length) controller.close();
            resolve();
          }, gapMs);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
        });
      },
      cancel() { clearTimeout(timer); },
    });
    return new Response(body, { status: 200, headers: opts.contentLength === false ? {} : { "content-length": String(bytes.length) } });
  };
}

const LINUX: CloudflaredAsset = { name: "cloudflared-linux-amd64", sha256: sha(BINARY), archive: "binary", deb: "amd64" };
const pin = (asset: CloudflaredAsset = LINUX) => ({ version: "2026.9.3", assets: { "linux-x64": asset } });
const base = (dataDir: string, extra: Record<string, unknown>) => ({ dataDir, env: { PATH: "/nonexistent" }, platform: "linux" as NodeJS.Platform, arch: "x64", pinnedOnly: true, pin: pin(), ...extra });
const installed = (dataDir: string) => readFileSync(join(dataDir, "bin", "cloudflared"));
const leftovers = (dataDir: string) => readdirSync(join(dataDir, "bin")).filter(f => f !== "cloudflared" && f !== "cloudflared.sha256");

describe("source order: Cloudflare's package first on Linux, GitHub the fallback, one pin for both", () => {
  it("the real pin: every Linux asset has its package (arm is the `arm` package, never armhf); macOS has none", () => {
    for (const key of ["linux-x64", "linux-arm64", "linux-arm", "linux-ia32"]) {
      const asset = (CLOUDFLARED_PIN.assets as Record<string, CloudflaredAsset>)[key];
      expect(packageUrl(asset), key).toMatch(new RegExp(`^https://pkg\\.cloudflare\\.com/cloudflared/pool/main/c/cloudflared/cloudflared_2026\\.9\\.3_(amd64|arm64|arm|386)\\.deb$`));
    }
    expect(packageUrl((CLOUDFLARED_PIN.assets as Record<string, CloudflaredAsset>)["linux-arm"])).toMatch(/_arm\.deb$/);
    for (const key of ["darwin-x64", "darwin-arm64"]) expect(packageUrl((CLOUDFLARED_PIN.assets as Record<string, CloudflaredAsset>)[key])).toBeNull();
  });

  it("Linux: the package is fetched, the binary inside verified against the pin and installed 0755; GitHub is never asked", async () => {
    const dataDir = scratch(); const net = network({ pkg: deb(BINARY), github: BINARY });
    const got = await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl }));
    expect(got.source).toBe("downloaded");
    expect(net.calls).toEqual(["pkg"]);
    expect(net.fetchImpl.mock.calls[0][0]).toBe(packageUrl(LINUX, "2026.9.3"));
    expect(installed(dataDir)).toEqual(BINARY);
    expect(statSync(join(dataDir, "bin", "cloudflared")).mode & 0o777).toBe(0o755);
    expect(leftovers(dataDir)).toEqual([]);
    // The installed copy verifies on the next start without any fetch.
    expect((await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl }))).source).toBe("agend");
    expect(net.calls).toEqual(["pkg"]);
  });

  it.each([
    ["missing (404)", 404, "failed"],
    ["offline", undefined, "failed"],
  ] as const)("package %s → GitHub, and step ② says so", async (_n, route, reason) => {
    const dataDir = scratch(); const net = network({ pkg: route, github: BINARY });
    const seen: CloudflaredInstallProgress[] = [];
    await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl, onProgress: (p: CloudflaredInstallProgress) => seen.push(p) }));
    expect(net.calls).toEqual(["pkg", "github"]);
    expect(net.fetchImpl.mock.calls[1][0]).toBe(releaseUrl(LINUX, "2026.9.3"));
    expect(installed(dataDir)).toEqual(BINARY);
    expect(seen.filter(p => p.phase === "downloading").at(-1)).toMatchObject({ fallback: { reason } });
    expect(leftovers(dataDir)).toEqual([]);
  });

  it.each([
    ["the binary inside does not match the pin", () => deb(OTHER)],
    ["not an ar archive", () => Buffer.from("<html>blocked by a proxy</html>")],
    ["no data.tar.gz", () => ar([{ name: "debian-binary", data: Buffer.from("2.0\n") }])],
    ["data.tar.gz is not gzip", () => ar([{ name: "data.tar.gz", data: Buffer.from("not gzip") }])],
    ["no usr/bin/cloudflared inside", () => ar([{ name: "data.tar.gz", data: gzipSync(tar([{ name: "./usr/bin/other", data: BINARY }])) }])],
    ["usr/bin/cloudflared is a symlink", () => ar([{ name: "data.tar.gz", data: gzipSync(tar([{ name: "./usr/bin/cloudflared", type: "2" }])) }])],
  ])("a package that is wrong (%s) is never installed; GitHub's verified bytes are", async (_n, make) => {
    const dataDir = scratch(); const net = network({ pkg: make(), github: BINARY });
    await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl }));
    expect(net.calls).toEqual(["pkg", "github"]);
    expect(installed(dataDir)).toEqual(BINARY);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("both sources wrong: the fallback's error, nothing installed, nothing left", async () => {
    const dataDir = scratch(); const net = network({ pkg: deb(OTHER), github: OTHER });
    const err = await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl })).catch(e => e);
    expect(err).toBeInstanceOf(CloudflaredInstallError);
    expect(err.kind).toBe("checksum-mismatch");
    expect(existsSync(join(dataDir, "bin", "cloudflared"))).toBe(false);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("macOS-shaped asset (no package): GitHub only, as before", async () => {
    const dataDir = scratch(); const net = network({ pkg: deb(BINARY), github: BINARY });
    const { deb: _none, ...githubOnly } = LINUX;
    await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl, pin: pin(githubOnly) }));
    expect(net.calls).toEqual(["github"]);
  });

  it("a cancel during the package download stops everything: typed cancelled, GitHub never asked, nothing left", async () => {
    const dataDir = scratch(); const abort = new AbortController();
    const net = network({ pkg: trickle(deb(BINARY), 50, 5), github: BINARY });
    const seen: number[] = [];
    const pending = ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl, signal: abort.signal,
      onProgress: (p: CloudflaredInstallProgress) => { if (p.phase === "downloading") { seen.push(p.received); if (p.received > 0) abort.abort(); } } }));
    const err = await pending.catch(e => e);
    expect(err).toMatchObject({ kind: "cancelled" });
    expect(net.calls).toEqual(["pkg"]);
    expect(existsSync(join(dataDir, "bin", "cloudflared"))).toBe(false);
    expect(leftovers(dataDir)).toEqual([]);
  });
});

describe("stall timeout instead of a fixed total: slow but moving finishes, silent fails", () => {
  it("slow but moving: longer in total than the stall limit, yet every gap shorter — it finishes", async () => {
    const dataDir = scratch(); const net = network({ github: trickle(BINARY, 10, 25) });
    const { deb: _none, ...githubOnly } = LINUX;
    const started = Date.now();
    await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl, pin: pin(githubOnly), stallMs: 120 }));
    expect(Date.now() - started).toBeGreaterThan(120);
    expect(installed(dataDir)).toEqual(BINARY);
  });

  it("no bytes for the stall limit: download-failed (stalled), nothing installed", async () => {
    const dataDir = scratch(); const net = network({ github: trickle(BINARY, 10, 5, { stallAfter: 3 }) });
    const { deb: _none, ...githubOnly } = LINUX;
    const err = await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl, pin: pin(githubOnly), stallMs: 80 })).catch(e => e);
    expect(err).toMatchObject({ kind: "download-failed" });
    expect(err.message).toMatch(/^stalled/);
    expect(existsSync(join(dataDir, "bin", "cloudflared"))).toBe(false);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("the overall ceiling still bounds a download that keeps trickling", async () => {
    const dataDir = scratch(); const net = network({ github: trickle(BINARY, 100, 10) });
    const { deb: _none, ...githubOnly } = LINUX;
    const err = await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl, pin: pin(githubOnly), stallMs: 1_000, timeoutMs: 60 })).catch(e => e);
    expect(err).toMatchObject({ kind: "download-failed", message: "timed out" });
  });

  it("a package that stalls goes to GitHub (reason: failed)", async () => {
    const dataDir = scratch(); const net = network({ pkg: trickle(deb(BINARY), 10, 5, { stallAfter: 2 }), github: BINARY });
    const seen: CloudflaredInstallProgress[] = [];
    await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl, stallMs: 80, onProgress: (p: CloudflaredInstallProgress) => seen.push(p) }));
    expect(net.calls).toEqual(["pkg", "github"]);
    expect(seen.filter(p => p.phase === "downloading").at(-1)).toMatchObject({ fallback: { reason: "failed" } });
    expect(installed(dataDir)).toEqual(BINARY);
  });

  it("a package moving too slowly to finish in reasonable time goes to GitHub (reason: slow); a fast-enough one does not", async () => {
    const slow = scratch(); const slowNet = network({ pkg: trickle(deb(BINARY), 200, 10), github: BINARY });
    const seen: CloudflaredInstallProgress[] = [];
    await ensureCloudflared(base(slow, { fetchImpl: slowNet.fetchImpl, slowCheckMs: 60, slowProjectionMs: 500, onProgress: (p: CloudflaredInstallProgress) => seen.push(p) }));
    expect(slowNet.calls).toEqual(["pkg", "github"]);
    expect(seen.filter(p => p.phase === "downloading").at(-1)).toMatchObject({ fallback: { reason: "slow" } });
    const fine = scratch(); const fineNet = network({ pkg: trickle(deb(BINARY), 20, 10), github: BINARY });
    await ensureCloudflared(base(fine, { fetchImpl: fineNet.fetchImpl, slowCheckMs: 60, slowProjectionMs: 5_000 }));
    expect(fineNet.calls).toEqual(["pkg"]);
  });

  it("GitHub as the fallback is never judged for pace (there is nowhere else to go)", async () => {
    const dataDir = scratch(); const net = network({ pkg: 404, github: trickle(BINARY, 30, 10) });
    await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl, slowCheckMs: 20, slowProjectionMs: 50 }));
    expect(installed(dataDir)).toEqual(BINARY);
  });
});

describe("deb-extract: the shapes accepted, and everything else refused", () => {
  const good = deb(BINARY);
  it("the recorded shape: ar → data.tar.gz → old-GNU tar ./usr/bin/cloudflared", async () => {
    expect(await extractDebFile(good, "usr/bin/cloudflared", 1 << 20)).toEqual(BINARY);
  });
  it("ar: a member after an odd-sized one (padding) is found; GNU names end in /", () => {
    const a = ar([{ name: "debian-binary", data: Buffer.from("2.0") }, { name: "data.tar.gz", data: Buffer.from("abc") }]);
    expect(arMember(a, "data.tar.gz").toString()).toBe("abc");
  });
  it.each([
    ["not an ar archive", Buffer.from("PK\x03\x04 zip")],
    ["a truncated header", Buffer.concat([Buffer.from("!<arch>\n"), Buffer.from("data.tar.gz/    0")])],
    ["a bad header terminator", Buffer.from(`!<arch>\n${"data.tar.gz/".padEnd(48)}${"3".padEnd(10)}XXabc`, "latin1")],
    ["a bad size", Buffer.from(`!<arch>\n${"data.tar.gz/".padEnd(48)}${"-3".padEnd(10)}\`\nabc`, "latin1")],
    ["a member running past the end", Buffer.from(`!<arch>\n${"data.tar.gz/".padEnd(48)}${"99".padEnd(10)}\`\nabc`, "latin1")],
  ])("ar: %s is refused", (_n, archive) => {
    expect(() => arMember(archive, "data.tar.gz")).toThrow(DebExtractError);
  });
  it("tar: a ustar prefix is joined; an old-GNU header's 345 field is not a prefix", () => {
    const ustar = tar([{ name: "cloudflared", data: Buffer.from("A"), magic: "ustar", prefix: "./usr/bin" }]);
    expect(tarFile(ustar, "usr/bin/cloudflared").toString()).toBe("A");
    const gnu = tarHeader("./usr/bin/cloudflared", 1);
    gnu.write("garbage", 345); // not a prefix in old GNU format; the checksum is recomputed
    gnu.fill(0x20, 148, 156); let sum = 0; for (const b of gnu) sum += b; gnu.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
    expect(tarFile(Buffer.concat([gnu, Buffer.from("B"), Buffer.alloc(511 + 1024)]), "usr/bin/cloudflared").toString()).toBe("B");
  });
  it.each([
    ["a bad header checksum", (() => { const t = dataTar(BINARY); t[0] ^= 1; return t; })()],
    ["an entry running past the end", dataTar(BINARY).subarray(0, 4 * 512 + 100)],
    ["the file missing", tar([{ name: "./usr/bin/other", data: BINARY }])],
    ["a hard link where the file should be", tar([{ name: "./usr/bin/cloudflared", type: "1" }])],
  ])("tar: %s is refused", (_n, archive) => {
    expect(() => tarFile(archive, "usr/bin/cloudflared")).toThrow(DebExtractError);
  });
  it("decompression is bounded: data larger than the cap is refused", async () => {
    await expect(extractDebFile(good, "usr/bin/cloudflared", 1024)).rejects.toThrow(DebExtractError);
  });
});

describe("step ② says when the source switched (en, zh-TW)", () => {
  it.each([["en"], ["zh-TW"]] as const)("%s", locale => {
    setLocale(locale);
    let clock = 0;
    const p = new PublicLinkProgressTracker(() => clock, () => {});
    p.installChecked(true, "2026.9.3"); clock = 4_000; p.downloaded(12 * 1024 * 1024, 38.3 * 1024 * 1024, "slow");
    const text = renderPublicLinkProgress(p.snapshot, clock);
    expect(text).toContain(t("dashboard.progress.download_fallback", "12.0 / 38.3 MB", t("dashboard.progress.fallback_slow")));
    expect(text).toContain("GitHub");
    expect(text).toContain("pkg.cloudflare.com");
  });
});

describe("#1555 review", () => {
  it.each([["EACCES"], ["EIO"]])("reading our own downloaded package failing (%s) is local: install-failed, GitHub never asked, nothing installed", async code => {
    const dataDir = scratch(); const net = network({ pkg: deb(BINARY), github: BINARY });
    fsFault.code = code;
    const err = await ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl })).catch(e => e);
    expect(err).toMatchObject({ kind: "install-failed" });
    expect(err.message).toContain(code);
    expect(net.calls).toEqual(["pkg"]);
    expect(existsSync(join(dataDir, "bin", "cloudflared"))).toBe(false);
    expect(leftovers(dataDir)).toEqual([]);
  });

  /** The first bytes, then the event loop held for `holdMs` (the stall timer cannot run), then the rest at once. */
  const late = (holdMs: number) => () => {
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(BINARY.subarray(0, 5))); },
      pull(c) {
        if (sent) return;
        sent = true;
        const until = performance.now() + holdMs; while (performance.now() < until) { /* hold the loop */ }
        c.enqueue(new Uint8Array(BINARY.subarray(5))); c.close();
      },
    }), { status: 200, headers: { "content-length": String(BINARY.length) } });
  };
  it("bytes that arrive after the stall deadline are not accepted, even though the timer has not run yet", async () => {
    const { deb: _none, ...githubOnly } = LINUX;
    const dataDir = scratch();
    const err = await ensureCloudflared(base(dataDir, { fetchImpl: network({ github: late(140) }).fetchImpl, pin: pin(githubOnly), stallMs: 80 })).catch(e => e);
    expect(err).toMatchObject({ kind: "download-failed" });
    expect(err.message).toMatch(/^stalled/);
    expect(existsSync(join(dataDir, "bin", "cloudflared"))).toBe(false);
    expect(leftovers(dataDir)).toEqual([]);
    const ok = scratch(); // control: inside the deadline
    await ensureCloudflared(base(ok, { fetchImpl: network({ github: late(10) }).fetchImpl, pin: pin(githubOnly), stallMs: 80 }));
    expect(installed(ok)).toEqual(BINARY);
  });

  it("a wrong package, then GitHub: ② is active again (no ③) while GitHub downloads, and a GitHub 404 fails at ②", async () => {
    const dataDir = scratch();
    let answer!: (r: Response) => void;
    const held = new Promise<Response>(resolve => { answer = resolve; });
    const net = network({ pkg: deb(OTHER), github: () => held });
    const tracker = new PublicLinkProgressTracker(() => performance.now(), () => {});
    const pending = ensureCloudflared(base(dataDir, { fetchImpl: net.fetchImpl, onProgress: (p: CloudflaredInstallProgress) => applyInstallProgress(tracker, p) })).catch(e => e);
    await vi.waitFor(() => expect(net.calls).toEqual(["pkg", "github"]));
    const running = tracker.snapshot.steps.at(-1)!;
    expect(running.step).toBe("download");
    expect(running.endedAt).toBeUndefined();
    expect(tracker.snapshot.steps.filter(s => s.step === "download")).toHaveLength(1);
    expect(tracker.snapshot.steps.some(s => s.step === "verify")).toBe(false);
    expect(tracker.snapshot.download?.fallback).toBe("failed");
    answer(new Response("not found", { status: 404 }));
    const err = await pending;
    tracker.fail(failureOf(err.kind)); // what PublicWebLink does with a failed start
    expect(tracker.snapshot.failed).toEqual({ step: "download", reason: "download-failed" });
    // control: the package missing and GitHub missing also fail at ②
    const both = new PublicLinkProgressTracker(() => performance.now(), () => {});
    const e2 = await ensureCloudflared(base(scratch(), { fetchImpl: network({ pkg: 404, github: 404 }).fetchImpl, onProgress: (p: CloudflaredInstallProgress) => applyInstallProgress(both, p) })).catch(e => e);
    both.fail(failureOf(e2.kind));
    expect(both.snapshot.failed).toEqual({ step: "download", reason: "download-failed" });
  });
});
