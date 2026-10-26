/**
 * M-2063: the Windows installer end to end — stages 1 to 5 of install-agend.ps1, run as a script FILE (`& path`, the way
 * install.ps1 runs it), against a fake Windows and a fake WSL. Tonight's live failures (2026-10-26) all passed the unit
 * tests and failed here first:
 *   - `wsl … -- <cmd>`: the distro's shell re-parses the line ($, quotes, backslashes) — #2711, #2720. The fake wsl.exe
 *     (tests/fixtures/installer-flow/fake-wsl.sh, put on PATH as wsl.exe) gives `--` exactly that parse, and --exec its argv.
 *   - a .GetNewClosure() block calling the installer's own functions only fails when they are script-scoped — #2718.
 *   - a port held on Windows' side (another Linux's WSL relay) — #2723.
 *   - a resumed run that could not change its backends — #2720.
 * The Linux side is one container (node:22-bookworm, no network) with canned installers and a fake `agend` (setup page,
 * fleet health); Windows itself — and the Linux internet reachability probe, which needs real internet — is replaced by
 * tests/fixtures/installer-flow/overrides.ps1, injected before the main body. A "person" finishes the setup page once the installer has opened it. Needs docker and pwsh; in CI both must be
 * there (it fails rather than skips).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const FIX = join(ROOT, "tests", "fixtures", "installer-flow");
const INSTALLER = join(ROOT, "website", "public", "install-agend.ps1");
const IMAGE = "node:22-bookworm";
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore", timeout: 60_000 }).status === 0;
let ready = false;
beforeAll(() => {
  ready = has("pwsh", ["-NoProfile", "-Command", "1"]) && has("docker", ["version"]);
  if (!ready && process.env.CI) throw new Error("installer flow test: pwsh and docker are required in CI");
  if (ready && !has("docker", ["image", "inspect", IMAGE])) execFileSync("docker", ["pull", "-q", IMAGE], { stdio: "ignore", timeout: 300_000 });
}, 320_000);

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) try { c(); } catch { /* best effort */ } });

/** The installer with the fake-Windows block before its main body (`mutate`: change the installer first, for the mutation checks). */
function installerCopy(dir: string, mutate: (s: string) => string = s => s): string {
  const src = mutate(readFileSync(INSTALLER, "utf8").replace(/^﻿/, ""));
  const at = src.indexOf("# ── 開始 ");
  if (at < 0) throw new Error("installer main-body marker moved");
  const file = join(dir, "install-agend-flow.ps1");
  writeFileSync(file, "﻿" + src.slice(0, at) + readFileSync(join(FIX, "overrides.ps1"), "utf8") + "\n" + src.slice(at));
  return file;
}

interface Flow { dir: string; state: string; ctr: string; run(o?: { answers?: string[]; live?: boolean; mutate?: (s: string) => string }): Promise<{ code: number | null; out: string }>; exec(sh: string): string }
function flow(): Flow {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agend-flow-")));
  for (const d of ["state", "home", "lad", "pd", "appdata", "stubs", "bin"]) mkdirSync(join(dir, d));
  cpSync(join(FIX, "linux"), join(dir, "stubs"), { recursive: true });
  cpSync(join(FIX, "fake-wsl.sh"), join(dir, "bin", "wsl.exe"));          // the name the installer calls
  const ctr = "agend-flow-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  const yaml = realpathSync(join(ROOT, "node_modules", "js-yaml"));
  execFileSync("docker", ["run", "-d", "--rm", "--name", ctr, "--network", "none", "-v", `${dir}/stubs:/opt/stubs:ro`, "-v", `${yaml}:/opt/js-yaml:ro`, "-v", `${dir}:${dir}`, IMAGE, "sleep", "infinity"], { stdio: "ignore" });
  cleanups.push(() => { spawnSync("docker", ["rm", "-f", ctr], { stdio: "ignore" }); rmSync(dir, { recursive: true, force: true }); });
  // A login shell's PATH starts at /usr/local/sbin (Debian's /etc/profile): the canned tools go there; `agend` only once installed.
  execFileSync("docker", ["exec", ctr, "sh", "-c", 'for f in /opt/stubs/*; do case "$f" in *.mjs|*.sh|*/agend) ;; *) ln -sf "$f" /usr/local/sbin/;; esac; done']);
  const state = join(dir, "state");
  const exec = (sh: string) => execFileSync("docker", ["exec", ctr, "bash", "-c", sh], { encoding: "utf8" });
  const run: Flow["run"] = (o = {}) => new Promise(resolve => {
    writeFileSync(join(dir, "answers"), (o.answers ?? []).join("\n") + "\n");
    rmSync(join(state, "browser.log"), { force: true });
    const file = installerCopy(dir, o.mutate);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(dir, "home"), USERPROFILE: join(dir, "home"), APPDATA: join(dir, "appdata"), LOCALAPPDATA: join(dir, "lad"),
      ProgramData: join(dir, "pd"), PATH: `${join(dir, "bin")}:${process.env.PATH}`, AGEND_FAKE_WSL_STATE: state, AGEND_FAKE_WSL_CONTAINER: ctr,
      AGEND_FLOW_ANSWERS: join(dir, "answers"), AGEND_FLOW_LIVE: o.live ? "1" : "0" };
    delete env.AGEND_HOME;                                                      // never this host's own fleet
    const p = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `& '${file}'; exit $LASTEXITCODE`], { cwd: dir, env });
    let out = ""; p.stdout.on("data", d => { out += d; }); p.stderr.on("data", d => { out += d; });
    // The person: once the setup page is open in "the browser", finish it there.
    const person = setInterval(() => {
      const log = join(state, "browser.log");
      const m = existsSync(log) ? /127\.0\.0\.1:(\d+)\/s\/flowsid\//.exec(readFileSync(log, "utf8")) : null;
      if (m) { clearInterval(person); setTimeout(() => spawnSync("docker", ["exec", ctr, "/usr/bin/curl", "-s", `http://127.0.0.1:${m[1]}/s/flowsid/finish`]), 1500); }
    }, 500);
    const killer = setTimeout(() => p.kill("SIGKILL"), 240_000);
    p.on("close", code => { clearInterval(person); clearTimeout(killer); resolve({ code, out }); });
  });
  return { dir, state, ctr, run, exec };
}
const calls = (f: Flow) => (existsSync(join(f.state, "calls.log")) ? readFileSync(join(f.state, "calls.log"), "utf8") : "");

