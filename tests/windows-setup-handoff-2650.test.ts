/**
 * #2650 items 1 and 10 (Sentinel's Windows installer review, M-2006).
 *
 * 1. Host confirmation reaches the Windows journey. The setup page's commit asks for a host confirmation; a Windows
 *    user has no host shell. The installer reads the confirmation id from the line `agend setup` already prints (every
 *    release since #1423), opens a separate window running `agend settings confirm <id>` — which shows the change and
 *    asks y/N itself — and prints the exact command to paste if no window appears. Nothing answers for the person: no
 *    `--yes`, nothing written to that window, and the page cannot confirm anything.
 * 10. Expiry and handover are recoverable: the setup URL is always printed, why the page closed is said, it reopens
 *    (or falls back to the console) with the backends already signed in left out, the page counts down to its TTL and
 *    says when it lost contact, and the dashboard can be opened again after the install finished.
 *
 * The installer's own functions run in pwsh (from its syntax tree; Start-Process, the browser and WSL stubbed); the
 * page's own script runs in a vm with an inert DOM; the real SetupHost runs on a scratch directory with no fleet.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SetupHost } from "../src/setup-host.js";
import { SETUP_FORM_HTML } from "../src/setup-form.js";
import { setupHttp } from "./helpers/setup-confirmation-1423.js";

const INSTALLER = join(import.meta.dirname, "..", "website", "public", "install-agend.ps1");
const text = readFileSync(INSTALLER, "utf8");
const code = text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const ID = "0123456789abcdef0123456789abcdef";
const requested = (fields: Record<string, unknown>) => `Settings confirmation requested: ${JSON.stringify(fields)}`;

const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function withHelpers(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-2650-")); dirs.push(dir);
  const file = join(dir, "t.ps1");
  writeFileSync(file, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
$script:OnWindows = $false
$UBUNTU_DISTRO = 'Ubuntu-24.04'
function Open-InBrowser([string]$url) { Add-Content -LiteralPath (Join-Path $env:TMPDIR 'opened.txt') -Value $url; return $true }
function Set-SetupClipboard([string]$text) { return $true }
# Start-Process, stubbed: what it was asked to start is written down, one line per call.
function Start-Process { param($FilePath, $ArgumentList) Add-Content -LiteralPath (Join-Path $env:TMPDIR 'started.txt') -Value ($FilePath + ' ' + ($ArgumentList -join ' ')) }
function Lines([string[]]$lines) { return { param($hook) foreach ($l in $lines) { & $hook $l }; return 0 }.GetNewClosure() }
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", timeout: 60_000, input: "", env: { ...process.env, TMPDIR: dir } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  const read = (f: string) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return null; } };
  return { out: r.stdout + r.stderr, started: read("started.txt") };
}
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

describe("item 1: host confirmation (static)", () => {
  it("nothing in the installer answers a confirmation: no --yes, no settings confirm in a watched or piped step", () => {
    expect(code).not.toMatch(/settings confirm[^\n]*--yes/);
    expect(code).not.toMatch(/settings (confirm|reject)[^\n]*(\||<<|RedirectStandardInput)/);
    // The window is opened without redirected input: the person types into it.
    const open = code.slice(code.indexOf("function Open-HostConfirmWindow"), code.indexOf("function Show-HostConfirm"));
    expect(open).toMatch(/Start-Process -FilePath 'wsl\.exe' -ArgumentList/);
    expect(open).not.toMatch(/NoNewWindow|Redirect/);
  });
  it("the reader matches the line SetupHost prints (pinned as a machine line)", () => {
    expect(readFileSync("src/setup-host.ts", "utf8")).toContain("this.log(`Settings confirmation ${event}: ${JSON.stringify(fields)}`)");
    expect(text).toContain("'Settings confirmation requested:\\s*(\\{.*\\})\\s*$'");
    expect(readFileSync("src/settings-confirmation.ts", "utf8")).toMatch(/this\.options\.audit\(event, \{ id: entry\.view\.id, section: entry\.view\.section, source: entry\.view\.source,/);
  });
});

describe.skipIf(!pwsh)("with pwsh: item 1, the confirmation handoff", { timeout: 90_000 }, () => {
  it("reads only a setup page's own request with a canonical id; the stop reason too", () => {
    const { out } = withHelpers(`
$cases = @(
  ${ps(requested({ id: ID, section: "quickstart", source: "setup_session", authority: { kind: "x" } }))},
  ${ps(requested({ id: ID, source: "web_session" }))},
  ${ps(requested({ id: ID.toUpperCase(), source: "setup_session" }))},
  ${ps(requested({ id: ID + "0", source: "setup_session" }))},
  ${ps(requested({ id: ID.slice(0, 31) + "; rm -rf /", source: "setup_session" }))},
  'Settings confirmation requested: {not json',
  ${ps(`Settings confirmation confirmed: ${JSON.stringify({ id: ID, source: "setup_session" })}`)},
  'Setup host stopped (ttl). Run \`agend setup\` again to reopen it.',
  'Setup host stopped (idle). Run \`agend setup\` again to reopen it.'
)
$i = 0
foreach ($c in $cases) { $p = Get-SetupPrompt $c; Write-Output ("CASE$i=" + $(if ($null -eq $p) { 'null' } elseif ($p.Confirm) { 'confirm:' + $p.Confirm } else { 'stopped:' + $p.Stopped })); $i++ }`);
    expect(out).toContain(`CASE0=confirm:${ID}\n`);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(out).toContain(`CASE${n}=null\n`);
    expect(out).toContain("CASE7=stopped:ttl\n");
    expect(out).toContain("CASE8=stopped:idle\n");
  });
  it("the request opens one confirmation window per id (wsl.exe, interactive, no --yes) and prints the command to paste", () => {
    const line = requested({ id: ID, section: "quickstart", source: "setup_session" });
    const { out, started } = withHelpers(`$r = Invoke-BrowserSetup (Lines @('  Setup page: http://127.0.0.1:19280/s/a/', '  Setup code: AAAA-BBBB', ${ps(line)}, ${ps(line)}))
Write-Output ("SHOWN=" + $r.Shown + " DONE=" + $r.Done)`);
    const calls = started!.trim().split("\n");
    expect(calls).toHaveLength(1);                                                  // the same id twice: one window
    expect(calls[0]).toMatch(/^wsl\.exe -d Ubuntu-24\.04 -u root -- bash -lc "[^"]*agend settings confirm 0123456789abcdef0123456789abcdef; echo; read -r -p 'Press Enter to close this window\. ' _"$/);
    expect(calls[0]).not.toContain("--yes");
    expect(out).toContain("已經另外打開一個「AgEnD setup confirmation」視窗：看過裡面列出的內容，沒問題就輸入 y 再按 Enter。");
    expect(out).toContain(`wsl -d Ubuntu-24.04 -u root -- bash -lc 'export PATH=/root/.local/bin:$PATH; source /root/.nvm/nvm.sh 2>/dev/null; agend settings confirm ${ID}'`);
    expect(out).toContain("SHOWN=True DONE=False");
  });
  it("no window could be opened: said so, and the command to paste is still there", () => {
    const { out } = withHelpers(`function Start-Process { throw 'blocked' }
$null = Invoke-BrowserSetup (Lines @(${ps(requested({ id: ID, source: "setup_session" }))}))`);
    expect(out).toContain("沒辦法自動打開確認視窗。");
    expect(out).toContain(`agend settings confirm ${ID}'`);
  });
  it("a page cannot flood the desktop: at most five windows per setup page", () => {
    const ids = Array.from({ length: 8 }, (_, n) => n.toString(16).repeat(32));
    const { started } = withHelpers(`$null = Invoke-BrowserSetup (Lines @(${ids.map(id => ps(requested({ id, source: "setup_session" }))).join(",")}))`);
    expect(started!.trim().split("\n")).toHaveLength(5);
  });
  it("Get-HostConfirmCommand refuses anything but a canonical id", () => {
    const { out } = withHelpers(`foreach ($id in @('${ID}', 'abc', '${ID}; calc', '${ID.toUpperCase()}')) { try { Write-Output ("OK=" + (Get-HostConfirmCommand $id)) } catch { Write-Output "REFUSED" } }`);
    expect(out.match(/^OK=/gm)).toHaveLength(1);
    expect(out.match(/^REFUSED$/gm)).toHaveLength(3);
  });
  it("an older AgEnD (no request line, or none yet): the page alone, nothing opened", () => {
    const { started } = withHelpers(`$null = Invoke-BrowserSetup (Lines @('  Setup page: http://127.0.0.1:19280/s/a/', '  Setup code: AAAA-BBBB', 'Setup complete — starting AgEnD.'))`);
    expect(started).toBeNull();
  });
});

/** The real SetupHost: the line the installer reads is printed when the page asks for a confirmation. */
describe("item 1 against the real SetupHost (no fleet)", () => {
  const hosts: { host: SetupHost; dir: string }[] = [];
  afterEach(async () => { for (const { host, dir } of hosts.splice(0)) { await host.shutdown(false, "test cleanup"); rmSync(dir, { recursive: true, force: true }); } });
  async function harness(now?: () => number) {
    const dir = mkdtempSync(join(tmpdir(), "agend-2650-host-")), logs: string[] = [];
    const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet: vi.fn(), log: m => logs.push(m), ...(now ? { now } : {}) });
    hosts.push({ host, dir });
    const { port, path, code } = await host.start();
    const signed = await setupHttp(port, path + "open", "POST", { code });
    return { port, path, logs, cookie: String(signed.headers["set-cookie"]).split(";")[0]! };
  }
  it("a commit prints `Settings confirmation requested: {id, source: setup_session}`, and the installer reads that very line", async () => {
    const h = await harness();
    const pending = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST",
      { web_only: true, backend: "claude-code", working_directory: "/home/demo/project", instance_name: "agent-1" }, h.cookie);
    expect(pending.status).toBe(202);
    const id = pending.body.pending_change.id as string;
    const line = h.logs.find(l => l.startsWith("Settings confirmation requested: "))!;
    expect(JSON.parse(line.slice("Settings confirmation requested: ".length))).toMatchObject({ id, source: "setup_session" });
    if (pwsh) expect(withHelpers(`Write-Output ("ID=" + (Get-SetupPrompt ${ps(line)}).Confirm)`).out).toContain(`ID=${id}\n`);
  });
  it("item 10: setup/status says how long the page has left, from the host's own clock", async () => {
    let t = 1_000_000;
    const h = await harness(() => t);
    expect((await setupHttp(h.port, h.path + "setup/status", "GET", undefined, h.cookie)).body).toMatchObject({ ttl_ms: 15 * 60_000, remaining_ms: 15 * 60_000 });
    t += 4 * 60_000 + 30_000;
    expect((await setupHttp(h.port, h.path + "setup/status", "GET", undefined, h.cookie)).body.remaining_ms).toBe(10 * 60_000 + 30_000);
  });
});

