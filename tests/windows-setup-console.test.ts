/**
 * Stage 5 in a narrow console (the user's, about 95 columns; 2026-10-26): the setup-code box broke apart, long Chinese
 * lines wrapped to column 0, and the once-a-tick status line redrew all the time — the screen flickered and the code could
 * not be selected (it was mistyped). Now: every line fits the real width (CJK counted as two cells), an ASCII box only when
 * it fits, the clipboard said right under the code, and no status redraw while the page is open.
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

function run(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-console-")); dirs.push(dir);
  const script = join(dir, "t.ps1");
  writeFileSync(script, `$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
$script:InstallLog = $null
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `& '${script}'`], { encoding: "utf8", timeout: 60_000 });
  return `${r.stdout}${r.stderr}`;
}
/** Display width as a console shows it: CJK and full-width forms two cells. */
const cells = (s: string) => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);

describe("stage 5's setup code in a narrow console", () => {
  for (const cols of [80, 100]) {
    it(`${cols} columns: every line fits, the code is on its own line in a box, and the clipboard is said right under it`, () => {
      if (!hasPwsh) return;
      const out = run(`function Get-StatusWidth { ${cols - 1} }
Show-SetupCode 'GR7K-2QXM' $true $true 'http://127.0.0.1:19282/s/abcdef0123456789/'`);
      const lines = out.split("\n").map(l => l.replace(/\r$/, "")).filter(l => !l.startsWith("  設定頁網址："));   // the URL is not wrapped: it is copied whole
      for (const l of lines) expect(cells(l), l).toBeLessThanOrEqual(cols - 1);
      const code = lines.findIndex(l => l.includes("G R 7 K - 2 Q X M"));
      expect(code).toBeGreaterThan(0);
      expect(lines[code - 1]).toMatch(/^  \+-+\+$/); expect(lines[code + 1]).toMatch(/^  \+-+\+$/);
      expect(lines[code + 2]).toContain("已複製到剪貼簿");
      expect(out).not.toMatch(/[┌┐└┘│─]/);                                   // no ambiguous-width box drawing
    });
  }

  it("too narrow for the box: the code alone on its line, still whole", () => {
    if (!hasPwsh) return;
    const out = run(`function Get-StatusWidth { 29 }
Show-SetupCode 'GR7K-2QXM' $false $true 'http://127.0.0.1:19280/s/x/'`);
    expect(out).toMatch(/^  設定碼：  G R 7 K - 2 Q X M$/m);
    expect(out).not.toContain("+---");
  });

  it("while the page is open the status line is not redrawn (no flicker); otherwise it is", () => {
    if (!hasPwsh) return;
    const count = (quiet: boolean) => run(`$script:draws = 0
function Test-LiveConsole { $true }
function Enter-StepConsole { $null }
function Write-StatusLine { $script:draws++; return 0 }
function New-StatusConsole { @{ Top = { 0 }; Move = { param($r) }; Write = { param($t) }; Height = { 50 } } }
$script:WatchQuiet = $${quiet}
$null = Invoke-Watched -Label 'wait' -Usually 'x' -File 'sh' -Arguments @('-c', 'sleep 2')
Write-Output ('DRAWS=' + $script:draws)`);
    expect(count(true)).toContain("DRAWS=0");
    expect(count(false)).toMatch(/DRAWS=([4-9]|\d\d)/);
  }, 30_000);                                                                // two pwsh starts; slow on a capped CPU
});