describe("the Windows installer, stages 1–5 as a script file against a fake Windows and WSL", { timeout: 300_000 }, () => {
  it("a fresh install with Codex: every stage passes, Codex is found after it installs, the setup page opens and the fleet is ready", async () => {
    if (!ready) return;
    const f = flow();
    const r = await f.run({ answers: ["4"] });
    expect(r.out).not.toMatch(/is not recognized|尚未安裝成功|所有選擇的後端都安裝失敗|沒有預料到的錯誤/);
    expect(r.out).toContain("[OK] OpenAI Codex 安裝完成（codex-cli 0.164.0）");
    expect(r.out).toContain("服務與儀表板已就緒");
    expect(r.code).toBe(0);
    expect(readFileSync(join(f.state, "browser.log"), "utf8")).toContain("http://127.0.0.1:19280/s/flowsid/");
    expect(f.exec("cat /root/.agend/fleet.yaml")).toMatch(/^health_port: 19280\n/);
    // Every argument list handed to wsl.exe used --exec (a `--` one would have been re-parsed by the shell).
    expect(calls(f).split("\n").filter(l => / -u \S+ -- /.test(l))).toEqual([]);
    // The fake runs a command only in a registered Linux, through --exec as through `--` (#2733 review).
    const wsl = (args: string[]) => spawnSync(join(f.dir, "bin", "wsl.exe"), args, { env: { ...process.env, AGEND_FAKE_WSL_STATE: f.state, AGEND_FAKE_WSL_CONTAINER: f.ctr } }).status;
    expect([wsl(["-d", "MissingDistro", "-u", "root", "--exec", "true"]), wsl(["-d", "MissingDistro", "-u", "root", "--", "true"])]).toEqual([1, 1]);
    expect([wsl(["-d", "Ubuntu-24.04", "-u", "root", "--exec", "true"]), wsl(["-d", "Ubuntu-24.04", "-u", "root", "--", "true"])]).toEqual([0, 0]);
  });

  it("caught here: the backend probe through `--` again (#2720) reads every backend as missing", async () => {
    if (!ready) return;
    const f = flow();
    const r = await f.run({ answers: ["4"], mutate: s => s.replace("'-u', 'root', '--exec', 'bash', '-c', $BACKEND_PROBE", "'-u', 'root', '--', 'bash', '-c', $BACKEND_PROBE") });
    expect(r.out).toContain("OpenAI Codex 尚未安裝成功");
    expect(r.code).not.toBe(0);
  });

  it("caught here: a GetNewClosure block calling Protect-LogText directly (#2718) stops the installer", async () => {
    if (!ready) return;
    const f = flow();
    const r = await f.run({ answers: ["4"], mutate: s => s.replace("(& $protect ([string]$line))", "(Protect-LogText ([string]$line))") });
    expect(r.out).toMatch(/Protect-LogText' is not recognized/);
    expect(r.code).not.toBe(0);
  });

  it("Windows' 19280 held (another Linux's WSL relay): the next pair, 19282, for the setup page and the fleet (#2723)", async () => {
    if (!ready) return;
    const f = flow();
    writeFileSync(join(f.state, "windows-listeners"), "19280\n");
    const r = await f.run({ answers: ["4"] });
    expect(r.out).toContain("「wslrelay」");
    expect(r.code).toBe(0);
    expect(readFileSync(join(f.state, "browser.log"), "utf8")).toContain("http://127.0.0.1:19282/s/flowsid/");
    expect(f.exec("cat /root/.agend/fleet.yaml")).toMatch(/^health_port: 19282\n/);
  });

  it("a backend that fails, then a resume: the saved choice is offered, a new one taken (#2720), and the install finishes", async () => {
    if (!ready) return;
    const f = flow();
    f.exec("touch /tmp/fail-codex");
    const first = await f.run({ answers: ["4"] });
    expect(first.out).toContain("OpenAI Codex 尚未安裝成功");
    expect(first.code).not.toBe(0);
    const second = await f.run({ answers: ["2"], live: true });
    expect(second.out).toContain("上次選擇的後端：OpenAI Codex");
    expect(second.out).toContain("[OK] Claude Code 安裝完成（2.1.310 (Claude Code)）");
    expect(second.out).toContain("服務與儀表板已就緒");
    expect(second.code).toBe(0);
  });
});
