/**
 * #1853 step ③ (the user's approved plan, 2026-10-20): signing in each AI backend without console skills.
 * - Login URLs open in the Windows browser: BROWSER in WSL points at a small wrapper that hands the URL to Windows'
 *   explorer.exe (WSL interop), whole, and never fails the CLI.
 * - Each backend with its own login command uses it (`kiro-cli login`, `claude auth login`, `codex login`): it ends by
 *   itself once signed in. A backend already signed in is skipped; one that isn't after the attempt is offered again.
 * - Antigravity has no login command: agy runs in a tmux of its own (socket agend-install), and it is sent its own
 *   `/quit` only once its credential file has stopped changing, `agy models` works and its ready screen shows — never
 *   mid-login, never killed. The commands and checks are the fleet /login's (src/login-flows.ts).
 * The helpers are the installer's own (pwsh); the agy watcher runs under bash with tmux and agy stubbed. A real login is
 * the user's Windows checklist.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const stage3 = code.slice(code.indexOf("function Invoke-LoginStage"), code.indexOf("function Complete-LoginStage"));
const stage3Top = code.slice(code.indexOf("Write-Step 4 $TOTAL"), code.indexOf("Write-Step 5 $TOTAL"));
const agySh = text.slice(text.indexOf("$AGY_LOGIN_SH = @'") + "$AGY_LOGIN_SH = @'".length + 1, text.indexOf("\n'@", text.indexOf("$AGY_LOGIN_SH = @'")));

describe("stage 3 signs in through each backend's own login (static)", () => {
  it("the login commands and checks are the fleet /login's; no bare CLI, no Ctrl+D to type", () => {
    expect(code).toMatch(/'kiro' \{ return 'kiro-cli login' \}/);
    expect(code).toMatch(/'claude' \{ return 'claude auth login' \}/);
    expect(code).toMatch(/'codex' \{ return 'codex login' \}/);
    expect(stage3).not.toMatch(/bash -lc "\$BACKEND_PATH; (claude|codex|agy)"/);
    expect(stage3).not.toMatch(/Ctrl\+D|\/quit 離開/);
    expect(stage3).toMatch(/if \(Test-WslLogin \$b\.Key\) \{ Write-Ok \("\{0\} 已經登入，跳過" -f \$b\.Name\); continue \}/);
    expect(stage3).toMatch(/\$loginFile, \$loginWsl = New-WslScriptFile \(Get-LoginScript \$b\.Key\)/);
    expect(stage3).toMatch(/按 Enter 再試一次；輸入 s 再按 Enter 先跳過/);
    expect(stage3).not.toMatch(/^\s*wsl -d/m);                                   // the login runs on the console (Start-Process), never inline
    expect(stage3Top).toMatch(/\$skippedLogins = @\(\)\nif \(\$browserLogin\) \{[\s\S]*\} else \{[\s\S]*\$skippedLogins = @\(Complete-LoginStage \$selected\)/);
    expect(stage3Top).not.toMatch(/Mark-Stage 3/);                                // console fallback marks it only with nothing skipped; browser mode verifies at the end
  });
  it("agy: its own tmux socket, a leftover session reattached (never killed), and nothing that kills", () => {
    expect(agySh).toMatch(/tmux -L agend-install has-session -t agy-login/);
    expect(agySh).toMatch(/tmux -L agend-install attach -t agy-login/);
    expect(agySh).not.toMatch(/kill|SIGKILL|-9\b/);
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const bash = spawnSync("bash", ["-c", "true"]).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
function withHelpers(body: string, env: Record<string, string> = {}) {
  const dir = scratch("agend-1853login-");
  const file = join(dir, "t.ps1");
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$AGY_' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: dir, ...env } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return { out: r.stdout + r.stderr, dir };
}

describe.skipIf(!pwsh)("with pwsh: the installer's login helpers", { timeout: 90_000 }, () => {
  it("explorer.exe's path inside WSL follows the Windows folder", () => {
    const a = withHelpers(`Write-Output ("P=" + (Get-WindowsExplorerWslPath))`, { SystemRoot: "C:\\Windows" });
    expect(a.out).toContain("P=/mnt/c/Windows/explorer.exe\n");
    const b = withHelpers(`Write-Output ("P=" + (Get-WindowsExplorerWslPath))`, { SystemRoot: "D:\\WINNT" });
    expect(b.out).toContain("P=/mnt/d/WINNT/explorer.exe\n");
  });
  it("the printed follow-up command keeps $HOME and $PATH for Linux when pasted into PowerShell (#2239 review)", () => {
    const { out } = withHelpers(`$UBUNTU_DISTRO = 'Ubuntu-24.04'
$env:HOME = '/windows-home'                                                     # what PowerShell would expand them to
function wsl { $script:got = $args }
foreach ($k in @('kiro', 'antigravity')) {
  $c = Get-LoginFollowUpCommand $k
  Invoke-Expression $c                                                          # pasted into PowerShell
  Write-Output ("CMD=" + $c)
  Write-Output ("WSL-GOT=" + ($script:got -join ' | '))
}`);
    expect(out).toContain("CMD=wsl -d Ubuntu-24.04 -u root -- bash -lc 'export PATH=/root/.local/bin:$HOME/.claude/local:$PATH; kiro-cli login'\n");
    // (A PowerShell function's $args drops the "--" that the real wsl.exe receives.)
    expect(out).toContain("WSL-GOT=-d | Ubuntu-24.04 | -u | root | bash | -lc | export PATH=/root/.local/bin:$HOME/.claude/local:$PATH; kiro-cli login\n");
    expect(out).toContain("WSL-GOT=-d | Ubuntu-24.04 | -u | root | bash | -lc | export PATH=/root/.local/bin:$HOME/.claude/local:$PATH; agy\n");
    expect(out).not.toContain("/windows-home");
  });
  it("claude's check is the fleet's authCheck: logged in only when status says \"loggedIn\": true", () => {
    const { out } = withHelpers(`Write-Output ("C=" + (Get-LoginCheck 'claude'))`);
    const check = out.match(/^C=(.*)$/m)![1];
    const run = (status: string) => spawnSync("bash", ["-c", check.replace("claude auth status 2>/dev/null", `printf '%s' '${status}'`)]).status;
    expect(run('{"loggedIn": true, "authMethod": "claude.ai"}')).toBe(0);
    expect(run('{"loggedIn": false}')).toBe(1);
    expect(run("")).toBe(1);
  });
  it.skipIf(!bash)("the URL wrapper hands the whole URL to explorer.exe and never fails the CLI", () => {
    const { out, dir } = withHelpers(`Write-Output (Get-OpenUrlScript)`, { SystemRoot: "C:\\Windows" });
    const fake = join(dir, "explorer.sh");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(dir, "args.txt")}'\nexit 1\n`); chmodSync(fake, 0o755);
    const script = out.trim().replace("/usr/local/bin/agend-open-url", join(dir, "open-url")).replace("/usr/local/bin/agend-open-url", join(dir, "open-url"))
      .replace("'/mnt/c/Windows/explorer.exe'", `'${fake}'`);
    expect(spawnSync("bash", ["-c", script]).status).toBe(0);
    const url = "https://example.test/oauth?client=a&state=b c";
    expect(spawnSync(join(dir, "open-url"), [url]).status).toBe(0);              // explorer.exe's exit 1 is not the CLI's failure
    expect(readFileSync(join(dir, "args.txt"), "utf8")).toBe(url + "\n");
  });
});

/** The agy watcher under bash: tmux and agy stubbed by files the test changes over time. */
function agyWatch(timeline: (dir: string) => Promise<void>, budgetMs = 15_000) {
  const dir = scratch("agend-1853agy-");
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
D='${dir}'
echo "$*" >> "$D/tmux.log"
case "$*" in
  *has-session*) [ -e "$D/alive" ] ;;
  *capture-pane*) cat "$D/pane" 2>/dev/null ;;
  *send-keys*) echo "$*" >> "$D/sent"; rm -f "$D/alive" ;;
