/** Batch C's inert PowerShell fixture. One pwsh, one compiled prelude per source, isolated script scopes per case. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface InstallerPwshCase { prelude: string; body: string; env?: Record<string, string>; setup?: (dir: string) => Record<string, string> | void }
export interface InstallerPwshResult { out: string; error: string | null; dir: string }
const psString = (text: string) => `'${text.replace(/'/g, "''")}'`;
/** Replace only the extracted test copy; production keeps its real Stopwatch. */
export const withInstallerClock = (source: string) => source.replaceAll("[Diagnostics.Stopwatch]::StartNew()", "$script:FixtureClock");

const SAFETY = `
$script:InstallLog = $null
$script:OnWindows = $false
$script:FixtureMilliseconds = 0.0
$script:FixtureClock = @{ Elapsed = @{ TotalMilliseconds = 0.0; TotalSeconds = 0.0; TotalMinutes = 0.0 } }
$script:FixtureTick = $null
function Get-Date { param([string]$Format)
  $now = ([datetime]'2026-01-01T00:00:00').AddMilliseconds($script:FixtureMilliseconds)
  if ($Format) { return $now.ToString($Format) }; return $now
}
function Start-Sleep { param([double]$Seconds, [double]$Milliseconds)
  $delta = $Milliseconds + 1000.0 * $Seconds
  if ($delta -le 0) { throw 'Fixture sleep must advance time' }
  $script:FixtureMilliseconds += $delta
  $script:FixtureClock.Elapsed.TotalMilliseconds = $script:FixtureMilliseconds
  $script:FixtureClock.Elapsed.TotalSeconds = $script:FixtureMilliseconds / 1000.0
  $script:FixtureClock.Elapsed.TotalMinutes = $script:FixtureMilliseconds / 60000.0
  if ($script:FixtureTick) { & $script:FixtureTick }
}
function wsl { throw 'Native WSL forbidden' }
function wsl.exe { throw 'Native WSL forbidden' }
function netsh.exe { throw 'Native network settings forbidden' }
function Invoke-WebRequest { throw 'Real network forbidden' }
function Invoke-RestMethod { throw 'Real network forbidden' }
function Start-Process { throw 'Native process/browser launch forbidden' }
function Restart-Computer { throw 'Reboot forbidden' }
function Read-Host { throw 'Unexpected terminal interaction' }
function Set-Clipboard { throw 'Real clipboard forbidden' }
function Set-ItemProperty { throw 'Real registry write forbidden' }
function Remove-ItemProperty { throw 'Real registry write forbidden' }
function New-Object {
  [CmdletBinding()] param([Parameter(Position=0)][string]$TypeName, [Parameter(Position=1)][object[]]$ArgumentList, [string]$ComObject, [hashtable]$Property)
  if ($ComObject) { throw 'Real COM forbidden' }
  Microsoft.PowerShell.Utility\\New-Object @PSBoundParameters
}
`;

export function installerPwshBatch(preludes: Record<string, string>, cases: Record<string, InstallerPwshCase>) {
  if (!Object.keys(cases).length) throw Error("Empty PowerShell batch");
  const dir = mkdtempSync(join(tmpdir(), "agend-pwsh-c-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const resultPath = join(dir, "results.json");
  const descriptions: string[] = [];
  for (const [name, test] of Object.entries(cases)) {
    if (!/^[a-z0-9-]+$/.test(name) || !Object.hasOwn(preludes, test.prelude)) { cleanup(); throw Error(`Bad fixture case ${name}`); }
    const caseDir = join(dir, name); mkdirSync(caseDir);
    const file = join(caseDir, "case.ps1");
    writeFileSync(file, `param([scriptblock]$FixturePrelude)\n$ErrorActionPreference = 'Stop'\n. $FixturePrelude\n${SAFETY}\n${test.body}\n`);
    const env = { HOME: caseDir, USERPROFILE: caseDir, TMPDIR: caseDir, TEMP: caseDir, TMP: caseDir,
      LOCALAPPDATA: join(caseDir, "localappdata"), AGEND_HOME: join(caseDir, "agend"), AGEND_VERSION: "", AGEND_WSL_DRIVE: "", ...test.env, ...test.setup?.(caseDir) };
    descriptions.push(`@{ Name = ${psString(name)}; File = ${psString(file)}; Prelude = ${psString(test.prelude)}; Env = @{ ${Object.entries(env).map(([k, v]) => `${psString(k)} = ${psString(v)}`).join("; ")} } }`);
  }
  const runner = join(dir, "batch.ps1");
  writeFileSync(runner, `$ErrorActionPreference = 'Stop'
if (Get-Variable PSStyle -ErrorAction SilentlyContinue) { $PSStyle.OutputRendering = 'PlainText' }
$originalEnv = @{}; Get-ChildItem Env: | ForEach-Object { $originalEnv[$_.Name] = $_.Value }
$preludes = @{ ${Object.entries(preludes).map(([name, source]) => `${psString(name)} = [scriptblock]::Create(${psString(source)})`).join("\n")} }
$results = [ordered]@{}
foreach ($case in @(${descriptions.join("\n")})) {
  @(Get-ChildItem Env:) | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }
  foreach ($pair in $originalEnv.GetEnumerator()) { [Environment]::SetEnvironmentVariable($pair.Key, $pair.Value, 'Process') }
  foreach ($pair in $case.Env.GetEnumerator()) { [Environment]::SetEnvironmentVariable($pair.Key, $pair.Value, 'Process') }
  $global:LASTEXITCODE = 0
  Push-Location (Split-Path -Parent $case.File)
  try { $output = (& $case.File $preludes[$case.Prelude] *>&1 | Out-String -Width 4096); $results[$case.Name] = @{ out = $output; error = $null } }
  catch { $results[$case.Name] = @{ out = ''; error = ($_ | Out-String) + $_.ScriptStackTrace } }
  finally { Pop-Location }
}
[IO.File]::WriteAllText(${psString(resultPath)}, (ConvertTo-Json -Depth 8 $results), [Text.UTF8Encoding]::new($false))
`);
  const run = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", runner], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: dir, TEMP: dir, TMP: dir, AGEND_HOME: join(dir, "agend") },
  });
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") { cleanup(); return { available: false, results: {} as Record<string, InstallerPwshResult>, cleanup }; }
  if (run.error || run.signal || run.status !== 0) { cleanup(); throw Error(`pwsh batch failed: ${run.error ?? run.signal ?? run.status}\n${run.stdout}${run.stderr}`); }
  const results = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, InstallerPwshResult>;
  for (const name of Object.keys(cases)) { if (!results[name]) { cleanup(); throw Error(`Missing fixture result ${name}`); } results[name].dir = join(dir, name); }
  return { available: true, results, cleanup };
}
