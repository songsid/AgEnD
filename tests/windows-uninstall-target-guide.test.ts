import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The installer can retain 24.04 or use a custom name while an unrelated 26.04
// exists. Copy/pasting the guide must never select a default distro for deletion.
describe('Windows removal guides require the actual verified target', () => {
  it.each(['', 'zh-tw/'])('the %s guide discovers the target and leaves deletion as an explicit verified-name choice', locale => {
    const page = readFileSync(`website/src/pages/${locale}install-windows.astro`, 'utf8');
    const removal = page.slice(page.indexOf('<!-- Uninstall -->'));
    expect(removal).toContain("Join-Path $env:LOCALAPPDATA 'AgEnD\\install.json'");
    expect(removal).toContain('Select-Object distro, user');
    expect(removal).toContain('wsl --list --quiet');
    const blocks = [...removal.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map(match => match[1]).join('\n');
    const commands = [...blocks.matchAll(/^wsl --unregister (.+)$/gm)].map(match => match[1]);
    expect(commands).toEqual(['"EXACT-VERIFIED-DISTRO-NAME"']);
    expect(removal).toContain(locale ? '其中所有檔案，不只是 AgEnD' : 'all its files, not just AgEnD');
    expect(removal).toContain(locale ? '沿用了原本的 Ubuntu' : 'reuse an existing Ubuntu');
    expect(removal).toContain(locale ? '不要用 Ubuntu 版本號猜測' : 'do not guess from an Ubuntu version number');
  });
});
