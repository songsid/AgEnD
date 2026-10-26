import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = resolve('website/public/install-agend.ps1');
const source = readFileSync(installer, 'utf8');
const pwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '1'], { timeout: 60000 }).status === 0;
function scratch(body: (run: (ps: string, env?: Record<string, string>) => string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'agend-wsl-path-2710-'));
  const ps = join(dir, 'test.ps1');
  // WSL 2.6.1 WslClient::ParseExecCommand/Launch: -- uses $SHELL -c; --exec parses literal argv.
  // Run an actual shell here: an argv-only fake would miss the extra parse that caused the real failure.
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
  writeFileSync(join(dir, 'wsl.exe'), shim); chmodSync(join(dir, 'wsl.exe'), 0o755);
  writeFileSync(join(dir, 'wslpath'), `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);
fs.writeFileSync(process.env.WSL_ARGV,JSON.stringify(a));
if(a[0]!=='-u'||a[1]!==process.env.WSL_EXPECTED){process.stderr.write('wslpath: '+a[1]+'\\n');process.exit(1);}
process.stdout.write(process.env.WSL_CONVERTED||'/mnt/c/ProgramData/AgEnD-install/step.sh');
`); chmodSync(join(dir, 'wslpath'), 0o755);
  const run = (body: string, env: Record<string, string> = {}) => {
    writeFileSync(ps, `$ErrorActionPreference='Stop'
$t=$null;$e=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile('${installer}',[ref]$t,[ref]$e)
if($e.Count){throw ($e|Out-String)}
foreach($fn in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($fn.Extent.Text))}
foreach($a in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$WSL_COMMAND_FN'},$false)){. ([scriptblock]::Create($a.Extent.Text))}
. ([scriptblock]::Create($WSL_COMMAND_FN))
$script:InstallLog='${dir}/install.log';$INSTALL_LOG_MAX_BYTES=5MB;$script:InstallLogFull=$false
$env:ProgramData='${dir}';$UBUNTU_DISTRO='AgEnD';$AGEND_USER='root';$ProgressFile=''
function Read-Host {throw 'No terminal provisioning allowed'}
function wsl {throw 'Unstubbed WSL forbidden'}
${body}`);
    return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', ps], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: dir, PATH: `${dir}:${process.env.PATH}`,
        WSL_CALLS: join(dir, 'calls.jsonl'), WSL_ARGV: join(dir, 'argv.json'), ...env },
    });
  };
  try { body(run, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe.skipIf(!pwsh)('Windows paths across the real bounded-process boundary, WSL entirely stubbed', () => {
  it('reproduces the user diagnostic: -- lets the Linux shell consume the backslash', () => scratch((run) => {
    const out = run(`$r=Invoke-BoundedWsl -Arguments @('-d','AgEnD','-u','root','--','wslpath','-u','C:\\ProgramData');Write-Output ($r|ConvertTo-Json -Compress)`, { WSL_EXPECTED: 'C:\\ProgramData' });
    expect(JSON.parse(out)).toMatchObject({ Code: 1, Text: 'wslpath: C:ProgramData\n' });
  }));
  it.each(['C:\\ProgramData\\AgEnD-install\\step.sh', 'D:\\中文 目錄\\step.sh', "C:\\space ' literal $HOME\\step.sh"])(
    '--exec preserves a literal Windows path: %s', path => scratch((run, dir) => {
      const out = run(`Write-Output (ConvertTo-WslScriptPath '${path.replaceAll("'", "''")}' 'AgEnD')`, { WSL_EXPECTED: path });
      expect(out.trim()).toBe('/mnt/c/ProgramData/AgEnD-install/step.sh');
      expect(JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'))).toEqual(['-u', path]);
      expect(JSON.parse(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim())).toEqual(['-d','AgEnD','-u','root','--exec','wslpath','-u',path]);
    }),
  );
  it('new and resumed script steps always use the same literal converter, without opening OOBE', () => scratch((run, dir) => {
    const out = run(`function Invoke-BoundedWsl {param($Arguments);if($Arguments[4] -ne '--exec'){throw 'OOBE/shell path must not be used'};return @{Code=0;Text=$Arguments[-1]}}
foreach($attempt in 1,2){$f,$w=New-WslScriptFile "echo ok\`r\`n";Write-Output ('PATH='+$w);Write-Output ([IO.File]::ReadAllText($f));Remove-Item -LiteralPath $f}`);
    expect(out.match(/PATH=/g)).toHaveLength(2);
    expect(out.match(/echo ok/g)).toHaveLength(2);
  }));
  it.each([1,37,124])('failed conversion includes code/output in the error and the redacted log: %s', code => scratch((run, dir) => {
    const out = run(`try{New-WslScriptFile 'echo never';throw 'unexpected success'}catch{Write-Output ('FAILED='+$_.Exception.Message)}`, { WSL_FAIL_CODE: String(code) });
    for (const text of [out, readFileSync(join(dir, 'install.log'), 'utf8')]) {
      expect(text).toContain(`exit ${code}`); expect(text).toContain('WSL provisioning error: first-launch failed');
    }
    expect(run(`Write-Output (@(Get-ChildItem '${dir}/AgEnD-install' -Filter '*.sh').Count)`)).toBe('0\n');
  }));
  it('an exit-zero malformed path retains diagnostic output and never starts a step', () => scratch(run => {
    const out = run(`function Invoke-BoundedWsl {return @{Code=0;Text="WSL_OK\`n/mnt/c/file"}}
try{New-WslScriptFile 'echo never'}catch{Write-Output $_.Exception.Message}`);
    expect(out).toContain('invalid path'); expect(out).toContain('exit 0'); expect(out).toContain('WSL_OK');
  }));
  it('root-probe and config failure diagnostics remain actionable and redact secrets', () => scratch((run, dir) => {
    const out = run(`function Invoke-BoundedWsl {return @{Code=23;Text='WSL_E_DISTRO_NOT_FOUND token=private-value'}}
Write-Output ('READY='+(Test-WslRoot 'AgEnD'))
Get-WslFailureMessage 'WSL config merge failed' @{Code=19;Text='config changed; retry'}`);
    expect(out).toContain('READY=False'); expect(out).toContain('exit 23'); expect(out).toContain('WSL_E_DISTRO_NOT_FOUND');
    expect(out).toContain('exit 19'); expect(out).toContain('config changed; retry');
    const log = readFileSync(join(dir,'install.log'),'utf8'); expect(log).not.toContain('private-value'); expect(log).toContain('token=[hidden]');
  }));
  it('redacts before retaining a bounded tail, while the original observer still receives raw input', () => scratch((run, dir) => {
    const out = run(`$script:observed=$null;$raw='token=private-value '+('x'*8177)
function New-WslScriptFile {return @('${dir}/owned-step.sh', '/scratch/step.sh')}
function Invoke-Watched {param($OnLine);& $OnLine $raw;return 42}
$code=Invoke-WslStep -Label 'stub' -Script 'never' -OnLine {param($line);$script:observed=$line}
Write-Output ('RAW_UNCHANGED='+($script:observed -ceq $raw))
Write-Output ('BOUNDED='+($script:LastWslStepResult.Text.Length -le 8192))
Write-Output (Get-WslFailureMessage 'WSL config merge failed' $script:LastWslStepResult)`);
    expect(out).toContain('RAW_UNCHANGED=True'); expect(out).toContain('BOUNDED=True'); expect(out).toContain('exit 42');
    expect(out).not.toContain('private-value');
    expect(readFileSync(join(dir, 'install.log'), 'utf8')).not.toContain('private-value');
  }));
  it('the real setup observer still sees completion through the diagnostic capture callback', () => scratch((run, dir) => {
    const out = run(`function New-WslScriptFile {return @('${dir}/owned-step.sh', '/scratch/step.sh')}
function Invoke-Watched {param($OnLine);& $OnLine 'Setup complete';return 0}
$r=Invoke-BrowserSetup {param($hook);Invoke-WslStep -Label 'setup' -Script 'stub' -OnLine $hook}
Write-Output ('DONE='+$r.Done+' EXIT='+$r.Exit)`);
    expect(out).toContain('DONE=True EXIT=0');
  }));
  it('a failed streamed WSL step keeps output/exit while forwarding the original observer once', () => scratch((run, dir) => {
    const out = run(`$script:seen=@();function New-WslScriptFile {return @('${dir}/owned-step.sh', '/scratch/step.sh')}
function Invoke-Watched {param($OnLine);& $OnLine 'linux config merge error';return 42}
$code=Invoke-WslStep -Label 'stub' -Script 'echo never' -OnLine {param($line);$script:seen+=$line}
Write-Output ('CODE='+$code+' SEEN='+$script:seen.Count)
Write-Output (Get-WslFailureMessage 'WSL config merge failed' $script:LastWslStepResult)`);
    expect(out).toContain('CODE=42 SEEN=1'); expect(out).toContain('exit 42'); expect(out).toContain('linux config merge error');
  }));
});

it('all script-file paths use the converter; shared shortcut helper stays identical', () => {
  expect(source).toContain('$wslFile = ConvertTo-WslScriptPath $file $Distro');
  expect(source.match(/'wslpath', '-u'/g)).toHaveLength(1);
  const helper = (text: string) => text.match(/\$WSL_COMMAND_FN = @'\n[\s\S]*?\n'@/)?.[0];
  expect(helper(source)).toBeTruthy();
  expect(helper(source)).toBe(helper(readFileSync(resolve('templates/windows-shortcuts.ps1'),'utf8')));
});
