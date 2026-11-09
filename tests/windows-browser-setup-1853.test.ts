/**
 * #1853 step ① (the user's approved plan, 2026-10-20): the Windows installer's last stage sets AgEnD up in the browser,
 * not in the console. It runs `agend setup` inside WSL, reads the page's address and code from what it prints, opens
 * the page in the Windows browser, puts the code on the clipboard and shows it large; the person picks Discord or
 * Telegram and pastes the bot token on the page. When the page finishes it starts AgEnD; the installer then makes it
 * the service — unless the service already runs (`agend install` would stop it, and a clean stop is not restarted).
 * A page that closed unfinished is offered again; one that never appeared falls back to the console quickstart.
 * The helpers are the installer's own, run in pwsh (the browser and clipboard stubbed). The real browser, clipboard
 * and WSL localhost forwarding are the user's Windows checklist.
 *
 * Batched (#3110 / #3117 / #3128 family): only the installer functions the cases call are sliced in Node
 * (tests/support/installer-ps-batch-a.ts), and every pwsh case of this file runs in ONE pwsh process. No waits on the
 * wall clock: Start-Sleep is a no-op in the batch, and the fake setup page prints at once.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CASE_RUNNER,
  caseOf,
  psLiteral,
  runPwshBatch,
  sliceAssignments,
  sliceFunctions,
  type CaseResult,
} from "./support/installer-ps-batch-a.js";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
// Stage 5 now prepares the private home before invoking an older release's setup/quickstart.
const agendEnv = text.match(/^\$AGEND_ENV = '((?:[^']|'')*)'$/m)![1]!.replace(/''/g, "'");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const stage5 = code.slice(code.indexOf("Write-Step 5 $TOTAL"), code.indexOf('Write-Info "檢查 AgEnD 狀態..."'));
const setupFn = code.slice(code.indexOf("function Invoke-SetupAndService"), code.indexOf("# ── AI 後端定義") > 0 ? code.indexOf("$ALL_BACKENDS") : undefined);

const ROOTS = ["Get-SetupPrompt", "Invoke-BrowserSetup", "Invoke-SetupAndService", "Invoke-ConsoleQuickstart", "Invoke-Watched"];
const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  sliceFunctions(text, ROOTS),
  sliceAssignments(text, ["AGEND_ENV"]),
  "$script:OnWindows = $false",
  "$AGEND_USER = 'root'",
  "$UBUNTU_DISTRO = 'Ubuntu-24.04'",
  CASE_RUNNER,
].join("\n");

describe("stage 5 sets up in the browser (static)", () => {
  it("the cases' functions are sliced in Node, not parsed from the whole installer", () => {
    expect(PRELUDE).toContain("function Invoke-BrowserSetup");
    expect(PRELUDE).toContain("function Invoke-ConsoleQuickstart");
    expect(PRELUDE).toContain("$AGEND_ENV = '");
    expect(PRELUDE).not.toContain("Parser]::ParseFile");
  });
  it("stage 5 is marked done only after setup and the service both succeeded; otherwise it ends with its progress kept", () => {
    expect(stage5).toMatch(/if \(-not \(Invoke-SetupAndService -BackendSignins \$browserSignins -Backends \$selected\)\) \{\n\s+Write-Info "之後再執行同一行安裝指令，會從這一步繼續。"\n\s+Read-Host "按 Enter 結束"; exit 1\n\s+\}/);
    expect(stage5).not.toMatch(/準備好了嗎/);                                       // nothing to press before the page opens
    expect(code.indexOf("Mark-Stage 5")).toBeGreaterThan(code.indexOf("if (-not (Invoke-SetupAndService -BackendSignins $browserSignins -Backends $selected))"));
  });
  it("runs agend setup through the watched runner, with the hook that opens the page; the service only when not already running", () => {
    expect(setupFn).toMatch(/Invoke-BrowserSetup \{ param\(\$hook\) Invoke-WslStep -Label "等待你在瀏覽器完成設定"[^\n]*-OnLine \$hook -Script \(\$AGEND_ENV \+ \$setupCommand\) \}/);
    expect(setupFn).toMatch(/if systemctl --user is-active --quiet com\.agend\.fleet; then echo "AgEnD service is already running"; else agend install; fi/);
    expect(code.match(/agend quickstart/g)).toHaveLength(1);                      // only Invoke-ConsoleQuickstart, the no-page fallback
  });
});

/** Stubs for the whole batch. A case redefines one inside its own scope, so the stub is seen only by that case. */
const STUBS = `$script:Opened = @(); $script:Clipped = @()
# The browser and the clipboard, stubbed: what they were asked for is recorded per case.
function Open-InBrowser([string]$url) { $script:Opened += $url; return $true }
function Wait-SetupPageReachable { return $true }
function Set-SetupClipboard([string]$text) { $script:Clipped += $text; return $true }
# Invoke-Watched polls with Start-Sleep -Milliseconds 250. No real waits: its own stopwatch still bounds the step.
function Start-Sleep { param($Seconds, $Milliseconds) }
function FakeSetup([string]$script) { return { param($hook) Invoke-Watched -Label '等待你在瀏覽器完成設定' -Usually 'x' -File 'sh' -Arguments @('-c', $script) -OnLine $hook -HeartbeatSeconds 60 }.GetNewClosure() }
# Stage 5's wsl steps and answers: each case queues what every step returns. Running out is a failure, never a loop.
$script:Log = @(); $script:Setups = $null; $script:Services = $null; $script:Answers = $null
function Reset-Stage5 { $script:Log = @(); $script:Setups = [System.Collections.Queue]::new(); $script:Services = [System.Collections.Queue]::new(); $script:Answers = [System.Collections.Queue]::new() }
function Invoke-WslStep { param($Label, $Usually, $Script, $UpperMinutes, $OnLine)
  if ($Script -match 'agend setup') {
    if ($script:Setups.Count -eq 0) { throw 'unexpected setup run' }
    $lines = $script:Setups.Dequeue(); $script:Log += 'setup'
    foreach ($l in $lines) { if ($l -and $OnLine) { & $OnLine $l } }
    return 0
  }
  if ($script:Services.Count -eq 0) { throw 'unexpected service run' }
  $c = $script:Services.Dequeue(); $script:Log += "service:$c"; return $c
}
function Read-Host { param($p) if ($script:Answers.Count -eq 0) { throw 'unexpected question' }; $a = $script:Answers.Dequeue(); $script:Log += "ask:$a"; return $a }
# A fake wsl.exe on PATH (a native process, so the console quickstart's own stdin and stdout are the real ones): its
# exit codes come from this case's list.
function Set-FakeWsl([int[]]$codes) {
  $d = Join-Path $env:TMPDIR ('wsl-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $d | Out-Null
  $txt = ''; foreach ($c in $codes) { $txt += "$c" + [char]10 }
  [IO.File]::WriteAllText((Join-Path $d 'codes.txt'), $txt)
  $env:AGEND_FAKE_WSL_DIR = $d
}`;