esac
`); chmodSync(join(bin, "tmux"), 0o755);
  // agy models can be held (a "hold" file): it says it was called, then waits until the test releases it.
  writeFileSync(join(bin, "agy"), `#!/bin/sh
if [ "$1" = models ] && [ -e '${dir}/hold' ]; then touch '${dir}/models-called'; while [ -e '${dir}/hold' ]; do sleep 0.05; done; fi
[ "$1" = models ] && [ -e '${dir}/agy-ok' ]
`); chmodSync(join(bin, "agy"), 0o755);
  writeFileSync(join(dir, "alive"), "");
  writeFileSync(join(dir, "watch.sh"), `${agySh}\nagend_agy_quit_when_logged_in '${dir}/token' agend-install agy-login\necho WATCHER-DONE\n`);
  return new Promise<{ sent: string | null; log: string; done: boolean; ms: number }>((resolve) => {
    const started = Date.now();
    const child = spawn("bash", [join(dir, "watch.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    let out = "";
    child.stdout.on("data", (c: Buffer) => { out += c; });
    const timer = setTimeout(() => child.kill(), budgetMs);
    let tl: Promise<void> = Promise.resolve();
    child.on("close", () => tl.catch(() => {}).then(() => {                       // the timeline's own measurements finish first
      clearTimeout(timer);
      resolve({ sent: existsSync(join(dir, "sent")) ? readFileSync(join(dir, "sent"), "utf8") : null, log: readFileSync(join(dir, "tmux.log"), "utf8"),
        done: out.includes("WATCHER-DONE"), ms: Date.now() - started });
    }));
    tl = timeline(dir);
  });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe.skipIf(!bash)("the agy watcher (bash, tmux and agy stubbed)", { timeout: 60_000 }, () => {
  it("sends /quit once — only after the token stopped changing, agy models works and the ready screen shows", async () => {
    const r = await agyWatch(async (dir) => {
      writeFileSync(join(dir, "pane"), "Visit https://www.google.com/device and enter ABCD-EFGH\n");
      await sleep(1500); writeFileSync(join(dir, "token"), "{\"a\":");          // being written
      await sleep(1500); writeFileSync(join(dir, "token"), "{\"a\":1}");       // complete, still not usable
      await sleep(4500); writeFileSync(join(dir, "agy-ok"), "");               // usable — but the screen isn't ready
      await sleep(2000); writeFileSync(join(dir, "pane"), "Signed in.\n? for shortcuts\n");
    });
    expect(r.sent).toBe("-L agend-install send-keys -t agy-login /quit Enter\n");
    expect(r.done).toBe(true);
    expect(r.ms).toBeGreaterThan(9000);                                          // not before the ready screen (at ~9.5 s)
    expect(r.log).not.toMatch(/kill/);
  });
  it("a token still being written is never followed by /quit", async () => {
    const r = await agyWatch(async (dir) => {
      writeFileSync(join(dir, "agy-ok", ), ""); writeFileSync(join(dir, "pane"), "? for shortcuts\n");
      for (let i = 0; i < 8; i++) { writeFileSync(join(dir, "token"), "x".repeat(i + 1)); await sleep(1000); }
      rmSync(join(dir, "alive"));                                                  // the person quit it themselves
    });
    expect(r.sent).toBeNull();
    expect(r.done).toBe(true);
  });
  it("a ready screen and a settled token are not enough while agy models fails (the credential isn't usable)", async () => {
    const r = await agyWatch(async (dir) => {
      writeFileSync(join(dir, "pane"), "? for shortcuts\n"); writeFileSync(join(dir, "token"), "{\"a\":1}");
      await sleep(6000); rmSync(join(dir, "alive"));
    });
    expect(r.sent).toBeNull();
    expect(r.done).toBe(true);
  });
  it("no credential file yet: no /quit, however ready agy looks", async () => {
    const r = await agyWatch(async (dir) => {
      writeFileSync(join(dir, "pane"), "? for shortcuts\n"); writeFileSync(join(dir, "agy-ok"), "");
      await sleep(6000); rmSync(join(dir, "alive"));
    });
    expect(r.sent).toBeNull();
    expect(r.done).toBe(true);
  });
  it("an equal-length rewrite is a change: no /quit while the token is rewritten, one once it really stops (#2239 review)", async () => {
    let stoppedAt = 0;
    const r = await agyWatch(async (dir) => {
      writeFileSync(join(dir, "pane"), "? for shortcuts\n"); writeFileSync(join(dir, "agy-ok"), "");
      for (let i = 0; i < 12; i++) { writeFileSync(join(dir, "token"), `tok-${String(i).padStart(4, "0")}`); await sleep(500); }   // 8 bytes, every 0.5 s
      stoppedAt = Date.now();
    }, 20_000);
    expect(r.sent).toBe("-L agend-install send-keys -t agy-login /quit Enter\n");
    expect(r.ms).toBeGreaterThan(6000 + 2500);                                     // only after the writes stopped and it stayed still
    expect(stoppedAt).toBeGreaterThan(0);
  });
  it("a rewrite that keeps the size and puts the old modification time back is still a change (the content checksum)", async () => {
    const r = await agyWatch(async (dir) => {
      writeFileSync(join(dir, "pane"), "? for shortcuts\n"); writeFileSync(join(dir, "agy-ok"), "");
      const tok = join(dir, "token");
      writeFileSync(tok, "tok-0000"); const { atime, mtime } = statSync(tok);
      for (let i = 1; i < 10; i++) { await sleep(700); writeFileSync(tok, `tok-${String(i).padStart(4, "0")}`); utimesSync(tok, atime, mtime); }
      rmSync(join(dir, "alive"));
    }, 20_000);
    expect(r.sent).toBeNull();
    expect(r.done).toBe(true);
  });
  it("a token rewritten while agy models was being waited on is checked again before /quit, and the count starts over (#2239 review)", async () => {
    let afterRewrite = -1;
    const r = await agyWatch(async (dir) => {
      writeFileSync(join(dir, "pane"), "? for shortcuts\n"); writeFileSync(join(dir, "agy-ok"), ""); writeFileSync(join(dir, "hold"), "");
      writeFileSync(join(dir, "token"), "tok-0000");                               // stable for 3 s, then models is asked …
      while (!existsSync(join(dir, "models-called"))) await sleep(50);
      writeFileSync(join(dir, "token"), "tok-0001");                               // … and the token changes while it waits
      const at = Date.now(); rmSync(join(dir, "hold"));
      while (!existsSync(join(dir, "sent")) && Date.now() - at < 10_000) await sleep(50);
      afterRewrite = Date.now() - at;
    }, 20_000);
    expect(r.sent).toBe("-L agend-install send-keys -t agy-login /quit Enter\n");
    expect(afterRewrite).toBeGreaterThan(2500);                                    // only once the new token stayed still again
  });
  it("control: models waited on, the token unchanged — /quit right after the wait", async () => {
    let afterRelease = -1;
    const r = await agyWatch(async (dir) => {
      writeFileSync(join(dir, "pane"), "? for shortcuts\n"); writeFileSync(join(dir, "agy-ok"), ""); writeFileSync(join(dir, "hold"), "");
      writeFileSync(join(dir, "token"), "tok-0000");
      while (!existsSync(join(dir, "models-called"))) await sleep(50);
      const at = Date.now(); rmSync(join(dir, "hold"));
      while (!existsSync(join(dir, "sent")) && Date.now() - at < 10_000) await sleep(50);
      afterRelease = Date.now() - at;
    }, 20_000);
    expect(r.sent).toBe("-L agend-install send-keys -t agy-login /quit Enter\n");
    expect(afterRelease).toBeLessThan(1500);
  });
  it("an atomic replace with the same content, or the token missing for a moment, starts the count again", async () => {
    const r = await agyWatch(async (dir) => {
      writeFileSync(join(dir, "pane"), "? for shortcuts\n"); writeFileSync(join(dir, "agy-ok"), "");
      for (let i = 0; i < 4; i++) {                                               // replaced by rename every 0.8 s: a new inode each time
        writeFileSync(join(dir, "token.new"), "same-token"); renameSync(join(dir, "token.new"), join(dir, "token")); await sleep(800);
      }
      for (let i = 0; i < 3; i++) { rmSync(join(dir, "token"), { force: true }); await sleep(900); writeFileSync(join(dir, "token"), "same-token"); await sleep(1200); }
      rmSync(join(dir, "alive"));                                                  // the person quit it: nothing was ever stable for 3 s
    }, 20_000);
    expect(r.sent).toBeNull();
    expect(r.done).toBe(true);
  });
  it("agy ending by itself ends the watcher, with nothing sent", async () => {
    const r = await agyWatch(async (dir) => { await sleep(1500); rmSync(join(dir, "alive")); });
    expect(r.sent).toBeNull();
    expect(r.done).toBe(true);
    expect(r.ms).toBeLessThan(5000);
  });
});

describe.skipIf(!pwsh)("with pwsh: a skipped login keeps stage 3 open (#2239 review)", { timeout: 90_000 }, () => {
  it("skip one → stage 3 not marked; after an interruption the resumed run asks again; once signed in it is marked", () => {
    const { out } = withHelpers(`$ProgressFile = Join-Path $env:TMPDIR 'progress'
