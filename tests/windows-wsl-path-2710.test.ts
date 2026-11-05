import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBatch, caseOut, psq, runBatch, type BatchResults, type PsCase } from './support/installer-ps-batch-b.js';
import { registerExecutableFixture } from './support/process-guard.js';

const installer = resolve('website/public/install-agend.ps1');
const source = readFileSync(installer, 'utf8');
const pwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '1'], { timeout: 60000 }).status === 0;

const PATHS = ['C:\\ProgramData\\AgEnD-install\\step.sh', 'D:\\中文 目錄\\step.sh', "C:\\space ' literal $HOME\\step.sh"];
const PROGRAM_DATA = 'C:\\ProgramData';

// WSL 2.6.1 WslClient::ParseExecCommand/Launch: -- uses $SHELL -c; --exec parses literal argv.
// Run an actual shell here: an argv-only fake would miss the extra parse that caused the real failure.
function installShims(bin: string) {
  mkdirSync(bin, { recursive: true });
  const shim = `#!${process.execPath}
const {spawnSync}=require('node:child_process'),fs=require('node:fs');
fs.appendFileSync(process.env.WSL_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');
if(process.env.WSL_UTF8!=='1')throw Error('native diagnostic encoding not set');
if(process.env.WSL_FAIL_CODE){process.stderr.write('WSL provisioning error: first-launch failed\\n');process.exit(Number(process.env.WSL_FAIL_CODE));}
const a=process.argv.slice(2),i=a.findIndex(v=>v==='--'||v==='--exec');
if(i<0)throw Error('unexpected native operation');
const cmd=a.slice(i+1),r=a[i]==='--exec'?spawnSync(cmd[0],cmd.slice(1),{stdio:'inherit'}):spawnSync('/bin/bash',['-c',cmd.join(' ')],{stdio:'inherit'});
process.exit(r.status??92);
`;
  writeFileSync(join(bin, 'wsl.exe'), shim); chmodSync(join(bin, 'wsl.exe'), 0o755);
  writeFileSync(join(bin, 'wslpath'), `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);
fs.writeFileSync(process.env.WSL_ARGV,JSON.stringify(a));
if(a[0]!=='-u'||a[1]!==process.env.WSL_EXPECTED){process.stderr.write('wslpath: '+a[1]+'\\n');process.exit(1);}
process.stdout.write(process.env.WSL_CONVERTED||'/mnt/c/ProgramData/AgEnD-install/step.sh');
`); chmodSync(join(bin, 'wslpath'), 0o755);
// M-2239 P2-5: both are private stand-ins, never Windows' own — registered, so the guard's Windows rule lets them run.
registerExecutableFixture(join(bin, 'wsl.exe')); registerExecutableFixture(join(bin, 'wslpath'));
}

/** Per-case state: its own ProgramData, install log, shim call log and argv; env the shims read. */
function header(batch: string): string {
  return `$UBUNTU_DISTRO = 'AgEnD'; $AGEND_USER = 'root'; $ProgressFile = ''
$INSTALL_LOG_MAX_BYTES = 5MB
function Read-Host {throw 'No terminal provisioning allowed'}
function wsl {throw 'Unstubbed WSL forbidden'}
function Use-PathCase([string]$name, [hashtable]$vars = @{}) {
  $d = Join-Path ${psq(batch)} $name
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  $env:ProgramData = $d
  $script:InstallLog = Join-Path $d 'install.log'; $script:InstallLogFull = $false
  $env:WSL_CALLS = Join-Path $d 'calls.jsonl'; $env:WSL_ARGV = Join-Path $d 'argv.json'
  foreach ($k in 'WSL_EXPECTED', 'WSL_CONVERTED', 'WSL_FAIL_CODE') { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
  foreach ($k in $vars.Keys) { Set-Item -Path "Env:$k" -Value ([string]$vars[$k]) }
  return $d
}`;
}

