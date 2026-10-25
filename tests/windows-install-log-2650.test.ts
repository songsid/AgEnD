/**
 * #2650 item 9 (Sentinel's Windows installer review): a safe installation receipt and transcript.
 * - install-agend.ps1 writes what it shows (Write-Step/Ok/Warn/Err/Info) and every line a watched step prints into a log
 *   under %LOCALAPPDATA%\AgEnD\install-logs, redacted first (setup and sign-in codes, tokens, URL credentials); at most
 *   5 MB, the last 10 kept. The first error says where the log is. A receipt, last.json, holds this run's id, the stage,
 *   the outcome (running / failed / done) and a failure kind; an uncaught error is trapped, logged and named.
 * - install.ps1 passes the run id, reads the receipt when the installer ends badly or its window is closed, and says
 *   which stage stopped and where the support file is. A receipt that says done wins over a stale exit code. It tells
 *   a declined UAC prompt from a security-policy block, antivirus quarantine, a failed download and other launch
 *   failures, and it never runs a downloaded file whose bytes changed after the check.
 * The functions are the scripts' own, taken from their syntax trees (or the whole one-liner, served locally), run in
 * pwsh with Windows-only calls stubbed. A real Windows run is the user's checklist.
 */
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BOOTSTRAP = join(ROOT, "website", "public", "install.ps1");
const INSTALLER = join(ROOT, "website", "public", "install-agend.ps1");
const code = (f: string) => readFileSync(f, "utf8").split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("static", () => {
  const inst = code(INSTALLER);
  it("every helper line and every watched child line goes through the log; the log starts before stage 1", () => {
    for (const fn of ["Write-Ok", "Write-Warn", "Write-Info"]) expect(inst).toMatch(new RegExp(`function ${fn}\\(\\$msg\\) \\{[^\\n]*Write-InstallLog`));
    expect(inst).toMatch(/function Write-Err\(\$msg\) \{\n[^\n]*Write-InstallLog/);
    expect(inst).toMatch(/function Write-Step[^\n]*\n[^\n]*\n\s+Write-InstallLog[^\n]*\n\s+Set-InstallStage/);
    const watched = inst.slice(inst.indexOf("function Invoke-Watched"), inst.indexOf("function Confirm-StopInstall"));
    expect(watched).toMatch(/\$printLine = \{\n[^\n]*\n[^\n]*Write-Host \("    " \+ \$line\)[^\n]*\n\s+Write-InstallLog \("    " \+ \$line\)/);
    expect(inst.indexOf("Start-InstallLog $InstallRunId")).toBeGreaterThan(0);
    expect(inst.indexOf("Start-InstallLog $InstallRunId")).toBeLessThan(inst.indexOf("Write-Step 1 $TOTAL"));
  });
  it("an uncaught error is trapped: logged, recorded as 'error', explained", () => {
    expect(inst).toMatch(/\ntrap \{\n\s+Write-InstallLog [^\n]+\n\s+Set-InstallFailure 'error'\n\s+Write-Err [^\n]+\n[^\n]+\n\s+Read-Host "按 Enter 結束"; exit 1\n\}/);
  });
  it("failure kinds where the installer gives up: download (WSL update), service; the end writes a done receipt", () => {
    expect(inst).toMatch(/'failed' \{ Set-InstallFailure 'download'; Read-Host/);
    expect(inst).toMatch(/AgEnD 服務沒有安裝成功[^\n]*\n\s+Set-InstallFailure 'service'/);
    expect(inst).toMatch(/if \((?:\$script:InstallerReady) -and \$missingBackends\.Count -eq 0\) \{ Save-InstallReceipt 'done'/);
    expect(inst).toContain("elseif ($missingBackends.Count -gt 0) { Set-InstallFailure 'backend' } else { Set-InstallFailure 'service' }");
    expect(inst.indexOf("Save-InstallReceipt 'done'")).toBeLessThan(inst.lastIndexOf("Remove-Item -LiteralPath $ProgressFile -Force"));
  });
  it("the setup and dashboard code boxes are not written through the logged helpers", () => {
    expect(inst).toMatch(/Write-Host \("  │   設定碼：  " \+ \$spaced/);
    expect(inst).toMatch(/Write-Host \("  │   儀表板登入碼：  " \+ \$spaced/);
  });
  it("install.ps1 stays ASCII and checks the file's hash again right before it runs it", () => {
    const boot = readFileSync(BOOTSTRAP, "utf8");
    expect(/^[\x00-\x7f]*$/.test(boot)).toBe(true);
    const b = code(BOOTSTRAP);
    expect(b.indexOf("$validatedHash = ")).toBeLessThan(b.indexOf("if ($nowHash -ne $validatedHash)"));
    expect(b.indexOf("if ($nowHash -ne $validatedHash)")).toBeLessThan(b.indexOf("if (-not $onWindows -or $admin)"));
  });
});

/** A pwsh script with the functions of `file` loaded from its syntax tree (nested ones too); nothing else of it runs. */
function run(file: string, body: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2650log-")); dirs.push(dir);
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
$env:LOCALAPPDATA = Join-Path '${dir}' 'lad'
$INSTALL_LOG_MAX_BYTES = 5MB; $INSTALL_LOG_KEEP = 10; $InstallVersion = 'beta'; $Force = $false
$script:InstallLog = $null; $script:InstallLogShown = $false; $script:InstallLogFull = $false
$script:InstallStage = 'start'; $script:InstallFailure = $null; $script:InstallRunId = ''
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: dir, ...env } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  const logs = join(dir, "lad", "AgEnD", "install-logs");
  const read = (f: string) => readFileSync(join(logs, f), "utf8").replace(/^﻿/, "");
  const logFile = existsSync(logs) ? readdirSync(logs).filter(f => /^install-.*\.log$/.test(f)).sort().pop() : undefined;
  return {
    out: r.stdout + r.stderr, logs,
    log: logFile ? read(logFile) : "",
    receipt: existsSync(join(logs, "last.json")) ? JSON.parse(read("last.json")) : null,
  };
}

describe.skipIf(!pwsh)("with pwsh: the installer's log and receipt", { timeout: 90_000 }, () => {
  it("Protect-LogText hides codes, tokens and URL credentials, and keeps error codes and ordinary text", () => {
    const cases: [string, string][] = [
      ["設定碼：ABCD-EFGH", "設定碼：[hidden code]"],
      ["Setup code: ABCD-EF23", "Setup code: [hidden]"],
      ["Code: WXYZ-2345", "Code: [hidden]"],
      ["enter device code QWER-ASDFG to continue", "enter device code [hidden code] to continue"],
      ["open https://x.example/cb?code=abc123&state=xyz&lang=en", "open https://x.example/cb?code=[hidden]&state=[hidden]&lang=en"],
      ["https://h.example/#access_token=eyJabc.def", "https://h.example/#access_token=[hidden]"],
      [`bot ${"1".repeat(9)}:${"A".repeat(35)}`, "bot [hidden token]"],
      [`d ${"a".repeat(24)}.${"b".repeat(6)}.${"c".repeat(27)}`, "d [hidden token]"],
      [`key sk-${"k".repeat(20)} ok`, "key [hidden token] ok"],
      ["token=hunter2", "token=[hidden]"],
      ["Authorization: Bearer abc.def", "Authorization: [hidden]"],
      ["curl -H authorization=Basic dXNlcjpwYXNz", "curl -H authorization=[hidden]"],
      ["Bearer abcdef", "Bearer [hidden]"],
      ["password: s3cret!", "password: [hidden]"],
    ];
    const keep = ["the installer ended with code 3", "error code: 0x80070005", "exit code: 1", "安裝 Kiro CLI：用了 12 秒", "WSL 2.6.1.0 已安裝，略過更新",
      "Ubuntu-24.04", "UTF-8"];
    const lines = [...cases.map(c => c[0]), ...keep];
    const { out } = run(INSTALLER, `$in = @(${lines.map(l => `'${l.replace(/'/g, "''")}'`).join(",")})
foreach ($l in $in) { Write-Output ('OUT=' + (Protect-LogText $l)) }`);
    const got = out.split("\n").filter(l => l.startsWith("OUT=")).map(l => l.slice(4));
    expect(got).toEqual([...cases.map(c => c[1]), ...keep]);
  });

  it("the log: helpers and watched child lines, redacted; the first error names the file once; the receipt follows the stage", () => {
    const { out, log, receipt } = run(INSTALLER, `$ProgressFile = Join-Path $env:TMPDIR 'progress'; $script:OnWindows = $false
Start-InstallLog ('${"a".repeat(32)}')
Write-Step 2 5 '安裝 AI 後端'
Write-Info '設定碼：ABCD-EFGH'
Write-Ok 'done'
$null = Invoke-Watched -Label 'child' -Usually 'x' -File 'sh' -Arguments @('-c', 'echo line-one; echo token=abc; echo WXYZ-2345 >&2')
Write-Err 'first'
Write-Err 'second'
Write-Warn 'warned'`);
    expect(log).toMatch(/AgEnD installer started; PowerShell 7[^\n]*requested version 'beta'; Force=False/);
    expect(log).toMatch(/\[2\/5\] 安裝 AI 後端/);
    expect(log).toContain("  設定碼：[hidden code]");
    expect(log).toContain("  [OK] done");
    expect(log).toContain("    line-one");
    expect(log).toContain("    token=[hidden]");
    expect(log).toContain("    [hidden code]");
    expect(log).toContain("  [X] first");
    expect(log).toContain("  [!!] warned");
    expect(log).not.toMatch(/ABCD-EFGH|WXYZ-2345|token=abc/);
    expect(out.match(/安裝紀錄（回報問題時請附上這個檔案）：/g)?.length).toBe(1);
    expect(out).toMatch(/安裝紀錄（回報問題時請附上這個檔案）：\S*install-\d{8}-\d{6}-\d+\.log/);
    expect(receipt).toMatchObject({ run: "a".repeat(32), outcome: "running", stage: "2", failure: null });
    expect(receipt.log).toMatch(/install-\d{8}-\d{6}-\d+\.log$/);
  });

  it("receipts: a failure is named; a new stage clears it; done clears it and lists pending sign-ins; a bad run id is dropped", () => {
    const failed = run(INSTALLER, `Start-InstallLog 'not-a-run-id'; Set-InstallStage '3'; Set-InstallFailure 'network'`);
    expect(failed.receipt).toMatchObject({ run: "", outcome: "failed", stage: "3", failure: "network" });
    expect(failed.log).toContain("FAILED stage=3 kind=network");
    const next = run(INSTALLER, `Start-InstallLog ''; Set-InstallStage '4'; Set-InstallFailure 'service'; Set-InstallStage '5'`);
    expect(next.receipt).toMatchObject({ outcome: "running", stage: "5", failure: null });
    const done = run(INSTALLER, `Start-InstallLog ''; Set-InstallStage '5'; Set-InstallFailure 'service'; Save-InstallReceipt 'done' @('claude', 'codex')`);
    expect(done.receipt).toMatchObject({ outcome: "done", failure: null, pendingSignIns: ["claude", "codex"] });
  });

  it("only the last 10 logs are kept, a log stops at its size cap with one marker, and no LOCALAPPDATA means no log", () => {
    const pruned = run(INSTALLER, `$d = Join-Path $env:LOCALAPPDATA 'AgEnD/install-logs'; New-Item -ItemType Directory -Path $d -Force | Out-Null
for ($i = 1; $i -le 12; $i++) { $f = Join-Path $d ("install-old-{0:00}.log" -f $i); Set-Content -LiteralPath $f -Value x; (Get-Item $f).LastWriteTime = (Get-Date).AddDays(-$i) }
Start-InstallLog ''
Write-Output ('LOGS=' + (@(Get-ChildItem -LiteralPath $d -Filter 'install-*.log').Count))
Write-Output ('NEWEST_OLD=' + (Test-Path (Join-Path $d 'install-old-01.log')) + ' OLDEST=' + (Test-Path (Join-Path $d 'install-old-12.log')))`);
    expect(pruned.out).toContain("LOGS=10");
    expect(pruned.out).toContain("NEWEST_OLD=True OLDEST=False");

    const capped = run(INSTALLER, `$INSTALL_LOG_MAX_BYTES = 2000; Start-InstallLog ''
for ($i = 0; $i -lt 100; $i++) { Write-InstallLog ('line ' + $i + ' ' + ('x' * 40)) }`);
    expect(capped.log.match(/later lines are not kept/g)?.length).toBe(1);
    expect(capped.log).not.toContain("line 99 ");
    expect(Buffer.byteLength(capped.log)).toBeLessThan(2200);

    const none = run(INSTALLER, `Remove-Item Env:LOCALAPPDATA; Start-InstallLog ''; Write-Info 'hello'; Set-InstallFailure 'x'; Write-Err 'boom'; Write-Output ('LOG=' + [string]$script:InstallLog)`);
    expect(none.out).toContain("LOG=\n");
    expect(none.out).not.toContain("安裝紀錄");
  });
});

describe.skipIf(!pwsh)("with pwsh: install.ps1 names the failure and the support file", { timeout: 90_000 }, () => {
  it("Get-LaunchFailure: 1223 declined, policy codes blocked, virus codes quarantined, anything else failed", () => {
    const { out } = run(BOOTSTRAP, `function E([int]$n) { try { throw [ComponentModel.Win32Exception]::new($n) } catch { return $_ } }
foreach ($n in 1223, 1260, 4551, 786, 225, 226, 2, 5) { Write-Output ("K$n=" + (Get-LaunchFailure (E $n))) }
try { throw [InvalidOperationException]::new('wrap', [ComponentModel.Win32Exception]::new(1223)) } catch { Write-Output ('INNER=' + (Get-LaunchFailure $_)) }`);
    expect(out).toContain("K1223=declined");
    for (const n of [1260, 4551, 786]) expect(out).toContain(`K${n}=blocked`);
    for (const n of [225, 226]) expect(out).toContain(`K${n}=quarantined`);
    expect(out).toContain("K2=failed");
    expect(out).toContain("K5=failed");
    expect(out).toContain("INNER=declined");
  });

  it("Start-ElevatedInstaller: the run id reaches the installer through the Windows Terminal wrapper; a throw there is code 1, not 0", () => {
    const { out } = run(BOOTSTRAP, `$tmp = Join-Path $env:TMPDIR 'stub-installer.ps1'
Set-Content $tmp 'param([switch]$Force, [string]$InstallVersion, [string]$InstallRunId); [IO.File]::WriteAllText((Join-Path $env:TMPDIR "run.txt"), $InstallRunId); if ($env:STUB_THROW) { throw "boom" }'
function Get-Command { param($Name, $CommandType); return @{ Source = 'stub-wt' } }
function Start-Process { param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
  if ($FilePath -eq 'stub-wt') { & pwsh -NoProfile -File ($ArgumentList[-1].Trim('"')); return }
  throw 'unexpected' }
$id = '${"c".repeat(32)}'
$r = Start-ElevatedInstaller 'pwsh' @('-NoProfile', '-File', $tmp, '-InstallRunId', $id) $tmp 'auto' 5 2
Write-Output ('RESULT=' + $r.Outcome + ' CODE=' + $r.Code + ' RUN=' + [IO.File]::ReadAllText((Join-Path $env:TMPDIR 'run.txt')))
$env:STUB_THROW = '1'
$r = Start-ElevatedInstaller 'pwsh' @('-NoProfile', '-File', $tmp, '-InstallRunId', 'not; valid') $tmp 'auto' 5 2
Write-Output ('THROWN=' + $r.Outcome + ' CODE=' + $r.Code + ' RUN=[' + [IO.File]::ReadAllText((Join-Path $env:TMPDIR 'run.txt')) + ']')`);
    expect(out).toContain(`RESULT=done CODE=0 RUN=${"c".repeat(32)}`);
    expect(out).toContain("THROWN=done CODE=1 RUN=[]");
  });

  it("Start-ElevatedInstaller in the PowerShell window: a policy block is 'blocked' with its message, not 'declined'", () => {
    const { out } = run(BOOTSTRAP, `function Start-Process { throw [ComponentModel.Win32Exception]::new(4551, 'blocked by policy') }
$r = Start-ElevatedInstaller 'pwsh' @('-NoProfile', '-File', 'x.ps1') 'x.ps1' 'conhost'
Write-Output ('RESULT=' + $r.Outcome + ' ERROR=' + $r.Error)
function Start-Process { throw [ComponentModel.Win32Exception]::new(1223) }
Write-Output ('NO=' + (Start-ElevatedInstaller 'pwsh' @('-File', 'x.ps1') 'x.ps1' 'conhost').Outcome)`);
    expect(out).toContain("RESULT=blocked ERROR=blocked by policy");
    expect(out).toContain("NO=declined");
  });

  // A stub install-agend.ps1 (UTF-8 with BOM, over 1 KiB, the installer's marker) that writes a receipt as told by STUB_RECEIPT.
  const stub = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([
    "param([switch]$Force, [string]$InstallVersion, [string]$InstallRunId)",
    "function Check-Admin { $true }",
    "$d = Join-Path $env:LOCALAPPDATA 'AgEnD/install-logs'; New-Item -ItemType Directory -Path $d -Force | Out-Null",
    "$s = $env:STUB_RECEIPT -split '\\|'",
    "$run = if ($s[0] -eq 'mine') { $InstallRunId } else { 'f' * 32 }",
    "@{ run = $run; outcome = $s[1]; stage = $s[2]; failure = $(if ($s[3]) { $s[3] } else { $null }); log = (Join-Path $d 'install-x.log') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $d 'last.json')",
    "Set-Content -LiteralPath $env:STUB_RAN -Value $InstallRunId",
    "exit [int]$s[4]",
    "#" + "x".repeat(1200),
    "",
  ].join("\n"), "utf8")]);
  let server: Server, port = 0;
  beforeAll(async () => {
    const boot = readFileSync(BOOTSTRAP);
    server = createServer((req, res) => {
      if (req.url === "/install.ps1") { res.writeHead(200); res.end(boot); return; }
      if (req.url === "/install-agend.ps1") { res.writeHead(200); res.end(stub); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server?.close(); });
  const oneLiner = (receipt: string, prelude = "") => new Promise<{ out: string; ran: string | null; dir: string }>(resolve => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2650boot-")); dirs.push(dir);
    mkdirSync(join(dir, "lad"));
    const ranFile = join(dir, "ran.txt");
    execFile("pwsh", ["-NoProfile", "-c", `${prelude}irm http://127.0.0.1:${port}/install.ps1 | iex; Write-Output "SESSION-GOES-ON"`], {
      encoding: "utf8", timeout: 60_000,
      env: { ...process.env, AGEND_INSTALL_BASE: `http://127.0.0.1:${port}`, AGEND_INSTALL_SHELL: "pwsh", TMPDIR: dir, LOCALAPPDATA: join(dir, "lad"), STUB_RECEIPT: receipt, STUB_RAN: ranFile },
    }, (_e, stdout, stderr) => resolve({ out: stdout + stderr, ran: existsSync(ranFile) ? readFileSync(ranFile, "utf8").trim() : null, dir }));
  });

  it("a failed run: the stage, the failure kind and the support file from this run's receipt", async () => {
    const { out, ran } = await oneLiner("mine|failed|2|network|3");
    expect(ran).toMatch(/^[0-9a-f]{32}$/);
    expect(out).toContain("the installer ended with code 3");
    expect(out).toContain("it stopped at stage 2 (network). Running the same command again carries on from there.");
    expect(out).toMatch(/support file \(attach it when you report the problem\): \S*install-x\.log/);
    expect(out).toContain("SESSION-GOES-ON");
  });
  it("another run's receipt is never quoted", async () => {
    const { out } = await oneLiner("other|failed|2|network|3");
    expect(out).toContain("the installer ended with code 3");
    expect(out).not.toContain("stopped at stage");
    expect(out).not.toContain("support file");
  });
  it("a done receipt wins over a stale nonzero exit code", async () => {
    const { out } = await oneLiner("mine|done|5||9");
    expect(out).toContain("the installer finished.");
    expect(out).not.toContain("ended with code");
  });
  it("a file changed after the check (antivirus, a proxy) is never run, and bootstrap.log says so", async () => {
    const prelude = "$global:hashCalls = 0; function global:Get-FileHash { $global:hashCalls++; [PSCustomObject]@{ Hash = ('H' + $global:hashCalls) } }; ";
    const { out, ran, dir } = await oneLiner("mine|done|5||0", prelude);
    expect(ran).toBeNull();
    expect(out).toContain("the downloaded installer was removed or changed before it could run");
    expect(out).toContain("Do not turn protection off.");
    expect(out).toMatch(/support file[^\n]*bootstrap\.log/);
    expect(readFileSync(join(dir, "lad", "AgEnD", "install-logs", "bootstrap.log"), "utf8")).toMatch(/\[[0-9a-f]{32}\] downloaded installer removed or changed/);
  });
});
