import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPsFunction } from './support/installer-ps-extract.js';
import { InstallerC2Batch, hasPwsh as pwsh } from './support/installer-pwsh-c2.js';

const installer = resolve('website/public/install-agend.ps1');
const source = readFileSync(installer,'utf8');
const prelude = ['Merge-InstallIni','Write-MergedWindowsWslConfig','ConvertFrom-WslConfigSnapshot','Get-MergedLinuxWslConfigScript',
  'Write-Info','Write-InstallLog','Protect-LogText'].map(n => extractPsFunction(source,n)).join('\n');
const batch = new InstallerC2Batch({installer:prelude});
async function scratch<T>(work: (dir: string, run: (body: string) => Promise<string>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agend-wsl-2651-'));
  const run = (body: string) => batch.run('installer',body,dir);
  try { return await work(dir, run); } finally { rmSync(dir,{recursive:true,force:true}); }
}
const linuxIt = it.skipIf(process.platform === 'win32' || !existsSync('/bin/bash'));
const encoded = (s: string) => Buffer.from(s).toString('base64');
const decodePS = (s: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(s)}'))`;

describe.skipIf(!pwsh)('WSL settings merge: private files and stub-only Windows boundaries', () => {
  it('the complete installer has no syntax errors (one deliberate parse, no execution)', () => scratch(async (_,run) => {
    const out = await run(`$tokens=$null; $errors=$null
$null=[Management.Automation.Language.Parser]::ParseInput((${decodePS(source.replace(/^\uFEFF/,''))}),[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
Write-Output 'SYNTAX=0'`);
    expect(out).toContain('SYNTAX=0');
  }));
  it('batch cases do not inherit script variables or environment changes from an earlier case', () => scratch(async (_,run) => {
    await run("$script:C2Sentinel='prior-case'; $env:C2_SENTINEL='prior-case'; Start-Sleep -Seconds 7");
    const out = await run("if($script:C2Sentinel -or $env:C2_SENTINEL -or $script:FixtureMilliseconds){throw 'Case state leaked'}; Write-Output 'ISOLATED'");
    expect(out).toContain('ISOLATED');
  }));
  it('preserves memory/swap/network/custom sections and comments, updates only owned keys, and is idempotent', () => scratch(async (_,run) => {
    const before = '# operator settings\r\n[wsl2]\r\nmemory=4GB\r\nswap=2GB\r\nnetworkingMode=mirrored\r\nvmIdleTimeout=1000 # keep comment\r\n[experimental]\r\ncustom=value\r\n';
    const out = await run(`$updates=[ordered]@{general=[ordered]@{instanceidletimeout='-1'};wsl2=[ordered]@{vmidletimeout='-1'}}
$once=Merge-InstallIni (${decodePS(before)}) $updates
$twice=Merge-InstallIni $once $updates
if($once -cne $twice){throw 'Merge not idempotent'}
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($once))`);
    const after = Buffer.from(out.trim(), 'base64').toString();
    for (const text of ['# operator settings','memory=4GB','swap=2GB','networkingMode=mirrored','[experimental]\r\ncustom=value','vmidletimeout=-1 # keep comment','instanceidletimeout=-1']) expect(after).toContain(text);
  }));
  it('backs up the original Windows bytes once and avoids rewriting an unchanged file', () => scratch(async (dir,run) => {
    const file=join(dir,'.wslconfig'), before='[wsl2]\nmemory=3GB\n';writeFileSync(file,before);
    await run(`Write-MergedWindowsWslConfig '${file}'\nWrite-MergedWindowsWslConfig '${file}'`);
    const backups=readdirSync(dir).filter(f=>f.includes('.agend-backup-'));
    expect(backups).toHaveLength(1);expect(readFileSync(join(dir,backups[0]),'utf8')).toBe(before);
    expect(readFileSync(file,'utf8')).toContain('memory=3GB');
    expect(readdirSync(dir).filter(f=>f.endsWith('.tmp'))).toHaveLength(0);
  }));
  it('updates every duplicate owned key without removing duplicate sections or unrelated entries', () => scratch(async (_,run) => {
    const before='[boot]\nsystemd=false\ncommand=echo hello\n[boot]\nsystemd=false\nother=yes\n[automount]\nroot=/windows/\n';
    const out=await run(`$next=Merge-InstallIni (${decodePS(before)}) ([ordered]@{boot=[ordered]@{systemd='true'}})\nWrite-Output $next`);
    expect(out.match(/systemd=true/g)).toHaveLength(2);expect(out).not.toContain('systemd=false');
    for(const text of ['command=echo hello','other=yes','[automount]','root=/windows/'])expect(out).toContain(text);
  }));
  linuxIt.each([false,true])('Linux atomic writer preserves settings and backup, existing=%s', existing => scratch(async (dir,run) => {
    mkdirSync(join(dir,'etc'));const file=join(dir,'etc/wsl.conf');
    const before=existing?'[boot]\ncommand=echo retained\n[automount]\nroot=/windows/\n':'';
    if(existing)writeFileSync(file,before);
    const script=(await run(`Get-MergedLinuxWslConfigScript (${decodePS(before)})`)).replaceAll('/etc/',`${dir}/etc/`);
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
  ])('refuses non-UTF-8/binary config clearly before any write: %s', bytes => scratch(async (_,run) => {
    const out=await run(`try { ConvertFrom-WslConfigSnapshot '${bytes.toString('base64')}'; throw 'BAD_ACCEPTED' } catch { if($_ -match 'BAD_ACCEPTED'){throw}; Write-Output $_ }`);
    expect(out).toContain('/etc/wsl.conf is not UTF-8 text');expect(out).toContain('No settings were replaced');
    expect(out).not.toContain('WSL config changed');
  }));
  linuxIt('refuses a changed read snapshot before creating a backup or replacing current settings', () => scratch(async (dir,run) => {
    mkdirSync(join(dir,'etc'));const file=join(dir,'etc/wsl.conf');writeFileSync(file,'[boot]\ncommand=new edit\n');
    const script=(await run(`Get-MergedLinuxWslConfigScript '[boot]'`)).replaceAll('/etc/',`${dir}/etc/`);
    const result=spawnSync('/bin/bash',['-c',script],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',HOME:dir}});
    expect(result.status).not.toBe(0);expect(result.stdout).not.toContain('WSL_CONF_OK');
    expect(readFileSync(file,'utf8')).toBe('[boot]\ncommand=new edit\n');expect(readdirSync(join(dir,'etc'))).toEqual(['wsl.conf']);
  }));
});