function cases(batch: string): PsCase[] {
  const out: PsCase[] = [
    { name: 'diagnostic', body: `$null = Use-PathCase 'diagnostic' @{ WSL_EXPECTED = ${psq(PROGRAM_DATA)} }
$r = Invoke-BoundedWsl -Arguments @('-d','AgEnD','-u','root','--','wslpath','-u',${psq(PROGRAM_DATA)});Write-Output ($r|ConvertTo-Json -Compress)` },
    ...PATHS.map((path, i) => ({ name: `exec-${i}`, body: `$null = Use-PathCase 'exec-${i}' @{ WSL_EXPECTED = ${psq(path)} }
Write-Output (ConvertTo-WslScriptPath ${psq(path)} 'AgEnD')` })),
    { name: 'resumed', body: `$null = Use-PathCase 'resumed'
function Invoke-BoundedWsl {param($Arguments);if($Arguments[4] -ne '--exec'){throw 'OOBE/shell path must not be used'};return @{Code=0;Text=$Arguments[-1]}}
foreach($attempt in 1,2){$f,$w=New-WslScriptFile "echo ok\`r\`n";Write-Output ('PATH='+$w);Write-Output ([IO.File]::ReadAllText($f));Remove-Item -LiteralPath $f}` },
    ...[1, 37, 124].flatMap(code => [
      { name: `fail-${code}`, body: `$null = Use-PathCase 'fail-${code}' @{ WSL_FAIL_CODE = '${code}' }
try{New-WslScriptFile 'echo never';throw 'unexpected success'}catch{Write-Output ('FAILED='+$_.Exception.Message)}` },
      { name: `fail-${code}-count`, body: `$d = Join-Path ${psq(batch)} 'fail-${code}'
Write-Output (@(Get-ChildItem (Join-Path $d 'AgEnD-install') -Filter '*.sh').Count)` },
    ]),
    { name: 'malformed', body: `$null = Use-PathCase 'malformed'
function Invoke-BoundedWsl {return @{Code=0;Text="WSL_OK\`n/mnt/c/file"}}
try{New-WslScriptFile 'echo never'}catch{Write-Output $_.Exception.Message}` },
    { name: 'root-probe', body: `$null = Use-PathCase 'root-probe'
function Invoke-BoundedWsl {return @{Code=23;Text='WSL_E_DISTRO_NOT_FOUND token=private-value'}}
Write-Output ('READY='+(Test-WslRoot 'AgEnD'))
Get-WslFailureMessage 'WSL config merge failed' @{Code=19;Text='config changed; retry'}` },
    { name: 'redacts', body: `$null = Use-PathCase 'redacts'
$script:observed=$null;$raw='token=private-value '+('x'*8177)
function New-WslScriptFile {return @(${psq(join(batch, 'redacts', 'owned-step.sh'))}, '/scratch/step.sh')}
function Invoke-Watched {param($OnLine);& $OnLine $raw;return 42}
$code=Invoke-WslStep -Label 'stub' -Script 'never' -OnLine {param($line);$script:observed=$line}
Write-Output ('RAW_UNCHANGED='+($script:observed -ceq $raw))
Write-Output ('BOUNDED='+($script:LastWslStepResult.Text.Length -le 8192))
Write-Output (Get-WslFailureMessage 'WSL config merge failed' $script:LastWslStepResult)` },
    { name: 'setup-observer', body: `$null = Use-PathCase 'setup-observer'
function New-WslScriptFile {return @(${psq(join(batch, 'setup-observer', 'owned-step.sh'))}, '/scratch/step.sh')}
function Invoke-Watched {param($OnLine);& $OnLine 'Setup complete';return 0}
$r=Invoke-BrowserSetup {param($hook);Invoke-WslStep -Label 'setup' -Script 'stub' -OnLine $hook}
Write-Output ('DONE='+$r.Done+' EXIT='+$r.Exit)` },
    { name: 'streamed-failure', body: `$null = Use-PathCase 'streamed-failure'
$script:seen=@();function New-WslScriptFile {return @(${psq(join(batch, 'streamed-failure', 'owned-step.sh'))}, '/scratch/step.sh')}
function Invoke-Watched {param($OnLine);& $OnLine 'linux config merge error';return 42}
$code=Invoke-WslStep -Label 'stub' -Script 'echo never' -OnLine {param($line);$script:seen+=$line}
Write-Output ('CODE='+$code+' SEEN='+$script:seen.Count)
Write-Output (Get-WslFailureMessage 'WSL config merge failed' $script:LastWslStepResult)` },
  ];
  return out;
}

