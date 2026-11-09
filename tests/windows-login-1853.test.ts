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
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InstallerPsBatch, hasPwsh } from "./support/installer-ps-batch.js";
import { extractPsFunctions, extractPsAssignments } from "./support/installer-ps-extract.js";

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
    expect(code).toMatch(/'codex' \{ return 'codex login --device-auth' \}/);
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

const pwsh = hasPwsh;
const batch = new InstallerPsBatch({ installer: extractPsFunctions(text) + "\n" + extractPsAssignments(text, ["AGY_LOGIN_SH"]) });
const bash = spawnSync("bash", ["-c", "true"]).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
async function withHelpers(body: string, env: Record<string, string> = {}) {
  const dir = scratch("agend-1853login-");
  const out = await batch.run("installer", body, { env: { TMPDIR: dir, ...env } });
  return { out, dir };
}

describe.skipIf(!pwsh)("with pwsh: the installer's login helpers", () => {
  it("explorer.exe's path inside WSL follows the Windows folder", async () => {
    const a = (await withHelpers(`Write-Output ("P=" + (Get-WindowsExplorerWslPath))`, { SystemRoot: "C:\\Windows" }));
    expect(a.out).toContain("P=/mnt/c/Windows/explorer.exe\n");
    const b = (await withHelpers(`Write-Output ("P=" + (Get-WindowsExplorerWslPath))`, { SystemRoot: "D:\\WINNT" }));
    expect(b.out).toContain("P=/mnt/d/WINNT/explorer.exe\n");
  });
  it("the printed follow-up command keeps $HOME and $PATH for Linux when pasted into PowerShell (#2239 review)", async () => {
    const { out } = (await withHelpers(`$UBUNTU_DISTRO = 'Ubuntu-24.04'
$env:HOME = '/windows-home'                                                     # what PowerShell would expand them to
function wsl { $script:got = $args }
foreach ($k in @('kiro', 'antigravity')) {
  $c = Get-LoginFollowUpCommand $k
  Invoke-Expression $c                                                          # pasted into PowerShell
  Write-Output ("CMD=" + $c)
  Write-Output ("WSL-GOT=" + ($script:got -join ' | '))
}`));
    expect(out).toContain("CMD=wsl -d Ubuntu-24.04 -u root -- bash -lc 'export PATH=/root/.local/bin:$HOME/.claude/local:$PATH; kiro-cli login'\n");
    // (A PowerShell function's $args drops the "--" that the real wsl.exe receives.)
    expect(out).toContain("WSL-GOT=-d | Ubuntu-24.04 | -u | root | bash | -lc | export PATH=/root/.local/bin:$HOME/.claude/local:$PATH; kiro-cli login\n");
    expect(out).toContain("WSL-GOT=-d | Ubuntu-24.04 | -u | root | bash | -lc | export PATH=/root/.local/bin:$HOME/.claude/local:$PATH; agy\n");
    expect(out).not.toContain("/windows-home");
  });
  it("claude's check is the fleet's authCheck: logged in only when status says \"loggedIn\": true", async () => {
    const { out } = (await withHelpers(`Write-Output ("C=" + (Get-LoginCheck 'claude'))`));
    const check = out.match(/^C=(.*)$/m)![1];
    const run = (status: string) => spawnSync("bash", ["-c", check.replace("claude auth status 2>/dev/null", `printf '%s' '${status}'`)]).status;
    expect(run('{"loggedIn": true, "authMethod": "claude.ai"}')).toBe(0);
    expect(run('{"loggedIn": false}')).toBe(1);
    expect(run("")).toBe(1);
  });
  it.skipIf(!bash)("the URL wrapper hands the whole URL to Windows' Start-Process (through the environment), explorer.exe only as a last resort, and never fails the CLI", async () => {
    const { out, dir } = (await withHelpers(`Write-Output (Get-OpenUrlScript)`, { SystemRoot: "C:\\Windows" }));
    const ps = join(dir, "powershell.sh"), explorer = join(dir, "explorer.sh");
    const script = out.trim().split("/usr/local/bin/agend-open-url").join(join(dir, "open-url"))
      .replace("'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'", `'${ps}'`)
      .replace("'/mnt/c/Windows/explorer.exe'", `'${explorer}'`);
    expect(spawnSync("bash", ["-c", script]).status).toBe(0);
    // A long URL with &, quotes and spaces, as an OAuth URL can be.
    const url = "https://example.test/oauth?client=a&state=b c&q='x'&" + "p=" + "z".repeat(900);
    const open = (psCode: number) => {
      writeFileSync(ps, `#!/bin/sh\nprintf '%s\\n' "$*" > '${join(dir, "ps-args.txt")}'\nprintf '%s' "$AGEND_OPEN_URL" > '${join(dir, "ps-url.txt")}'\nprintf '%s' "$WSLENV" > '${join(dir, "ps-wslenv.txt")}'\nexit ${psCode}\n`); chmodSync(ps, 0o755);
      writeFileSync(explorer, `#!/bin/sh\nprintf '%s' "$1" > '${join(dir, "explorer-url.txt")}'\nexit 1\n`); chmodSync(explorer, 0o755);
      rmSync(join(dir, "explorer-url.txt"), { force: true });
      return spawnSync(join(dir, "open-url"), [url], { env: { PATH: "/usr/bin:/bin" } }).status;
    };
    expect(open(0)).toBe(0);
    expect(readFileSync(join(dir, "ps-url.txt"), "utf8")).toBe(url);                       // the whole URL, untouched
    expect(readFileSync(join(dir, "ps-args.txt"), "utf8")).toBe("-NoProfile -NonInteractive -Command Start-Process -FilePath $env:AGEND_OPEN_URL\n");
    expect(readFileSync(join(dir, "ps-wslenv.txt"), "utf8")).toBe("AGEND_OPEN_URL");       // carried across to Windows
    expect(existsSync(join(dir, "explorer-url.txt"))).toBe(false);                          // explorer.exe not used
    expect(open(1)).toBe(0);                                                                // PowerShell failed: explorer.exe, still exit 0
    expect(readFileSync(join(dir, "explorer-url.txt"), "utf8")).toBe(url);
  });
});