const FAKE_WSL = `#!/bin/sh
printf 'CHOICE-PROMPT> '
read answer
echo "ANSWER=$answer ARGS=$*"
c=$(head -n 1 "$AGEND_FAKE_WSL_DIR/codes.txt")
sed -i 1d "$AGEND_FAKE_WSL_DIR/codes.txt"
echo "quickstart:$c" >> "$AGEND_FAKE_WSL_DIR/qlog.txt"
exit "$c"
`;

const PAGE = ["  Setup page: http://127.0.0.1:19280/s/a/", "  Setup code: AAAA-BBBB"];

interface Stage5Case { name: string; setups: string[][]; services?: number[]; answers?: string[]; codes?: number[] }
/** One stage-5 run: Invoke-SetupAndService with its steps queued, and what it logged. */
function stage5Case({ name, setups, services = [], answers = [], codes = [] }: Stage5Case): string {
  return `Invoke-Case ${psLiteral(name)} {
  Reset-Stage5
${setups.map(lines => `  $script:Setups.Enqueue([string[]]@(${lines.map(psLiteral).join(",")}))`).join("\n")}
${services.map(c => `  $script:Services.Enqueue(${c})`).join("\n")}
${answers.map(a => `  $script:Answers.Enqueue(${psLiteral(a)})`).join("\n")}
  Set-FakeWsl @(${codes.join(",")})
  $ok = Invoke-SetupAndService
  $q = Join-Path $env:AGEND_FAKE_WSL_DIR 'qlog.txt'
  if (Test-Path -LiteralPath $q) { $script:Log = @($script:Log) + @(Get-Content -LiteralPath $q) }
  Write-Output ("RESULT=" + $ok + " LOG=" + ($script:Log -join ','))
}`;
}