describe.skipIf(!pwsh)('Windows paths across the real bounded-process boundary, WSL entirely stubbed', () => {
  let batch = '';
  let results: BatchResults = {};
  beforeAll(() => {
    batch = mkdtempSync(join(tmpdir(), 'agend-wsl-path-2710-'));
    const bin = join(batch, 'bin');
    installShims(bin);
    results = runBatch(batch, buildBatch(source, header(batch), cases(batch)), {
      HOME: batch, USERPROFILE: batch, TMPDIR: batch, PATH: `${bin}:${process.env.PATH}`,
    }, 20000);
  });
  afterAll(() => { if (batch) rmSync(batch, { recursive: true, force: true }); });

  it('reproduces the user diagnostic: -- lets the Linux shell consume the backslash', () => {
    expect(JSON.parse(caseOut(results, 'diagnostic'))).toMatchObject({ Code: 1, Text: 'wslpath: C:ProgramData\n' });
  });
  it.each(PATHS.map((path, i) => [path, i] as const))('--exec preserves a literal Windows path: %s', (path, i) => {
    expect(caseOut(results, `exec-${i}`).trim()).toBe('/mnt/c/ProgramData/AgEnD-install/step.sh');
    const dir = join(batch, `exec-${i}`);
    expect(JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'))).toEqual(['-u', path]);
    expect(JSON.parse(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim())).toEqual(['-d', 'AgEnD', '-u', 'root', '--exec', 'wslpath', '-u', path]);
  });
  it('new and resumed script steps always use the same literal converter, without opening OOBE', () => {
    const out = caseOut(results, 'resumed');
    expect(out.match(/PATH=/g)).toHaveLength(2);
    expect(out.match(/echo ok/g)).toHaveLength(2);
  });
  it.each([1, 37, 124])('failed conversion includes code/output in the error and the redacted log: %s', code => {
    const out = caseOut(results, `fail-${code}`);
    for (const text of [out, readFileSync(join(batch, `fail-${code}`, 'install.log'), 'utf8')]) {
      expect(text).toContain(`exit ${code}`); expect(text).toContain('WSL provisioning error: first-launch failed');
    }
    expect(caseOut(results, `fail-${code}-count`)).toBe('0\n');
  });
  it('an exit-zero malformed path retains diagnostic output and never starts a step', () => {
    const out = caseOut(results, 'malformed');
    expect(out).toContain('invalid path'); expect(out).toContain('exit 0'); expect(out).toContain('WSL_OK');
  });
  it('root-probe and config failure diagnostics remain actionable and redact secrets', () => {
    const out = caseOut(results, 'root-probe');
    expect(out).toContain('READY=False'); expect(out).toContain('exit 23'); expect(out).toContain('WSL_E_DISTRO_NOT_FOUND');
    expect(out).toContain('exit 19'); expect(out).toContain('config changed; retry');
    const log = readFileSync(join(batch, 'root-probe', 'install.log'), 'utf8'); expect(log).not.toContain('private-value'); expect(log).toContain('token=[hidden]');
  });
  it('redacts before retaining a bounded tail, while the original observer still receives raw input', () => {
    const out = caseOut(results, 'redacts');
    expect(out).toContain('RAW_UNCHANGED=True'); expect(out).toContain('BOUNDED=True'); expect(out).toContain('exit 42');
    expect(out).not.toContain('private-value');
    expect(readFileSync(join(batch, 'redacts', 'install.log'), 'utf8')).not.toContain('private-value');
  });
  it('the real setup observer still sees completion through the diagnostic capture callback', () => {
    expect(caseOut(results, 'setup-observer')).toContain('DONE=True EXIT=0');
  });
  it('a failed streamed WSL step keeps output/exit while forwarding the original observer once', () => {
    const out = caseOut(results, 'streamed-failure');
    expect(out).toContain('CODE=42 SEEN=1'); expect(out).toContain('exit 42'); expect(out).toContain('linux config merge error');
  });
});

it('all script-file paths use the converter; shared shortcut helper stays identical', () => {
  expect(source).toContain('$wslFile = ConvertTo-WslScriptPath $file $Distro');
  expect(source.match(/'wslpath', '-u'/g)).toHaveLength(1);
  const helper = (text: string) => text.match(/\$WSL_COMMAND_FN = @'\n[\s\S]*?\n'@/)?.[0];
  expect(helper(source)).toBeTruthy();
  expect(helper(source)).toBe(helper(readFileSync(resolve('templates/windows-shortcuts.ps1'), 'utf8')));
});
