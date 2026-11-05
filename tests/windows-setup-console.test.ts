/** Narrow-console rendering and quiet watching: real sliced installer functions, virtual process/clock, one pwsh. */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPsFunction } from "./support/installer-ps-extract.js";
import { installerPwshBatch, withInstallerClock, type InstallerPwshCase } from "./support/installer-pwsh-fixture.js";

const source = readFileSync(join(import.meta.dirname, "..", "website/public/install-agend.ps1"), "utf8");
const prelude = withInstallerClock([
  "Get-DisplayWidth", "Split-DisplayLines", "Write-Wrapped", "Show-SetupCode", "Write-Ok", "Write-Warn", "Write-Info",
  "Write-InstallLog", "Protect-LogText", "Format-Elapsed", "Join-ProcessArguments", "New-OutputTail", "Read-OutputTail", "Split-ToolOutput", "Get-LastSegment", "Invoke-Watched",
].map(name => extractPsFunction(source, name)).join("\n"));
const watch = (quiet: boolean) => `
$script:draws = 0
$script:process = [pscustomobject]@{ HasExited = $false; Handle = 1; ExitCode = 0 }
$script:process | Add-Member ScriptMethod WaitForExit { }
function Test-LiveConsole { $true }
function Enter-StepConsole { $null }
function Restore-StepConsole { param($Saved) }
function Get-StatusWidth { 79 }
function Write-StatusLine { $script:draws++; return 0 }
function New-StatusConsole { @{ Top = { 0 }; Move = { param($r) }; Write = { param($t) }; Height = { 50 } } }
function Start-Process { param($FilePath, $ArgumentList, [switch]$NoNewWindow, [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
  if ($FilePath -ne 'inert-child') { throw 'Unexpected process' }
  [IO.File]::WriteAllText($RedirectStandardOutput, ''); [IO.File]::WriteAllText($RedirectStandardError, '')
  return $script:process
}
$script:FixtureTick = { if ($script:FixtureMilliseconds -ge 2000) { $script:process.HasExited = $true } }
$script:WatchQuiet = $${quiet}
$exitCode = Invoke-Watched -Label 'wait' -Usually 'x' -File 'inert-child'
Write-Output ('DRAWS=' + $script:draws + ' EXIT=' + $exitCode + ' ELAPSED=' + $script:FixtureMilliseconds)
`;
const cases: Record<string, InstallerPwshCase> = {
  ...Object.fromEntries([80, 100].map(cols => [`width-${cols}`, { prelude: "installer", body: `function Get-StatusWidth { ${cols - 1} }\nShow-SetupCode 'GR7K-2QXM' $true $true 'http://127.0.0.1:19282/s/abcdef0123456789/'` }])),
  narrow: { prelude: "installer", body: "function Get-StatusWidth { 29 }\nShow-SetupCode 'GR7K-2QXM' $false $true 'http://127.0.0.1:19280/s/x/'" },
  quiet: { prelude: "installer", body: watch(true) }, active: { prelude: "installer", body: watch(false) },
};
const batch = installerPwshBatch({ installer: prelude }, cases);
afterAll(batch.cleanup);
const output = (name: string) => { expect(batch.results[name]?.error).toBeNull(); return batch.results[name]!.out; };
const cells = (s: string) => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);

describe.skipIf(!batch.available)("stage 5's setup code in a narrow console", () => {
  it.each([80, 100])("%i columns: every line fits, the ASCII code box and clipboard guidance stay together", cols => {
    const out = output(`width-${cols}`);
    const lines = out.split("\n").map(l => l.replace(/\r$/, "")).filter(l => !l.startsWith("  設定頁網址："));
    for (const line of lines) expect(cells(line), line).toBeLessThanOrEqual(cols - 1);
    const code = lines.findIndex(l => l.includes("G R 7 K - 2 Q X M")); expect(code).toBeGreaterThan(0);
    expect(lines[code - 1]).toMatch(/^  \+-+\+$/); expect(lines[code + 1]).toMatch(/^  \+-+\+$/);
    expect(lines[code + 2]).toContain("已複製到剪貼簿"); expect(out).not.toMatch(/[┌┐└┘│─]/);
  });
  it("too narrow for the box: the code remains whole on its own line", () => {
    expect(output("narrow")).toMatch(/^  設定碼：  G R 7 K - 2 Q X M$/m); expect(output("narrow")).not.toContain("+---");
  });
  it("while the page is open no status redraw occurs; the same eight virtual ticks redraw otherwise", () => {
    expect(output("quiet")).toContain("DRAWS=0 EXIT=0 ELAPSED=2000");
    expect(output("active")).toContain("DRAWS=8 EXIT=0 ELAPSED=2000");
  });
});
