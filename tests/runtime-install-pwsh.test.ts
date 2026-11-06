import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeBundle } from "../src/runtime-bundle.js";
import { RUNTIME_BUNDLE_PATH, RUNTIME_INSTALL_SCRIPT_PATH, RuntimeInstallService } from "../src/runtime-install.js";

/**
 * The real install.ps1, as the server serves it, run by a real PowerShell as `irm <server>/runtime/install.ps1 | iex`
 * against a loopback server. What cannot run off Windows (the user PATH in the registry) is switched off with its own
 * AGEND_RUNTIME_NO_PATH; everything else is the script as shipped: download, pinned checksum, unpack, shim, message.
 * Skipped where there is no `pwsh` (CI's pwsh partition has it); the static rules are in runtime-install-script.test.ts.
 */
const probe = spawnSync("pwsh", ["-NoProfile", "-c", "[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName"], { encoding: "utf8" });
const pwsh = probe.status === 0;
/** Absolute, so a run whose PATH holds only a fake node still finds PowerShell itself. */
const PWSH = probe.status === 0 ? probe.stdout.trim() : "pwsh";
const TEMPLATE = readFileSync("templates/runtime-install/install.ps1", "utf8");
const VERSION = "2.3.5-alpha.7";
const roots: string[] = [];
let server: Server | undefined;
const seen: string[] = [];
let behaviour: (req: IncomingMessage, res: ServerResponse, real: () => void) => boolean = () => false;

