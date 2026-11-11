/**
 * M-2885: the desktop shortcuts on a real Windows (a GitHub-hosted windows runner; .github/workflows/windows-shortcuts.yml).
 * The production path of `agend shortcuts` minus WSL: the shared template and the package's icons, built by the real
 * src/windows-shortcuts.ts, sent to Windows PowerShell 5.1 (powershell.exe) on standard input behind the
 * -EncodedCommand loader, with the real WScript.Shell COM object.
 *   1. A first run without icons, then a run with them: the second puts the icons on the EXISTING shortcuts.
 *   2. Each .lnk read back through WScript.Shell: IconLocation is its own .ico, which holds the package's bytes.
 *   3. Windows' own decoder reads each .ico at 256/48/32/16 px, and the shell's icon for each .lnk: PNGs in $OUT.
 *   4. The standalone installer's embedded block, run by Windows PowerShell 5.1, gives exactly the package's bytes.
 * Exit 0 only when every check holds. Never run on a person's own PC: it writes to the desktop of the user running it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildShortcutsScript, packageShortcutIcons, powershellArgs, sharedShortcutsPs, SHORTCUT_ICON_NAMES } from "../../src/windows-shortcuts.js";

const OUT = process.env.OUT ?? join(process.cwd(), "shortcut-check");
mkdirSync(OUT, { recursive: true });
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failures.push(what); };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ps = (script: string) => spawnSync("powershell.exe", powershellArgs(), { input: script, encoding: "utf8", timeout: 180_000 });
const icons = packageShortcutIcons();
check(SHORTCUT_ICON_NAMES.every(n => icons[n]?.length), "the package's two icons are readable");

const shared = sharedShortcutsPs();
for (const [label, withIcons] of [["without icons", false], ["with icons", true]] as const) {
  const r = ps(buildShortcutsScript(shared, "AgEnD-CI", "runner", undefined, withIcons ? icons : {}));
  console.log(r.stdout.trim()); if (r.stderr.trim()) console.log(r.stderr.trim());
  check(r.status === 0 && /^AGEND_SHORTCUTS_MADE=2\r?$/m.test(r.stdout), `run ${label}: both shortcuts made (status ${r.status})`);
}

const read = ps(`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$desk = [Environment]::GetFolderPath('Desktop')
Add-Type -AssemblyName System.Drawing
$out = $env:OUT
foreach ($pair in @(@('AgEnD 儀表板', 'dashboard'), @('AgEnD 重新啟動', 'restart'))) {
  $lnk = Join-Path $desk ($pair[0] + '.lnk')
  $sc = $shell.CreateShortcut($lnk)
  Write-Output ('LNK|' + $pair[1] + '|' + $sc.IconLocation + '|' + $sc.TargetPath)
  $assoc = [System.Drawing.Icon]::ExtractAssociatedIcon($lnk)
  $assoc.ToBitmap().Save((Join-Path $out ('shell-' + $pair[1] + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
}
$dir = Join-Path $env:LOCALAPPDATA 'AgEnD'
foreach ($name in @('agend.ico', 'agend-restart.ico')) {
  $file = Join-Path $dir $name
  Write-Output ('ICO|' + $name + '|' + (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLower())
  foreach ($px in @(256, 48, 32, 16)) {
    $icon = New-Object System.Drawing.Icon($file, $px, $px)
    $bmp = $icon.ToBitmap()
    Write-Output ('DECODED|' + $name + '|' + $px + '|' + $bmp.Width + 'x' + $bmp.Height)
    $bmp.Save((Join-Path $out ($name + '-' + $px + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  }
}
`);
console.log(read.stdout.trim()); if (read.stderr.trim()) console.log(read.stderr.trim());
check(read.status === 0, "the shortcuts and icons read back (status " + read.status + ")");
const lines = read.stdout.split(/\r?\n/);
for (const [kind, name] of [["dashboard", "agend.ico"], ["restart", "agend-restart.ico"]]) {
  const lnk = lines.find(l => l.startsWith(`LNK|${kind}|`))?.split("|") ?? [];
  check(new RegExp(`\\\\AgEnD\\\\${name.replace(".", "\\.")},0$`, "i").test(lnk[2] ?? ""), `${kind}.lnk IconLocation is its own ${name} (${lnk[2]})`);
  const ico = lines.find(l => l.startsWith(`ICO|${name}|`))?.split("|")[2];
  check(ico === sha(icons[name as "agend.ico"]!), `${name} on disk is the package's bytes`);
  for (const px of [256, 48, 32, 16]) check(lines.includes(`DECODED|${name}|${px}|${px}x${px}`), `Windows decodes ${name} at ${px} px`);
}

// The installer's own copy, as Windows PowerShell 5.1 parses it.
const installer = readFileSync(join(import.meta.dirname, "..", "..", "website", "public", "install-agend.ps1"), "utf8");
const block = installer.slice(installer.indexOf("$AGEND_ICONS = @{"), installer.indexOf("# <<< shortcut icons"));
const embedded = ps(`${block}\nforeach ($k in @('agend.ico', 'agend-restart.ico')) { $h = [Security.Cryptography.SHA256]::Create().ComputeHash($AGEND_ICONS[$k]); Write-Output ('EMB|' + $k + '|' + (($h | ForEach-Object { $_.ToString('x2') }) -join '')) }`);
for (const name of SHORTCUT_ICON_NAMES) check(embedded.stdout.includes(`EMB|${name}|${sha(icons[name]!)}`), `the installer's embedded ${name} is the package's bytes (Windows PowerShell 5.1)`);

writeFileSync(join(OUT, "result.txt"), (failures.length ? `FAIL\n${failures.join("\n")}\n` : "PASS\n"));
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exitCode = failures.length ? 1 : 0;
