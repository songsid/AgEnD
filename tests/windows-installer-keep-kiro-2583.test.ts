/**
 * #2583 follow-ups: re-running the Windows installer with a backend already installed.
 * - Fable's P3 on #2584: kiro's install.sh asks "Do you want to replace it? (y/N)" on /dev/tty whenever kiro-cli
 *   exists, and no flag skips it (`--force` only skips its Amazon Q check). With no terminal to ask on it exits
 *   non-zero, so the rerun showed a failed step for a CLI that was fine.
 * - A real user installed codex by hand as root (`curl … | sh` → /root/.local/bin), reran the installer and chose
 *   Codex: stage 2 never looked before installing, so it ran codex's installer again (which hung before #2584).
 *
 * Now stage 2 asks first: a backend whose binary is there and answers `--version` is kept, with its version, and its
 * installer is not run. It looks where the vendor installers put it: PATH, /root/.local/bin, $HOME/.local/bin,
 * $HOME/.claude/local, and npm's global prefix (nvm). One found only under npm's prefix is linked into
 * $HOME/.local/bin, so AgEnD (it runs as $AGEND_USER = root, the same user) finds it. The same applies to every
 * backend the installer offers (kiro, claude, antigravity, codex); each CLI updates itself afterwards.
 *
 * Get-InstalledBackend is the installer's own, run in pwsh with a fake native wsl that runs the bash it is given as
 * root with a scratch HOME.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");

describe("stage 2 looks before it installs (static)", () => {
  it("each chosen backend is looked for first; one that is there says so with its version and is not installed again", () => {
    const loop = text.slice(text.indexOf("    foreach ($b in $selected) {"), text.indexOf("Write-Info \"  [WSL] 設定 PATH...\""));
    expect(loop).toMatch(/^ {4}foreach \(\$b in \$selected\) \{\n {8}\$have = Get-InstalledBackend \$b\n {8}if \(\$have\) \{\n {12}Write-Ok \("\{0\} 已安裝（\{1\}），保留" -f \$b\.Name, \$have\.Version\)\n {12}if \(\$have\.LinkedFrom\) \{ Write-Info [^\n]+\}\n {12}continue\n {8}\}\n {8}Write-Info \("  \[WSL\] 安裝 \{0\}\.\.\." -f \$b\.Name\)/);
  });
  it("the probe is one line with no double quotes, like $AGEND_PROBE, so Windows PowerShell 5.1 passes it to wsl.exe intact", () => {
    const line = text.split("\n").find(l => l.startsWith("$BACKEND_PROBE = '"))!;
    expect(line).toBeTruthy();
    expect(line).not.toContain('"');
    expect(line).toMatch(/^\$BACKEND_PROBE = 'set -f; IFS=; /);
  });
});

// Resolved once: each run below gets a PATH of its own (the scratch bin and the system's).
const PWSH = spawnSync("sh", ["-c", "command -v pwsh"], { encoding: "utf8" }).stdout.trim();
const pwsh = !!PWSH && spawnSync(PWSH, ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const cli = (file: string, name: string, code = 0) => {
  writeFileSync(file, `#!/bin/sh\n[ "$1" = --version ] && { echo "${name} 9.9.9"; echo second-line; exit ${code}; }\nexit 0\n`);
  chmodSync(file, 0o755);
};

/**
 * A scratch machine: `bin` (on PATH: the fake wsl, and CLIs "on PATH"), `home` (root's HOME inside the fake wsl), and
 * optionally a fake npm whose global prefix holds CLIs.
 */
