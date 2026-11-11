import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectInstallUserManager, InstallUserManagerError, installActivationHints, installRunsOnWsl } from '../src/install-user-systemd.js';
import { getLocale, setLocale } from '../src/locale.js';

const artifactRoot = resolve('.artifacts/install-user-manager-3630');
const roots: string[] = [];
afterAll(() => {
  for (const p of roots) {
    rmSync(p, { recursive: true, force: true });
  }
});
function install(state: 'active' | 'inactive' | 'reachable', locale: 'en' | 'zh-TW', activate = true, staleRuntime = false) {
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(join(artifactRoot, 'cli-'));
  roots.push(root);
  const home = join(root, 'home'), bin = join(root, 'bin'), trace = join(root, 'calls.jsonl');
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data/fleet.yaml'), 'defaults:\n  locale: ' + locale + '\ninstances: {}\n');
  const script = `#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify(args)+'\\n');\nif(args[0]==='--user'&&process.env.FIXTURE_MANAGER!=='reachable'){console.error('Failed to connect to bus: No such file or directory');process.exit(1)}\nif(args[0]==='is-active'){console.log(process.env.FIXTURE_MANAGER);process.exit(process.env.FIXTURE_MANAGER==='active'?0:3)}\nprocess.exit(0);\n`;
  writeFileSync(join(bin, 'systemctl'), script);
  chmodSync(join(bin, 'systemctl'), 0o700);
  // Override only the two canonical socket existence reads inside this child; never write host /run.
  const sockets = join(root, 'sockets.mjs');
  writeFileSync(sockets, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const runtime='/run/user/'+(process.getuid?.()??0);const sockets=new Set([runtime+'/bus',runtime+'/systemd/private']);
const exists=fs.existsSync;fs.existsSync=p=>sockets.has(String(p))?${staleRuntime}:exists(p);syncBuiltinESMExports();`);
  const runtime = staleRuntime ? join(root, 'stale-runtime') : '/run/user/' + (process.getuid?.() ?? 0);
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(sockets).href, '--import', 'tsx', 'src/cli.ts', 'install', ...(activate ? [] : ['--no-activate'])], { cwd: resolve('.'), encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: home, AGEND_HOME: join(root, 'data'), PATH: bin + ':' + process.env.PATH, VITEST: 'true', AGEND_LANG: locale, LANG: locale === 'en' ? 'en_US.UTF-8' : 'zh_TW.UTF-8', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + runtime + '/bus', WSL_DISTRO_NAME: 'fixture', FIXTURE_TRACE: trace, FIXTURE_MANAGER: state } });
  const calls = (existsSync(trace) ? readFileSync(trace, 'utf8') : '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as string[]);
  if (activate && !calls.length)
    throw Error('CLI fixture did not reach systemctl: ' + run.stdout + run.stderr);
  writeFileSync(resolve('.artifacts/install-user-manager-3630', state + '-' + locale + (staleRuntime ? '-stale' : '') + (activate ? '' : '-file-only') + '.txt'), run.stdout + run.stderr);
  return { run, text: run.stdout + run.stderr, calls };
}
describe.skipIf(process.platform !== 'linux')('agend install: unreachable user manager diagnostics (#3630)', () => {
  it.each(['en', 'zh-TW'] as const)('names an active manager with both sockets missing in %s and never enables or restarts it', locale => {
    const { run, text, calls } = install('active', locale);
    expect(run.status, text).toBe(1);
    expect(text).toContain(locale === 'en' ? 'is still running, but both communication sockets are missing:' : '仍在執行，但連線用的兩個通訊端不見了：');
    expect(text).toContain(locale === 'en' ? 'Environment variables cannot recreate missing sockets' : '環境變數無法重建遺失的通訊端');
    expect(text).toContain(locale === 'en' ? 'stops Fleet and every agent' : '會停止 Fleet 和其中所有 Agent');
    expect(text).toContain('wsl --update');
    expect(text).toContain('2.6.0');
    expect(text.indexOf('wsl --update')).toBeLessThan(text.indexOf('systemctl restart user@'));
    expect(text).toContain(locale === 'en' ? 'Make sure no Agent is working' : '請先確認沒有 Agent 正在工作');
    expect(text).toContain('systemctl --user start dbus.socket');
    expect(text).toContain('enable --now --no-block com.agend.fleet.service');
    expect(calls).not.toContainEqual(expect.arrayContaining(['restart']));
    expect(calls.filter(c => c.includes('enable') || c.includes('daemon-reload'))).toEqual([]);
  });
  it.each(['en', 'zh-TW'] as const)('a stale environment with intact manager sockets gets inspection in %s', locale => {
    const {run,text,calls}=install('active',locale,true,true);
    expect(run.status,text).toBe(1);
    expect(text).toContain(locale==='en'?'state or sockets could not be verified':'目前無法確認其狀態或通訊端');
    expect(text).toContain('systemctl status user@');
    expect(text).not.toContain('systemctl restart');
    expect(calls.filter(c=>c.includes('restart')||c.includes('enable')||c.includes('daemon-reload'))).toEqual([]);
  });
  it('a reachable manager keeps the ordinary activation path',()=>{const r=install('reachable','en');expect(r.run.status,r.text).toBe(0);expect(r.calls).toContainEqual(['--user','daemon-reload']);expect(r.calls.some(c=>c.includes('enable')&&c.includes('--now'))).toBe(true);expect(r.calls).not.toContainEqual(['is-active','user@'+(process.getuid?.()??0)+'.service']);});
  it('file-only installation skips activation diagnostics and makes no manager call', () => { const r = install('active', 'en', false); expect(r.run.status, r.text).toBe(0); expect(r.calls).toEqual([]); });
  it.each(['en', 'zh-TW'] as const)('names a stopped manager distinctly in %s before activation', locale => {
    const { run, text, calls } = install('inactive', locale);
    expect(run.status, text).toBe(1);
    expect(text).toContain(locale === 'en' ? 'is not running' : '目前未執行');
    expect(text).not.toContain(locale === 'en' ? 'is still running, but both' : '仍在執行，但連線用的兩個');
    expect(text).toContain('systemctl start user@' + (process.getuid?.() ?? 0) + '.service');
    expect(calls.filter(c => c.includes('restart') || c.includes('enable') || c.includes('daemon-reload'))).toEqual([]);
  });
});
it.each([0, 1000])('prints a manual restart for uid%s with the correct privilege and interruption warning', uid => {
  const old = getLocale();
  setLocale('en');
  try {
    const state = vi.fn((_unit: string, user: boolean) => user ? 'unavailable' as const : 'running' as const), exists = vi.fn(() => false);
    const p = inspectInstallUserManager('com.agend.fleet.service', { uid, env: {}, exists, state })!;
    expect(p).toMatchObject({ kind: 'missing-sockets', bus: `/run/user/${uid}/bus`, privateSocket: `/run/user/${uid}/systemd/private` });
    const lines = installActivationHints(new InstallUserManagerError(p), 'linux', 'unused');
    expect(lines).toContain(`${uid === 0 ? '' : 'sudo '}systemctl restart user@${uid}.service`);
    expect(lines.join('\n')).toContain('stops Fleet and every agent');
    expect(state.mock.calls).toEqual([['com.agend.fleet.service', true], [`user@${uid}.service`, false]]);
  }
  finally {
    setLocale(old);
  }
});
it.each(['running', 'stopped'] as const)('a reachable manager with a %s Fleet unit needs no repair, even without a public bus', value => {
  const state = vi.fn(() => value), exists = vi.fn(() => false);
  expect(inspectInstallUserManager('com.agend.fleet.service', { uid: 1000, env: {}, state, exists })).toBeNull();
  expect(state).toHaveBeenCalledOnce();
  expect(exists).not.toHaveBeenCalled();
});
it('unknown manager or a remaining socket is unavailable, never called stopped or both missing', () => {
  for (const [manager, socket] of [['unavailable', ''], ['running', '/run/user/1000/bus'], ['running', '/run/user/1000/systemd/private']] as const) {
    const p = inspectInstallUserManager('com.agend.fleet.service', { uid: 1000, env: { XDG_RUNTIME_DIR: '/run/user/1000' }, exists: path => path === socket, state: (_u, user) => user ? 'unavailable' : manager })!;
    expect(p.kind).toBe('unavailable');
    const hints = installActivationHints(new InstallUserManagerError(p), 'linux', 'unused', false);
    expect(hints).toContain('sudo systemctl status user@1000.service');
    expect(hints.join('\n')).not.toMatch(/systemctl (restart|start)|WSL/);
  }
});
it('detects WSL from its environment or kernel version without assuming Linux means WSL', () => {
  const unread = vi.fn(() => { throw Error('unreadable'); });
  expect(installRunsOnWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, unread)).toBe(true);
  expect(unread).not.toHaveBeenCalled();
  expect(installRunsOnWsl({}, () => 'Linux version 6.6.87.2-microsoft-standard-WSL2')).toBe(true);
  expect(installRunsOnWsl({}, () => 'Linux version 6.8.0-generic')).toBe(false);
  expect(installRunsOnWsl({}, unread)).toBe(false);
});
it('prints WSL lasting recovery before manual commands, and omits it off WSL', () => {
  const old = getLocale();
  setLocale('zh-TW');
  try {
    const p = inspectInstallUserManager('com.agend.fleet.service', { uid: 0, env: {}, exists: () => false, state: (_u, user) => user ? 'unavailable' : 'running' })!;
    const error = new InstallUserManagerError(p);
    expect(error.message).toBe('user@0.service 仍在執行，但連線用的兩個通訊端不見了：/run/user/0/bus、/run/user/0/systemd/private。');
    const on = installActivationHints(error, 'linux', 'unused', true).join('\n');
    expect(on).toContain('這是 WSL 2.6.0 以前的已知問題。長久解法：在 Windows 執行 wsl --update，再重新開啟 WSL（參考 microsoft/WSL#13143）。 也可以先用下面的指令暫時復原：');
    expect(on.indexOf('wsl --update')).toBeLessThan(on.indexOf('手動復原'));
    expect(installActivationHints(error, 'linux', 'unused', false).join('\n')).not.toContain('WSL');
  }
  finally {
    setLocale(old);
  }
});
it('keeps the existing commands for unrelated Linux and macOS activation errors', () => {
  const old = getLocale();
  setLocale('en');
  try {
    expect(installActivationHints(Error('unrelated'), 'linux', 'unused', false)).toEqual(['Run manually: systemctl --user daemon-reload && systemctl --user enable --now com.agend.fleet']);
    expect(installActivationHints(Error('unrelated'), 'macos', '/fixture/fleet.plist', false)).toEqual(['Run manually: launchctl load /fixture/fleet.plist']);
  }
  finally {
    setLocale(old);
  }
});

it.each([true, false])('an unverified runtime directory never prescribes a restart (canonical sockets present: %s)', intact => {
  const p = inspectInstallUserManager('com.agend.fleet.service', {
    uid: 1000,
    env: { XDG_RUNTIME_DIR: '/stale/runtime', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/stale/runtime/bus' },
    exists: path => intact && ['/run/user/1000/bus', '/run/user/1000/systemd/private'].includes(path),
    state: (_unit, user) => user ? 'unavailable' : 'running',
  })!;
  expect(p.kind).toBe('unavailable');
  expect(installActivationHints(new InstallUserManagerError(p), 'linux', 'unused', false).join('\n')).not.toContain('systemctl restart');
});
