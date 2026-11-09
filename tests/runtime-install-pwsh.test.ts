import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBundle } from "../src/runtime-bundle.js";
import { RUNTIME_BUNDLE_PATH, RUNTIME_INSTALL_SCRIPT_PATH, RuntimeInstallService } from "../src/runtime-install.js";
import { runtimeEnrollCommand, runtimeInstallCommand, runtimeInstallOnlyCommand } from "../src/ui/runtime-commands.js";
import { runtimeFreshInstallCommand } from "../src/ui/runtime-update-commands.js";
import { extractPsFunction } from "./support/installer-ps-extract.js";
import { acquireRuntimeInstallLock, parseRuntimeInstallLock, RUNTIME_INSTALL_LOCK } from "../src/runtime-update-lock.js";
import { readRuntimeInstallReceipt, RUNTIME_INSTALL_RECEIPT } from "../src/runtime-update-install.js";
import { paneSystemBootId } from "../src/runtime-pane-boot.js";

/**
 * The real install.ps1, as the server serves it, run by a real PowerShell against a loopback server, the way the page's command
 * runs it: the command downloads the script, checks its SHA-256 against the one the page shows and only then runs it (iex).
 * The command under test is built by the same function the page uses. What cannot run off Windows (the user PATH in the registry,
 * cmd.exe running the shim) is switched off (AGEND_RUNTIME_NO_PATH) or covered by the static tests and the real-Windows run;
 * everything else is the script as shipped. Skipped where there is no `pwsh` (CI's pwsh partition has it).
 */
const probe = spawnSync("pwsh", ["-NoProfile", "-c", "[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName"], { encoding: "utf8" });
const pwsh = probe.status === 0;
/** Absolute, so a run whose PATH holds only a fake node still finds PowerShell itself. */
const PWSH = probe.status === 0 ? probe.stdout.trim() : "pwsh";
const TEMPLATE = readFileSync("templates/runtime-install/install.ps1", "utf8");
// Linux fixture only: process/file operations are real; the Windows-only boot source is fixed and never queries the host.
const BOOT_FIXTURE = "function global:Get-CimInstance { [pscustomobject]@{LastBootUpTime=[DateTime]::new(638980000000000000,[DateTimeKind]::Utc)} }";
const VERSION = "2.3.5-alpha.7", NEXT = "2.3.6-alpha.1";
/** SHA-256 of the exact bytes of connect-agend.bat as the installer writes it; see the matching pin in runtime-install-script.test.ts. */
const BAT_SHA256 = "becead46b15ae681a41fc33143e48c54f5f1cebb3f9d60c23b8ab8c6f0d3d85a";
const roots: string[] = [];
let server: Server | undefined;
const seen: string[] = [];
let behaviour: (req: IncomingMessage, res: ServerResponse) => boolean = () => false;
let clock = 1_000_000;
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A tiny stored ZIP with the files the script insists on, so a successful install is the real unpack path. */
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
function makeBundle(version: string, tag = version, cli = `// fixture runtime ${tag}\n`): RuntimeBundle {
  const bytes = zip({ "dist/runtime-cli.js": cli, "bundle-manifest.json": "{}\n", "package.json": "{}\n" });
  return { bytes, filename: `agend-runtime-windows-${version}.zip`, version, sha256: sha(bytes) };
}
const serviceFor = (bundle: RuntimeBundle): RuntimeInstallService => new RuntimeInstallService({ bundle: () => bundle, template: () => TEMPLATE, now: () => clock });
/** The install folder names the build as well as the version, so a different build of the same version lands beside it. */
const folderOf = (bundle: RuntimeBundle): string => `${bundle.version}+${bundle.sha256.slice(0, 8)}`;
const bundleA = makeBundle(VERSION), serviceA = serviceFor(bundleA), FOLDER_A = folderOf(bundleA);
let active: RuntimeInstallService = serviceA;