describe.skipIf(!pwsh)("with pwsh: item 10, reopening and the dashboard", { timeout: 90_000 }, () => {
  /** Stage 5's setup loop with WSL steps, logins and answers stubbed; the setup commands it ran are written down. */
  function stage5(setups: string[][], answers: string[], loggedInAfterFirst: string[] = []) {
    return withHelpers(`foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -match '^\\$AGEND_ENV' }, $false)) { . ([scriptblock]::Create($a.Extent.Text)) }
$script:setups = [System.Collections.ArrayList]::new()
${setups.map(ls => "[void]$script:setups.Add([string[]]@(" + [...ls.map(ps), "''"].join(",") + "))").join("\n")}
$script:answers = @(${answers.map(ps).join(",") || "@()"}); $script:log = @(); $script:runs = 0
$script:late = @(${loggedInAfterFirst.map(ps).join(",") || "@()"})
function Test-WslLogin([string]$key) { return ($script:runs -gt 0 -and $script:late -contains $key) }
function Invoke-WslStep { param($Label, $Usually, $Script, $UpperMinutes, $OnLine)
  if ($Script -match '(agend setup[^\\n]*)$') { $script:log += ('run:' + $Matches[1]); $script:runs++; $lines = $script:setups[0]; $script:setups.RemoveAt(0); foreach ($l in $lines) { if ($l -and $OnLine) { & $OnLine $l } }; return 0 }
  $script:log += 'service'; return 0 }
function Invoke-ConsoleQuickstart { $script:log += 'console'; return 0 }
function Read-Host { param($p) $a = $script:answers[0]; $script:answers = @($script:answers | Select-Object -Skip 1); $script:log += "ask:$a"; return $a }
$backends = @([PSCustomObject]@{ Key = 'kiro' }, [PSCustomObject]@{ Key = 'codex' })
$ok = Invoke-SetupAndService -BackendSignins 'kiro-cli,codex' -Backends $backends
Write-Output ("RESULT=" + $ok + " LOG=" + ($script:log -join '|'))`);
  }
  const PAGE = ["  Setup page: http://127.0.0.1:19280/s/a/", "  Setup code: AAAA-BBBB"];
  it("closed on its TTL: says so; Enter reopens it asking only for the backends still signed out", () => {
    const { out } = stage5([[...PAGE, "Setup host stopped (ttl). Run `agend setup` again to reopen it."], [...PAGE, "Setup complete — starting AgEnD."]], [""], ["kiro"]);
    expect(out).toContain("設定頁開滿 15 分鐘，自動關閉了。");
    expect(out).toContain("RESULT=True LOG=run:agend setup --backend-signins kiro-cli,codex|ask:|run:agend setup --backend-signins codex|service\n");
  });
  it("every backend signed in meanwhile: the reopened page asks for none", () => {
    const { out } = stage5([[...PAGE, "Setup host stopped (idle). Run `agend setup` again to reopen it."], [...PAGE, "Setup complete — starting AgEnD."]], [""], ["kiro", "codex"]);
    expect(out).toContain("設定頁太久沒有操作，自動關閉了。");
    expect(out).toContain("選的後端都已經登入，新的設定頁不會再要求登入。");
    expect(out).toContain("|run:agend setup|service\n");
  });
  it("closed: c sets up in this window instead; n ends with the progress kept", () => {
    expect(stage5([[...PAGE, "Setup host stopped (lockout). Run `agend setup` again to reopen it."]], ["c"]).out)
      .toContain("RESULT=True LOG=run:agend setup --backend-signins kiro-cli,codex|ask:c|console|service\n");
    const stop = stage5([[...PAGE]], ["n"]).out;
    expect(stop).toContain("設定頁關閉了，設定還沒完成。");                        // no reason printed: the plain sentence
    expect(stop).toContain("RESULT=False LOG=run:agend setup --backend-signins kiro-cli,codex|ask:n\n");
  });
});

