/**
 * Some company networks block every *.github.io at the TLS handshake while github.com and raw.githubusercontent.com work.
 * The installer then falls back to the same DEPLOYED files on GitHub's raw host, at the tag `installer-live`, which only
 * the website deploy moves — after Pages deployed that commit from main, and only forward — so it never serves
 * undeployed main. Covered here, with github.io simulated as unreachable (a refused port) or answering a block page:
 *   - the tag script (the deploy job's step) against a local bare origin: created, moved forward, never back;
 *   - install.ps1 (the one-liner): github.io first when it works; the fallback when it fails or sends something else;
 *   - install-agend.ps1's install.sh fetch inside WSL (its bash, for real, with a fake curl);
 *   - the resume after a restart (the RunOnce script, for real in pwsh) — it survives a block;
 *   - the network check: either source is enough, and both are named.
 */
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BOOTSTRAP = join(ROOT, "website", "public", "install.ps1");
const INSTALLER = join(ROOT, "website", "public", "install-agend.ps1");
const WORKFLOW = join(ROOT, ".github", "workflows", "deploy-website.yml");
const MARK = join(ROOT, "scripts", "ci", "mark-installer-live.sh");
const RAW = "https://raw.githubusercontent.com/songsid/AgEnD/installer-live/website/public";
const PAGES = "https://songsid.github.io/AgEnD";
const code = (f: string) => readFileSync(f, "utf8").split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
const pwsh = spawnSync("pwsh", ["-NoProfile", "-c", "1"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function scratch(): string { const d = mkdtempSync(join(tmpdir(), "agend-ghio-")); dirs.push(d); return d; }
const DEAD = "http://127.0.0.1:1";                                     // refused: github.io blocked

describe("installer-live: the raw ref only ever names what Pages deployed", () => {
  it("the deploy workflow admits only main, forward, BEFORE Pages changes; then moves the tag to that commit, with the only write grant", () => {
    const wf = readFileSync(WORKFLOW, "utf8");
    const admit = wf.slice(wf.indexOf("\n  admit:"), wf.indexOf("\n  build:"));
    expect(admit).toContain('[ "$REF" = refs/heads/main ] ||');
    expect(admit).toContain('run: bash scripts/ci/mark-installer-live.sh --check "$DEPLOYED"');
    expect(admit).toMatch(/permissions:\n\s+contents: read/);
    expect(wf).toMatch(/\n  build:\n    needs: admit\n/);
    expect(wf).toMatch(/\n  deploy:\n    needs: build\n/);
    expect(wf).toContain("needs: [admit, build, deploy, mark-live]");             // a failed tag move is reported
    const job = wf.slice(wf.indexOf("\n  mark-live:"), wf.indexOf("\n  notify:"));
    expect(job).toMatch(/needs: deploy\n/);
    expect(job).toMatch(/permissions:\n\s+contents: write/);
    expect(job).toContain("DEPLOYED: ${{ github.sha }}");
    expect(job).toContain('run: bash scripts/ci/mark-installer-live.sh "$DEPLOYED"');
    expect(job).toContain("fetch-depth: 0");
    expect(wf.match(/contents: write/g)).toHaveLength(1);
    // Nothing else in the repo's workflows writes that tag.
    for (const f of spawnSync("git", ["ls-files", ".github/workflows"], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n")) {
      if (!f.endsWith("deploy-website.yml")) expect(readFileSync(join(ROOT, f), "utf8"), f).not.toContain("installer-live");
    }
  });

  /** A local origin with main c1→c2→c3, and a working clone of it. */
  function repo() {
    const dir = scratch(), origin = join(dir, "origin.git"), work = join(dir, "work");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
    const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8", env });
    git(dir, "init", "-q", "--bare", origin); git(dir, "init", "-q", "-b", "main", work); git(work, "remote", "add", "origin", origin);
    const shas: string[] = [];
    for (const n of [1, 2, 3]) { writeFileSync(join(work, "f"), String(n)); git(work, "add", "f"); git(work, "commit", "-qm", `c${n}`); shas.push(git(work, "rev-parse", "HEAD").stdout.trim()); }
    git(work, "push", "-q", "origin", "main");
    const mark = (args: string[], extra: Record<string, string> = {}) => spawnSync("bash", [MARK, ...args], { cwd: work, encoding: "utf8", env: { ...env, ...extra } });
    const live = () => git(origin, "rev-parse", "--verify", "-q", "refs/tags/installer-live^{commit}").stdout.trim();
    return { work, origin, git, shas, mark, live };
  }

  it("the tag script: created on the first deploy, moved forward, never back, idempotent; refuses a non-SHA", () => {
    const { work, git, shas, mark, live } = repo();
    let r = mark([shas[1]]); expect(r.status, r.stderr).toBe(0); expect(live()).toBe(shas[1]);
    r = mark([shas[2]]); expect(r.status, r.stderr).toBe(0); expect(live()).toBe(shas[2]);
    r = mark([shas[0]]); expect(r.status).toBe(1); expect(r.stderr).toContain("refusing to move installer-live"); expect(live()).toBe(shas[2]);
    r = mark([shas[2]]); expect(r.status).toBe(0); expect(r.stdout).toContain("already at");
    // A side branch that does not contain the current tag is refused too.
    git(work, "checkout", "-q", "-b", "side", shas[0]); writeFileSync(join(work, "g"), "x"); git(work, "add", "g"); git(work, "commit", "-qm", "side");
    r = mark([git(work, "rev-parse", "HEAD").stdout.trim()]); expect(r.status).toBe(1); expect(live()).toBe(shas[2]);
    for (const bad of ["main", shas[2].slice(0, 12), `${shas[2]};x`, ""]) { r = mark([bad]); expect(r.status, bad).toBe(2); }
    expect(live()).toBe(shas[2]);
  });

  it("admission (--check, before Pages): forward or first passes and writes nothing; an older commit is refused", () => {
    const { shas, mark, live } = repo();
    let r = mark(["--check", shas[0]]); expect(r.status, r.stderr).toBe(0); expect(live()).toBe("");     // no tag yet
    expect(mark([shas[1]]).status).toBe(0);
    r = mark(["--check", shas[2]]); expect(r.status, r.stderr).toBe(0); expect(live()).toBe(shas[1]);    // nothing written
    r = mark(["--check", shas[0]]); expect(r.status).toBe(1); expect(live()).toBe(shas[1]);
  });

  it("atomic: a writer that moves the tag between the read and the push wins; this push fails instead of overwriting it", () => {
    for (const start of [null, 0] as const) {                                                            // absent, then present
      const { origin, shas, mark, live } = repo();
      if (start !== null) expect(mark([shas[start]]).status).toBe(0);
      // B read the tag, then C deployed and moved it (to c3), then B pushes c2.
      const racer = `git --git-dir='${origin}' update-ref refs/tags/installer-live ${shas[2]}`;
      const r = mark([shas[1]], { MARK_INSTALLER_LIVE_BEFORE_PUSH: racer });
      expect(r.status, String(start)).not.toBe(0);
      expect(live(), String(start)).toBe(shas[2]);
    }
  });

  it("fails closed when origin's tag cannot be read (never treated as absent)", () => {
    const { shas, mark, live } = repo();
    expect(mark([shas[2]]).status).toBe(0);
    // Reads fail (upload-pack), pushes would still work: nothing may be pushed.
    const unreadable = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.uploadpack", GIT_CONFIG_VALUE_0: "/bin/false" };
    for (const args of [[shas[1]], ["--check", shas[1]]]) {
      const r = mark(args, unreadable);
      expect(r.status, args.join(" ")).toBe(3);
      expect(r.stderr).toContain("could not read origin's installer-live");
    }
    expect(live()).toBe(shas[2]);
  });

  it("the install.sh check names install.sh's real first two lines (the copies stay in sync)", () => {
    for (const f of ["install.sh", "website/public/install.sh"]) {
      expect(readFileSync(join(ROOT, f), "utf8").split("\n").slice(0, 2), f).toEqual(["#!/usr/bin/env bash", "# AgEnD Bootstrap Installer"]);
    }
    expect(code(INSTALLER)).toContain("head -n 1 $f | grep -qx ''#!/usr/bin/env bash'' && sed -n 2p $f | grep -qx ''# AgEnD Bootstrap Installer''");
  });

  it("every fallback URL in the scripts is that tag, never a branch", () => {
    for (const f of [BOOTSTRAP, INSTALLER]) {
      const raws = code(f).match(/https:\/\/raw\.githubusercontent\.com\/songsid\/AgEnD\/[^'"\s/]+/g) ?? [];
      expect(raws.length, f).toBeGreaterThan(0);
      for (const u of raws) expect(u, f).toBe("https://raw.githubusercontent.com/songsid/AgEnD/installer-live");
    }
    // github.io stays first.
    expect(code(BOOTSTRAP)).toContain(`$bases = @('${PAGES}', '${RAW}')`);
    expect(code(INSTALLER)).toContain(`function Get-InstallSources { return @('${PAGES}', '${RAW}') }`);
  });

  it("the install pages offer the raw one-liners, EN and zh-TW", () => {
    for (const f of ["website/src/pages/install-windows.astro", "website/src/pages/zh-tw/install-windows.astro"]) {
      const page = readFileSync(join(ROOT, f), "utf8");
      expect(page, f).toContain(`const oneLinerRaw = 'powershell -ExecutionPolicy ByPass -c "irm ${RAW}/install.ps1 | iex"';`);
      expect(page, f).toContain(`const unixLineRaw = 'curl -fsSL ${RAW}/install.sh | bash';`);
      expect(page, f).toContain("{oneLinerRaw}");
      expect(page, f).toContain("{unixLineRaw}");
    }
  });
});

/** The installer's functions and script-level tables, then the body, run as a script file. */
function ps(body: string, env: Record<string, string> = {}): string {
  const dir = scratch(), script = join(dir, "t.ps1");
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALLER}', [ref]$t, [ref]$e)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
foreach ($a in $ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -match '^\\$(NET_|RESUME_)' }) { . ([scriptblock]::Create($a.Extent.Text)) }
function Write-InstallLog { param($m) }
${body}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", script], { encoding: "utf8", timeout: 90_000, env: { ...process.env, TMPDIR: dir, ...env } });
  if (r.error || r.signal || r.status !== 0) throw new Error(`pwsh ended ${r.error ?? r.signal ?? r.status}:\n${r.stdout}${r.stderr}`);
  return r.stdout + r.stderr;
}

describe("install.sh inside WSL: github.io first, then the deployed raw copy (its bash, run for real)", () => {
  // A fake curl: github.io → "blocked" (35, the TLS handshake), an html.* host → a 200 block page, a raw host → the script.
  function fakeCurl(dir: string, pagesBehaviour: "blocked" | "ok" | "page" | "urlpage", rawBehaviour: "ok" | "blocked" = "ok") {
    const bin = join(dir, "bin"); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "curl"), `#!/bin/bash
out=; url=; while [ $# -gt 0 ]; do case $1 in -o) out=$2; shift;; http*) url=$1;; esac; shift; done
echo "$url" >> ${dir}/calls
script='#!/usr/bin/env bash
# AgEnD Bootstrap Installer
echo "RAN from=$SRC version=\${AGEND_VERSION:-none}"'
case $url in
  ${PAGES}/*) case ${pagesBehaviour} in blocked) exit 35;; page) printf '<html>Blocked by policy</html>\\n' > "$out"; exit 0;; urlpage) printf '<html><body>Blocked by policy. AgEnD URL: %s</body></html>\\n' "$url" > "$out"; exit 0;; ok) printf '%s\\n' "\${script/\\$SRC/pages}" > "$out"; exit 0;; esac;;
  ${RAW}/*) case ${rawBehaviour} in blocked) exit 35;; ok) printf '%s\\n' "\${script/\\$SRC/raw}" > "$out"; exit 0;; esac;;
esac
exit 6
`);
    chmodSync(join(bin, "curl"), 0o755);
    return bin;
  }
  const scriptFor = (version: string) => ps(`Write-Output (Get-AgendInstallCommand '${version}')`).trim();
  const runIt = (script: string, bin: string) => spawnSync("bash", ["-c", `set -e\n${script}\necho AFTER`], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });

  it.skipIf(!pwsh)("github.io works: it alone is fetched and run", () => {
    const dir = scratch(), r = runIt(scriptFor("beta"), fakeCurl(dir, "ok"));
    expect(r.stdout).toContain("RAN from=pages version=beta");
    expect(r.stdout).toContain("AFTER");
    expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n")).toEqual([`${PAGES}/install.sh`]);
  });
  it.skipIf(!pwsh)("github.io blocked, or answering a block page: the raw copy is run, and only that", () => {
    // urlpage: a block page that echoes the requested URL — it contains "AgEnD", and still is not the script (Prism).
    for (const pages of ["blocked", "page", "urlpage"] as const) {
      const dir = scratch(), r = runIt(scriptFor(""), fakeCurl(dir, pages));
      expect(r.stdout, pages).toContain("RAN from=raw version=none");
      expect(r.stdout, pages).not.toContain("Blocked by policy");
      expect(r.stderr, pages).toContain(`could not fetch ${PAGES}/install.sh, trying the next source`);
      expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n"), pages).toEqual([`${PAGES}/install.sh`, `${RAW}/install.sh`]);
    }
  });
  it.skipIf(!pwsh)("both unreachable: nothing runs, the step fails (set -e stops what follows), both named", () => {
    const dir = scratch(), r = runIt(scriptFor(""), fakeCurl(dir, "blocked", "blocked"));
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("RAN");
    expect(r.stdout).not.toContain("AFTER");
    expect(r.stderr).toContain("could not be fetched from songsid.github.io or raw.githubusercontent.com");
  });
  it.skipIf(!pwsh)("the repair path uses the same fetch", () => {
    expect(code(INSTALLER)).toContain("$cmd = Get-WslAgendCommand (Get-AgendInstallShScript $pin)");
    expect(code(INSTALLER)).not.toMatch(/curl[^\n]*songsid\.github\.io[^\n]*\| /);
  });
});

