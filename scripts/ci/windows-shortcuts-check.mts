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
import { buildShortcutsScript, packageShortcutIcons, powershellArgs, sharedShortcutsPs, SHORTCUT_ICON_NAMES, stdinPayload } from "../../src/windows-shortcuts.js";

const OUT = process.env.OUT ?? join(process.cwd(), "shortcut-check");
mkdirSync(OUT, { recursive: true });
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failures.push(what); };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ps = (script: string) => spawnSync("powershell.exe", powershellArgs(), { input: stdinPayload(script), encoding: "utf8", timeout: 180_000 });
const icons = packageShortcutIcons();
check(SHORTCUT_ICON_NAMES.every(n => icons[n]?.length), "the package's two icons are readable");

// A hosted runner's account may have no Desktop folder, and .NET then answers "" for it (every interactive user has
// one). Made here, and said, so a failure below is about the shortcuts, not the runner.
const desk = ps("$before = [Environment]::GetFolderPath('Desktop'); New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE 'Desktop') | Out-Null; Write-Output ('DESKTOP|' + $before + '|' + [Environment]::GetFolderPath('Desktop'))\n");
console.log(desk.stdout.trim());
check(/^DESKTOP\|[^|]*\|.+\\Desktop\r?$/m.test(desk.stdout), "the runner account has a Desktop folder");

const shared = sharedShortcutsPs();

// Control (informational, never a check): main's shared code on this same runner — before M-2885 on an en-US Windows its
// WScript.Shell Save() of the Chinese names fails and it makes none (MADE=0).
const mainTemplate = spawnSync("git", ["show", "origin/main:templates/windows-shortcuts.ps1"], { encoding: "utf8" });
if (mainTemplate.status === 0) {
  const ctl = ps(buildShortcutsScript(sharedShortcutsPs(mainTemplate.stdout), "AgEnD-CI", "runner"));
  console.log(`CONTROL main's shortcut code on this runner: ${(/^AGEND_SHORTCUTS_MADE=\d+/m.exec(ctl.stdout) ?? ["(no answer)"])[0]}`);
  ps("$d = [Environment]::GetFolderPath('Desktop'); Get-ChildItem -LiteralPath $d -Filter 'AgEnD*' | Remove-Item -Force; Write-Output cleared");
} else console.log("CONTROL main's template not available (git show origin/main failed)");
for (const [label, withIcons] of [["without icons", false], ["with icons", true]] as const) {
  const r = ps(buildShortcutsScript(shared, "AgEnD-CI", "runner", undefined, withIcons ? icons : {}));
  console.log(r.stdout.trim()); if (r.stderr.trim()) console.log(r.stderr.trim());
  check(r.status === 0 && /^AGEND_SHORTCUTS_MADE=2\r?$/m.test(r.stdout), `run ${label}: both shortcuts made (status ${r.status})`);
  if (!/^AGEND_SHORTCUTS_MADE=2\r?$/m.test(r.stdout)) {
    // Install-AgendShortcuts keeps going past a shortcut it cannot make: ask the same function directly, for its reason.
    const why = ps([
      "$script:OnWindows = $true", shared,
      "function Show-Scope { Write-Output ('SCOPE|script:OnWindows=' + [string]$script:OnWindows + '|global:OnWindows=' + [string]$global:OnWindows) }",
      "Show-Scope",
      "try { New-AgendShortcut 'AgEnD probe' 'probe.ps1' '# probe' 'probe' | Out-Null; Write-Output 'PROBE|ascii|ok' } catch { Write-Output ('PROBE|ascii|' + $_) }",
      "try { New-AgendShortcut 'AgEnD 儀表板' 'open-dashboard.ps1' (Get-DashboardOpenerScript 'AgEnD-CI' 'runner') 'AgEnD 網頁儀表板（自動帶入登入碼）' | Out-Null; Write-Output 'PROBE|chinese|ok' } catch { Write-Output ('PROBE|chinese|' + $_) }",
      "Write-Output ('PROBE|codepage|ansi=' + [Text.Encoding]::Default.CodePage + '|oem=' + [Console]::OutputEncoding.CodePage + '|culture=' + [Globalization.CultureInfo]::CurrentCulture.Name)",
      // Save under an ASCII name, then rename with .NET (Unicode): does the shortcut survive the move with its settings?
      "try { $d = [Environment]::GetFolderPath('Desktop'); $tmp = Join-Path $d 'agend-tmp.lnk'; $sh = New-Object -ComObject WScript.Shell; $sc = $sh.CreateShortcut($tmp); $sc.TargetPath = (Join-Path $env:SystemRoot 'System32\\notepad.exe'); $sc.Save(); $final = Join-Path $d ([string][char]0x5100 + [char]0x8868 + [char]0x677F + '.lnk'); if ([IO.File]::Exists($final)) { [IO.File]::Delete($final) }; [IO.File]::Move($tmp, $final); $app = New-Object -ComObject Shell.Application; $link = $app.Namespace($d).ParseName([IO.Path]::GetFileName($final)).GetLink; Write-Output ('PROBE|move|ok|exists=' + [IO.File]::Exists($final) + '|target=' + $link.Path) } catch { Write-Output ('PROBE|move|' + $_) }",
      "Write-Output ('PROBE|install|' + (@(Install-AgendShortcuts 'AgEnD-CI' 'runner') -join ';'))",
      "",
    ].join("\n"));
    console.log(why.stdout.trim());
  }
}

