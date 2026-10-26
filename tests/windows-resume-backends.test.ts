/**
 * Live (2026-10-26): every backend read as missing (fixed: --exec), and a rerun then reused the saved choice
 * (BACKENDS=4, Codex) with no way to pick another — "重新執行也是被卡在強制裝codex了". On resume the installer now shows
 * the saved choice: Enter keeps it, a new list replaces it, a wrong answer is asked again; unattended runs keep it.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
let hasPwsh = false;
beforeAll(() => { try { execFileSync("pwsh", ["-NoProfile", "-Command", "1"], { stdio: "ignore" }); hasPwsh = true; } catch { hasPwsh = false; } });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function resume(saved: string, live: boolean, answers: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "agend-resume-")); dirs.push(dir);
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -match '^(Select-ResumeBackends|Resolve-Backends|Write-(Err|Warn|Info|Ok)|Write-InstallLog|Protect-LogText)$' }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$ALL_BACKENDS' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
$script:answers = [System.Collections.Queue]::new(); @(${answers.map(a => `'${a}'`).join(",")}) | ForEach-Object { $script:answers.Enqueue($_) }; $script:asked = 0
function Test-LiveConsole { $${live} }
function Read-Host { param($Prompt) $script:asked++; if ($script:answers.Count) { $script:answers.Dequeue() } else { '' } }
$sel = Select-ResumeBackends '${saved}'
Write-Output ('SELECTED=' + (($sel | ForEach-Object { $_.Key }) -join ','))
Write-Output ('ASKED=' + $script:asked)`);
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `& '${script}'`], { encoding: "utf8", timeout: 60_000 });
  return `${r.stdout}${r.stderr}`;
}

describe("stage 2 on resume: the saved backends can be kept or changed", () => {
  it("Enter keeps the saved choice (and says what it was)", () => {
    if (!hasPwsh) return;
    const out = resume("4", true, [""]);
    expect(out).toContain("上次選擇的後端：OpenAI Codex");
    expect(out).toContain("SELECTED=codex"); expect(out).toContain("ASKED=1");
  });
  it("a new list replaces it", () => {
    if (!hasPwsh) return;
    expect(resume("4", true, ["1,2"])).toMatch(/SELECTED=(kiro,claude|claude,kiro)/);
  });
  it("a wrong answer is asked again, then taken", () => {
    if (!hasPwsh) return;
    const out = resume("4", true, ["9", "abc", "2"]);
    expect(out).toContain("沒有可用的編號"); expect(out).toContain("SELECTED=claude"); expect(out).toContain("ASKED=3");
  });
  it("unattended (no live console): the saved choice, nothing asked", () => {
    if (!hasPwsh) return;
    const out = resume("4", false, ["1"]);
    expect(out).toContain("SELECTED=codex"); expect(out).toContain("ASKED=0");
  });
});