const STAGE5_CASES: Stage5Case[] = [
  { name: "stage5-finished", setups: [[...PAGE, "Setup complete — starting AgEnD."]], services: [0] },
  { name: "stage5-service-retry", setups: [[...PAGE, "Setup complete — starting AgEnD."]], services: [1, 0], answers: [""] },
  { name: "stage5-service-stop", setups: [[...PAGE, "Setup complete — starting AgEnD."]], services: [1], answers: ["n"] },
  // No page: the console quickstart runs on the console; its two exit codes are the two runs. Its stdin is the batch's
  // input, in order: "first" and "second" here, "yes" for the next case.
  { name: "stage5-console", setups: [[], []], services: [0], answers: ["", ""], codes: [1, 0] },
  { name: "stage5-console-ok", setups: [[]], services: [0], answers: [""], codes: [0] },
  { name: "stage5-closed-stop", setups: [[...PAGE, "Setup host stopped (ttl). Run `agend setup` again to reopen it."]], answers: ["n"] },
  { name: "stage5-resumed", setups: [["Setup has already been completed. Use `agend setup --reset` to run it again, or edit settings from the dashboard."]], services: [0] },
];

const BATCH = `${PRELUDE}
${STUBS}
Invoke-Case 'prompts' {
  $a = Get-SetupPrompt '  Setup page: http://127.0.0.1:19280/s/8f3c2b/'
  $b = Get-SetupPrompt '  Setup code: K7QM-3XRD'
  $c = Get-SetupPrompt '  Open the page, type the code. Five wrong attempts closes it,'
  $d = Get-SetupPrompt '  Setup code: K7QM-3XR1'
  Write-Output ("URL=" + $a.Url + " CODE=" + $b.Code + " OTHER=" + ($null -eq $c) + " BAD=" + ($null -eq $d))
}
Invoke-Case 'finished' {
  $r = Invoke-BrowserSetup (FakeSetup 'printf "\\n  Setup page: http://127.0.0.1:19280/s/ab12/\\n  Setup code: K7QM-3XRD\\n  Open the page, type the code.\\n"; echo "Setup complete — starting AgEnD."')
  Write-Output ("DONE=" + $r.Done + " SHOWN=" + $r.Shown + " ALREADY=" + $r.Already)
}
Invoke-Case 'unfinished' {
  $r = Invoke-BrowserSetup (FakeSetup 'echo "  Setup page: http://127.0.0.1:19280/s/x/"; echo "  Setup code: AAAA-BBBB"; echo "Setup host stopped (ttl). Run agend setup again to reopen it."')
  Write-Output ("DONE=" + $r.Done + " SHOWN=" + $r.Shown)
}
Invoke-Case 'already' {
  $r = Invoke-BrowserSetup (FakeSetup 'echo "Setup has already been completed. Use agend setup --reset to run it again, or edit settings from the dashboard." >&2; exit 1')
  Write-Output ("DONE=" + $r.Done + " ALREADY=" + $r.Already + " SHOWN=" + $r.Shown + " EXIT=" + $r.Exit)
}
Invoke-Case 'no-browser' {
  function Open-InBrowser([string]$url) { return $false }
  function Set-SetupClipboard([string]$text) { return $false }
  $null = Invoke-BrowserSetup (FakeSetup 'echo "  Setup page: http://127.0.0.1:19280/s/q/"; echo "  Setup code: CCCC-DDDD"')
}
${STAGE5_CASES.map(stage5Case).join("\n")}
`;

// Stdin of the batch: one line per console-quickstart run, in case order ("stage5-console" takes two, the next one).
const BATCH_INPUT = "first\nsecond\nyes\n";

let batch: Map<string, CaseResult> | undefined;
const dirs: string[] = [];
beforeAll(() => {
  if (!pwsh) return;
  const dir = mkdtempSync(join(tmpdir(), "agend-1853setup-")); dirs.push(dir);
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "wsl.exe"), FAKE_WSL);
  chmodSync(join(bin, "wsl.exe"), 0o755);
  batch = runPwshBatch(dir, BATCH, { input: BATCH_INPUT, env: { PATH: `${bin}:${process.env.PATH}` } });
});
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const run = (name: string): CaseResult => caseOf(batch!, name);

