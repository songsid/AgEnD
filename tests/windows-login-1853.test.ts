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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const stage3 = code.slice(code.indexOf("Write-Step 3 $TOTAL"), code.indexOf("Write-Step 4 $TOTAL"));
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
  writeFileSync(join(bin, "agy"), `#!/bin/sh\n[ "$1" = models ] && [ -e '${dir}/agy-ok' ]\n`); chmodSync(join(bin, "agy"), 0o755);
  writeFileSync(join(dir, "alive"), "");
  writeFileSync(join(dir, "watch.sh"), `${agySh}\nagend_agy_quit_when_logged_in '${dir}/token' agend-install agy-login\necho WATCHER-DONE\n`);
  return new Promise<{ sent: string | null; log: string; done: boolean; ms: number }>((resolve) => {
    const started = Date.now();
    const child = spawn("bash", [join(dir, "watch.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    let out = "";
    child.stdout.on("data", (c: Buffer) => { out += c; });
    const timer = setTimeout(() => child.kill(), budgetMs);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ sent: existsSync(join(dir, "sent")) ? readFileSync(join(dir, "sent"), "utf8") : null, log: readFileSync(join(dir, "tmux.log"), "utf8"),
        done: out.includes("WATCHER-DONE"), ms: Date.now() - started });
    });
    void timeline(dir);
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
  it("agy ending by itself ends the watcher, with nothing sent", async () => {
    const r = await agyWatch(async (dir) => { await sleep(1500); rmSync(join(dir, "alive")); });
    expect(r.sent).toBeNull();
    expect(r.done).toBe(true);
    expect(r.ms).toBeLessThan(5000);
  });
});
