/**
 * Live failure (2026-10-26): Codex installed (exit 0, `codex --version` works in the distro), yet the installer said
 * "尚未安裝成功" and "所有選擇的後端都安裝失敗". The backend probe went `wsl.exe … -- bash -c <probe>`: with `--`, wsl.exe hands
 * the rest of its command line to the distro's shell as-is, so that shell expanded $p, $(command -v …) and $HOME inside the
 * double-quoted probe before bash -c ran it — the probe could never succeed. `--exec` keeps the argv.
 *
 * The fake wsl.exe here does what wsl.exe does with each form: `--exec` runs the argv; `--` rebuilds the command line the
 * way PowerShell quoted it on Windows (an argument with spaces in "…") and runs it through a shell.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const SOURCE = readFileSync(INSTALLER, "utf8");
let hasPwsh = false, PWSH = "pwsh";
beforeAll(() => { try { PWSH = execFileSync("sh", ["-c", "command -v pwsh"], { encoding: "utf8" }).trim() || "pwsh"; execFileSync(PWSH, ["-NoProfile", "-Command", "1"], { stdio: "ignore" }); hasPwsh = true; } catch { hasPwsh = false; } });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const FAKE_WSL = `#!/bin/bash
# skip -d <distro> -u <user>
while [ $# -gt 0 ]; do case "$1" in -d|-u) shift 2;; --exec) shift; exec "$@";; --) shift; break;; *) break;; esac; done
line=
for a in "$@"; do case "$a" in *' '*) line="$line \\"$a\\"";; *) line="$line $a";; esac; done
exec bash -c "$line"
`;

function probe(installer: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-probe-")); dirs.push(dir);
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "wsl.exe"), FAKE_WSL); chmodSync(join(bin, "wsl.exe"), 0o755);
  const local = join(dir, "home", ".local", "bin"); mkdirSync(local, { recursive: true });
  writeFileSync(join(local, "codex"), "#!/bin/sh\necho 'codex-cli 0.164.0'\n"); chmodSync(join(local, "codex"), 0o755);
  const file = join(dir, "installer.ps1"); writeFileSync(file, installer);
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$(BACKEND_PROBE|WSL_COMMAND_FN)$' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
. ([scriptblock]::Create($WSL_COMMAND_FN))
$UBUNTU_DISTRO = 'AgEnD-Ubuntu-24.04'
$have = Get-InstalledBackend ([PSCustomObject]@{ Bin = 'codex' })
if ($have) { Write-Output ('FOUND=' + $have.Version + '|' + $have.Path) } else { Write-Output 'FOUND=none' }`);
  const r = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", `& '${script}'`], {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: join(dir, "home"), PATH: `${bin}:/usr/bin:/bin`, WSL_UTF8: "1" },
  });
  return `${r.stdout}${r.stderr}`;
}

describe("the backend probe reaches bash with its argv intact (--exec, not --)", () => {
  it("an installed backend is found", () => {
    if (!hasPwsh) return;
    expect(probe(SOURCE)).toContain("FOUND=codex-cli 0.164.0|");
  });

  it("through `--` (the distro's shell) the same probe never finds it — the live false negative", () => {
    if (!hasPwsh) return;
    const old = SOURCE.replace("'-u', 'root', '--exec', 'bash', '-c', $BACKEND_PROBE", "'-u', 'root', '--', 'bash', '-c', $BACKEND_PROBE");
    expect(old).not.toBe(SOURCE);
    expect(probe(old)).toContain("FOUND=none");
  });

  it("no `wsl … -- bash -c <script>` is left in the installer", () => {
    expect(SOURCE).not.toMatch(/'--',\s*'bash',\s*'-c'/);
  });
});