beforeAll(async () => {
  if (!pwsh) return;
  vi.stubEnv("AGEND_REMOTE_RUNTIME", "1");
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (behaviour(req, res)) return;
    if (!active.handle(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
});
afterAll(async () => { vi.unstubAllEnvs(); await new Promise<void>(done => server ? server.close(() => done()) : done()); });
afterEach(() => {
  behaviour = () => false; active = serviceA; seen.length = 0;
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe fixture cleanup"); rmSync(root, { recursive: true, force: true }); }
});

const origin = (): string => `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "agend-install-pwsh-")); roots.push(root);
  const local = join(root, "local"); mkdirSync(local, { mode: 0o700 });
  const harness = join(root, "harness.ps1");
  // mode "command": exactly what the page copies, run by iex in this session. mode "direct": the served script run without the page's check,
  // for what the script itself must refuse (a bad $agend, an old Node) on its own.
  writeFileSync(harness, [
    "$global:LASTEXITCODE = 0", BOOT_FIXTURE,
    "if ($env:T_PRESET) { Invoke-Expression $env:T_PRESET }",
    "try {",
    "  if ($env:T_MODE -eq 'direct') { if ($env:T_AGEND -ne $null) { $agend = $env:T_AGEND }; $direct = (Invoke-WebRequest \"$env:T_FETCH/runtime/install.ps1\" -UseBasicParsing).Content; Invoke-Expression $direct }",
    "  else { Invoke-Expression $env:T_COMMAND }",
    "} catch { Write-Host ('COMMAND-ERROR: ' + $_.Exception.Message) }",
    "'VARS=[' + $agendEnroll + '|' + $agendFingerprint + ']'",
    "'LASTEXITCODE=' + $LASTEXITCODE",
  ].join("\n"));
  return { root, local, harness, install: join(local, "agend-runtime"), marker: join(root, "script-ran.txt") };
}
/** The command the page shows for this installer (the same function), for the hash the server reports. */
const pageCommand = (service: RuntimeInstallService = active, base = origin()): string => runtimeInstallCommand(base, service.installer().scriptSha256);
/** Asynchronous on purpose: this process also serves the loopback server pwsh downloads from, so it must not block while pwsh runs. */
function run(s: ReturnType<typeof scratch>, env: Record<string, string> = {}, mode: "harness" | "paste" = "harness"): Promise<{ out: string; code: number; status: number | null; verifyFailed: boolean }> {
  clock += 600_000; seen.length = 0;   // each run is a new person at a new minute: the rate limit has its own tests
  // "paste": the command (after any preset line) is the whole file, so a failing statement does not stop the next one, as at a prompt
  const file = mode === "paste" ? join(s.root, "pasted.ps1") : s.harness;
  if (mode === "paste") writeFileSync(file, `${BOOT_FIXTURE}\n${env.T_PRESET ?? ""}\n${env.T_COMMAND ?? pageCommand()}\n'LASTEXITCODE=' + $LASTEXITCODE\n`);
  return new Promise(done => {
    const previousMask = process.umask(0o077);
    let child;
    try { child = spawn(PWSH, ["-NoProfile", "-NonInteractive", "-File", file],
      { env: { PATH: process.env.PATH ?? "", HOME: s.root, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", LOCALAPPDATA: s.local, AGEND_RUNTIME_NO_PATH: "1", T_FETCH: origin(), T_AGEND: origin(), T_MODE: "command", T_COMMAND: pageCommand(), ...env }, stdio: ["ignore", "pipe", "pipe"] }); } finally { process.umask(previousMask); }
    let out = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { out += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    child.on("error", error => { clearTimeout(timer); done({ out: `spawn failed: ${error.message}`, code: NaN, status: null, verifyFailed: false }); });
    child.on("close", status => { clearTimeout(timer); done({ out, status, code: Number(/LASTEXITCODE=(\d+)/.exec(out)?.[1] ?? NaN), verifyFailed: /install\.ps1 could not be verified/.test(out) }); });
  });
}
const LOCK_HELPERS = ["Resolve-AgendOrigin", "Set-AgendFile", "Assert-AgendDirectory", "Read-AgendSmallFile", "Get-AgendBootProof", "Test-AgendOwnerRecord", "Get-AgendProcessMatch", "Read-AgendLock", "Assert-AgendLock", "Remove-AgendLock", "Enter-AgendInstallLock", "Register-AgendInstallOrigin",
  "Test-AgendSwitch", "Test-AgendInteractive", "Get-AgendConnectMode", "Test-AgendEnrollToken", "Test-AgendFingerprint", "Get-AgendConnectName", "Write-AgendConnectEntry"]
  .map(name => extractPsFunction(TEMPLATE, name)).join("\n");
/** The script's own `$connectBatText = (...) -join` statement, so a helper run writes exactly the text the installer writes. */
const BAT_STATEMENT = /\$connectBatText = \([\s\S]*?\) -join "`r`n"/.exec(TEMPLATE)![0];
function helperRun(s: ReturnType<typeof scratch>, body: string): Promise<string> {
  const file = join(s.root, `helpers-${randomUUID()}.ps1`);
  writeFileSync(file, `$ErrorActionPreference='Stop'\n${BOOT_FIXTURE}\n${LOCK_HELPERS}\n${BAT_STATEMENT}\n${body}`);
  return new Promise((done, reject) => {
    const previousMask = process.umask(0o077);
    let child;
    try { child = spawn(PWSH, ["-NoProfile", "-NonInteractive", "-File", file], { env: { ...process.env, HOME: s.root, T_ROOT: s.install }, stdio: ["ignore", "pipe", "pipe"] }); } finally { process.umask(previousMask); }
    let out = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { out += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? done(out.trim()) : reject(Error(`Helper exited ${code}: ${out}`)); });
  });
}
const tree = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];
/** Every file under a folder with its bytes and modification time: equal before and after means it was not touched. */
const snapshot = (dir: string): Record<string, string> => Object.fromEntries(tree(dir).filter(entry => statSync(join(dir, entry)).isFile()).map(entry => [entry, `${sha(readFileSync(join(dir, entry)))}@${statSync(join(dir, entry)).mtimeMs}`]));
/** The script the server really sends, so a tampered copy can be made from it. */
const realScript = (service: RuntimeInstallService = serviceA): Buffer => {
  let sent = Buffer.alloc(0);
  const req = { method: "GET", url: RUNTIME_INSTALL_SCRIPT_PATH, headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
  const res = { destroyed: false, writableEnded: false, writeHead() { return res; }, end(chunk?: Buffer) { sent = Buffer.from(chunk ?? ""); return res; } } as unknown as ServerResponse;
  service.handle(req, res, new URL(RUNTIME_INSTALL_SCRIPT_PATH, "http://localhost")); return sent;
};
const serveScript = (bytes: Buffer, status = 200) => (req: IncomingMessage, res: ServerResponse): boolean => {
  if (req.url !== RUNTIME_INSTALL_SCRIPT_PATH) return false;
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": bytes.length }); res.end(bytes); return true;
};

describe.skipIf(!pwsh)("with pwsh: the page's command and install.ps1, run against a loopback server", { timeout: 180_000 }, () => {
  it("the fresh-root repair command runs only in a new folder with the pinned script; blocked controls never fall back", async () => {
    const s=scratch(), sentinel="Write-Output ('FRESH-RAN:' + $env:AGEND_RUNTIME_INSTALL_DIR + ':' + $env:AGEND_RUNTIME_NO_PATH + ':' + $env:AGEND_RUNTIME_REPAIR)", quoted=(value:string)=>`'${value.replace(/'/g,"''")}'`;
    const file=join(s.root,"fresh-command.ps1");writeFileSync(file,runtimeFreshInstallCommand("https://paired.example.test",sha(Buffer.from(sentinel))));
    const out=await helperRun(s,`$ErrorActionPreference='Continue'
      function global:Invoke-WebRequest { param($Uri,[switch]$UseBasicParsing); [pscustomobject]@{Content=$global:Sentinel} }
      function global:Test-Path { param($LiteralPath); if($global:Collision){return $true}; Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath }
      foreach($case in @('valid','no-home','exists','bad-download')) {
        $env:LOCALAPPDATA=${quoted(s.local)}; $env:AGEND_RUNTIME_INSTALL_DIR=${quoted(s.install)}
        $global:Collision=$case -eq 'exists'; $global:Sentinel=${quoted(sentinel)}
        if($case -eq 'no-home'){$env:LOCALAPPDATA=''}
        if($case -eq 'bad-download'){$global:Sentinel='Write-Output UNVERIFIED'}
        Write-Output ('CASE:'+$case)
        try { & ${quoted(file)} } catch { Write-Output ('BLOCKED:'+$case) }
      }`);
    expect((out.match(/FRESH-RAN:/g)??[])).toHaveLength(1);expect(out).toContain(`FRESH-RAN:${join(s.local,"agend-runtime-")}`);
    for(const blocked of ['no-home','exists','bad-download'])expect(out).toContain(`BLOCKED:${blocked}`);
    expect(out).not.toContain('UNVERIFIED');expect(out).toContain(':1:1');expect(readdirSync(s.local)).toEqual([]);
  });
  it("repair output selects the new shim over an old PATH entry and retains the supplied existing profile", async () => {
    const s=scratch(), old=join(s.root,"old-bin"), profile=join(s.root,"existing 'profile'"), quoted=(value:string)=>`'${value.replace(/'/g,"''")}'`;
    s.local=join(s.root,"local's data");s.install=join(s.local,"agend-runtime");mkdirSync(s.local);
    mkdirSync(old); const oldCommand=join(old,process.platform==="win32"?"agend-runtime.cmd":"agend-runtime");writeFileSync(oldCommand,process.platform==="win32"?"@echo OLD-PATH-RUNTIME\r\n":"#!/bin/sh\necho OLD-PATH-RUNTIME\n");chmodSync(oldCommand,0o700);
    mkdirSync(profile); writeFileSync(join(profile,"connection.json"),'{"paired":"keep"}'); const before=snapshot(profile);
    const preset=`$env:PATH=${quoted(old)}+[IO.Path]::PathSeparator+$env:PATH`;
    const r=await run(s,{AGEND_RUNTIME_REPAIR:"1",AGEND_RUNTIME_NO_PATH:"",T_PRESET:preset});
    expect(r.code,r.out).toBe(0); expect(r.out).not.toContain('connect --server'); expect(r.out).not.toContain('one-time pairing code');
    expect(existsSync(join(s.install,"connect")),"a repair run leaves no reconnect entry and never connects").toBe(false);
    const command=r.out.split(/\r?\n/).find(line=>line.includes('Read-Host')&&line.includes('start --profile'))?.trim(); expect(command,r.out).toBeTruthy();
    const shim=join(s.install,"bin","agend-runtime.cmd");expect(command).toContain(shim.replace(/'/g,"''"));
    const out=await helperRun(s,`${preset}
      'OLD-RESOLVES:' + (Get-Command agend-runtime).Source
      function global:Invoke-NewFixtureRuntime { 'NEW:' + ($args | ConvertTo-Json -Compress) }
      Set-Alias -Name ${quoted(shim)} -Value Invoke-NewFixtureRuntime
      function global:Read-Host { ${quoted(profile)} }
      ${command}
      function global:Read-Host { '' }
      try { ${command} } catch { 'EMPTY-PROFILE-REFUSED' }`);
    expect(out).toContain('OLD-RESOLVES:'+oldCommand);expect(out).toContain('EMPTY-PROFILE-REFUSED');expect((out.match(/NEW:/g)??[])).toHaveLength(1);
    expect(out).toContain('NEW:'+JSON.stringify(['start','--profile',profile]));expect(out).not.toContain('OLD-PATH-RUNTIME');expect(snapshot(profile)).toEqual(before);
  });
  it("runs the page's command: downloads the script, checks its hash, then installs under <LOCALAPPDATA>\\agend-runtime\\<version> and, with no interactive console, only prints the connect command", async () => {
    const s = scratch(), r = await run(s);
    expect(r.code, r.out).toBe(0); expect(r.verifyFailed).toBe(false);
    expect(readFileSync(join(s.install, FOLDER_A, "dist", "runtime-cli.js"), "utf8")).toBe(`// fixture runtime ${VERSION}\n`);
    expect(readFileSync(join(s.install, FOLDER_A, ".agend-install-sha256"), "utf8")).toBe(bundleA.sha256);
    // a shim that names no version, and the one small file that says which version it starts
    const shim = readFileSync(join(s.install, "bin", "agend-runtime.cmd"), "latin1");
    expect(shim).toContain('set /p AGEND_RT_VERSION=<"%~dp0current.txt"'); expect(shim).not.toContain(VERSION); expect(shim.split("\r\n").length).toBeGreaterThan(8);
    expect(readFileSync(join(s.install, "bin", "current.txt"), "latin1")).toBe(FOLDER_A);   // version+build, e.g. 2.3.5-alpha.7+1a2b3c4d
    expect(r.out).toContain(`& "${join(s.install, "bin", "agend-runtime.cmd")}" connect --server "${origin()}"`);
    expect(r.out).toContain("not connected yet and nothing has been paired"); expect(r.out).toContain("not an interactive console"); expect(r.out).not.toContain("connecting this computer");
    expect(r.out).toContain("cannot be put in a command, a variable or a file");
    // the reconnect entry sits beside the Runtime and the output says where, for a person to double-click
    const [entry] = readdirSync(join(s.install, "connect")); expect(r.out).toContain(join(s.install, "connect", entry, "connect-agend.bat"));
    expect(readRuntimeInstallReceipt(s.install)).toMatchObject({ version: 1, revision: 1, origins: [origin()], shared: false });
    // It touched the install folder and nothing else: no staging folder or temporary file left, nothing beside it.
    expect(readdirSync(s.local)).toEqual(["agend-runtime"]); expect(readdirSync(s.install).sort()).toEqual([RUNTIME_INSTALL_RECEIPT, "bin", "connect", FOLDER_A].sort()); expect(readdirSync(join(s.install, "bin")).sort()).toEqual(["agend-runtime.cmd", "current.txt"]);
    // Two requests, both static downloads: never a pairing endpoint.
    expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`, `GET ${RUNTIME_BUNDLE_PATH}`]);
  });
  it("is idempotent: running it again for the same version downloads no archive and changes nothing, not even a modification time", async () => {
    const s = scratch(); expect((await run(s)).code).toBe(0);
    const before = snapshot(s.install); seen.length = 0;
    const again = await run(s);
    expect(again.code, again.out).toBe(0); expect(again.out).toContain("is already installed");
    expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]); expect(snapshot(s.install)).toEqual(before);
  });

  describe("the page's hash check (M1): a script that is not the one the page vouches for never runs", () => {
    const sentinel = (marker: string) => Buffer.from(`\nSet-Content -LiteralPath '${marker}' -Value 'the tampered script ran'\n`);
    const expectRefused = (s: ReturnType<typeof scratch>, r: Awaited<ReturnType<typeof run>>) => {
      expect(r.verifyFailed, r.out).toBe(true); expect(r.out).toContain("reload the page and copy the command again");
      expect(existsSync(s.marker), "the tampered script must not have run").toBe(false);
      expect(existsSync(s.install), "nothing installed").toBe(false); expect(readdirSync(s.local)).toEqual([]);
      expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]);   // not even the archive was requested
      expect(r.out).not.toContain("installed version");
    };
    it("refuses a script with something appended, and runs none of it", async () => {
      const s = scratch(); behaviour = serveScript(Buffer.concat([realScript(), sentinel(s.marker)]));
      expectRefused(s, await run(s));
    });
    it("refuses a script with a single byte changed", async () => {
      const s = scratch(), script = Buffer.from(realScript()), at = script.indexOf("Node.js"); script[at] = script[at] ^ 0x01; behaviour = serveScript(Buffer.concat([script, sentinel(s.marker)]));
      expectRefused(s, await run(s));
    });
    it("refuses a script whose line ends were rewritten on the way (the hash is of the exact bytes sent)", async () => {
      const s = scratch(); behaviour = serveScript(Buffer.from(realScript().toString("utf8").replace(/\n/g, "\r\n") + sentinel(s.marker).toString()));
      expectRefused(s, await run(s));
      const bare = scratch(); behaviour = serveScript(Buffer.from(realScript().toString("utf8").replace(/\n/g, "\r\n")));
      expectRefused(bare, await run(bare));   // even with nothing added: the bytes differ from what the page vouched for
    });
    it("refuses the same script with a byte-order mark in front, and a script that is another server's", async () => {
      const s = scratch(); behaviour = serveScript(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), realScript(), sentinel(s.marker)]));
      expectRefused(s, await run(s));
      const other = scratch(); behaviour = serveScript(Buffer.concat([realScript(serviceFor(makeBundle("9.9.9", "other"))), sentinel(other.marker)]));
      expectRefused(other, await run(other));
    });
    it("refuses a command whose hash is stale (the server was updated since the page was loaded), saying to reload the page", async () => {
      const s = scratch(), stale = runtimeInstallCommand(origin(), sha(Buffer.from("an older script")));
      const r = await run(s, { T_COMMAND: stale });
      expectRefused(s, r);
    });
    it("runs nothing when the script cannot be fetched at all, and never reruns a script left in $s by an earlier attempt", async () => {
      behaviour = serveScript(Buffer.from("down"), 500);
      // pasted at a prompt, a failed download does not stop the next statement; $s from an earlier command holds a script that would write the sentinel
      const s = scratch(), r = await run(s, { T_PRESET: `$s = "Set-Content -LiteralPath '${s.marker}' -Value 'stale script ran'"` }, "paste");
      expect(r.verifyFailed, r.out).toBe(true); expect(existsSync(s.marker), "the stale script must not run").toBe(false); expect(existsSync(s.install)).toBe(false);
      expect(r.status).not.toBe(0); expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]);
      // and through the harness (an exception ends it at the download): still nothing runs
      const t = scratch(), u = await run(t, { T_PRESET: `$s = "Set-Content -LiteralPath '${t.marker}' -Value 'stale script ran'"` });
      expect(existsSync(t.marker)).toBe(false); expect(existsSync(t.install)).toBe(false); expect(u.out).toMatch(/could not be verified|does not indicate success/);
    });
    it("stops, and runs nothing, when the check itself cannot be computed: ConstrainedLanguage, under any $ErrorActionPreference (B1: any step failing must not reach iex)", async () => {
      // In ConstrainedLanguage [Security.Cryptography.SHA256]::Create() is refused. That is a statement-terminating error: an `if` whose condition throws it is
      // skipped, and a command written as `if (bad) { throw }; iex $s` then runs the unverified script. The sentinel proves whether it did.
      for (const preference of ["Continue", "SilentlyContinue", "Stop"]) {
        const s = scratch(); behaviour = serveScript(Buffer.concat([realScript(), sentinel(s.marker)]));
        const r = await run(s, { T_PRESET: `$ErrorActionPreference = '${preference}'; $ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'` }, "paste");
        expect(existsSync(s.marker), `the unverified script must not run (${preference})\n${r.out}`).toBe(false);
        expect(existsSync(s.install), `nothing installed (${preference})`).toBe(false); expect(readdirSync(s.local)).toEqual([]);
        // (under Stop the failing TLS line ends the command before even the script is requested: stricter, and just as safe)
        expect(seen.filter(request => request !== `GET ${RUNTIME_INSTALL_SCRIPT_PATH}`), `no archive was requested (${preference})`).toEqual([]);
        // the message is always shown, even when the person's own $ErrorActionPreference swallows a bare throw (it then also lets the session carry on)
        // (under Stop the first failure, the TLS line, is itself what ends the command, and its own error is what is shown)
        if (preference === "Stop") expect(r.out, "the reason is shown (Stop)").toMatch(/Cannot set property|only on core types/i);
        else expect(r.out, `the reason is shown (${preference})`).toContain("could not be verified");
        if (preference !== "SilentlyContinue") expect(r.status, `the command ends in an error (${preference})`).not.toBe(0);
        // the TLS 1.2 line is the first thing in the command and fails in ConstrainedLanguage; the check after it still refuses
        if (preference === "Continue") expect(r.out).toMatch(/Cannot set property|only on core types|Property setting is supported only on core types/i);
      }
      // an honest script in ConstrainedLanguage is stopped as well: the hash cannot be checked, so nothing runs
      const honest = scratch(), h = await run(honest, { T_PRESET: "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'" }, "paste");
      expect(existsSync(honest.install), h.out).toBe(false); expect(h.out).toContain("could not be verified"); expect(h.out).not.toContain("installed version");
    });
    it("in the FULL language mode, a person's own $ErrorActionPreference never lets a tampered script run: under SilentlyContinue a bare throw is swallowed, so iex must not come after it", async () => {
      // The previous command was `if (<bad>) { throw }; iex $s`. Under $ErrorActionPreference = 'SilentlyContinue' that throw is swallowed and the script goes on to `iex $s`: the second
      // way that command failed open (the first was ConstrainedLanguage). The command now has iex only inside the branch the check admits; this pins it against going back.
      for (const preference of ["SilentlyContinue", "Continue", "Stop"]) {
        const s = scratch(); behaviour = serveScript(Buffer.concat([realScript(), sentinel(s.marker)]));
        const r = await run(s, { T_PRESET: `$ErrorActionPreference = '${preference}'; "LanguageMode=" + $ExecutionContext.SessionState.LanguageMode` }, "paste");
        expect(r.out, `full language mode (${preference})`).toContain("LanguageMode=FullLanguage");
        expect(existsSync(s.marker), `the tampered script must not run (${preference})\n${r.out}`).toBe(false);
        expect(existsSync(s.install), `nothing installed (${preference})`).toBe(false); expect(readdirSync(s.local)).toEqual([]);
        expect(seen, `no archive was requested (${preference})`).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]);
        // the reason is shown whatever the preference swallows
        expect(r.out, `the reason is shown (${preference})`).toContain("could not be verified"); expect(r.out).not.toContain("installed version");
        if (preference !== "SilentlyContinue") expect(r.status, `ends in an error (${preference})`).not.toBe(0);
      }
      // and the preference does not stop an honest script from installing (the server must send the honest script again: `behaviour` still holds the tampered one)
      behaviour = () => false;
      const honest = scratch(), h = await run(honest, { T_PRESET: "$ErrorActionPreference = 'SilentlyContinue'" }, "paste");
      expect(h.out).toContain("installed version"); expect(existsSync(join(honest.install, "bin", "current.txt")), h.out).toBe(true);
    });
    it("accepts the script when the hash matches, byte for byte, and then still checks the archive's own pinned hash", async () => {
      const s = scratch(); expect(sha(realScript())).toBe(serviceA.installer().scriptSha256);
      const r = await run(s); expect(r.code, r.out).toBe(0); expect(r.verifyFailed).toBe(false);
      // the archive is checked by the script on top: a swapped archive under a good script is still refused
      const t = scratch(); behaviour = (req, res) => { if (req.url !== RUNTIME_BUNDLE_PATH) return false; const bad = Buffer.concat([bundleA.bytes, Buffer.from([0])]); res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": bad.length }); res.end(bad); return true; };
      const u = await run(t); expect(u.code, u.out).toBe(1); expect(u.out).toContain("does not match the checksum pinned in this installer, so nothing was unpacked");
      expect(existsSync(t.install)).toBe(false);
    });
  });

  describe("an archive that is not the one pinned in the script (the second pin)", () => {
    it("refuses an archive with a different SHA-256: nothing unpacked, nothing installed, exit 1", async () => {
      behaviour = (req, res) => {
        if (req.url !== RUNTIME_BUNDLE_PATH) return false;
        const bad = Buffer.concat([bundleA.bytes, Buffer.from([0])]);
        res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": bad.length, "X-Agend-SHA256": sha(bad) }); res.end(bad); return true;
      };
      const s = scratch(), r = await run(s);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("does not match the checksum pinned in this installer, so nothing was unpacked");
      // The header the tampered response carried is not what the script trusts: its own pinned value is what it compared.
      expect(r.out).toContain(bundleA.sha256);
      expect(r.out).not.toContain("connect --server"); expect(r.out).not.toContain("is installed");
      expect(existsSync(s.install)).toBe(false); expect(readdirSync(s.local)).toEqual([]);
    });
    it("refuses an archive swapped for different bytes of the same size", async () => {
      behaviour = (req, res) => {
        if (req.url !== RUNTIME_BUNDLE_PATH) return false;
        const swapped = Buffer.from(bundleA.bytes); swapped[swapped.length - 30] ^= 0xff;
        res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": swapped.length }); res.end(swapped); return true;
      };
      const s = scratch(), r = await run(s);
      expect(r.code, r.out).toBe(1); expect(r.out).toContain("nothing was unpacked"); expect(tree(s.install)).toEqual([]);
    });
    it("refuses to follow a redirect, and to read more than its size cap", async () => {
      behaviour = (req, res) => { if (req.url !== RUNTIME_BUNDLE_PATH) return false; res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere.zip" }); res.end(); return true; };
      const redirected = scratch(), a = await run(redirected);
      expect(a.code, a.out).toBe(1); expect(a.out).toContain("answered 302"); expect(tree(redirected.install)).toEqual([]);
      behaviour = (req, res) => { if (req.url !== RUNTIME_BUNDLE_PATH) return false; res.writeHead(200, { "Content-Length": 20 * 1024 * 1024 }); res.end(Buffer.alloc(1024)); return true; };
      const large = scratch(), b = await run(large);
      expect(b.code, b.out).toBe(1); expect(b.out).toContain("larger than expected"); expect(tree(large.install)).toEqual([]);
    });
  });

  describe("shared installer ownership", () => {
    it("keeps an existing legacy root unadopted while installing normally", async () => {
      const s = scratch(); mkdirSync(s.install, { mode: 0o700 });
      const r = await run(s); expect(r.code, r.out).toBe(0);
      expect(readRuntimeInstallReceipt(s.install)).toBeUndefined();
      expect(readFileSync(join(s.install, "bin", "current.txt"), "utf8")).toBe(FOLDER_A);
    });
    it("remembers a second origin permanently, and leaves the receipt unchanged on repeated installs", async () => {
      const s = scratch(); expect((await run(s)).code).toBe(0);
      const initial = readRuntimeInstallReceipt(s.install)!;
      await helperRun(s, "$l=Enter-AgendInstallLock $env:T_ROOT; try { Register-AgendInstallOrigin $env:T_ROOT 'https://second.example.test' $false $l } finally { Remove-AgendLock $l }");
      const shared = readRuntimeInstallReceipt(s.install)!;
      expect(shared).toMatchObject({ id: initial.id, revision: 2, origins: [origin(), "https://second.example.test"], shared: true });
      const before = snapshot(s.install); expect((await run(s)).code).toBe(0);
      expect(snapshot(s.install)).toEqual(before); expect(readRuntimeInstallReceipt(s.install)).toEqual(shared);
    });
    // Linux .NET derives StartTime from jiffies with a per-process epoch estimate, unlike Windows' stable creation timestamp.
    it.skipIf(process.platform !== "win32")("PowerShell respects the Node owner's actual process identity without downloading or disturbing its lock", async () => {
      const s = scratch(); mkdirSync(s.install, { mode: 0o700 });
      const birth = await helperRun(s, `[Console]::Write([string][Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().Ticks)`);
      const own = { pid: process.pid, birth, boot: paneSystemBootId("638980000000000000") };
      const lock = await acquireRuntimeInstallLock(s.install, { ownProof: own });
      try {
        const before = snapshot(s.install), r = await run(s);
        expect(r.code, r.out).toBe(1); expect(r.out).toContain("Another installer or Runtime owns");
        expect(snapshot(s.install)).toEqual(before); expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]);
        lock.assert();
      } finally { lock.release(); }
    });
    it.each(["alive", "unknown"])("the PowerShell helper preserves the Node lock on an inert %s observation", async observation => {
      const s = scratch(); mkdirSync(s.install, { mode: 0o700 });
      const lock = await acquireRuntimeInstallLock(s.install, { ownProof: { pid: process.pid, birth: "638980000000000000", boot: paneSystemBootId("638980000000000000") } });
      try {
        const before = snapshot(s.install);
        const message = await helperRun(s, `function Get-AgendProcessMatch { return '${observation}' }; try { $null=Enter-AgendInstallLock $env:T_ROOT; throw 'Unexpected permission' } catch { [Console]::Write($_.Exception.Message) }`);
        expect(message).toContain("Another installer or Runtime owns"); expect(snapshot(s.install)).toEqual(before); lock.assert();
      } finally { lock.release(); }
    });
    it("Node respects a real in-flight PowerShell installer and it releases its own lock after completion", async () => {
      const s = scratch(); let release!: () => void, requested!: () => void;
      const ready = new Promise<void>(resolve => { requested = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      behaviour = (req, res) => {
        if (req.url !== RUNTIME_BUNDLE_PATH) return false;
        requested(); void held.then(() => { if (!res.destroyed) { res.writeHead(200); res.end(bundleA.bytes); } }); return true;
      };
      const running = run(s);
      try {
        await Promise.race([ready, running.then(result => { throw Error(`Installer ended before the held download: ${result.out}`); })]);
        const owner = parseRuntimeInstallLock(JSON.parse(readFileSync(join(s.install, RUNTIME_INSTALL_LOCK, "owner.json"), "utf8")));
        expect(owner.type).toBe("installer"); expect(owner.pid).not.toBe(process.pid);
        const before = snapshot(join(s.install, RUNTIME_INSTALL_LOCK));
        await expect(acquireRuntimeInstallLock(s.install, { ownProof: { ...owner, pid: process.pid }, observe: async pid => pid === owner.pid ? { state: "alive", proof: owner } : { state: "unknown" } })).rejects.toThrow(/held/);
        expect(snapshot(join(s.install, RUNTIME_INSTALL_LOCK))).toEqual(before);
      } finally { release(); }
      const r = await running; expect(r.code, r.out).toBe(0); expect(existsSync(join(s.install, RUNTIME_INSTALL_LOCK))).toBe(false);
    });
    it("preserves a lockless installer's newer current.txt selection made during download", async () => {
      const s = scratch(); expect((await run(s)).code).toBe(0);
      const next = makeBundle(NEXT); active = serviceFor(next);
      behaviour = (req, res) => {
        if (req.url !== RUNTIME_BUNDLE_PATH) return false;
        writeFileSync(join(s.install, "bin", "current.txt"), "manual-selection");
        res.writeHead(200); res.end(next.bytes); return true;
      };
      const r = await run(s); expect(r.code, r.out).toBe(1); expect(r.out).toContain("selected Runtime changed during installation");
      expect(readFileSync(join(s.install, "bin", "current.txt"), "utf8")).toBe("manual-selection");
      expect(existsSync(join(s.install, folderOf(next)))).toBe(true); expect(existsSync(join(s.install, FOLDER_A))).toBe(true);
      expect(existsSync(join(s.install, RUNTIME_INSTALL_LOCK))).toBe(false);
    });
    it.each(["incomplete", "unknown-work", "contended-reclaim"])("keeps a %s lock and all its work untouched", async variant => {
      const s = scratch(); mkdirSync(s.install, { mode: 0o700 }); const lock = join(s.install, RUNTIME_INSTALL_LOCK); mkdirSync(lock, { mode: 0o700 });
      if (variant !== "incomplete") writeFileSync(join(lock, "owner.json"), JSON.stringify({ version: 1, type: "supervisor", nonce: randomUUID(), pid: process.pid, birth: "600000000000000000", boot: "a".repeat(64) }));
      if (variant === "unknown-work") writeFileSync(join(lock, "inflight"), "uncertain physical work");
      if (variant === "contended-reclaim") { mkdirSync(join(lock, "reclaim")); writeFileSync(join(lock, "reclaim", "claim.json"), "someone else's guard"); }
      const before = snapshot(lock), r = await run(s);
      expect(r.code, r.out).toBe(1); expect(snapshot(lock)).toEqual(before);
      expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]); expect(readdirSync(s.install)).toEqual([RUNTIME_INSTALL_LOCK]);
    });
    // Unix .NET maps CreationTimeUtc to mutable ctime on this fixture filesystem. The production lock is Windows-only;
    // exercise positive reclamation on native Windows, keeping all inert/live/unknown refusal controls on Linux too.
    it.skipIf(process.platform !== "win32")("reclaims only a positively reused process identity, then installs and releases the new lease", async () => {
      const s = scratch(); mkdirSync(s.install, { mode: 0o700 }); const lock = join(s.install, RUNTIME_INSTALL_LOCK); mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ version: 1, type: "supervisor", nonce: randomUUID(), pid: process.pid, birth: "600000000000000000", boot: "a".repeat(64) }));
      const r = await run(s); expect(r.code, r.out).toBe(0); expect(existsSync(lock)).toBe(false);
      expect(readFileSync(join(s.install, "bin", "current.txt"), "utf8")).toBe(FOLDER_A);
      expect(readRuntimeInstallReceipt(s.install)).toBeUndefined(); // reclaiming an existing root never manufactures fresh-install proof
    });
  });

  describe("version skew (M4): installing again puts the new build beside the old one and never touches a running one", () => {
    const serveNext = (bundle: RuntimeBundle) => { active = serviceFor(bundle); };
    it("installs the next version side by side, swaps current.txt, leaves the first folder byte-for-byte alone and the shim unchanged", async () => {
      const s = scratch(); expect((await run(s)).code).toBe(0);
      const first = snapshot(join(s.install, FOLDER_A)), shim = snapshot(join(s.install, "bin"))["agend-runtime.cmd"];
      const nextBundle = makeBundle(NEXT), NEXT_FOLDER = folderOf(nextBundle); serveNext(nextBundle);
      const r = await run(s, { T_COMMAND: pageCommand(active) });
      expect(r.code, r.out).toBe(0);
      expect(snapshot(join(s.install, FOLDER_A))).toEqual(first);   // not deleted, not replaced, not even re-written
      expect(readFileSync(join(s.install, NEXT_FOLDER, "dist", "runtime-cli.js"), "utf8")).toBe(`// fixture runtime ${NEXT}\n`);
      expect(readdirSync(s.install).sort()).toEqual([RUNTIME_INSTALL_RECEIPT, "bin", "connect", NEXT_FOLDER, FOLDER_A].sort());
      expect(readFileSync(join(s.install, "bin", "current.txt"), "latin1")).toBe(NEXT_FOLDER);
      expect(snapshot(join(s.install, "bin"))["agend-runtime.cmd"]).toBe(shim);   // the shim file was not rewritten
      expect(readdirSync(join(s.install, "bin")).sort()).toEqual(["agend-runtime.cmd", "current.txt"]);   // no temporary sibling left behind
      expect(r.out).toContain(`agend-runtime now starts ${NEXT_FOLDER} (it was ${FOLDER_A})`); expect(r.out).toContain("runs in a window keeps its own version");
      expect(r.out).toContain(`earlier versions are kept where they are (${FOLDER_A})`); expect(r.out).toContain("never removes a version");
    });
    it("a different BUILD of the same version lands beside the old one, with no manual deleting: current.txt moves, the old folder is untouched (N3)", async () => {
      const s = scratch(); expect((await run(s)).code).toBe(0);
      const before = snapshot(join(s.install, FOLDER_A));
      const rebuilt = makeBundle(VERSION, "rebuilt with the same version"), REBUILT = folderOf(rebuilt);
      expect(rebuilt.version).toBe(VERSION); expect(REBUILT).not.toBe(FOLDER_A); expect(REBUILT.split("+")[0]).toBe(FOLDER_A.split("+")[0]);
      serveNext(rebuilt);
      const r = await run(s, { T_COMMAND: pageCommand(active) });
      expect(r.code, r.out).toBe(0); expect(r.out).not.toContain("exists but does not hold this build");
      expect(readdirSync(s.install).sort()).toEqual([RUNTIME_INSTALL_RECEIPT, "bin", "connect", FOLDER_A, REBUILT].sort());
      expect(snapshot(join(s.install, FOLDER_A))).toEqual(before);
      expect(readFileSync(join(s.install, REBUILT, "dist", "runtime-cli.js"), "utf8")).toBe("// fixture runtime rebuilt with the same version\n");
      expect(readFileSync(join(s.install, "bin", "current.txt"), "latin1")).toBe(REBUILT);
      expect(r.out).toContain(`agend-runtime now starts ${REBUILT} (it was ${FOLDER_A})`);
    });
    it("running the same build's command again finds its own folder and only repoints; switching back to an earlier build keeps every folder", async () => {
      const s = scratch(); expect((await run(s)).code).toBe(0);
      const next = makeBundle(NEXT), NEXT_FOLDER = folderOf(next); serveNext(next); expect((await run(s, { T_COMMAND: pageCommand(active) })).code).toBe(0);
      active = serviceA; const back = await run(s);
      expect(back.code, back.out).toBe(0); expect(back.out).toContain("is already installed"); expect(readFileSync(join(s.install, "bin", "current.txt"), "latin1")).toBe(FOLDER_A);
      expect(readdirSync(s.install).sort()).toEqual([RUNTIME_INSTALL_RECEIPT, "bin", "connect", NEXT_FOLDER, FOLDER_A].sort());
      expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]);   // no archive was downloaded again
    });
    it("leaves a folder that carries this build's own name but does not hold it (changed by hand, or incomplete) completely alone", async () => {
      const s = scratch(), folder = join(s.install, FOLDER_A, "dist"); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "runtime-cli.js"), "// changed by hand\n");
      const before = snapshot(s.install), r = await run(s);
      expect(r.code, r.out).toBe(1); expect(r.out).toContain("exists but does not hold this build"); expect(r.out).toContain("It was left untouched because it may be running"); expect(snapshot(s.install)).toEqual(before);
      expect(existsSync(join(s.install, "bin", "current.txt"))).toBe(false);   // nothing was repointed
    });
    it("does not repoint agend-runtime when the new version failed to install, so the working version keeps working", async () => {
      const s = scratch(); expect((await run(s)).code).toBe(0);
      const before = snapshot(s.install), bad = makeBundle(NEXT); serveNext(bad);
      behaviour = (req, res) => { if (req.url !== RUNTIME_BUNDLE_PATH) return false; const wrong = Buffer.concat([bad.bytes, Buffer.from([1])]); res.writeHead(200, { "Content-Length": wrong.length }); res.end(wrong); return true; };
      const r = await run(s, { T_COMMAND: pageCommand(active) });
      expect(r.code, r.out).toBe(1); expect(snapshot(s.install)).toEqual(before); expect(readFileSync(join(s.install, "bin", "current.txt"), "latin1")).toBe(FOLDER_A);
    });
  });

  /**
   * A real pty (util-linux `script`), so stdin and stdout are a console the way they are when a person pastes the command. The progress bar is
   * switched off: on a pty with no terminal behind it, PowerShell asks the terminal for the cursor position and waits ten seconds for an answer.
   */
  const hasScript = process.platform !== "win32" && spawnSync("script", ["--version"]).status === 0;
  function runInteractive(s: ReturnType<typeof scratch>, env: Record<string, string> = {}, pwshArgs: string[] = []): Promise<{ out: string; code: number }> {
    clock += 600_000; seen.length = 0;
    const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
    return new Promise(done => {
      const previousMask = process.umask(0o077);
      let child;
      try {
        child = spawn("script", ["-qec", [quote(PWSH), "-NoProfile", ...pwshArgs, "-File", quote(s.harness)].join(" "), "/dev/null"],
          { env: { PATH: process.env.PATH ?? "", HOME: s.root, TERM: "dumb", DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", LOCALAPPDATA: s.local, AGEND_RUNTIME_NO_PATH: "1", T_FETCH: origin(), T_AGEND: origin(), T_MODE: "command", T_COMMAND: pageCommand(), ...env, T_PRESET: `$ProgressPreference = 'SilentlyContinue'; ${env.T_PRESET ?? ""}` }, stdio: ["ignore", "pipe", "pipe"] });
      } finally { process.umask(previousMask); }
      let raw = ""; child.stdout.on("data", d => { raw += d; }); child.stderr.on("data", d => { raw += d; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      const finish = (): void => { clearTimeout(timer); const out = raw.replace(/\r/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); done({ out, code: Number(/LASTEXITCODE=(\d+)/.exec(out)?.[1] ?? NaN) }); };
      child.on("error", error => { raw += `spawn failed: ${error.message}`; finish(); }); child.on("close", finish);
    });
  }
  describe("connecting after the install: one pasted command installs and connects, only at an interactive console", () => {
    // A runtime that records how it was started, so what the installer launches can be checked without Windows.
    const RECORDER = `const fs=require("fs"),path=require("path");
if(process.argv.indexOf("--connection-dir")<0){fs.appendFileSync(process.env.T_MARK+".other",JSON.stringify(process.argv.slice(2))+"\\n");process.exit(0)}
const dir=process.argv[process.argv.indexOf("--connection-dir")+1], root=path.dirname(path.dirname(__dirname));
fs.writeFileSync(process.env.T_MARK,JSON.stringify({argv:process.argv.slice(2),stdinTTY:!!process.stdin.isTTY,stdoutTTY:!!process.stdout.isTTY,lockHeld:fs.existsSync(path.join(root,".agend-runtime-install.lock")),server:JSON.parse(fs.readFileSync(path.join(dir,"agend-server.json"),"utf8")).server,files:fs.readdirSync(dir).sort()}));
process.stdout.write("RECORDER-CONNECT-RAN\\n");process.exitCode=Number(process.env.T_EXIT||0);\n`;
    const bundleR = makeBundle("2.3.7-alpha.1", "recorder", RECORDER);
    const recorded = (s: ReturnType<typeof scratch>) => existsSync(s.marker) ? JSON.parse(readFileSync(s.marker, "utf8")) : undefined;
    const entryOf = (s: ReturnType<typeof scratch>) => { const [name] = readdirSync(join(s.install, "connect")); return join(s.install, "connect", name); };
    const EXPECTED_BAT = ["@echo off", "setlocal DisableDelayedExpansion", 'if not exist "%~dp0..\\..\\bin\\agend-runtime.cmd" (',
      "  echo AgEnD Runtime is not installed correctly. Run the install command shown in AgEnD Settings - Runtime - Connect a computer again.", "  pause", "  exit /b 1", ")",
      'call "%~dp0..\\..\\bin\\agend-runtime.cmd" connect --connection-dir "%~dp0."', 'set "AGEND_EXIT=%errorlevel%"', "echo.",
      'if not "%AGEND_EXIT%"=="0" (', "  echo AgEnD Runtime stopped or could not connect. Read the message above for what to do next.", ") else (", "  echo Done. Read the message above: a Runtime that was started keeps running in the background after this window closes.", ")", "pause", ""].join("\r\n");
    beforeEach(() => { active = serviceFor(bundleR); });

    it.skipIf(!hasScript)("installs, then connects in the same window with the Runtime's own --connection-dir, after the install lock is gone", async () => {
      const s = scratch(), r = await runInteractive(s, { T_MARK: s.marker });
      expect(r.code, r.out).toBe(0);
      const dir = entryOf(s);
      // what was started: node, the installed version's own file, `connect --connection-dir <that folder>`; stdin and stdout are the console; the lock was released first
      expect(recorded(s), r.out).toEqual({ argv: ["connect", "--connection-dir", dir], stdinTTY: true, stdoutTTY: true, lockHeld: false, server: origin(), files: ["agend-server.json", "connect-agend.bat"] });
      expect(r.out).toContain(`connecting this computer to ${origin()}`); expect(r.out).toContain("RECORDER-CONNECT-RAN");
      expect(r.out).toContain(`done. To reconnect later, double-click ${join(dir, "connect-agend.bat")}`);
      expect(r.out).not.toContain("not connected yet"); expect(r.out).not.toContain("nothing has been paired");
      // nothing but the two static downloads: the script never touches a pairing endpoint (the Runtime does, and it is not started here)
      expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`, `GET ${RUNTIME_BUNDLE_PATH}`]);
      expect(existsSync(join(s.install, RUNTIME_INSTALL_LOCK))).toBe(false);
    });
    it.skipIf(!hasScript)("pasting it again on the same computer connects again without downloading the archive: the Runtime itself decides to reconnect", async () => {
      const s = scratch(); expect((await runInteractive(s, { T_MARK: s.marker })).code).toBe(0); rmSync(s.marker);
      const again = await runInteractive(s, { T_MARK: s.marker });
      expect(again.code, again.out).toBe(0); expect(again.out).toContain("is already installed"); expect(recorded(s)?.argv).toEqual(["connect", "--connection-dir", entryOf(s)]);
      expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]);
    });
    it.skipIf(!hasScript)("ends with the Runtime's own exit code and says how to try again when it could not connect", async () => {
      const s = scratch(), r = await runInteractive(s, { T_MARK: s.marker, T_EXIT: "7" });
      expect(r.code, r.out).toBe(7); expect(r.out).toContain("could not connect (status 7)"); expect(r.out).toContain(join(entryOf(s), "connect-agend.bat"));
    });
    it.skipIf(!hasScript)("connect moves the Runtime to the background by itself; $agendForeground = 1 asks for --foreground and keeps the old wording, unset or 0 does not", async () => {
      const plain = scratch(), p = await runInteractive(plain, { T_MARK: plain.marker });
      expect(p.code, p.out).toBe(0); expect(recorded(plain)?.argv).toEqual(["connect", "--connection-dir", entryOf(plain)]);
      expect(p.out).toContain("keeps running in the background and closing this window does not disconnect it"); expect(p.out).not.toContain("Ctrl+C");
      const on = scratch(), a = await runInteractive(on, { T_MARK: on.marker, T_PRESET: "$agendForeground = 1" });
      expect(a.code, a.out).toBe(0); expect(recorded(on)?.argv).toEqual(["connect", "--connection-dir", entryOf(on), "--foreground"]);
      expect(a.out).toContain("$agendForeground is set, so the Runtime stays in this window"); expect(a.out).toContain(`stopped. To reconnect, double-click ${join(entryOf(on), "connect-agend.bat")}`);
      for (const value of ["0", "$false", "''", "'no'", "$null"]) {
        const s = scratch(), r = await runInteractive(s, { T_MARK: s.marker, T_PRESET: `$agendForeground = ${value}` });
        expect(recorded(s)?.argv, `${value}\n${r.out}`).toEqual(["connect", "--connection-dir", entryOf(s)]);
      }
    });
    it("restarts Runtimes that run in the background after a repair run or when a different build was selected, never on a first install or the same build again", async () => {
      const others = (s: ReturnType<typeof scratch>): string[][] => existsSync(s.marker + ".other") ? readFileSync(s.marker + ".other", "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
      const s = scratch(), first = await run(s, { T_MARK: s.marker });
      expect(first.code, first.out).toBe(0); expect(others(s)).toEqual([]); expect(first.out).not.toContain("restarting any Runtime");
      const same = await run(s, { T_MARK: s.marker });
      expect(same.code, same.out).toBe(0); expect(others(s)).toEqual([]);
      const nextBundle = makeBundle("2.3.7-alpha.9", "recorder", RECORDER); active = serviceFor(nextBundle);
      const update = await run(s, { T_MARK: s.marker, T_COMMAND: pageCommand(active) });
      expect(update.code, update.out).toBe(0); expect(others(s)).toEqual([["restart", "--all"]]); expect(update.out).toContain("restarting any Runtime that runs in the background so it uses this version");
      const repair = scratch(), r = await run(repair, { T_MARK: repair.marker, AGEND_RUNTIME_REPAIR: "1", AGEND_RUNTIME_NO_PATH: "" });
      expect(r.code, r.out).toBe(0); expect(others(repair)).toEqual([["restart", "--all"]]); expect(recorded(repair)).toBeUndefined();
    });
    it("a Runtime that cannot be restarted is a warning: the install itself is complete and the exit status stays 0", async () => {
      const failing = makeBundle("2.3.7-alpha.7", "failing-restart", `process.stderr.write("restart refused\\n");process.exitCode=3;\n`);
      const s = scratch(); expect((await run(s)).code).toBe(0);
      active = serviceFor(failing);
      const r = await run(s, { T_COMMAND: pageCommand(active) });
      expect(r.code, r.out).toBe(0); expect(r.out).toContain("warning: a background Runtime could not be restarted"); expect(r.out).toContain("restart refused");
      expect(readFileSync(join(s.install, "bin", "current.txt"), "latin1")).toBe(folderOf(failing));
    });
    it.skipIf(!hasScript)("installs only, and says why, when $agendNoConnect is set; unset or 0 does not stop the connection", async () => {
      const off = scratch(), a = await runInteractive(off, { T_MARK: off.marker, T_PRESET: "$agendNoConnect = 1" });
      expect(a.code, a.out).toBe(0); expect(recorded(off)).toBeUndefined(); expect(a.out).toContain("$agendNoConnect is set in this window"); expect(a.out).toContain("run $agendNoConnect = $null first");
      expect(a.out).toContain(`& "${join(off.install, "bin", "agend-runtime.cmd")}" connect --server "${origin()}"`); expect(existsSync(join(entryOf(off), "agend-server.json"))).toBe(true);
      for (const value of ["0", "$false", "''", "'no'", "$null"]) {
        const s = scratch(), r = await runInteractive(s, { T_MARK: s.marker, T_PRESET: `$agendNoConnect = ${value}` });
        expect(r.code, `${value}\n${r.out}`).toBe(0);
        expect(recorded(s)?.argv, `${value}\n${r.out}`).toEqual(["connect", "--connection-dir", entryOf(s)]);
      }
    });
    it.skipIf(!hasScript)("never connects under -NonInteractive (or any abbreviation of it), even with a real console", async () => {
      for (const flag of ["-NonInteractive", "-noni", "-NonI"]) {
        const s = scratch(), r = await runInteractive(s, { T_MARK: s.marker }, [flag]);
        expect(r.code, `${flag}\n${r.out}`).toBe(0); expect(recorded(s), flag).toBeUndefined(); expect(r.out, flag).toContain("not an interactive console");
        expect(r.out, flag).toContain(`connect --server "${origin()}"`);
      }
    });
    it.skipIf(!hasScript)("never connects on a pseudo-terminal when a usual CI variable is set (an AI agent or CI step gives PowerShell a console): it installs only and prints the manual command", async () => {
      for (const name of ["CI", "GITHUB_ACTIONS", "TF_BUILD", "BUILD_BUILDID", "JENKINS_URL", "GITLAB_CI", "CIRCLECI", "BUILDKITE", "TEAMCITY_VERSION"]) {
        const s = scratch(), r = await runInteractive(s, { T_MARK: s.marker, [name]: "true" });
        expect(r.code, `${name}\n${r.out}`).toBe(0); expect(recorded(s), name).toBeUndefined();
        expect(r.out, name).toContain("not an interactive console"); expect(r.out, name).toContain(`connect --server "${origin()}"`); expect(r.out, name).not.toContain("connecting this computer");
      }
      // the variable's own value is read like $agendNoConnect: empty, 0, false, no and off mean "not set", so a person who has CI=false still connects
      for (const value of ["", "0", "false", "no", "off"]) {
        const s = scratch(), r = await runInteractive(s, { T_MARK: s.marker, CI: value });
        expect(r.code, `CI=${value}\n${r.out}`).toBe(0); expect(recorded(s)?.argv, `CI=${value}\n${r.out}`).toEqual(["connect", "--connection-dir", entryOf(s)]);
      }
    });
    it.skipIf(!hasScript)("a repair run, a failed install and an entry that could not be written never connect", async () => {
      const repair = scratch(), a = await runInteractive(repair, { T_MARK: repair.marker, AGEND_RUNTIME_REPAIR: "1", AGEND_RUNTIME_NO_PATH: "" });
      expect(a.code, a.out).toBe(0); expect(recorded(repair)).toBeUndefined(); expect(existsSync(join(repair.install, "connect"))).toBe(false); expect(a.out).not.toContain("connecting this computer");
      behaviour = (req, res) => { if (req.url !== RUNTIME_BUNDLE_PATH) return false; const wrong = Buffer.concat([bundleR.bytes, Buffer.from([0])]); res.writeHead(200, { "Content-Length": wrong.length }); res.end(wrong); return true; };
      const failed = scratch(), b = await runInteractive(failed, { T_MARK: failed.marker });
      expect(b.code, b.out).toBe(1); expect(recorded(failed)).toBeUndefined(); expect(b.out).not.toContain("connecting this computer");
      behaviour = () => false;
      // a folder name with % in it cannot be carried by a batch file's `call`, so there is no entry and no automatic connection; the install itself succeeds
      const odd = scratch(); odd.local = join(odd.root, "local%temp"); odd.install = join(odd.local, "agend-runtime"); mkdirSync(odd.local);
      const c = await runInteractive(odd, { T_MARK: odd.marker, LOCALAPPDATA: odd.local });
      expect(c.code, c.out).toBe(0); expect(recorded(odd)).toBeUndefined(); expect(existsSync(join(odd.install, "connect"))).toBe(false);
      expect(c.out).toContain("the reconnect entry was not written"); expect(c.out).toContain("which a batch file cannot carry safely"); expect(c.out).toContain("did not connect by itself"); expect(c.out).toContain(`connect --server "${origin()}"`);
      expect(readFileSync(join(odd.install, "bin", "current.txt"), "latin1")).toBe(folderOf(bundleR));
    });
    it("does not connect without a console, and the page's install-only command behaves the same as $agendNoConnect", async () => {
      const piped = scratch(), a = await run(piped, { T_MARK: piped.marker });
      expect(a.code, a.out).toBe(0); expect(recorded(piped)).toBeUndefined(); expect(a.out).toContain("not an interactive console");
      const only = scratch(), command = runtimeInstallOnlyCommand(origin(), active.installer().scriptSha256), b = await run(only, { T_COMMAND: command, T_MARK: only.marker });
      expect(b.code, b.out).toBe(0); expect(recorded(only)).toBeUndefined(); expect(readFileSync(join(only.install, "bin", "current.txt"), "latin1")).toBe(folderOf(bundleR));
    });

    it("writes only the public address and the pinned connect-agend.bat, one folder per AgEnD, and rewrites nothing when run again", async () => {
      const s = scratch(); expect((await run(s)).code).toBe(0);
      const dir = entryOf(s);
      expect(readdirSync(dir).sort()).toEqual(["agend-server.json", "connect-agend.bat"]);
      expect(readFileSync(join(dir, "agend-server.json"), "utf8")).toBe(JSON.stringify({ server: origin() }, null, 2) + "\n");   // the same bytes the ZIP carries; no credential, no code
      expect(readFileSync(join(dir, "connect-agend.bat"), "latin1")).toBe(EXPECTED_BAT);
      expect(sha(readFileSync(join(dir, "connect-agend.bat")))).toBe(BAT_SHA256);
      const name = dir.split(sep).pop()!; expect(name).toMatch(/^127\.0\.0\.1-\d+-[a-f0-9]{8}$/);
      expect(name.split("-").at(-1)).toBe(sha(Buffer.from(origin())).slice(0, 8));
      const before = snapshot(s.install); expect((await run(s)).code).toBe(0); expect(snapshot(s.install)).toEqual(before);
      // another AgEnD gets a folder of its own and the first is not touched
      const second = await helperRun(s, "$e = Write-AgendConnectEntry $env:T_ROOT 'https://second.example.test:10444'; [Console]::Write($e)");
      expect(second).toBe(join(s.install, "connect", `second.example.test-10444-${sha(Buffer.from("https://second.example.test:10444")).slice(0, 8)}`));
      expect(readFileSync(join(second, "agend-server.json"), "utf8")).toBe(JSON.stringify({ server: "https://second.example.test:10444" }, null, 2) + "\n");
      expect(readdirSync(join(s.install, "connect")).sort()).toHaveLength(2); expect(snapshot(dir)).toEqual(Object.fromEntries(Object.entries(snapshot(s.install)).filter(([k]) => k.startsWith(`connect${sep}${name}${sep}`)).map(([k, v]) => [k.slice(`connect${sep}${name}${sep}`.length), v])));
    });
    it("refuses an address agend-server.json cannot carry and an install folder a batch file would misread", async () => {
      const s = scratch(); mkdirSync(s.install, { recursive: true });
      const out = await helperRun(s, `foreach ($case in @(@($env:T_ROOT, 'https://a"b.example.test'), @($env:T_ROOT, 'https://host.example.test/x y'), @(($env:T_ROOT + '%x'), 'https://host.example.test'), @(($env:T_ROOT + '^x'), 'https://host.example.test'))) {
        try { $null = Write-AgendConnectEntry $case[0] $case[1]; 'WROTE' } catch { 'REFUSED:' + $_.Exception.Message }
      }`);
      expect(out.split(/\r?\n/)).toEqual(["REFUSED:the AgEnD address has characters that agend-server.json does not carry", "REFUSED:the AgEnD address has characters that agend-server.json does not carry",
        "REFUSED:the install folder name contains % or ^, which a batch file cannot carry safely", "REFUSED:the install folder name contains % or ^, which a batch file cannot carry safely"]);
      expect(tree(s.install)).toEqual([]);
    });
    it("reads $agendNoConnect as on for anything but empty, 0, false, no and off; and a redirected console is never interactive", async () => {
      const out = await helperRun(scratch(), `foreach ($v in @($null, '', ' ', '0', 0, $false, 'false', 'FALSE', 'no', 'Off', 1, '1', $true, 'true', 'yes', 'x')) { [string](Test-AgendSwitch $v) }
        'interactive=' + (Test-AgendInteractive)`);
      expect(out.split(/\r?\n/)).toEqual([...Array(10).fill("False"), ...Array(6).fill("True"), "interactive=False"]);
    });
  });

  describe("connecting with a one-time token: any window, no pairing code, the token only ever on the Runtime's standard input", () => {
    const TOKEN = "agend_enroll_" + "Qw3_-".repeat(9).slice(0, 43), FP = "cd".repeat(32);
    // A runtime that records exactly how it was started: arguments, what arrived on standard input, whether a token is in its environment, whether the lock is gone.
    const RECORDER = `const fs=require("fs"),path=require("path");
if(process.argv.indexOf("--connection-dir")<0){fs.appendFileSync(process.env.T_MARK+".other",JSON.stringify(process.argv.slice(2))+"\\n");process.exit(0)}
const dir=process.argv[process.argv.indexOf("--connection-dir")+1], root=path.dirname(path.dirname(__dirname));
let stdin="";try{stdin=fs.readFileSync(0,"utf8")}catch{}
fs.writeFileSync(process.env.T_MARK,JSON.stringify({argv:process.argv.slice(2),stdin,stdinTTY:!!process.stdin.isTTY,envHasToken:Object.entries(process.env).some(([k,v])=>!k.startsWith("T_")&&(/enroll/i.test(k)||String(v).includes("agend_enroll_"))),lockHeld:fs.existsSync(path.join(root,".agend-runtime-install.lock")),files:fs.readdirSync(dir).sort()}));
process.stdout.write("RECORDER-CONNECT-RAN\\n");process.exitCode=Number(process.env.T_EXIT||0);\n`;
    const bundleT = makeBundle("2.3.8-alpha.1", "token-recorder", RECORDER);
    const recorded = (s: ReturnType<typeof scratch>) => existsSync(s.marker) ? JSON.parse(readFileSync(s.marker, "utf8")) : undefined;
    const entryOf = (s: ReturnType<typeof scratch>) => { const [name] = readdirSync(join(s.install, "connect")); return join(s.install, "connect", name); };
    const tokenCommand = (): string => runtimeEnrollCommand(origin(), active.installer().scriptSha256, TOKEN, FP);
    /** Everything under the install folder and the scratch home, as text, to prove the token was written nowhere. */
    const everything = (s: ReturnType<typeof scratch>): string => [s.root].flatMap(dir => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name !== "harness.ps1" && entry.name !== "pasted.ps1" && entry.name !== "script-ran.txt").map(entry => readFileSync(join(entry.parentPath, entry.name), "latin1"))).join("\n");
    beforeEach(() => { active = serviceFor(bundleT); });

    it("connects with no console at all (-NonInteractive, no stdin): the Runtime gets the token on stdin and nowhere else, then the fingerprint as an argument", async () => {
      const s = scratch(), r = await run(s, { T_COMMAND: tokenCommand(), T_MARK: s.marker });
      expect(r.code, r.out).toBe(0);
      const got = recorded(s), dir = entryOf(s);
      expect(got, r.out).toMatchObject({ argv: ["connect", "--connection-dir", dir, "--enroll-stdin", "--server-fingerprint", FP], stdin: TOKEN + "\n", stdinTTY: false, envHasToken: false, lockHeld: false, files: ["agend-server.json", "connect-agend.bat"] });
      expect(got.argv.join(" ")).not.toContain(TOKEN); expect(got.argv.join(" ")).not.toMatch(/agend_enroll/);
      expect(r.out).toContain("with the one-time token from the install command: no pairing code and no approval step"); expect(r.out).toContain("RECORDER-CONNECT-RAN");
      expect(r.out).not.toContain("not an interactive console"); expect(r.out).not.toContain(TOKEN);
      expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`, `GET ${RUNTIME_BUNDLE_PATH}`]);                  // the script never touches an enrollment endpoint: the Runtime does
    });
    it("with $agendForeground the token route stays in the window (--foreground last), and without it the Runtime is told nothing of the sort", async () => {
      const s = scratch(), r = await run(s, { T_COMMAND: tokenCommand(), T_MARK: s.marker, T_PRESET: "$agendForeground = 1" });
      expect(r.code, r.out).toBe(0);
      expect(recorded(s), r.out).toMatchObject({ argv: ["connect", "--connection-dir", entryOf(s), "--enroll-stdin", "--server-fingerprint", FP, "--foreground"], stdin: TOKEN + "\n", envHasToken: false });
      expect(r.out).toContain("The Runtime stays running in this window until you press Ctrl+C"); expect(r.out).not.toContain(TOKEN);
    });
    it("writes the token to no file: not the install folder, the reconnect entry, the batch file or the profile", async () => {
      const s = scratch(), r = await run(s, { T_COMMAND: tokenCommand(), T_MARK: s.marker });
      expect(r.code, r.out).toBe(0);
      const text = everything(s); expect(text).not.toContain(TOKEN); expect(text).not.toContain(TOKEN.slice("agend_enroll_".length));
      expect(readdirSync(entryOf(s)).sort()).toEqual(["agend-server.json", "connect-agend.bat"]);
      expect(readFileSync(join(entryOf(s), "agend-server.json"), "utf8")).toBe(JSON.stringify({ server: origin() }, null, 2) + "\n");   // address only
      expect(sha(readFileSync(join(entryOf(s), "connect-agend.bat")))).toBe(BAT_SHA256);                             // the same pinned bytes as without a token
    });
    it.skipIf(!hasScript)("connects at an interactive console too, the same way, with the token piped (stdin is not the console)", async () => {
      const s = scratch(), r = await runInteractive(s, { T_COMMAND: tokenCommand(), T_MARK: s.marker });
      expect(r.code, r.out).toBe(0);
      expect(recorded(s), r.out).toMatchObject({ argv: ["connect", "--connection-dir", entryOf(s), "--enroll-stdin", "--server-fingerprint", FP], stdin: TOKEN + "\n", stdinTTY: false, envHasToken: false });
      expect(r.out).not.toContain(TOKEN);
    });
    it("clears $agendEnroll and $agendFingerprint: after a connection, and after a command the page's check refused to run", async () => {
      // (the test's harness prints both variables after the command, whatever happened to it)
      const s = scratch(), done = await run(s, { T_COMMAND: tokenCommand(), T_MARK: s.marker });
      expect(done.out, done.out).toContain("VARS=[|]"); expect(done.out).not.toContain(TOKEN);
      // a script the check refuses (a stale hash): `throw` ends the command, so only try/finally can still clear the token
      const refused = scratch(), stale = runtimeEnrollCommand(origin(), "f".repeat(64), TOKEN, FP);
      const r = await run(refused, { T_COMMAND: stale, T_MARK: refused.marker });
      expect(r.verifyFailed, r.out).toBe(true); expect(recorded(refused)).toBeUndefined(); expect(r.out).toContain("VARS=[|]"); expect(r.out).not.toContain(TOKEN);
    });
    it("installs only, and says the token was not used, when $agendNoConnect is set (the switch wins over the token)", async () => {
      const s = scratch(), r = await run(s, { T_PRESET: "$agendNoConnect = 1", T_COMMAND: tokenCommand(), T_MARK: s.marker });
      expect(r.code, r.out).toBe(0); expect(recorded(s)).toBeUndefined();
      expect(r.out).toContain("The one-time token in this command was NOT used"); expect(r.out).toContain("$agendNoConnect is set in this window"); expect(r.out).not.toContain(TOKEN);
      expect(readFileSync(join(s.install, "bin", "current.txt"), "latin1")).toBe(folderOf(bundleT));
    });
    it("passes the Runtime's exit code through and says how to try again", async () => {
      const s = scratch(), r = await run(s, { T_COMMAND: tokenCommand(), T_MARK: s.marker, T_EXIT: "7" });
      expect(r.code, r.out).toBe(7); expect(r.out).toContain("could not connect (status 7)"); expect(r.out).toContain(join(entryOf(s), "connect-agend.bat"));
    });
    it("returns the outcome to the shell as its exit status (powershell -Command): 0 when the Runtime ends normally, 1 when the install or the connection failed", async () => {
      const exitStatus = async (env: Record<string, string>): Promise<{ status: number | null; out: string }> => {
        clock += 600_000; const s = scratch();
        return new Promise(done => {
          const child = spawn(PWSH, ["-NoProfile", "-NonInteractive", "-Command", `${BOOT_FIXTURE}; ${tokenCommand()}`],
            { env: { PATH: process.env.PATH ?? "", HOME: s.root, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", LOCALAPPDATA: s.local, AGEND_RUNTIME_NO_PATH: "1", T_MARK: s.marker, ...env }, stdio: ["ignore", "pipe", "pipe"] });
          let out = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { out += d; });
          const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
          child.on("close", status => { clearTimeout(timer); done({ status, out }); });
        });
      };
      const ok = await exitStatus({}); expect(ok.status, ok.out).toBe(0);
      const stopped = await exitStatus({ T_EXIT: "7" }); expect(stopped.status, stopped.out).toBe(1);
      expect(stopped.out).toContain("could not connect (status 7)"); expect(stopped.out).not.toContain(TOKEN);
      // a stale $LASTEXITCODE from an earlier command is not mistaken for a failure: the command starts by resetting it
      const stale = scratch(); clock += 600_000;
      const staleRun = await new Promise<{ status: number | null; out: string }>(done => {
        const child = spawn(PWSH, ["-NoProfile", "-NonInteractive", "-Command", `${BOOT_FIXTURE}; $global:LASTEXITCODE = 9; $agendNoConnect = 1; ${tokenCommand()}; $agendNoConnect = $null`],
          { env: { PATH: process.env.PATH ?? "", HOME: stale.root, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", LOCALAPPDATA: stale.local, AGEND_RUNTIME_NO_PATH: "1", T_MARK: stale.marker }, stdio: ["ignore", "pipe", "pipe"] });
        let out = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { out += d; });
        child.on("close", status => done({ status, out }));
      });
      expect(staleRun.status, staleRun.out).toBe(0);                       // install only, nothing failed: 0, whatever the session's $LASTEXITCODE was
    });
    it("refuses a malformed token or fingerprint BEFORE installing or downloading anything, exit 1, and does not print it", async () => {
      for (const [token, fingerprint, said] of [["", FP, "one-time token in this install command is not valid"], ["   ", FP, "one-time token in this install command is not valid"], ["agend_enroll_short", FP, "one-time token in this install command is not valid"], [TOKEN.toUpperCase(), FP, "one-time token in this install command is not valid"],
        [TOKEN + "x", FP, "one-time token in this install command is not valid"], [TOKEN, "nope", "server fingerprint in this install command is missing or not valid"], [TOKEN, "", "server fingerprint in this install command is missing or not valid"],
        [TOKEN, FP.toUpperCase(), "server fingerprint in this install command is missing or not valid"]] as const) {
        const s = scratch(), r = await run(s, { T_PRESET: `$agendEnroll = '${token}'; $agendFingerprint = '${fingerprint}'`, T_MARK: s.marker });
        expect(r.code, `${token} ${fingerprint}\n${r.out}`).toBe(1); expect(r.out).toContain(said); expect(r.out).toContain("generate a new install command");
        expect(recorded(s)).toBeUndefined(); expect(existsSync(s.install)).toBe(false); expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]);
        if (token.length > 20) expect(r.out).not.toContain(token);
      }
    });
    it("treats a variable that is not there, or is $null (what the page's command leaves behind), as no token; only an empty or blank one is an error", async () => {
      for (const preset of ["$agendEnroll = $null; $agendFingerprint = $null", "$agendEnroll = $null"]) {
        const s = scratch(), r = await run(s, { T_PRESET: preset, T_MARK: s.marker });
        expect(r.code, `${preset}\n${r.out}`).toBe(0); expect(recorded(s)).toBeUndefined(); expect(r.out).toContain("not an interactive console"); expect(r.out).not.toContain("one-time token");
      }
    });
    it("without a token it connects only through the pairing-code flow: no console, no connection, the manual command is printed", async () => {
      const s = scratch(), r = await run(s, { T_MARK: s.marker });
      expect(r.code, r.out).toBe(0); expect(recorded(s)).toBeUndefined(); expect(r.out).toContain("not an interactive console"); expect(r.out).not.toContain("one-time token");
    });
    it("decides in one fixed order: repair, $agendNoConnect, a token (connect in any window), no console, no entry, otherwise connect", async () => {
      const out = await helperRun(scratch(), `foreach ($r in $false,$true) { foreach ($n in $false,$true) { foreach ($i in $false,$true) { foreach ($h in $false,$true) { foreach ($t in $false,$true) { '' + [int]$r + [int]$n + [int]$i + [int]$h + [int]$t + '=' + (Get-AgendConnectMode $r $n $i $h $t) } } } } }
        'default=' + (Get-AgendConnectMode $false $false $true $true)`);
      const expected = (r: number, n: number, i: number, h: number, t: number): string => r ? "repair" : n ? "switch" : t ? (h ? "enroll" : "noentry") : !i ? "noninteractive" : !h ? "noentry" : "connect";
      const rows = out.split(/\r?\n/); expect(rows.pop()).toBe("default=connect");                         // the token argument is optional: a call without it decides as one without a token
      expect(rows).toHaveLength(32);
      for (const row of rows) { const [bits, mode] = row.split("="); expect(mode, row).toBe(expected(...[...bits].map(Number) as [number, number, number, number, number])); }
    });
    it("accepts only a lower-case-exact token and fingerprint shape", async () => {
      const out = await helperRun(scratch(), `foreach ($v in @('${TOKEN}', 'agend_enroll_short', '${TOKEN}x', ' ${TOKEN}', '${TOKEN.toUpperCase()}', ('agend_enroll_' + ('a' * 43)), $null, 5, '')) { [string](Test-AgendEnrollToken $v) }
        foreach ($v in @('${FP}', '${FP.toUpperCase()}', 'ab', '${FP}0', $null, '${FP.slice(0, 63)}g')) { [string](Test-AgendFingerprint $v) }`);
      expect(out.split(/\r?\n/)).toEqual(["True", "False", "False", "False", "False", "True", "False", "False", "False", "True", "False", "False", "False", "False", "False"]);
    });
  });

  describe("what the script refuses on its own", () => {
    it("stops before the network when $agend is missing or is not a plain https origin (http only for this computer)", async () => {
      for (const agend of [undefined, "", "http://192.168.1.20:19280", "https://user:pw@host.example", "https://host.example/path", "https://host.example?x=1", "ftp://host.example", "host.example", "https://host.example/ ; calc"]) {
        const s = scratch(), r = await run(s, { T_MODE: "direct", ...(agend === undefined ? { T_AGEND: "" } : { T_AGEND: agend }) });
        expect(r.code, `${agend}\n${r.out}`).toBe(1); expect(r.out, String(agend)).toContain("needs $agend set to your AgEnD address"); expect(r.out).toContain("Do not run this file by hand");
        expect(seen, String(agend)).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]); seen.length = 0; expect(existsSync(s.install)).toBe(false);
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
    it("accepts only a full drive path for AGEND_RUNTIME_INSTALL_DIR, never a relative one", async () => {
      const s = scratch(), r = await run(s, { AGEND_RUNTIME_INSTALL_DIR: "relative/place" });
      expect(r.code, r.out).toBe(1); expect(r.out).toContain("must be a full path on a drive"); expect(seen).toEqual([`GET ${RUNTIME_INSTALL_SCRIPT_PATH}`]);
    });
  });
});