describe.skipIf(!pwsh)("with pwsh: the one-liner and the resume over a blocked github.io", { timeout: 120_000 }, () => {
  const stub = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([
    "param([switch]$Force, [string]$InstallVersion)", "function Check-Admin { $true }",
    "@{ version = $InstallVersion } | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $env:STUB_OUT", "exit 0", "#" + "x".repeat(1200), "",
  ].join("\n"), "utf8")]);
  // What the resume fetches: a stand-in install.ps1 that records the version it was given.
  const bootStub = "function Invoke-InstallDownload([string]$Uri) { }\nSet-Content -LiteralPath $env:RESUME_OUT -Value (\"RESUMED version=\" + $env:AGEND_VERSION)\n";
  let server: Server, port = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url?.startsWith("/good/install-agend.ps1")) { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(stub); return; }
      if (req.url?.startsWith("/good/install.ps1")) { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(bootStub); return; }
      if (req.url?.startsWith("/html/")) { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html><body>Blocked by policy</body></html>".repeat(60)); return; }
      res.writeHead(404); res.end("not found");
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server?.close(); });
  const run = (args: string[], env: Record<string, string>, input = "") => new Promise<{ stdout: string; stderr: string }>(resolve => {
    const child = execFile("pwsh", args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } }, (_e, stdout, stderr) => resolve({ stdout, stderr }));
    child.stdin?.end(input);
  });
  async function oneLiner(first: string, fallback: string | null) {
    const dir = scratch(), out = join(dir, "stub.json");
    hits.length = 0;
    const r = await run(["-NoProfile", "-ExecutionPolicy", "ByPass", "-c", `irm http://127.0.0.1:${port}/good/install.ps1 -ErrorAction SilentlyContinue | Out-Null; Get-Content -Raw '${BOOTSTRAP}' | iex; Write-Output "SESSION-GOES-ON"`],
      { AGEND_INSTALL_BASE: first, ...(fallback ? { AGEND_INSTALL_FALLBACK_BASE: fallback } : {}), AGEND_INSTALL_SHELL: "pwsh", STUB_OUT: out, TMPDIR: dir, AGEND_VERSION: "beta" });
    return { r, ran: existsSync(out) ? JSON.parse(readFileSync(out, "utf8").replace(/^﻿/, "")) : null, hits: hits.filter(h => h.endsWith("install-agend.ps1")) };
  }

  it("install.ps1: github.io first when it works — the fallback is never asked", async () => {
    const { ran, hits: h } = await oneLiner(`http://127.0.0.1:${port}/good`, `http://127.0.0.1:${port}/html`);
    expect(ran).toMatchObject({ version: "beta" });
    expect(h).toEqual(["/good/install-agend.ps1"]);
  });
  it("install.ps1: github.io refused, or answering a block page: the fallback's installer runs", async () => {
    let { r, ran, hits: h } = await oneLiner(DEAD, `http://127.0.0.1:${port}/good`);
    expect(ran).toMatchObject({ version: "beta" });
    expect(r.stdout).toContain(`downloading the installer from ${DEAD}/install-agend.ps1`);
    expect(r.stdout).toContain("that download failed");
    expect(h).toEqual(["/good/install-agend.ps1"]);
    ({ r, ran, hits: h } = await oneLiner(`http://127.0.0.1:${port}/html`, `http://127.0.0.1:${port}/good`));
    expect(ran).toMatchObject({ version: "beta" });
    expect(r.stdout).toContain("is not the AgEnD installer");
    expect(h).toEqual(["/html/install-agend.ps1", "/good/install-agend.ps1"]);
  });
  it("install.ps1: both unreachable — nothing runs, both hosts named, the session goes on", async () => {
    const { r, ran } = await oneLiner(DEAD, DEAD);
    expect(ran).toBeNull();
    expect(r.stdout + r.stderr).toContain("Neither songsid.github.io nor raw.githubusercontent.com could be reached");
    expect(r.stdout).toContain("SESSION-GOES-ON");
  });

  /** The resume script as Register-ResumeAtLogon writes it, for these sources, then run as RunOnce would. */
  async function resume(sources: string[], version: string) {
    const dir = scratch(), file = join(dir, "install-resume.ps1"), out = join(dir, "resumed.txt");
    ps(`[IO.File]::WriteAllText('${file}', (Get-InstallResumeScript '${version}' @(${sources.map(s => `'${s}'`).join(", ")})), (New-Object Text.UTF8Encoding $false))`);
    hits.length = 0;
    const r = await run(["-NoProfile", "-ExecutionPolicy", "ByPass", "-File", file], { RESUME_OUT: out }, "\n");
    return { r, file, resumed: existsSync(out) ? readFileSync(out, "utf8").trim() : null, hits: hits.filter(h => h.endsWith("install.ps1")) };
  }
  it("resume after a restart: github.io first when it works", async () => {
    const { resumed, hits: h } = await resume([`http://127.0.0.1:${port}/good`, `http://127.0.0.1:${port}/html`], "beta");
    expect(resumed).toBe("RESUMED version=beta");
    expect(h).toEqual(["/good/install.ps1"]);
  });
  it("resume after a restart survives a blocked github.io (refused, or a block page)", async () => {
    for (const first of [DEAD, `http://127.0.0.1:${port}/html`]) {
      const { r, resumed } = await resume([first, `http://127.0.0.1:${port}/good`], "2.3.2-beta.5");
      expect(resumed, first).toBe("RESUMED version=2.3.2-beta.5");
      expect(r.stdout, first).toContain("trying the next source");
    }
  });
  it("resume with both unreachable: nothing runs, both named; the script is ASCII", async () => {
    const { r, resumed, file } = await resume([DEAD, DEAD], "");
    expect(resumed).toBeNull();
    expect(r.stdout).toContain("could not be downloaded from songsid.github.io or raw.githubusercontent.com");
    expect([...readFileSync(file)].every(b => b < 0x80)).toBe(true);
  });

  it("RunOnce runs the written script (a short line), with github.io then the raw tag by default; Clear removes both", () => {
    const lad = scratch();
    const out = ps(`
$RESUME_KEY='scratch'; $AgendInstallVersion='beta'
function Test-Path { return $true }
function Set-ItemProperty { param($Path, $Name, $Value) Write-Host ('REGISTER=' + $Value) }
function Remove-ItemProperty { param($Path, $Name) Write-Host ('UNREGISTER=' + $Name) }
Write-Output ('OK=' + (Register-ResumeAtLogon))
$f = Get-InstallResumeScriptPath
Write-Output ('FILE=' + $f)
Write-Output ('BODY=' + ([IO.File]::ReadAllText($f) -replace "\`r?\`n", ' | '))
Clear-ResumeAtLogon
Write-Output ('GONE=' + -not (Test-Path -LiteralPath $f -PathType Leaf -ErrorAction SilentlyContinue))`, { LOCALAPPDATA: lad });
    const file = join(lad, "AgEnD", "install-resume.ps1");
    expect(out).toContain("OK=True");
    const reg = /REGISTER=(.*)/.exec(out)![1];
    expect(reg).toBe(`powershell -NoProfile -ExecutionPolicy ByPass -File "${file}"`);
    expect(reg.length).toBeLessThan(260);
    expect(reg).not.toContain("-Force");
    const body = /BODY=(.*)/.exec(out)![1];
    expect(body).toContain(`$env:AGEND_VERSION = 'beta'`);
    expect(body).toContain(`foreach ($u in @('${PAGES}/install.ps1', '${RAW}/install.ps1'))`);
    expect(out).toContain("UNREGISTER=AgEnDInstallResume");
    expect(existsSync(file)).toBe(false);
    expect(() => ps("Get-InstallResumeScript 'beta;bad'")).toThrow(/AGEND_VERSION must be/);
  });
});