describe.skipIf(!pwsh)("with pwsh: the installer's browser setup", () => {
  it("reads the page's address and code from agend setup's lines, and nothing else", () => {
    expect(run("prompts").out).toContain("URL=http://127.0.0.1:19280/s/8f3c2b/ CODE=K7QM-3XRD OTHER=True BAD=True");
  });
  it("finished: the page opened once, the code copied and shown large, and the result says done", () => {
    const r = run("finished");
    expect(r.record.opened).toEqual(["http://127.0.0.1:19280/s/ab12/"]);
    expect(r.record.clipped).toEqual(["K7QM-3XRD"]);
    expect(r.out).toContain("設定碼：  K 7 Q M - 3 X R D");
    expect(r.out).toContain("設定頁已在瀏覽器打開。");
    expect(r.out).toContain("設定頁網址：http://127.0.0.1:19280/s/ab12/");          // #2650 item 10: printed even when it opened
    expect(r.out).toContain("設定碼已複製到剪貼簿：在網頁的輸入框按 Ctrl+V 或右鍵貼上，不必自己打");
    expect(r.out).toContain("DONE=True SHOWN=True ALREADY=False");
  });
  it("the page closed unfinished: not done, but it was shown (the installer offers it again)", () => {
    expect(run("unfinished").out).toContain("DONE=False SHOWN=True");
  });
  it("set up before (a resumed install): already, and no page is opened", () => {
    const r = run("already");
    expect(r.out).toContain("DONE=False ALREADY=True SHOWN=False EXIT=1");
    expect(r.record.opened).toEqual([]);
  });
  it("no browser or clipboard: the address is printed to open by hand, and the code to type", () => {
    const { out } = run("no-browser");
    expect(out).toContain("瀏覽器沒有自動打開，請自己打開下面的網址。");
    expect(out).toContain("設定頁網址：http://127.0.0.1:19280/s/q/");
    expect(out).toContain("在網頁的輸入框輸入上面的設定碼。");
  });
});

describe.skipIf(!pwsh)("with pwsh: stage 5's decisions (#2235 review: done only when the commands succeeded)", () => {
  it("the page finished and the service installed: done", () => {
    expect(run("stage5-finished").out).toContain("RESULT=True LOG=setup,service:0\n");
  });
  it("the service failed: said so, offered again — Enter retries and a success is done", () => {
    const { out } = run("stage5-service-retry");
    expect(out).toContain("AgEnD 服務沒有安裝成功（結束碼 1）。設定已經存好，不用重新設定。");
    expect(out).toContain("RESULT=True LOG=setup,service:1,ask:,service:0\n");
  });
  it("the service failed and the person stops: not done (progress kept, stage 5 not marked)", () => {
    expect(run("stage5-service-stop").out).toContain("RESULT=False LOG=setup,service:1,ask:n\n");
  });
  it("no page: the console quickstart runs on the console (its prompt shown, its input read) and counts only when it exits 0", () => {
    const { out } = run("stage5-console");
    expect(out).toContain(`CHOICE-PROMPT> ANSWER=first ARGS=-d Ubuntu-24.04 -u root --exec bash -lc ${agendEnv}agend quickstart\n`);
    expect(out).toContain("CHOICE-PROMPT> ANSWER=second");
    expect(out).toContain("主控台的設定沒有完成（結束碼 1）。");                // one exit code, never its output
    expect(out).toContain("RESULT=True LOG=setup,ask:,setup,ask:,service:0,quickstart:1,quickstart:0\n");
  });
  it("no page: a quickstart that exits 0 the first time goes straight to the service", () => {
    const { out } = run("stage5-console-ok");
    expect(out).toContain("CHOICE-PROMPT> ANSWER=yes");
    expect(out).not.toContain("主控台的設定沒有完成");
    expect(out).toContain("RESULT=True LOG=setup,ask:,service:0,quickstart:0\n");
  });
  it("a page closed unfinished and the person stops: not done, and no service install", () => {
    expect(run("stage5-closed-stop").out).toContain("RESULT=False LOG=setup,ask:n\n");
  });
  it("set up before (a resumed install): straight to the service", () => {
    expect(run("stage5-resumed").out).toContain("RESULT=True LOG=setup,service:0\n");
  });
});