describe("item 10: the dashboard after the install (static)", () => {
  it("rerunning an installed machine offers the dashboard (default yes) before it ends", () => {
    const fast = code.slice(code.indexOf("$existing = Find-ExistingAgend"), code.indexOf("Read-Host \"按 Enter 結束\"; exit 0"));
    expect(fast).toMatch(/\$ans = Read-Host "  要現在打開 AgEnD 網頁儀表板嗎？\(Y\/n\)"\n\s+if \(\$ans -notmatch '\^\\s\*\[nN\]'\) \{ \$null = Invoke-OpenDashboard \$existing\.Distro \$existing\.User \}/);
  });
});

/** The page's own script with an inert DOM, a manual clock and timer queue. */
function page(opts: { remaining?: number; pending?: string; failPending?: boolean; holdList?: boolean; holdCommit?: boolean } = {}) {
  const elements = new Map<string, any>();
  const element = (tag = "input"): any => ({ tag, dataset: {}, children: [], disabled: false, hidden: false, value: "", textContent: "", className: "", listeners: new Map(),
    addEventListener(event: string, cb: any) { this.listeners.set(event, cb); }, append(...c: any[]) { this.children.push(...c); }, set innerHTML(_v: string) { this.children = []; } });
  for (const m of SETUP_FORM_HTML.matchAll(/<(input|select|button|div|span|pre)[^>]*\bid="([^"]+)"/g)) { const e: any = element(m[1]); e.id = m[2]; elements.set(e.id, e); }
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const state = { failPending: opts.failPending ?? false };
  // Held answers (#2653 review): released by the test, after the page may have closed.
  const held: Array<() => void> = [];
  const hold = () => new Promise<void>(resolve => held.push(resolve));
  const fetch = vi.fn(async (path: string) => {
    if (path.startsWith("api/settings/pending/") && state.failPending) throw new Error("offline");
    if (path === "api/settings/pending" && opts.holdList) await hold();
    if (path === "api/settings/quickstart/commit" && opts.holdCommit) { await hold(); return { ok: true, status: 202, json: async () => ({ result: "pending_confirmation", pending_change: { id: ID } }) }; }
    let body: any = {};
    if (path === "api/settings/quickstart/environment") body = { backends: ["kiro-cli"] };
    if (path === "api/settings/pending") body = opts.pending ? [{ id: opts.pending, state: "pending" }] : [];
    if (path.startsWith("api/settings/pending/")) body = { state: "pending" };
    if (path === "setup/status") body = { finish_ready: false, ...(opts.remaining === undefined ? {} : { remaining_ms: opts.remaining }) };
    return { ok: true, status: 200, json: async () => body };
  });
  const context = createContext({ fetch, Date, performance: { now: () => now },
    document: { getElementById: (id: string) => elements.get(id), createElement: element,
      querySelectorAll: () => [...elements.values()].filter(e => ["input", "select", "button"].includes(e.tag) && e.id !== "finish") },
    crypto: { randomUUID: () => "k" }, setTimeout: (fn: () => void, ms = 0) => { timers.push({ at: now + ms, fn }); } });
  runInContext(SETUP_FORM_HTML.slice(SETUP_FORM_HTML.indexOf("<script>") + 8, SETUP_FORM_HTML.indexOf("</script>")), context);
  const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift(); now = next.at; next.fn(); await flush();
    }
    now = end; await flush();
  };
  const release = async () => { for (const r of held.splice(0)) r(); await flush(); };
  return { $: (id: string) => elements.get(id), flush, advance, fetch, state, release };
}