/** Real watcher/stat/checksum, with an injected logical sleep and file-backed tmux/agy models.
 * Every tick is one production sleep, so CPU scheduling cannot change the interleaving. */
function agyWatch(setup: string, step: string, models = ':') {
  const dir = scratch("agend-1853agy-");
  const script = `set -e
cd '${dir}'
tick=0; alive=1; models_ok=0
printf '%s\\n' 'Visit https://www.google.com/device' > pane
function tmux() {
  printf '%s\\n' "$*" >> tmux.log
  case "$*" in
    *has-session*) [ "$alive" = 1 ] ;;
    *capture-pane*) cat pane ;;
    *send-keys*) printf '%s\\n' "$*" >> sent; printf '%s' "$tick" > sent-tick; alive=0 ;;
    *) return 1 ;;
  esac
}
function agy() { ${models}; [ "$models_ok" = 1 ]; }
function sleep() {
  [ "$1" = 1 ] || return 97
  tick=$((tick+1)); [ "$tick" -le 20 ] || return 98
  ${step}
}
${setup}
${agySh}
agend_agy_quit_when_logged_in '${dir}/token' agend-install agy-login
printf 'WATCHER-DONE tick=%s\\n' "$tick"
`;
  const file = join(dir, "watch.sh"); writeFileSync(file, script);
  const r = spawnSync("bash", [file], { encoding: "utf8", timeout: 10_000 });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain("WATCHER-DONE");
  const sent = existsSync(join(dir, "sent")) ? readFileSync(join(dir, "sent"), "utf8") : null;
  const log = readFileSync(join(dir, "tmux.log"), "utf8");
  expect(log).not.toMatch(/kill/);
  return { sent, tick: Number(r.stdout.match(/tick=(\d+)/)![1]),
    sentTick: sent ? Number(readFileSync(join(dir, "sent-tick"), "utf8")) : null };
}
const QUIT = "-L agend-install send-keys -t agy-login /quit Enter\n";

