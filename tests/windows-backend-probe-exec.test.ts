/**
 * Live failure (2026-10-26): Codex installed (exit 0, `codex --version` works in the distro), yet the installer said
 * "尚未安裝成功" and "所有選擇的後端都安裝失敗". The backend probe went `wsl.exe … -- bash -c <probe>`: with `--`, wsl.exe hands
 * the rest of its command line to the distro's shell as-is, so that shell expanded $p, $(command -v …) and $HOME inside the
 * double-quoted probe before bash -c ran it — the probe could never succeed. `--exec` keeps the argv.
 *
 * The fake wsl.exe here does what wsl.exe does with each form: `--exec` runs the argv; `--` rebuilds the command line the
 * way PowerShell quoted it on Windows (an argument with spaces in "…") and runs it through a shell.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPsFunction, extractPsAssignments } from "./support/installer-ps-extract.js";
import { InstallerC3Batch, hasPwsh } from "./support/installer-pwsh-c3.js";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const SOURCE = readFileSync(INSTALLER, "utf8");
const posix = process.platform !== 'win32' && existsSync('/bin/bash');
function prelude(source: string) {
  return extractPsAssignments(source,['BACKEND_PROBE','WSL_COMMAND_FN'])
    + "\n. ([scriptblock]::Create($WSL_COMMAND_FN))\n" + extractPsFunction(source,'Get-InstalledBackend');
}
const old = SOURCE.replace("'-u', 'root', '--exec', 'bash', '-c', $BACKEND_PROBE", "'-u', 'root', '--', 'bash', '-c', $BACKEND_PROBE");
const batch = new InstallerC3Batch({ current: prelude(SOURCE), shell: prelude(old) });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function probe(template: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "agend-probe-")); dirs.push(dir);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const tools = join(dir,"tools"); mkdirSync(tools);
  for (const name of ["bash","sh","head","mkdir","ln","sed","timeout"]) {
    const executable = [join('/bin',name),join('/usr/bin',name)].find(existsSync);
    if (!executable) throw Error(`Missing fixture tool: ${name}`);
    symlinkSync(executable,join(tools,name));
  }
  const home = join(dir,"root"), local = join(home,".local","bin"); mkdirSync(local,{recursive:true});
  writeFileSync(join(local,"codex"), "#!/bin/sh\necho 'codex-cli 0.164.0'\n"); chmodSync(join(local,"codex"),0o755);
  // Both forms run actual bash, with every probe /root and HOME mapped into this scratch Linux.
  // The -- control deliberately reconstructs the quoted command line so its outer shell expands the probe.
  writeFileSync(join(bin,"wsl.exe"), `#!/bin/bash
mode=exec
while [ $# -gt 0 ]; do case "$1" in -d|-u) shift 2;; --exec) shift; break;; --) mode=shell; shift; break;; *) break;; esac; done
args=()
for a in "$@"; do args+=("$(printf '%s' "$a" | /usr/bin/sed 's#/root/#${home}/#g')"); done
if [ "$mode" = exec ]; then exec /usr/bin/env -i HOME='${home}' PATH='${tools}' "\${args[@]}"; fi
line=
for a in "\${args[@]}"; do case "$a" in *' '*) line="$line \\"$a\\"";; *) line="$line $a";; esac; done
exec /usr/bin/env -i HOME='${home}' PATH='${tools}' /bin/bash -c "$line"
`); chmodSync(join(bin,"wsl.exe"),0o755);
  return batch.run(template, `$UBUNTU_DISTRO = 'AgEnD-Ubuntu-24.04'
$have = Get-InstalledBackend ([PSCustomObject]@{ Bin = 'codex' })
if ($have) { Write-Output ('FOUND=' + $have.Version + '|' + $have.Path) } else { Write-Output 'FOUND=none' }`, dir,
    { PATH: `${bin}:/usr/bin:/bin`, WSL_UTF8: '1' });
}

describe("the backend probe reaches bash with its argv intact (--exec, not --)", () => {
  it.skipIf(!hasPwsh || !posix)("an installed backend is found", async () => {
    expect(await probe("current")).toContain("FOUND=codex-cli 0.164.0|");
  });

  it.skipIf(!hasPwsh || !posix)("through `--` (the distro's shell) the same probe never finds it — the live false negative", async () => {
    expect(old).not.toBe(SOURCE);
    expect(await probe("shell")).toContain("FOUND=none");
  });

  it("no wsl.exe argument list goes through `--` (the distro's shell) in the installer or the shortcut code", () => {
    const shortcuts = readFileSync(join(import.meta.dirname, "..", "templates", "windows-shortcuts.ps1"), "utf8");
    for (const [name, text] of [["install-agend.ps1", SOURCE], ["windows-shortcuts.ps1", shortcuts]] as const) {
      // -d <distro> -u <user> '--' …: every such array is passed to wsl.exe as argv; only --exec keeps it.
      expect(text.match(/'-u',\s*[^,]+,\s*'--',/g) ?? [], name).toEqual([]);
    }
  });
});
