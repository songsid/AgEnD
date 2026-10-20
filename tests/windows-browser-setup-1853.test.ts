/**
 * #1853 step ① (the user's approved plan, 2026-10-20): the Windows installer's last stage sets AgEnD up in the browser,
 * not in the console. It runs `agend setup` inside WSL, reads the page's address and code from what it prints, opens
 * the page in the Windows browser, puts the code on the clipboard and shows it large; the person picks Discord or
 * Telegram and pastes the bot token on the page. When the page finishes it starts AgEnD; the installer then makes it
 * the service — unless the service already runs (`agend install` would stop it, and a clean stop is not restarted).
 * A page that closed unfinished is offered again; one that never appeared falls back to the console quickstart.
 * The helpers are the installer's own, run in pwsh (the browser and clipboard stubbed). The real browser, clipboard
 * and WSL localhost forwarding are the user's Windows checklist.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const stage5 = code.slice(code.indexOf("Write-Step 5 $TOTAL"), code.indexOf('Write-Info "檢查 AgEnD 狀態..."'));
const setupFn = code.slice(code.indexOf("function Invoke-SetupAndService"), code.indexOf("# ── AI 後端定義") > 0 ? code.indexOf("$ALL_BACKENDS") : undefined);

describe("stage 5 sets up in the browser (static)", () => {
  it("stage 5 is marked done only after setup and the service both succeeded; otherwise it ends with its progress kept", () => {
    expect(stage5).toMatch(/if \(-not \(Invoke-SetupAndService\)\) \{\n\s+Write-Info "之後再執行同一行安裝指令，會從這一步繼續。"\n\s+Read-Host "按 Enter 結束"; exit 1\n\s+\}/);
    expect(stage5).not.toMatch(/準備好了嗎/);                                       // nothing to press before the page opens
    expect(code.indexOf("Mark-Stage 5")).toBeGreaterThan(code.indexOf("if (-not (Invoke-SetupAndService))"));
  });
  it("runs agend setup through the watched runner, with the hook that opens the page; the service only when not already running", () => {
    expect(setupFn).toMatch(/Invoke-BrowserSetup \{ param\(\$hook\) Invoke-WslStep -Label "等待你在瀏覽器完成設定"[^\n]*-OnLine \$hook -Script \(\$AGEND_ENV \+ 'agend setup'\) \}/);
    expect(setupFn).toMatch(/if systemctl --user is-active --quiet com\.agend\.fleet; then echo "AgEnD service is already running"; else agend install; fi/);
    expect(code.match(/agend quickstart/g)).toHaveLength(1);                      // only Invoke-ConsoleQuickstart, the no-page fallback
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function withHelpers(body: string, input?: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1853setup-")); dirs.push(dir);
  const file = join(dir, "t.ps1");
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
$script:OnWindows = $false
# The browser and the clipboard, stubbed: what they were asked for is written down.
function Open-InBrowser([string]$url) { Add-Content -LiteralPath (Join-Path $env:TMPDIR 'opened.txt') -Value $url; return $true }
function Set-SetupClipboard([string]$text) { Add-Content -LiteralPath (Join-Path $env:TMPDIR 'clip.txt') -Value $text; return $true }
function FakeSetup([string]$script) { return { param($hook) Invoke-Watched -Label '等待你在瀏覽器完成設定' -Usually 'x' -File 'sh' -Arguments @('-c', $script) -OnLine $hook -HeartbeatSeconds 60 }.GetNewClosure() }
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, input: input ?? "", env: { ...process.env, TMPDIR: dir, ...env } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  const read = (f: string) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return null; } };
  return { out: r.stdout + r.stderr, opened: read("opened.txt"), clip: read("clip.txt") };
}

describe.skipIf(!pwsh)("with pwsh: the installer's browser setup", { timeout: 90_000 }, () => {
  it("reads the page's address and code from agend setup's lines, and nothing else", () => {
    const { out } = withHelpers(`$a = Get-SetupPrompt '  Setup page: http://127.0.0.1:19280/s/8f3c2b/'
$b = Get-SetupPrompt '  Setup code: K7QM-3XRD'
$c = Get-SetupPrompt '  Open the page, type the code. Five wrong attempts closes it,'
$d = Get-SetupPrompt '  Setup code: K7QM-3XR1'
Write-Output ("URL=" + $a.Url + " CODE=" + $b.Code + " OTHER=" + ($null -eq $c) + " BAD=" + ($null -eq $d))`);
    expect(out).toContain("URL=http://127.0.0.1:19280/s/8f3c2b/ CODE=K7QM-3XRD OTHER=True BAD=True");
  });
  it("finished: the page opened once, the code copied and shown large, and the result says done", () => {
    const { out, opened, clip } = withHelpers(`$r = Invoke-BrowserSetup (FakeSetup 'printf "\\n  Setup page: http://127.0.0.1:19280/s/ab12/\\n  Setup code: K7QM-3XRD\\n  Open the page, type the code.\\n"; sleep 1; echo "Setup complete — starting AgEnD."')
Write-Output ("DONE=" + $r.Done + " SHOWN=" + $r.Shown + " ALREADY=" + $r.Already)`);
    expect(opened).toBe("http://127.0.0.1:19280/s/ab12/\n");
    expect(clip).toBe("K7QM-3XRD\n");
    expect(out).toContain("設定碼：  K 7 Q M - 3 X R D");
    expect(out).toContain("設定頁已在瀏覽器打開。");
    expect(out).toContain("設定碼已複製：在網頁的輸入框按 Ctrl+V（或右鍵 → 貼上）。");
    expect(out).toContain("DONE=True SHOWN=True ALREADY=False");
  });
  it("the page closed unfinished: not done, but it was shown (the installer offers it again)", () => {
    const { out } = withHelpers(`$r = Invoke-BrowserSetup (FakeSetup 'echo "  Setup page: http://127.0.0.1:19280/s/x/"; echo "  Setup code: AAAA-BBBB"; echo "Setup host stopped (ttl). Run agend setup again to reopen it."')
Write-Output ("DONE=" + $r.Done + " SHOWN=" + $r.Shown)`);
    expect(out).toContain("DONE=False SHOWN=True");
  });
  it("set up before (a resumed install): already, and no page is opened", () => {
    const { out, opened } = withHelpers(`$r = Invoke-BrowserSetup (FakeSetup 'echo "Setup has already been completed. Use agend setup --reset to run it again, or edit settings from the dashboard." >&2; exit 1')
Write-Output ("DONE=" + $r.Done + " ALREADY=" + $r.Already + " SHOWN=" + $r.Shown + " EXIT=" + $r.Exit)`);
    expect(out).toContain("DONE=False ALREADY=True SHOWN=False EXIT=1");
    expect(opened).toBeNull();
  });
  it("no browser or clipboard: the address is printed to open by hand, and the code to type", () => {
    const { out } = withHelpers(`function Open-InBrowser([string]$url) { return $false }
function Set-SetupClipboard([string]$text) { return $false }
$null = Invoke-BrowserSetup (FakeSetup 'echo "  Setup page: http://127.0.0.1:19280/s/q/"; echo "  Setup code: CCCC-DDDD"')`);
    expect(out).toContain("瀏覽器沒有自動打開，請自己打開這個網址：http://127.0.0.1:19280/s/q/");
    expect(out).toContain("在網頁的輸入框輸入上面的設定碼。");
  });
});

/** Stage 5's own decisions (Invoke-SetupAndService) with its steps, the console and the answers stubbed. */
function stage5Run(setupLines: string[][], serviceCodes: number[], answers: string[], quickstartCodes: number[] = [], input?: string) {
  // A native wsl.exe (#2235 review): it prints a prompt without a newline, waits for a line on stdin, prints it back and
  // exits with the next code — its output must reach the console, not the function's result.
  const bin = mkdtempSync(join(tmpdir(), "agend-1853wsl-")); dirs.push(bin);
  const codes = join(bin, "codes.txt"), qlog = join(bin, "qlog.txt");
  writeFileSync(codes, quickstartCodes.map(c => `${c}\n`).join(""));
  writeFileSync(join(bin, "wsl.exe"), `#!/bin/sh
printf 'CHOICE-PROMPT> '
read answer
echo "ANSWER=$answer ARGS=$*"
c=$(head -n 1 '${codes}')
sed -i 1d '${codes}'
echo "quickstart:$c" >> '${qlog}'
exit "$c"
`);
  chmodSync(join(bin, "wsl.exe"), 0o755);
  return withHelpers(`$UBUNTU_DISTRO = 'Ubuntu-24.04'
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$AGEND_ENV' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
$script:setups = [System.Collections.ArrayList]::new()
${setupLines.map(ls => "[void]$script:setups.Add([string[]]@(" + [...ls.map(l => `'${l}'`), "''"].join(",") + "))").join("\n")}
$script:services = @(${serviceCodes.join(",") || "@()"}); $script:answers = @(${answers.map(a => `'${a}'`).join(",") || "@()"}); $script:quick = @(${quickstartCodes.join(",") || "@()"})
$script:log = @()
function Invoke-WslStep { param($Label, $Usually, $Script, $UpperMinutes, $OnLine)
  if ($Script -match 'agend setup') { $lines = $script:setups[0]; $script:setups.RemoveAt(0); $script:log += 'setup'; foreach ($l in $lines) { if ($l -and $OnLine) { & $OnLine $l } }; return 0 }
  $c = $script:services[0]; $script:services = @($script:services | Select-Object -Skip 1); $script:log += "service:$c"; return $c }
function Read-Host { param($p) $a = $script:answers[0]; $script:answers = @($script:answers | Select-Object -Skip 1); $script:log += "ask:$a"; return $a }
$ok = Invoke-SetupAndService
$q = $env:QLOG
if (Test-Path $q) { $script:log = @($script:log) + @(Get-Content $q) }
Write-Output ("RESULT=" + $ok + " LOG=" + ($script:log -join ','))`, input, { PATH: `${bin}:${process.env.PATH}`, QLOG: qlog });
}
const PAGE = ["  Setup page: http://127.0.0.1:19280/s/a/", "  Setup code: AAAA-BBBB"];