const read = ps(`
$ErrorActionPreference = 'Stop'
$desk = [Environment]::GetFolderPath('Desktop')
$app = New-Object -ComObject Shell.Application
Add-Type -AssemblyName System.Drawing
$out = $env:OUT
foreach ($pair in @(@('AgEnD 儀表板', 'dashboard'), @('AgEnD 重新啟動', 'restart'))) {
  $lnk = Join-Path $desk ($pair[0] + '.lnk')
  # Shell.Application reads it by its Unicode name (WScript.Shell cannot even open a Chinese path on an en-US Windows).
  $link = $app.Namespace($desk).ParseName($pair[0] + '.lnk').GetLink
  $iconPath = ''; $iconIndex = $link.GetIconLocation([ref]$iconPath)
  Write-Output ('LNK|' + $pair[1] + '|' + $iconPath + ',' + $iconIndex + '|' + $link.Path + '|' + $link.Arguments)
  $assoc = [System.Drawing.Icon]::ExtractAssociatedIcon($lnk)
  $assoc.ToBitmap().Save((Join-Path $out ('shell-' + $pair[1] + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
}
Write-Output ('DESKTOP-FILES|' + ((Get-ChildItem -LiteralPath $desk -Filter 'AgEnD*' | ForEach-Object { $_.Name }) -join ';'))
$dir = Join-Path $env:LOCALAPPDATA 'AgEnD'
Write-Output ('TEMPS|' + ((Get-ChildItem -LiteralPath $dir -Filter 'shortcut-*.tmp.lnk' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ';'))
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
  check(/powershell\.exe$|wt\.exe$/i.test(lnk[3] ?? ""), `${kind}.lnk target is PowerShell or Windows Terminal (${lnk[3]})`);
  check(new RegExp(`-File "[^"]*\\\\AgEnD\\\\${kind === "dashboard" ? "open-dashboard" : "restart-agend"}\\.ps1"`).test(lnk[4] ?? ""), `${kind}.lnk runs its own script (${lnk[4]})`);
  const ico = lines.find(l => l.startsWith(`ICO|${name}|`))?.split("|")[2];
  check(ico === sha(icons[name as "agend.ico"]!), `${name} on disk is the package's bytes`);
  for (const px of [256, 48, 32, 16]) check(lines.includes(`DECODED|${name}|${px}|${px}x${px}`), `Windows decodes ${name} at ${px} px`);
}

check(lines.includes("DESKTOP-FILES|AgEnD 儀表板.lnk;AgEnD 重新啟動.lnk") || lines.includes("DESKTOP-FILES|AgEnD 重新啟動.lnk;AgEnD 儀表板.lnk"), "only the two shortcuts on the desktop (no staged leftovers)");
check(lines.includes("TEMPS|"), "no temporary shortcut left in the AgEnD folder");

// The installer's own copy, as Windows PowerShell 5.1 parses it.
const installer = readFileSync(join(import.meta.dirname, "..", "..", "website", "public", "install-agend.ps1"), "utf8");
const block = installer.slice(installer.indexOf("$AGEND_ICONS = @{"), installer.indexOf("# <<< shortcut icons"));
const embedded = ps(`${block}\nforeach ($k in @('agend.ico', 'agend-restart.ico')) { $h = [Security.Cryptography.SHA256]::Create().ComputeHash($AGEND_ICONS[$k]); Write-Output ('EMB|' + $k + '|' + (($h | ForEach-Object { $_.ToString('x2') }) -join '')) }`);
for (const name of SHORTCUT_ICON_NAMES) check(embedded.stdout.includes(`EMB|${name}|${sha(icons[name]!)}`), `the installer's embedded ${name} is the package's bytes (Windows PowerShell 5.1)`);

writeFileSync(join(OUT, "result.txt"), (failures.length ? `FAIL\n${failures.join("\n")}\n` : "PASS\n"));
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exitCode = failures.length ? 1 : 0;
