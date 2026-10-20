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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const stage5 = code.slice(code.indexOf("Write-Step 5 $TOTAL"), code.indexOf('Write-Info "檢查 AgEnD 狀態..."'));

describe("stage 5 sets up in the browser (static)", () => {
  it("runs agend setup through the watched runner, with the hook that opens the page", () => {
    expect(stage5).toMatch(/Invoke-BrowserSetup \{ param\(\$hook\) Invoke-WslStep -Label "等待你在瀏覽器完成設定"[^\n]*-OnLine \$hook -Script \(\$agendEnv \+ 'agend setup'\) \}/);
    expect(stage5).not.toMatch(/準備好了嗎/);                                       // nothing to press before the page opens
  });
  it("done or set up before (a resumed install) both go on; a page that closed unfinished is offered again", () => {
    expect(stage5).toMatch(/if \(\$setup\.Done -or \$setup\.Already\) \{ \$configured = \$true; break \}/);
    expect(stage5).toMatch(/按 Enter 重新打開設定頁；輸入 n 再按 Enter 結束/);
  });
  it("the console quickstart only as the fallback when no page appeared", () => {
    const quick = stage5.indexOf("agend quickstart");
    expect(quick).toBeGreaterThan(stage5.indexOf("設定頁沒有出現。"));
    expect(stage5.match(/agend quickstart/g)).toHaveLength(1);
  });
  it("makes AgEnD the service only when the service isn't already running", () => {
    expect(stage5).toMatch(/if systemctl --user is-active --quiet com\.agend\.fleet; then echo "AgEnD service is already running"; else agend install; fi/);
    expect(stage5).not.toMatch(/'agend install'\)/);
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function withHelpers(body: string) {
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
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: dir } });
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
