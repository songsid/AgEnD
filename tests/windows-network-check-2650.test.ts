/** Inert Windows network classifications plus the real WSL bash against a private fake curl; one pwsh batch. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractPsFunction } from './support/installer-ps-extract.js';
import { installerPwshBatch, type InstallerPwshCase } from './support/installer-pwsh-fixture.js';
const ROOT = join(import.meta.dirname,'..');
const BOOTSTRAP = join(ROOT,'website/public/install.ps1');
const INSTALLER = join(ROOT,'website/public/install-agend.ps1');
const code = (f: string) => readFileSync(f,'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
const source = readFileSync(INSTALLER,'utf8');
// Slice only these data tables, not the installer body or its platform actions.
const tables = source.slice(source.indexOf('$NET_WINDOWS = @('), source.indexOf('function Get-NetFailureKind'));
const alternates = source.match(/^\$NET_ALTERNATES = [^\r\n]+/m)?.[0];
if (!tables.startsWith('$NET_WINDOWS = @(') || !tables.includes('$NET_WSL = @(') || !alternates) throw Error('Missing network tables');
const prelude = tables + '\n' + alternates + '\n' + [
 'Get-NetFailureKind','Test-WindowsEndpoint','Get-WindowsProxy','Format-NetFailure','Write-NetAdvice','Resolve-NetResults',
 'Get-WslNetScript','Get-CurlFailureKind','ConvertFrom-WslNetOutput','Write-Ok','Write-Warn','Write-Info','Write-Err','Write-InstallLog','Protect-LogText',
].map(n => extractPsFunction(source,n)).join('\n');
const cases: Record<string,InstallerPwshCase> = {};
const add = (name: string, body: string) => { cases[name] = {prelude:'installer',body}; };
add('kinds', `
function W($status) { try { throw [Net.WebException]::new('x', [Net.WebExceptionStatus]::$status) } catch { return $_ } }
function M($msg) { try { throw [Net.Http.HttpRequestException]::new($msg) } catch { return $_ } }
foreach ($s in 'NameResolutionFailure', 'Timeout', 'ConnectFailure', 'TrustFailure', 'SecureChannelFailure', 'ProxyNameResolutionFailure', 'UnknownError') { Write-Output ("W$s=" + (Get-NetFailureKind (W $s))) }
Write-Output ('M1=' + (Get-NetFailureKind (M 'No such host is known. (songsid.github.io:443)')))
Write-Output ('M2=' + (Get-NetFailureKind (M 'The SSL connection could not be established, see inner exception.')))
Write-Output ('M3=' + (Get-NetFailureKind (M 'The request was canceled due to the configured HttpClient.Timeout of 10 seconds elapsing. timed out')))
Write-Output ('M4=' + (Get-NetFailureKind (M 'Connection refused (songsid.github.io:443)')))
Write-Output ('M5=' + (Get-NetFailureKind (M 'Response status code does not indicate success: 407 (Proxy Authentication Required).')))`);
add('endpoint', `
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
add('resolve', `
function Get-WindowsProxy { return 'proxy.corp:8080' }
$script:answer = ''
function Read-Host { param($p) Write-Host "ASKED: $p"; return $script:answer }
function NR($host_, $req, $kind) { return @{ Host = $host_; Why = 'why'; Required = $req; Kind = $kind } }
Write-Output ('ALL=' + (Resolve-NetResults @((NR 'a.example' $true $null)) 'windows'))
Write-Output ('OPT=' + (Resolve-NetResults @((NR 'a.example' $true $null), (NR 'b.example' $false 'timeout')) 'windows'))
Write-Output '--REQ--'
Write-Output ('REQ=' + (Resolve-NetResults @((NR 'registry.npmjs.org' $true 'tls'), (NR 'c.example' $false 'dns')) 'wsl'))
$script:answer = ' y '
Write-Output ('YES=' + (Resolve-NetResults @((NR 'nodejs.org' $true 'refused')) 'wsl'))`);
add('curl', `foreach ($c in 0, 22, 5, 97, 6, 7, 28, 35, 60, 77, 52) { $k = Get-CurlFailureKind $c; Write-Output ("C$c=" + $(if ($null -eq $k) { 'ok' } else { $k })) }`);
// Never fall through to Windows' bash.exe/WSL; this proof requires an actual POSIX scratch environment.
const bash = process.platform !== 'win32' && existsSync('/bin/bash') ? '/bin/bash' : null;
if (bash) cases.bash = {prelude:'installer', setup(dir) {
 const bin = join(dir,'bin'); mkdirSync(bin);
 writeFileSync(join(bin,'curl'), `#!/bin/sh
for a in "$@"; do case $a in https://*) h=$a;; esac; done
printf '%s\\n' "$h" >> "$FIXTURE_CURL_CALLS"
case $h in
 *songsid.github.io*) exit 0;;
 *registry.npmjs.org*) exit 60;;
 *nodejs.org*) exit 28;;
 *raw.githubusercontent.com*) exit 22;;
 *archive.ubuntu.com*) exit 6;;
 *claude.ai*) exit 5;;
 *) exit 7;;
esac
`); chmodSync(join(bin,'curl'),0o755);
 return {FIXTURE_BASH:bash, FIXTURE_CURL_CALLS:join(dir,'calls'),PATH:bin+':'+process.env.PATH};
}, body: `
$file = Join-Path $env:TMPDIR 'net.sh'
[IO.File]::WriteAllText($file, ((Get-WslNetScript $NET_WSL) -replace "\`r\`n", "\`n"))
$text = (& $env:FIXTURE_BASH $file) -join "\`n"
if ($LASTEXITCODE -ne 0) {throw 'Scratch bash failed'}
foreach ($x in ConvertFrom-WslNetOutput $text $NET_WSL) { Write-Output ('P=' + $x.Host + '|' + $x.Required + '|' + $x.Kind) }
foreach ($x in ConvertFrom-WslNetOutput 'NET_NO_CURL' $NET_WSL) { Write-Output ('N=' + $x.Host + '|' + $x.Required + '|' + $x.Kind) }
foreach ($x in ConvertFrom-WslNetOutput '' @(@{ Host='a.example'; Why='w'; Required=$true })) { Write-Output ('E=' + $x.Host + '|' + $x.Kind) }
`};
const batch = installerPwshBatch({installer:prelude},cases);
afterAll(batch.cleanup);
const output = (name: string) => { expect(batch.results[name]?.error).toBeNull(); return batch.results[name]!.out; };
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
describe.skipIf(!batch.available)("with pwsh: the network checks", () => {
  it("Get-NetFailureKind names DNS, timeout, refused, TLS and proxy failures (Windows PowerShell's statuses and .NET's messages)", () => {
    const out = output('kinds');
    for (const [k, v] of [["NameResolutionFailure", "dns"], ["Timeout", "timeout"], ["ConnectFailure", "refused"], ["TrustFailure", "tls"],
      ["SecureChannelFailure", "tls"], ["ProxyNameResolutionFailure", "proxy"], ["UnknownError", "other"]]) expect(out).toContain(`W${k}=${v}`);
    expect(out).toContain("M1=dns");
    expect(out).toContain("M2=tls");
    expect(out).toContain("M3=timeout");
    expect(out).toContain("M4=refused");
    expect(out).toContain("M5=proxy");
  });

  it("Test-WindowsEndpoint: success or an HTTP response is reachable, except a proxy's 407; a failure is tried twice, no more, and named", () => {
    const out = output('endpoint');
    expect(out).toContain("OK=[] calls=1 last=Head https://ok.example/ 10");
    expect(out).toContain("HTTP=[] calls=1");
    expect(out).toContain("DNS=[dns] calls=2");
    expect(out).toContain("PROXY=[proxy] calls=1");                         // a proxy's 407 is not the site answering (Prism review)
    expect(out).toContain("METHOD=[]");                                      // 405 (HEAD not allowed) is still the site answering
  });

  it("Resolve-NetResults: all fine is one line; an optional failure warns and goes on; a required one explains and asks, default no", () => {
    const out = output('resolve');
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

  it.skipIf(!bash)("the WSL check's real Linux bash: every host at once, bounded retries, HTTP reachable, parsed failures", () => {
    const out = output('bash');
    const calls = readFileSync(join(batch.results.bash!.dir, 'calls'), 'utf8').trim().split('\n');
    for (const [host, count] of [['songsid.github.io',1],['raw.githubusercontent.com',1],['registry.npmjs.org',2],['cli.kiro.dev',2]] as const) {
      expect(calls.filter(c => c === `https://${host}/`)).toHaveLength(count);
    }
    for (const line of ['P=songsid.github.io|True|','P=registry.npmjs.org|True|tls','P=nodejs.org|True|timeout','P=raw.githubusercontent.com|True|',
      'P=archive.ubuntu.com|False|dns','P=cli.kiro.dev|False|refused','P=claude.ai|False|proxy']) expect(out).toContain(line);
    expect(out).toContain('N=registry.npmjs.org|False|curl'); expect(out).toContain('E=a.example|other');
  });

  it("Get-CurlFailureKind maps curl's exit codes", () => {
    const out = output('curl');
    for (const [c, k] of [[0, "ok"], [22, "ok"], [5, "proxy"], [97, "proxy"], [6, "dns"], [7, "refused"], [28, "timeout"], [35, "handshake"], [60, "tls"], [77, "tls"], [52, "other"]]) {
      expect(out).toContain(`C${c}=${k}`);
    }
  });
});