describe.skipIf(!bash)("the agy watcher (logical clock; real file fingerprint)", () => {
  it("sends /quit once — only after the token stopped changing, agy models works and the ready screen shows", () => {
    const r = agyWatch('', `case "$tick" in
1) printf '{"a":' > token ;;
2) printf '{"a":1}' > token ;;
4) models_ok=1 ;;
6) printf '? for shortcuts\\n' > pane ;;
esac`);
    expect(r.sent).toBe(QUIT); expect(r.sentTick).toBe(6);
  });
  it("a token still being written is never followed by /quit", () => {
    const r = agyWatch(`models_ok=1; printf '? for shortcuts\\n' > pane; printf x > token`,
      `if [ "$tick" -le 8 ]; then printf x >> token; else alive=0; fi`);
    expect(r.sent).toBeNull(); expect(r.tick).toBe(9);
  });
  it("a ready screen and a settled token are not enough while agy models fails (the credential isn't usable)", () => {
    const r = agyWatch(`printf '? for shortcuts\\n' > pane; printf token > token`, `[ "$tick" -lt 6 ] || alive=0`);
    expect(r.sent).toBeNull(); expect(r.tick).toBe(6);
  });
  it("no credential file yet: no /quit, however ready agy looks", () => {
    const r = agyWatch(`models_ok=1; printf '? for shortcuts\\n' > pane`, `[ "$tick" -lt 6 ] || alive=0`);
    expect(r.sent).toBeNull(); expect(r.tick).toBe(6);
  });
  it("an equal-length rewrite is a change: no /quit while the token is rewritten, one once it really stops (#2239 review)", () => {
    const r = agyWatch(`models_ok=1; printf '? for shortcuts\\n' > pane; printf tok-0000 > token`,
      `if [ "$tick" -le 6 ]; then printf 'tok-%04d' "$tick" > token; fi`);
    expect(r.sent).toBe(QUIT); expect(r.sentTick).toBe(9);
  });
  it("a rewrite that keeps the size and puts the old modification time back is still a change (the content checksum)", () => {
    const r = agyWatch(`models_ok=1; printf '? for shortcuts\\n' > pane; printf tok-0000 > token; touch -r token reference`,
      `if [ "$tick" -le 8 ]; then printf 'tok-%04d' "$tick" > token; touch -r reference token; else alive=0; fi`);
    expect(r.sent).toBeNull(); expect(r.tick).toBe(9);
  });
  it("a token rewritten while agy models was being waited on is checked again before /quit, and the count starts over (#2239 review)", () => {
    const r = agyWatch(`models_ok=1; rewritten=0; printf '? for shortcuts\\n' > pane; printf tok-0000 > token`, ':',
      `if [ "$rewritten" = 0 ]; then rewritten=1; printf tok-0001 > token; fi`);
    expect(r.sent).toBe(QUIT); expect(r.sentTick).toBe(6);
  });
  it("control: models waited on, the token unchanged — /quit right after the wait", () => {
    const r = agyWatch(`models_ok=1; printf '? for shortcuts\\n' > pane; printf tok-0000 > token`, ':');
    expect(r.sent).toBe(QUIT); expect(r.sentTick).toBe(3);
  });
  it("an atomic replace with the same content, or the token missing for a moment, starts the count again", () => {
    const r = agyWatch(`models_ok=1; printf '? for shortcuts\\n' > pane; printf same-token > token`,
      `if [ "$tick" -le 4 ]; then printf same-token > token.new; mv token.new token
elif [ "$tick" -le 10 ]; then
  if [ $((tick % 2)) = 1 ]; then rm -f token; else printf same-token > token; fi
else alive=0; fi`);
    expect(r.sent).toBeNull(); expect(r.tick).toBe(11);
  });
  it("agy ending by itself ends the watcher, with nothing sent", () => {
    const r = agyWatch('', 'alive=0');
    expect(r.sent).toBeNull(); expect(r.tick).toBe(1);
  });
});

describe.skipIf(!pwsh)("with pwsh: a skipped login keeps stage 3 open (#2239 review)", () => {
  it("skip one → stage 3 not marked; after an interruption the resumed run asks again; once signed in it is marked", async () => {
    const { out } = (await withHelpers(`$ProgressFile = Join-Path $env:TMPDIR 'progress'
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
Write-Output ("SECOND skipped=" + $second.Count + " attempts=" + $script:attempts + " stage3=" + (Stage-Done 3))`));
    expect(out).toContain("FIRST skipped=kiro attempts=1 stage3=False\n");
    expect(out).toContain("還沒登入：Kiro CLI。之後接續安裝時會再請你登入；已登入的會跳過。");
    expect(out).toContain("SECOND skipped=0 attempts=0 stage3=True\n");      // checked again, found signed in, marked
  });
  it("everything signed in: no attempt, marked at once", async () => {
    const { out } = (await withHelpers(`$ProgressFile = Join-Path $env:TMPDIR 'progress'
$UBUNTU_DISTRO = 'Ubuntu-24.04'
$ALL = @([PSCustomObject]@{ Id = 1; Key = 'kiro'; Name = 'Kiro CLI' })
$script:attempts = 0
function Invoke-WslStep { return 0 }
function Start-Process { $script:attempts++ }
function Test-WslLogin([string]$key) { return $true }
$r = @(Complete-LoginStage $ALL)
Write-Output ("skipped=" + $r.Count + " attempts=" + $script:attempts + " stage3=" + (Stage-Done 3))`));
    expect(out).toContain("skipped=0 attempts=0 stage3=True\n");
  });
});