describe.skipIf(!pwsh)("with pwsh: stage 5's decisions (#2235 review: done only when the commands succeeded)", { timeout: 90_000 }, () => {
  it("the page finished and the service installed: done", () => {
    expect(stage5Run([[...PAGE, "Setup complete — starting AgEnD."]], [0], []).out).toContain("RESULT=True LOG=setup,service:0\n");
  });
  it("the service failed: said so, offered again — Enter retries and a success is done", () => {
    const { out } = stage5Run([[...PAGE, "Setup complete — starting AgEnD."]], [1, 0], [""]);
    expect(out).toContain("AgEnD 服務沒有安裝成功（結束碼 1）。設定已經存好，不用重新設定。");
    expect(out).toContain("RESULT=True LOG=setup,service:1,ask:,service:0\n");
  });
  it("the service failed and the person stops: not done (progress kept, stage 5 not marked)", () => {
    expect(stage5Run([[...PAGE, "Setup complete — starting AgEnD."]], [1], ["n"]).out).toContain("RESULT=False LOG=setup,service:1,ask:n\n");
  });
  it("no page: the console quickstart runs on the console (its prompt shown, its input read) and counts only when it exits 0", () => {
    const { out } = stage5Run([[], []], [0], ["", ""], [1, 0], "first\nsecond\n");
    expect(out).toContain("CHOICE-PROMPT> ANSWER=first ARGS=-d Ubuntu-24.04 -u root -- bash -lc export PATH=/root/.local/bin:$PATH; source /root/.nvm/nvm.sh 2>/dev/null; agend quickstart\n");
    expect(out).toContain("CHOICE-PROMPT> ANSWER=second");
    expect(out).toContain("主控台的設定沒有完成（結束碼 1）。");                // one exit code, never its output
    expect(out).toContain("RESULT=True LOG=setup,ask:,setup,ask:,service:0,quickstart:1,quickstart:0\n");
  });
  it("no page: a quickstart that exits 0 the first time goes straight to the service", () => {
    const { out } = stage5Run([[]], [0], [""], [0], "yes\n");
    expect(out).toContain("CHOICE-PROMPT> ANSWER=yes");
    expect(out).not.toContain("主控台的設定沒有完成");
    expect(out).toContain("RESULT=True LOG=setup,ask:,service:0,quickstart:0\n");
  });
  it("a page closed unfinished and the person stops: not done, and no service install", () => {
    expect(stage5Run([[...PAGE, "Setup host stopped (ttl). Run `agend setup` again to reopen it."]], [], ["n"]).out).toContain("RESULT=False LOG=setup,ask:n\n");
  });
  it("set up before (a resumed install): straight to the service", () => {
    expect(stage5Run([["Setup has already been completed. Use `agend setup --reset` to run it again, or edit settings from the dashboard."]], [0], []).out)
      .toContain("RESULT=True LOG=setup,service:0\n");
  });
});