$UBUNTU_DISTRO = 'Ubuntu-24.04'; $Force = $false
$ALL = @([PSCustomObject]@{ Id = 1; Key = 'kiro'; Name = 'Kiro CLI' }, [PSCustomObject]@{ Id = 4; Key = 'codex'; Name = 'OpenAI Codex' })
$script:signedIn = @('codex'); $script:answers = @('s'); $script:attempts = 0
function Invoke-WslStep { return 0 }
function New-WslScriptFile { return @((Join-Path $env:TMPDIR 'x.sh'), '/x.sh') }
function Start-Process { $script:attempts++ }
function Test-WslLogin([string]$key) { return ($script:signedIn -contains $key) }
function Read-Host { $a = $script:answers[0]; $script:answers = @($script:answers | Select-Object -Skip 1); return $a }
$first = @(Complete-LoginStage $ALL)
Write-Output ("FIRST skipped=" + (($first | ForEach-Object { $_.Key }) -join ',') + " attempts=" + $script:attempts + " stage3=" + (Stage-Done 3))
# Stages 4/5 are interrupted; the same line again resumes, and stage 3 runs again: kiro is now signed in.
$script:signedIn = @('codex', 'kiro'); $script:attempts = 0
$second = @(Complete-LoginStage $ALL)
Write-Output ("SECOND skipped=" + $second.Count + " attempts=" + $script:attempts + " stage3=" + (Stage-Done 3))`);
    expect(out).toContain("FIRST skipped=kiro attempts=1 stage3=False\n");
    expect(out).toContain("還沒登入：Kiro CLI。之後接續安裝時會再請你登入；已登入的會跳過。");
    expect(out).toContain("SECOND skipped=0 attempts=0 stage3=True\n");      // checked again, found signed in, marked
  });
  it("everything signed in: no attempt, marked at once", () => {
    const { out } = withHelpers(`$ProgressFile = Join-Path $env:TMPDIR 'progress'
$UBUNTU_DISTRO = 'Ubuntu-24.04'
$ALL = @([PSCustomObject]@{ Id = 1; Key = 'kiro'; Name = 'Kiro CLI' })
$script:attempts = 0
function Invoke-WslStep { return 0 }
function Start-Process { $script:attempts++ }
function Test-WslLogin([string]$key) { return $true }
$r = @(Complete-LoginStage $ALL)
Write-Output ("skipped=" + $r.Count + " attempts=" + $script:attempts + " stage3=" + (Stage-Done 3))`);
    expect(out).toContain("skipped=0 attempts=0 stage3=True\n");
  });
});