describe("item 10 and item 1 on the setup page", () => {
  it("counts down to the host's remaining time, warns in the last three minutes, then says it closed and how to reopen", async () => {
    const p = page({ remaining: 5 * 60_000 }); await p.flush();
    expect(p.$("ttlMsg").textContent).toMatch(/^This page closes in 5:00 at the latest/);
    expect(p.$("ttlMsg").className).toBe("sub msg");
    await p.advance(2 * 60_000 + 30_000);
    expect(p.$("ttlMsg").textContent).toMatch(/^This page closes in 2:30 at the latest.* Finish soon\. If it closes first: Reopen it where you started setup: in the Windows installer, press Enter in its window/);
    expect(p.$("ttlMsg").className).toBe("sub msg err");
    await p.advance(3 * 60_000);
    expect(p.$("ttlMsg").textContent).toBe("This setup page has closed.");
    expect(p.$("finishMsg").textContent).toMatch(/^This setup page has closed\. Reopen it where you started setup.* Backends you already signed in stay signed in\.$/);
    expect(p.$("finish").disabled).toBe(true);
    expect(p.$("token").disabled).toBe(true);
  });
  it("a host without remaining_ms (older status): no countdown, nothing breaks", async () => {
    const p = page(); await p.flush(); await p.advance(60 * 60_000);
    expect(p.$("ttlMsg").textContent).toBe("");
  });
  it("a pending confirmation: the page says a person at the computer approves it, and never confirms itself", async () => {
    const p = page({ pending: ID, remaining: 10 * 60_000 }); await p.flush();
    expect(p.$("finishMsg").textContent).toBe(`Approve this on the computer running AgEnD. The Windows installer opens a confirmation window for it, and shows a command to paste if no window appears. Otherwise run there: agend settings confirm ${ID}`);
    await p.advance(30_000);
    const writes = p.fetch.mock.calls.filter(([, o]: any[]) => o?.method && o.method !== "GET");
    expect(writes).toEqual([]);                                                     // only reads: no confirm path exists here
  });
  it("lost contact while waiting: said after five misses, still retrying, and back to the request once it answers", async () => {
    const p = page({ pending: ID, remaining: 10 * 60_000, failPending: true }); await p.flush();
    await p.advance(4_500);
    expect(p.$("finishMsg").textContent).toMatch(/^Approve this/);
    await p.advance(1_000);
    expect(p.$("finishMsg").textContent).toMatch(/^Lost contact with the setup page; still trying\. If this stays, the page has closed\. Reopen it/);
    p.state.failPending = false; await p.advance(3_000);
    expect(p.$("finishMsg").textContent).toMatch(/^Approve this on the computer running AgEnD\./);
  });
  it("an answer that arrives after the page closed neither reopens it nor starts polling (pending list, commit)", async () => {
    const late = page({ pending: ID, remaining: 2_000, holdList: true }); await late.flush();
    await late.advance(3_000);
    expect(late.$("finishMsg").textContent).toMatch(/^This setup page has closed\./);
    await late.release();
    const after = late.fetch.mock.calls.length;
    await late.advance(5_000);
    expect(late.fetch.mock.calls.length).toBe(after);                              // no poll started
    expect(late.$("finishMsg").textContent).toMatch(/^This setup page has closed\./);

    const commit = page({ remaining: 60_000, holdCommit: true }); await commit.flush();
    commit.$("pickWeb").onclick(); commit.$("dir").value = "/home/demo/app"; await commit.flush();
    commit.$("finish").disabled = false; void commit.$("finish").onclick(); await commit.flush();
    expect(commit.fetch.mock.calls.some(([path]: any[]) => path === "api/settings/quickstart/commit")).toBe(true);
    await commit.advance(61_000);
    await commit.release();
    const calls = commit.fetch.mock.calls.length;
    await commit.advance(5_000);
    expect(commit.fetch.mock.calls.length).toBe(calls);
    expect(commit.$("finishMsg").textContent).toMatch(/^This setup page has closed\./);
    expect(commit.$("finish").disabled).toBe(true);
  });
  it("the TTL passing while waiting stops the polling", async () => {
    const p = page({ pending: ID, remaining: 20_000 }); await p.flush();
    await p.advance(25_000);
    const before = p.fetch.mock.calls.length;
    await p.advance(30_000);
    expect(p.fetch.mock.calls.length).toBe(before);
    expect(p.$("finishMsg").textContent).toMatch(/^This setup page has closed\./);
  });
});
