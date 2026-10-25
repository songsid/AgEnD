/**
 * #2650 item 8 (Sentinel's Windows installer review): the Google-only network gate is replaced by checks of what the
 * installer really downloads, on each side.
 * - Windows: songsid.github.io (the installer and the resume after a restart) is required; GitHub (the WSL update
 *   fallback) and raw.githubusercontent.com (the Ubuntu image list) only warn. Before, one request to Google decided
 *   everything: a network that blocks Google stopped the install, and one where only the browser works passed.
 * - WSL, once Ubuntu is ready and before backends or AgEnD are downloaded: AgEnD's installer, npm, Node.js and nvm are
 *   required; the Ubuntu archive and the AI vendors' hosts only warn. Windows reaching a host says nothing for WSL
 *   (proxy, VPN, DNS).
 * - Each host: at most 2 tries of 10 s (in WSL, all hosts at once); any HTTP status means reachable. A failure is named
 *   (DNS, timeout, refused, HTTPS certificate, proxy) with what to do: the company root certificate for Ubuntu and
 *   NODE_EXTRA_CA_CERTS, the Windows proxy's host:port for WSL (never credentials). A required host that fails asks
 *   before going on, default no.
 * - install.ps1's own download has a deadline and names proxy, certificate and timeout failures.
 * The functions are the installer's own, taken from its syntax tree and run in pwsh with the web calls stubbed; the
 * WSL check's bash runs for real against a fake curl. A real corporate-network run is the user's checklist.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BOOTSTRAP = join(ROOT, "website", "public", "install.ps1");
const INSTALLER = join(ROOT, "website", "public", "install-agend.ps1");
const code = (f: string) => readFileSync(f, "utf8").split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("static", () => {
  const c = code(INSTALLER);
  it("no Google gate; the Windows check runs before progress is touched, and stops (nothing changed) when declined", () => {
    expect(c).not.toMatch(/google\.com/);
    const gate = c.indexOf("if (-not (Test-WindowsNetwork)) {");
    expect(gate).toBeGreaterThan(c.indexOf("$identityMismatch") > 0 ? c.indexOf("$identityMismatch") : c.indexOf("if (-not (Check-Admin))"));
    expect(gate).toBeLessThan(c.indexOf("Clear-ResumeAtLogon\nStart-FreshProgress"));
    expect(c.slice(gate)).toMatch(/^if \(-not \(Test-WindowsNetwork\)\) \{\n[^\n]+\n\s+Set-InstallFailure 'network'\n\s+Read-Host "按 Enter 結束"; exit 1\n\}/);
  });
  it("the WSL check runs after WSL is ready and before stage 2, unless backends and AgEnD are both done", () => {
    const gate = c.indexOf("if (-not ((Stage-Done 2) -and (Stage-Done 4))) {");
    expect(gate).toBeGreaterThan(c.indexOf('Write-Ok "WSL 已就緒"'));
    expect(gate).toBeLessThan(c.indexOf('Write-Step 2 $TOTAL "安裝 AI 後端"'));
    expect(c.slice(gate)).toMatch(/^[^\n]+\n\s+if \(-not \(Test-WslNetwork \$UBUNTU_DISTRO\)\) \{\n[^\n]+\n\s+Set-InstallFailure 'network'\n\s+Read-Host "按 Enter 結束"; exit 1\n\s+\}\n\}/);
  });
  it("install.ps1's download has a deadline and names proxy, certificate and timeout failures; still ASCII", () => {
    const boot = readFileSync(BOOTSTRAP, "utf8");
    expect(/^[\x00-\x7f]*$/.test(boot)).toBe(true);
    expect(boot).toMatch(/Invoke-InstallDownload -Uri "\$base\/install-agend\.ps1" -OutFile \$tmp -TimeoutSec \d+/);
    for (const s of ["A proxy blocked it", "The HTTPS certificate was not trusted", "It timed out"]) expect(boot).toContain(s);
  });
});

function run(body: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2650net-")); dirs.push(dir);
  const script = join(dir, "t.ps1");
  // Script-level tables come from the installer itself: the assignments are taken from the syntax tree too.
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -match '^\\$NET_' }) { . ([scriptblock]::Create($a.Extent.Text)) }
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 90_000, env: { ...process.env, TMPDIR: dir, ...env } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return { out: r.stdout + r.stderr, dir };
}

describe.skipIf(!pwsh)("with pwsh: the network checks", { timeout: 120_000 }, () => {
  it("Get-NetFailureKind names DNS, timeout, refused, TLS and proxy failures (Windows PowerShell's statuses and .NET's messages)", () => {
    const { out } = run(`
function W($status) { try { throw [Net.WebException]::new('x', [Net.WebExceptionStatus]::$status) } catch { return $_ } }
function M($msg) { try { throw [Net.Http.HttpRequestException]::new($msg) } catch { return $_ } }
foreach ($s in 'NameResolutionFailure', 'Timeout', 'ConnectFailure', 'TrustFailure', 'SecureChannelFailure', 'ProxyNameResolutionFailure', 'UnknownError') { Write-Output ("W$s=" + (Get-NetFailureKind (W $s))) }
Write-Output ('M1=' + (Get-NetFailureKind (M 'No such host is known. (songsid.github.io:443)')))
Write-Output ('M2=' + (Get-NetFailureKind (M 'The SSL connection could not be established, see inner exception.')))
Write-Output ('M3=' + (Get-NetFailureKind (M 'The request was canceled due to the configured HttpClient.Timeout of 10 seconds elapsing. timed out')))
Write-Output ('M4=' + (Get-NetFailureKind (M 'Connection refused (songsid.github.io:443)')))
Write-Output ('M5=' + (Get-NetFailureKind (M 'Response status code does not indicate success: 407 (Proxy Authentication Required).')))`);
    for (const [k, v] of [["NameResolutionFailure", "dns"], ["Timeout", "timeout"], ["ConnectFailure", "refused"], ["TrustFailure", "tls"],
      ["SecureChannelFailure", "tls"], ["ProxyNameResolutionFailure", "proxy"], ["UnknownError", "other"]]) expect(out).toContain(`W${k}=${v}`);
    expect(out).toContain("M1=dns");
    expect(out).toContain("M2=tls");
    expect(out).toContain("M3=timeout");
    expect(out).toContain("M4=refused");
    expect(out).toContain("M5=proxy");
  });

  it("Test-WindowsEndpoint: success or an HTTP response is reachable, except a proxy's 407; a failure is tried twice, no more, and named", () => {
    const { out } = run(`
$script:calls = 0
function Invoke-WebRequest { param($Uri, $Method, $TimeoutSec, [switch]$UseBasicParsing, $ErrorAction)
  $script:calls++; $script:last = "$Method $Uri $TimeoutSec"
  switch -wildcard ($Uri) {
    '*ok.example*' { return 'ok' }
    '*proxyauth.example*' { $ex = [Net.WebException]::new('407'); $resp = [PSCustomObject]@{ StatusCode = 407 }; $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force; throw $ex }
    '*notallowed.example*' { $ex = [Net.WebException]::new('405'); $resp = [PSCustomObject]@{ StatusCode = 405 }; $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force; throw $ex }
    '*forbidden.example*' { $ex = [Net.WebException]::new('403'); $resp = [PSCustomObject]@{ StatusCode = 403 }; $ex | Add-Member -NotePropertyName Response -NotePropertyValue $resp -Force; throw $ex }
    default { throw [Net.WebException]::new('x', [Net.WebExceptionStatus]::NameResolutionFailure) } } }
Write-Output ('OK=[' + (Test-WindowsEndpoint 'ok.example') + '] calls=' + $script:calls + ' last=' + $script:last); $script:calls = 0
Write-Output ('HTTP=[' + (Test-WindowsEndpoint 'forbidden.example') + '] calls=' + $script:calls); $script:calls = 0
Write-Output ('DNS=[' + (Test-WindowsEndpoint 'gone.example') + '] calls=' + $script:calls); $script:calls = 0
Write-Output ('PROXY=[' + (Test-WindowsEndpoint 'proxyauth.example') + '] calls=' + $script:calls); $script:calls = 0
Write-Output ('METHOD=[' + (Test-WindowsEndpoint 'notallowed.example') + ']')`);
    expect(out).toContain("OK=[] calls=1 last=Head https://ok.example/ 10");
    expect(out).toContain("HTTP=[] calls=1");
    expect(out).toContain("DNS=[dns] calls=2");
    expect(out).toContain("PROXY=[proxy] calls=1");                         // a proxy's 407 is not the site answering (Prism review)
    expect(out).toContain("METHOD=[]");                                      // 405 (HEAD not allowed) is still the site answering
  });

  it("Resolve-NetResults: all fine is one line; an optional failure warns and goes on; a required one explains and asks, default no", () => {
    const { out } = run(`
function Get-WindowsProxy { return 'proxy.corp:8080' }
$script:answer = ''
function Read-Host { param($p) Write-Output "ASKED: $p" | Out-Host; return $script:answer }
function NR($host_, $req, $kind) { return @{ Host = $host_; Why = 'why'; Required = $req; Kind = $kind } }
Write-Output ('ALL=' + (Resolve-NetResults @((NR 'a.example' $true $null)) 'windows'))
Write-Output ('OPT=' + (Resolve-NetResults @((NR 'a.example' $true $null), (NR 'b.example' $false 'timeout')) 'windows'))
Write-Output '--REQ--'
Write-Output ('REQ=' + (Resolve-NetResults @((NR 'registry.npmjs.org' $true 'tls'), (NR 'c.example' $false 'dns')) 'wsl'))
$script:answer = ' y '
Write-Output ('YES=' + (Resolve-NetResults @((NR 'nodejs.org' $true 'refused')) 'wsl'))`);
    expect(out).toContain("Windows 的網路連線正常（需要的網站都連得上）");
    expect(out).toContain("ALL=True");
    expect(out).toContain("Windows 連不上 b.example（why）：逾時；只有用到時才需要");
    expect(out).toMatch(/OPT=True/);
    expect(out.slice(0, out.indexOf("--REQ--"))).not.toContain("ASKED:");
    const req = out.slice(out.indexOf("--REQ--"));
    expect(req).toContain("WSL 裡 連不上 registry.npmjs.org（why）：HTTPS 憑證不被信任");
    expect(req).toContain("update-ca-certificates");
    expect(req).toContain("NODE_EXTRA_CA_CERTS");
    expect(req).toContain("Windows 透過 proxy（proxy.corp:8080）上網。");
    expect(req).toContain("https_proxy=http://proxy.corp:8080");
    expect(req).toContain("ASKED:   安裝需要上面這些網站，現在多半會失敗。還是要繼續嗎？(y/N)");
    expect(req).toContain("REQ=False");
    expect(req).toContain("VPN 或 WSL 的 DNS 設定");
    expect(req).toContain("YES=True");
  });

  it("the WSL check's bash: every host at once, 2 tries at most, an HTTP error still reachable; parsed into named failures", () => {
    const { out, dir } = run(`
$script:text = Get-WslNetScript $NET_WSL
[IO.File]::WriteAllText((Join-Path $env:TMPDIR 'net.sh'), ($script:text -replace "\`r\`n", "\`n"))
Write-Output 'WROTE'`);
    expect(out).toContain("WROTE");
    // A fake curl: exit codes by host, every call logged.
    const bin = join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "curl"), `#!/bin/sh
for a in "$@"; do case $a in https://*) h=$a;; esac; done
echo "$h" >> ${dir}/calls
case $h in
  *songsid.github.io*) exit 0;;
  *registry.npmjs.org*) exit 60;;
  *nodejs.org*) exit 28;;
  *raw.githubusercontent.com*) exit 22;;
  *archive.ubuntu.com*) exit 6;;
  *claude.ai*) exit 5;;
  *) exit 7;;
esac
`);
    chmodSync(join(bin, "curl"), 0o755);
    const r = spawnSync("bash", [join(dir, "net.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.status).toBe(0);
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
    expect(calls.filter(c => c.includes("songsid.github.io"))).toHaveLength(1);
    expect(calls.filter(c => c.includes("raw.githubusercontent.com"))).toHaveLength(1);
    expect(calls.filter(c => c.includes("registry.npmjs.org"))).toHaveLength(2);
    expect(calls.filter(c => c.includes("cli.kiro.dev"))).toHaveLength(2);
    const parsed = run(`
$text = @'
${r.stdout}
'@
foreach ($x in ConvertFrom-WslNetOutput $text $NET_WSL) { Write-Output ('P=' + $x.Host + '|' + $x.Required + '|' + $x.Kind) }
foreach ($x in ConvertFrom-WslNetOutput 'NET_NO_CURL' $NET_WSL) { Write-Output ('N=' + $x.Host + '|' + $x.Required + '|' + $x.Kind) }
foreach ($x in ConvertFrom-WslNetOutput '' @(@{ Host = 'a.example'; Why = 'w'; Required = $true })) { Write-Output ('E=' + $x.Host + '|' + $x.Kind) }`).out;
    for (const line of ["P=songsid.github.io|True|", "P=registry.npmjs.org|True|tls", "P=nodejs.org|True|timeout", "P=raw.githubusercontent.com|True|",
      "P=archive.ubuntu.com|False|dns", "P=cli.kiro.dev|False|refused", "P=claude.ai|False|proxy"]) expect(parsed).toContain(line);
    expect(parsed).toContain("N=registry.npmjs.org|False|curl");
    expect(parsed).toContain("E=a.example|other");
  });

  it("Get-CurlFailureKind maps curl's exit codes", () => {
    const { out } = run(`foreach ($c in 0, 22, 5, 97, 6, 7, 28, 35, 60, 77, 52) { $k = Get-CurlFailureKind $c; Write-Output ("C$c=" + $(if ($null -eq $k) { 'ok' } else { $k })) }`);
    for (const [c, k] of [[0, "ok"], [22, "ok"], [5, "proxy"], [97, "proxy"], [6, "dns"], [7, "refused"], [28, "timeout"], [35, "tls"], [60, "tls"], [77, "tls"], [52, "other"]]) {
      expect(out).toContain(`C${c}=${k}`);
    }
  });
});
