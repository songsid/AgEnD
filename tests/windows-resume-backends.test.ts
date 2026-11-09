/**
 * Live (2026-10-26): every backend read as missing (fixed: --exec), and a rerun then reused the saved choice
 * (BACKENDS=4, Codex) with no way to pick another — "重新執行也是被卡在強制裝codex了". On resume the installer now shows
 * the saved choice: Enter keeps it, a new list replaces it, a wrong answer is asked again; unattended runs keep it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPsFunction, extractPsAssignments } from "./support/installer-ps-extract.js";
import { InstallerC3Batch, hasPwsh } from "./support/installer-pwsh-c3.js";

const source = readFileSync(join(import.meta.dirname, "..", "website", "public", "install-agend.ps1"), "utf8");
const names = ['Select-ResumeBackends','Resolve-Backends','Write-Err','Write-Warn','Write-Info','Write-Ok','Write-InstallLog','Protect-LogText'];
const batch = new InstallerC3Batch({ installer: extractPsAssignments(source, ['ALL_BACKENDS']) + "\n" + names.map(n => extractPsFunction(source,n)).join("\n") });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function resume(saved: string, live: boolean, answers: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "agend-resume-")); dirs.push(dir);
  return batch.run('installer', `$script:answers = [System.Collections.Queue]::new(); @(${answers.map(a => `'${a}'`).join(",")}) | ForEach-Object { $script:answers.Enqueue($_) }; $script:asked = 0
function Test-LiveConsole { $${live} }
function Read-Host { param($Prompt) $script:asked++; if ($script:answers.Count) { $script:answers.Dequeue() } else { '' } }
$sel = Select-ResumeBackends '${saved}'
Write-Output ('SELECTED=' + (($sel | ForEach-Object { $_.Key }) -join ','))
Write-Output ('ASKED=' + $script:asked)`, dir);
}

describe.skipIf(!hasPwsh)("stage 2 on resume: the saved backends can be kept or changed", () => {
  it("Enter keeps the saved choice (and says what it was)", async () => {
    const out = await resume("4", true, [""]);
    expect(out).toContain("上次選擇的後端：OpenAI Codex");
    expect(out).toContain("SELECTED=codex"); expect(out).toContain("ASKED=1");
  });
  it("a new list replaces it", async () => {
    expect(await resume("4", true, ["1,2"])).toMatch(/SELECTED=(kiro,claude|claude,kiro)/);
  });
  it("a wrong answer is asked again, then taken", async () => {
    const out = await resume("4", true, ["9", "abc", "2"]);
    expect(out).toContain("沒有可用的編號"); expect(out).toContain("SELECTED=claude"); expect(out).toContain("ASKED=3");
  });
  it("unattended (no live console): the saved choice, nothing asked", async () => {
    const out = await resume("4", false, ["1"]);
    expect(out).toContain("SELECTED=codex"); expect(out).toContain("ASKED=0");
  });
});
