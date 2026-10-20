/**
 * #2233 part 3: the Windows installer with the setup page's "Web only (no bot)". The page itself is tested with the
 * setup host (setup-web-only-2233.test.ts); here, what the installer says: the setup prompts name the choice, and the
 * closing summary does not claim a chat connection the fleet does not have (fleet.yaml without channel/channels).
 * Static checks always; with pwsh, the installer's own Test-WebOnlyFleet runs against a stubbed `wsl` (no WSL).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");

describe("#2233 the installer names Web only and says what was set up (static)", () => {
  it("both setup prompts offer Web only next to Discord or Telegram", () => {
    expect(text.match(/或選「Web only \(no bot\)」/g)).toHaveLength(2);
  });
  it("the summary asks the fleet, then says web only or a connected chat app — and daily use follows", () => {
    expect(text).toMatch(/\$webOnly = Test-WebOnlyFleet \$UBUNTU_DISTRO\nif \(\$webOnly\) \{ Write-Info "  \[OK\] 只用網頁儀表板[^\n]*\}\nelse \{ Write-Info "  \[OK\] 通訊軟體已串接" \}/);
    expect(text).toMatch(/if \(\$webOnly\) \{\n\s+Write-Info "    在網頁儀表板跟 agent 對話[^\n]*\n\} else \{\n\s+Write-Info "    直接在 Discord\/Telegram 跟 Bot 對話即可/);
  });
  it("stays UTF-8 with a BOM (Windows PowerShell 5.1 reads it as ANSI otherwise)", () => {
    expect(readFileSync(INSTALLER).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function run(body: string, fleetYaml: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2233win-")); dirs.push(dir);
  const yamlPath = join(dir, "fleet.yaml");
  if (fleetYaml !== null) writeFileSync(yamlPath, fleetYaml);
  const file = join(dir, "t.ps1");
  // `wsl -d <distro> -u root -- bash -lc '<script>'`, stubbed: the script runs in sh here, with the fleet.yaml path swapped
  // for the scratch one.
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
function wsl { $script = $args[-1] -replace '/root/.agend/fleet.yaml', '${yamlPath}'; & sh -c $script }
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000 });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return r.stdout + r.stderr;
}
describe.skipIf(!pwsh)("with pwsh: Test-WebOnlyFleet", { timeout: 60_000 }, () => {
  it("no channel or channels in fleet.yaml: web only; either one, or no fleet.yaml: not", () => {
    expect(run(`Write-Output ("R=" + (Test-WebOnlyFleet 'Ubuntu'))`, "instances:\n  agent-1:\n    backend: claude-code\n")).toContain("R=True");
    expect(run(`Write-Output ("R=" + (Test-WebOnlyFleet 'Ubuntu'))`, "channel:\n  type: telegram\ninstances: {}\n")).toContain("R=False");
    expect(run(`Write-Output ("R=" + (Test-WebOnlyFleet 'Ubuntu'))`, "channels:\n  - type: discord\ninstances: {}\n")).toContain("R=False");
    expect(run(`Write-Output ("R=" + (Test-WebOnlyFleet 'Ubuntu'))`, null)).toContain("R=False");
  });
});