describe.skipIf(!pwsh)("the network check: either source is enough, and both are named", () => {
  const check = (pages: string | null, raw: string | null, where = "windows") => ps(`
function Get-WindowsProxy { param($h) Write-Host "PROXY-FOR=$h"; return $null }
function Read-Host { param($p) Write-Host "ASKED: $p"; return '' }
function NR($h, $req, $kind) { return @{ Host = $h; Why = 'why'; Required = $req; Kind = $kind } }
$k1 = ${pages ? `'${pages}'` : "$null"}; $k2 = ${raw ? `'${raw}'` : "$null"}
Write-Output ('OK=' + (Resolve-NetResults @((NR 'songsid.github.io' $true $k1), (NR 'raw.githubusercontent.com' ${where === "wsl" ? "$true" : "$false"} $k2)) '${where}'))`);
  it("github.io blocked, raw reachable: passes without asking, saying it uses raw", () => {
    for (const where of ["windows", "wsl"]) {
      const out = check("tls", null, where);
      expect(out).toContain("連不上 songsid.github.io（why）：HTTPS 憑證不被信任（常見於公司會檢查加密連線的網路）；改用 raw.githubusercontent.com（同一份已部署的安裝程式），可以繼續");
      expect(out).not.toContain("ASKED:");
      expect(out).toContain("PROXY-FOR=songsid.github.io");
      expect(out).toContain("OK=True");
    }
  });
  it("both blocked: an error naming both, then the question (default no)", () => {
    const out = check("tls", "refused");
    expect(out).toContain("[X] Windows 連不上 songsid.github.io（why）：HTTPS 憑證不被信任（常見於公司會檢查加密連線的網路）；備用來源 raw.githubusercontent.com 也連不上");
    expect(out).toContain("ASKED:");
    expect(out).toContain("OK=False");
  });
  it("github.io reachable: unchanged", () => {
    expect(check(null, null)).toContain("Windows 的網路連線正常");
    expect(check(null, "dns")).toContain("OK=True");
  });
});