/** A tiny stored ZIP with the two files the script insists on, so a successful install is the real unpack path. */
function zip(entries: Record<string, string>): Buffer {
  const crc = (data: Buffer): number => { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0, size = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text), file = Buffer.from(`agend-runtime/${name}`), sum = crc(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0x0021, 12); h.writeUInt32LE(sum, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(file.length, 26);
    local.push(h, file, data);
    const d = Buffer.alloc(46); d.writeUInt32LE(0x02014b50, 0); d.writeUInt16LE(0x0314, 4); d.writeUInt16LE(20, 6); d.writeUInt16LE(0x0800, 8); d.writeUInt16LE(0x0021, 14); d.writeUInt32LE(sum, 16); d.writeUInt32LE(data.length, 20); d.writeUInt32LE(data.length, 24); d.writeUInt16LE(file.length, 28); d.writeUInt32LE((0o100644 << 16) >>> 0, 38); d.writeUInt32LE(offset, 42);
    central.push(d, file); size += d.length + file.length; offset += h.length + file.length + data.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(local.length / 3, 8); end.writeUInt16LE(local.length / 3, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
const bytes = zip({ "dist/runtime-cli.js": "// fixture runtime\n", "bundle-manifest.json": "{}\n", "package.json": "{}\n" });
const bundle: RuntimeBundle = { bytes, filename: `agend-runtime-windows-${VERSION}.zip`, version: VERSION, sha256: createHash("sha256").update(bytes).digest("hex") };

beforeAll(async () => {
  if (!pwsh) return;
  vi.stubEnv("AGEND_REMOTE_RUNTIME", "1");
  const service = new RuntimeInstallService({ bundle: () => bundle, template: () => TEMPLATE });
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (behaviour(req, res, () => service.handle(req, res, url))) return;
    if (!service.handle(req, res, url)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
});
afterAll(async () => { vi.unstubAllEnvs(); await new Promise<void>(done => server ? server.close(() => done()) : done()); });
afterEach(() => {
  behaviour = () => false; seen.length = 0;
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe fixture cleanup"); rmSync(root, { recursive: true, force: true }); }
});

const origin = (): string => `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "agend-install-pwsh-")); roots.push(root);
  const local = join(root, "local"); mkdirSync(local);
  const harness = join(root, "harness.ps1");
  // Exactly what the page's command does: $agend is set, then the script is fetched and run by iex in this session.
  writeFileSync(harness, [`$global:LASTEXITCODE = 0`, `if ($env:T_AGEND -ne $null) { $agend = $env:T_AGEND }`, `irm "$env:T_FETCH/runtime/install.ps1" | iex`, `'LASTEXITCODE=' + $LASTEXITCODE`].join("\n"));
  return { root, local, harness, install: join(local, "agend-runtime") };
}
/** Asynchronous on purpose: this process also serves the loopback server pwsh downloads from, so it must not block while pwsh runs. */
function run(s: ReturnType<typeof scratch>, env: Record<string, string> = {}): Promise<{ out: string; code: number }> {
  return new Promise(done => {
    const child = spawn(PWSH, ["-NoProfile", "-NonInteractive", "-File", s.harness],
      { env: { PATH: process.env.PATH ?? "", HOME: s.root, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", LOCALAPPDATA: s.local, AGEND_RUNTIME_NO_PATH: "1", T_FETCH: origin(), T_AGEND: origin(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { out += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    child.on("error", error => { clearTimeout(timer); done({ out: `spawn failed: ${error.message}`, code: NaN }); });
    child.on("close", () => { clearTimeout(timer); done({ out, code: Number(/LASTEXITCODE=(\d+)/.exec(out)?.[1] ?? NaN) }); });
  });
}
const tree = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];

describe.skipIf(!pwsh)("with pwsh: install.ps1 as the server serves it, run by `irm | iex`", { timeout: 120_000 }, () => {
  it("installs under <LOCALAPPDATA>\\agend-runtime\\<version>, writes the shim, and only prints the connect command", async () => {
    const s = scratch(), r = await run(s);
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(s.install, VERSION, "dist", "runtime-cli.js"), "utf8")).toBe("// fixture runtime\n");
    expect(readFileSync(join(s.install, VERSION, ".agend-install-sha256"), "utf8")).toBe(bundle.sha256);
    expect(readFileSync(join(s.install, "bin", "agend-runtime.cmd"), "latin1")).toBe(`@echo off\r\nnode.exe "%~dp0..\\${VERSION}\\dist\\runtime-cli.js" %*\r\n`);
    expect(r.out).toContain(`& "${join(s.install, "bin", "agend-runtime.cmd")}" connect --server "${origin()}"`);
    expect(r.out).toContain("not connected yet and nothing has been paired");
    // It touched the install folder and nothing else: no staging folder left, nothing beside it.
    expect(readdirSync(s.local)).toEqual(["agend-runtime"]); expect(readdirSync(s.install).sort()).toEqual(["bin", VERSION].sort());
    // Two requests, both static downloads: never a pairing endpoint.
    expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`, `GET ${RUNTIME_BUNDLE_PATH}`]);
  });
  it("is idempotent: running it again for the same version downloads nothing and changes nothing", async () => {
    const s = scratch(); expect((await run(s)).code).toBe(0);
    const before = tree(s.install); seen.length = 0;
    const again = await run(s);
    expect(again.code, again.out).toBe(0); expect(again.out).toContain("is already installed");
    expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]); expect(tree(s.install)).toEqual(before);
  });
  it("refuses an archive whose SHA-256 differs from the one pinned in the script: nothing unpacked, nothing installed, exit 1", async () => {
    behaviour = (req, res) => {
      if (req.url !== RUNTIME_BUNDLE_PATH) return false;
      const bad = Buffer.concat([bytes, Buffer.from([0])]);
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": bad.length, "X-Agend-SHA256": createHash("sha256").update(bad).digest("hex") }); res.end(bad); return true;
    };
    const s = scratch(), r = await run(s);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("does not match the checksum pinned in this installer, so nothing was unpacked");
    // The header the tampered response carried is not what the script trusts: its own pinned value is what it compared.
    expect(r.out).toContain(bundle.sha256);
    expect(r.out).not.toContain("connect --server"); expect(r.out).not.toContain("is installed");
    // No version folder, no shim, no staging folder: nothing of the archive was ever written beyond the refused download itself.
    expect(tree(s.install).filter(entry => entry !== "")).toEqual([]);
    expect(existsSync(join(s.install, "bin"))).toBe(false);
    // The install folder this run created is gone again: a refused run leaves no trace at all.
    expect(existsSync(s.install)).toBe(false); expect(readdirSync(s.local)).toEqual([]);
  });
  it("refuses an archive that was swapped for different bytes of the same size", async () => {
    behaviour = (req, res) => {
      if (req.url !== RUNTIME_BUNDLE_PATH) return false;
      const swapped = Buffer.from(bytes); swapped[swapped.length - 30] ^= 0xff;
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": swapped.length }); res.end(swapped); return true;
    };
    const s = scratch(), r = await run(s);
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("nothing was unpacked"); expect(tree(s.install)).toEqual([]);
  });
  it("leaves an earlier install intact when a later run is refused", async () => {
    const s = scratch(); expect((await run(s)).code).toBe(0);
    const before = tree(s.install), shim = readFileSync(join(s.install, "bin", "agend-runtime.cmd"), "latin1");
    rmSync(join(s.install, VERSION, ".agend-install-sha256"));   // makes the next run download again
    behaviour = (req, res) => { if (req.url !== RUNTIME_BUNDLE_PATH) return false; res.writeHead(200, { "Content-Length": 4 }); res.end("nope"); return true; };
    const r = await run(s);
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("nothing was unpacked");
    expect(tree(s.install)).toEqual(before.filter(entry => !entry.endsWith(".agend-install-sha256")));
    expect(readFileSync(join(s.install, "bin", "agend-runtime.cmd"), "latin1")).toBe(shim);
  });
  it("stops before the network when $agend is missing or is not a plain https origin (http only for this computer)", async () => {
    for (const agend of [undefined, "", "http://192.168.1.20:19280", "https://user:pw@host.example", "https://host.example/path", "https://host.example?x=1", "ftp://host.example", "host.example", "https://host.example/ ; calc"]) {
      const s = scratch(), r = await run(s, agend === undefined ? { T_AGEND: "" } : { T_AGEND: agend });
      const fetchOnly = [`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`];
      expect(r.code, `${agend}\n${r.out}`).toBe(1); expect(r.out, String(agend)).toContain("First set $agend");
      expect(seen, String(agend)).toEqual(fetchOnly); seen.length = 0; expect(existsSync(s.install)).toBe(false);
    }
  });
  it("stops with a plain message when Node.js is missing or too old, installing nothing and downloading nothing", async () => {
    for (const [label, version] of [["too old", "v20.11.1"], ["22.13", "v22.13.1"], ["23.5", "v23.5.0"]] as const) {
      const s = scratch(), bin = join(s.root, "fake-node"); mkdirSync(bin);
      writeFileSync(join(bin, "node"), `#!/bin/sh\necho ${version}\n`); chmodSync(join(bin, "node"), 0o755);
      const r = await run(s, { PATH: bin });
      expect(r.code, `${label}\n${r.out}`).toBe(1); expect(r.out).toContain("22.14"); expect(r.out).toContain("winget install OpenJS.NodeJS.LTS");
      expect(seen, label).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]); seen.length = 0; expect(existsSync(s.install)).toBe(false);
    }
    for (const version of ["v22.14.0", "v23.6.0", "v24.0.0"]) {
      const s = scratch(), bin = join(s.root, "fake-node"); mkdirSync(bin);
      writeFileSync(join(bin, "node"), `#!/bin/sh\necho ${version}\n`); chmodSync(join(bin, "node"), 0o755);
      expect((await run(s, { PATH: bin })).code, version).toBe(0);
    }
    const none = scratch(), r = await run(none, { PATH: join(none.root, "empty") });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("Node.js was not found");
  });
  it("refuses to follow a redirect, and to read more than its size cap", async () => {
    behaviour = (req, res) => { if (req.url !== RUNTIME_BUNDLE_PATH) return false; res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere.zip" }); res.end(); return true; };
    const redirected = scratch(), a = await run(redirected);
    expect(a.code, a.out).toBe(1); expect(a.out).toContain("answered 302"); expect(tree(redirected.install)).toEqual([]);
    behaviour = (req, res) => { if (req.url !== RUNTIME_BUNDLE_PATH) return false; res.writeHead(200, { "Content-Length": 20 * 1024 * 1024 }); res.end(Buffer.alloc(1024)); return true; };
    const large = scratch(), b = await run(large);
    expect(b.code, b.out).toBe(1); expect(b.out).toContain("larger than expected"); expect(tree(large.install)).toEqual([]);
  });
  it("accepts only a full drive path for AGEND_RUNTIME_INSTALL_DIR, never a relative one", async () => {
    const s = scratch(), r = await run(s, { AGEND_RUNTIME_INSTALL_DIR: "relative/place" });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("must be a full path on a drive"); expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`, ]);
  });
});