function machine(o: { onPath?: Record<string, number>; inHomeLocalBin?: string[]; inNpmPrefix?: string[] } = {}) {
  const root = scratch("agend-2583-machine-");
  const bin = join(root, "bin"), home = join(root, "home"), prefix = join(root, "npm-prefix");
  for (const d of [bin, home, join(prefix, "bin")]) mkdirSync(d, { recursive: true });
  const wsl = `#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexport HOME='${home}'\nexec "$@"\n`;
  for (const f of ["wsl", "wsl.exe"]) { writeFileSync(join(bin, f), wsl); chmodSync(join(bin, f), 0o755); }
  for (const [name, code] of Object.entries(o.onPath ?? {})) cli(join(bin, name), name, code);
  if (o.inHomeLocalBin?.length) { mkdirSync(join(home, ".local", "bin"), { recursive: true }); for (const name of o.inHomeLocalBin) cli(join(home, ".local", "bin", name), name); }
  if (o.inNpmPrefix) {
    for (const name of o.inNpmPrefix) cli(join(prefix, "bin", name), name);
    writeFileSync(join(bin, "npm"), `#!/bin/sh\n[ "$1 $2" = "prefix -g" ] && echo '${prefix}'\n`);
    chmodSync(join(bin, "npm"), 0o755);
  }
  return { bin, home, prefix };
}
/** Get-InstalledBackend for one table row, in pwsh: "<null>" or "version | path | linkedFrom". */
function installed(key: string, m: ReturnType<typeof machine>): string {
  const dir = scratch("agend-2583-");
  const file = join(dir, "t.ps1");
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-InstalledBackend' }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$(ALL_BACKENDS|BACKEND_PROBE)$' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
$UBUNTU_DISTRO = 'AgEnD-Ubuntu'
$b = $ALL_BACKENDS | Where-Object { $_.Key -eq '${key}' }
$r = Get-InstalledBackend $b
if ($null -eq $r) { '<null>' } else { "$($r.Version) | $($r.Path) | $($r.LinkedFrom)" }`);
  // PATH: only the scratch bin and the system's — no host ~/.local/bin, nvm or npm.
  const r = spawnSync(PWSH, ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: dir, PATH: `${m.bin}:/usr/local/bin:/usr/bin:/bin` } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return r.stdout.replace(/\s+$/, "");
}

describe.skipIf(!pwsh)("with pwsh: Get-InstalledBackend", { timeout: 90_000 }, () => {
  it("kiro-cli on PATH and answering --version: kept, with the first line of its version", () => {
    const m = machine({ onPath: { "kiro-cli": 0 } });
    expect(installed("kiro", m)).toBe(`kiro-cli 9.9.9 | ${m.bin}/kiro-cli |`);
  });
  it("not installed: not kept (its installer runs)", () => {
    expect(installed("kiro", machine())).toBe("<null>");
    expect(installed("codex", machine({ onPath: { claude: 0 } }))).toBe("<null>");
  });
  it("there but broken (--version fails): not kept, so the installer repairs it", () => {
    expect(installed("kiro", machine({ onPath: { "kiro-cli": 1 } }))).toBe("<null>");
  });
  it("codex installed by hand as root, only in ~/.local/bin (not on this shell's PATH): found and kept", () => {
    const m = machine({ inHomeLocalBin: ["codex"] });
    expect(installed("codex", m)).toBe(`codex 9.9.9 | ${m.home}/.local/bin/codex |`);
  });
  it("codex only under npm's global prefix: kept, and linked into ~/.local/bin so AgEnD finds it", () => {
    const m = machine({ inNpmPrefix: ["codex"] });
    expect(installed("codex", m)).toBe(`codex 9.9.9 | ${m.home}/.local/bin/codex | ${m.prefix}/bin/codex`);
    const link = join(m.home, ".local", "bin", "codex");
    expect(existsSync(link) && lstatSync(link).isSymbolicLink() && readlinkSync(link)).toBe(join(m.prefix, "bin", "codex"));
  });
  it("every backend the installer offers is looked for the same way (claude, antigravity)", () => {
    const m = machine({ onPath: { claude: 0, agy: 0 } });
    expect(installed("claude", m)).toBe(`claude 9.9.9 | ${m.bin}/claude |`);
    expect(installed("antigravity", m)).toBe(`agy 9.9.9 | ${m.bin}/agy |`);
  });
});