describe.skipIf(!pwsh)("the WSL check says how WSL connects and tells a blocked site from an inspected one", () => {
  it("the probe reports the path (proxy host:port only, never credentials); 35 is a cut handshake, 60 an untrusted certificate", () => {
    const dir = scratch();
    const script = ps(`Write-Output (Get-WslNetScript $NET_WSL)`);
    const bin = join(dir, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nfor a in "$@"; do case $a in https://*) h=$a;; esac; done\ncase $h in *songsid.github.io*) exit 35;; *registry.npmjs.org*) exit 60;; esac\nexit 0\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const probe = (env: Record<string, string>) => spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, ...env } }).stdout;
    expect(probe({})).toContain("NET_PATH|direct");
    const viaProxy = probe({ https_proxy: "http://alice:s3cret@proxy.corp:8080/" });
    expect(viaProxy).toContain("NET_PATH|proxy.corp:8080");
    expect(viaProxy).not.toContain("s3cret");
    writeFileSync(join(dir, "out.txt"), viaProxy);
    const out = ps(`
function Read-Host { param($p) Write-Host "ASKED: $p"; return '' }
function Get-WindowsProxy { return $null }
$script:logged = @(); function Write-InstallLog { param($m) $script:logged += $m }
$r = ConvertFrom-WslNetOutput ([IO.File]::ReadAllText('${join(dir, "out.txt")}')) $NET_WSL
foreach ($x in $r | Where-Object { $_.Host -in 'songsid.github.io', 'registry.npmjs.org' }) { Write-Output ('K=' + $x.Host + '|' + $x.Kind + '|' + $x.Code + '|' + $x.Via) }
Write-Output ('OK=' + (Resolve-NetResults $r 'wsl'))
Write-Output ('LOG=' + ($script:logged -join ' / '))`);
    expect(out).toContain("K=songsid.github.io|handshake|35|proxy.corp:8080");
    expect(out).toContain("K=registry.npmjs.org|tls|60|proxy.corp:8080");
    expect(out).toContain("WSL 裡 經過 proxy proxy.corp:8080 連線");
    expect(out).toContain("HTTPS 連線在握手時被切斷（常見於防火牆擋掉這個網站，不是憑證的問題）；改用 raw.githubusercontent.com");
    expect(out).toContain("連線在 HTTPS 握手時就被切斷：多半是防火牆擋掉了那個網站");
    expect(out).toContain("WSL 裡 registry.npmjs.org：curl 結束碼 60（tls）");
    expect(out).toContain("WSL 裡 songsid.github.io：curl 結束碼 35（handshake）");
  });
});
