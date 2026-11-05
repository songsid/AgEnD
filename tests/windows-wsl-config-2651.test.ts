import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = resolve('website/public/install-agend.ps1');
const pwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '1'], {timeout:60000}).status === 0;
function scratch<T>(work: (dir: string, run: (body: string) => string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'agend-wsl-2651-'));
  const run = (body: string) => {
    const file = join(dir, 'probe.ps1');
    writeFileSync(file, `$ErrorActionPreference='Stop'
$t=$null;$e=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile('${installer}',[ref]$t,[ref]$e)
if($e.Count){throw ($e|Out-String)}
foreach($f in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($f.Extent.Text))}
function wsl {throw 'Native WSL forbidden'}
function Start-Process {throw 'Native process launch forbidden'}
${body}`);
    return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', file], { encoding:'utf8', timeout:15000, env:{...process.env, HOME:dir, USERPROFILE:dir} });
  };
  try { return work(dir, run); } finally { rmSync(dir, { recursive:true, force:true }); }
}
const encoded = (s: string) => Buffer.from(s).toString('base64');
const decodePS = (s: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(s)}'))`;

describe.skipIf(!pwsh)('WSL settings merge: private files and stub-only Windows boundaries', () => {
  it('preserves memory/swap/network/custom sections and comments, updates only owned keys, and is idempotent', () => scratch((_,run) => {
    const before = '# operator settings\r\n[wsl2]\r\nmemory=4GB\r\nswap=2GB\r\nnetworkingMode=mirrored\r\nvmIdleTimeout=1000 # keep comment\r\n[experimental]\r\ncustom=value\r\n';
    const out = run(`$updates=[ordered]@{general=[ordered]@{instanceidletimeout='-1'};wsl2=[ordered]@{vmidletimeout='-1'}}
$once=Merge-InstallIni (${decodePS(before)}) $updates
$twice=Merge-InstallIni $once $updates
if($once -cne $twice){throw 'Merge not idempotent'}
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($once))`);
    const after = Buffer.from(out.trim(), 'base64').toString();
    for (const text of ['# operator settings','memory=4GB','swap=2GB','networkingMode=mirrored','[experimental]\r\ncustom=value','vmidletimeout=-1 # keep comment','instanceidletimeout=-1']) expect(after).toContain(text);
  }));
  it('backs up the original Windows bytes once and avoids rewriting an unchanged file', () => scratch((dir,run) => {
    const file=join(dir,'.wslconfig'), before='[wsl2]\nmemory=3GB\n';writeFileSync(file,before);
    run(`Write-MergedWindowsWslConfig '${file}'\nWrite-MergedWindowsWslConfig '${file}'`);
    const backups=readdirSync(dir).filter(f=>f.includes('.agend-backup-'));
    expect(backups).toHaveLength(1);expect(readFileSync(join(dir,backups[0]),'utf8')).toBe(before);
    expect(readFileSync(file,'utf8')).toContain('memory=3GB');
    expect(readdirSync(dir).filter(f=>f.endsWith('.tmp'))).toHaveLength(0);
  }));
  it('updates every duplicate owned key without removing duplicate sections or unrelated entries', () => scratch((_,run) => {
    const before='[boot]\nsystemd=false\ncommand=echo hello\n[boot]\nsystemd=false\nother=yes\n[automount]\nroot=/windows/\n';
    const out=run(`$next=Merge-InstallIni (${decodePS(before)}) ([ordered]@{boot=[ordered]@{systemd='true'}})\nWrite-Output $next`);
    expect(out.match(/systemd=true/g)).toHaveLength(2);expect(out).not.toContain('systemd=false');
    for(const text of ['command=echo hello','other=yes','[automount]','root=/windows/'])expect(out).toContain(text);
  }));
  it.each([false,true])('Linux atomic writer preserves settings and backup, existing=%s', existing => scratch((dir,run) => {
    mkdirSync(join(dir,'etc'));const file=join(dir,'etc/wsl.conf');
    const before=existing?'[boot]\ncommand=echo retained\n[automount]\nroot=/windows/\n':'';
    if(existing)writeFileSync(file,before);
    const script=run(`Get-MergedLinuxWslConfigScript (${decodePS(before)})`).replaceAll('/etc/',`${dir}/etc/`);
    // Only the generated script runs; every /etc path is mapped into this scratch directory.
    expect(script).not.toContain('file=/etc/');
    const result=spawnSync('/bin/bash',['-c',script],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',HOME:dir}});
    expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('WSL_CONF_OK');
    const after=readFileSync(file,'utf8');
    for(const text of ['systemd=true','appendWindowsPath=false','default=root'])expect(after).toContain(text);
    if(existing){expect(after).toContain('command=echo retained');expect(after).toContain('root=/windows/');}
    const backups=readdirSync(join(dir,'etc')).filter(f=>f.includes('.agend-backup-'));
    expect(backups).toHaveLength(existing?1:0);
    if(existing)expect(readFileSync(join(dir,'etc',backups[0]),'utf8')).toBe(before);
  }));
  it.each([
    Buffer.from([0xff,0xfe,0x23,0x00,0x61,0x00]),
    Buffer.from([0x23,0x20,0xe9,0x0a]),
    Buffer.from([0x23,0x00,0x61]),
  ])('refuses non-UTF-8/binary config clearly before any write: %s', bytes => scratch((_,run) => {
    const out=run(`try { ConvertFrom-WslConfigSnapshot '${bytes.toString('base64')}'; throw 'BAD_ACCEPTED' } catch { if($_ -match 'BAD_ACCEPTED'){throw}; Write-Output $_ }`);
    expect(out).toContain('/etc/wsl.conf is not UTF-8 text');expect(out).toContain('No settings were replaced');
    expect(out).not.toContain('WSL config changed');
  }));
  it('refuses a changed read snapshot before creating a backup or replacing current settings', () => scratch((dir,run) => {
    mkdirSync(join(dir,'etc'));const file=join(dir,'etc/wsl.conf');writeFileSync(file,'[boot]\ncommand=new edit\n');
    const script=run(`Get-MergedLinuxWslConfigScript '[boot]'`).replaceAll('/etc/',`${dir}/etc/`);
    const result=spawnSync('/bin/bash',['-c',script],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',HOME:dir}});
    expect(result.status).not.toBe(0);expect(result.stdout).not.toContain('WSL_CONF_OK');
    expect(readFileSync(file,'utf8')).toBe('[boot]\ncommand=new edit\n');expect(readdirSync(join(dir,'etc'))).toEqual(['wsl.conf']);
  }));
});
