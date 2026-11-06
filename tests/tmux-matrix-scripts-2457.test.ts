/**
 * M-2457: the §2 matrix scripts (scripts/manual/tmux-matrix/) must fail when their proof fails — a later pin change is
 * gated on them. Each leg runs here against inert stand-ins (a stub rig, a stub tmux on PATH, a stub docker): a passing
 * control and negative controls. No real tmux server, container, CLI or fleet is started.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const M = join(process.cwd(), "scripts/manual/tmux-matrix");
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    // Stand-in "servers" (sleep processes) a stub tmux started.
    const pidf = join(r, "server.pid");
    if (existsSync(pidf)) try { process.kill(Number(readFileSync(pidf, "utf8")), "SIGKILL"); } catch { /* gone */ }
    rmSync(r, { recursive: true, force: true });
  }
});
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-matrix-")); roots.push(d); return d; };
const exe = (file: string, body: string) => { writeFileSync(file, body); chmodSync(file, 0o755); return file; };
const run = (script: string, env: Record<string, string>, args: string[] = []) =>
  spawnSync("bash", [join(M, script), ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });

/**
 * A stub rig (README.md's interface). It records sends; `calls` answers PONG-<tag> for every PING-<tag> sent when
 * STUB_REPLY=1. STUB_START_FAIL / STUB_SEND_FAIL make those verbs fail; STUB_RAW=SENT|SWALLOWED is what a raw trial sees.
 */
function stubRig(dir: string) {
  return exe(join(dir, "rig.sh"), `#!/bin/bash
S=${JSON.stringify(dir)}
case "$1" in
  start) [ -z "\${STUB_START_FAIL:-}" ] ;;
  stop) echo stopped >> "$S/stopped" ;;
  wait-fresh) [ -z "\${STUB_STALE:-}" ] ;;
  send) [ -z "\${STUB_SEND_FAIL:-}" ] || exit 1; echo "$3" >> "$S/sent" ;;
  calls) node -e 'const fs=require("fs");const f=process.argv[1];const sent=fs.existsSync(f)?fs.readFileSync(f,"utf8").trim().split("\\n"):[];
    const reply=process.env.STUB_REPLY==="1";console.log(JSON.stringify({result:reply?sent.map(t=>({method:"sendMessage",params:{text:t.replace("PING-","PONG-")}})):[]}))' "$S/sent" ;;
  r|x) case "$2" in
         "tmux -V") echo "tmux 3.8" ;;
         *new-session*) echo "\${STUB_RAW:-SENT}" ;;
         *) : ;;
       esac ;;
  *) exit 2 ;;
esac
`);
}

describe("delivery-309.sh", () => {
  const go = (env: Record<string, string>) => { const d = scratch(); const r = run("delivery-309.sh", { RIG: stubRig(d), WAIT_FIRST: "2", WAIT_TWO: "2", ...env }); return { ...r, d }; };

  it("passing control: every agent replies — exit 0, PASS, the rig stopped", () => {
    const r = go({ STUB_REPLY: "1" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("delivery-309: PASS");
    expect(r.stdout.match(/all 4 replied/g)?.length).toBe(4);
    expect(existsSync(join(r.d, "stopped"))).toBe(true);
  });

  it.each([
    ["no agent replies", {}, /0 of 4 replied/],
    ["the sends fail", { STUB_REPLY: "1", STUB_SEND_FAIL: "1" }, /a send did not go through/],
    ["the rig does not start", { STUB_REPLY: "1", STUB_START_FAIL: "1" }, /the rig did not start/],
    ["the agents do not come back after the restart", { STUB_REPLY: "1", STUB_STALE: "1" }, /did not come back with fresh windows/],
  ])("negative control: %s — exit 1 and FAIL, even though the rig's cleanup succeeds", (_why, env, reason) => {
    const r = go(env);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(reason);
    expect(r.stdout).toMatch(/delivery-309: FAIL/);
    expect(existsSync(join(r.d, "stopped"))).toBe(true);
  });
});

describe("raw-309.sh", () => {
  const go = (env: Record<string, string>) => { const d = scratch(); return run("raw-309.sh", { RIG: stubRig(d), N: "2", SETTLE: "0", ...env }); };

  it("passing control: every trial submitted — exit 0", () => {
    const r = go({});
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("raw #309: 2 of 2 submitted, 0 swallowed");
  });

  it.each([
    ["the trials are swallowed", { STUB_RAW: "SWALLOWED" }, /2 of 2 trials were not submitted/],
    ["the rig does not start", { STUB_START_FAIL: "1" }, /the rig did not start/],
  ])("negative control: %s — exit 1", (_why, env, reason) => {
    const r = go(env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(reason);
  });
});

/**
 * A stub tmux for the leak/stress legs: new-session starts a real `sleep` as the "server" (its pid answers
 * `display -p '#{pid}'`, so /proc/<pid>/status has a VmRSS), `-C attach` answers each command line with %begin/%end,
 * capture-pane succeeds. STUB_REFUSE=1: every command fails. STUB_SILENT=1: the control client answers nothing.
 */
function stubTmuxDir() {
  const d = scratch();
  mkdirSync(join(d, "bin"));
  exe(join(d, "bin", "tmux"), `#!/bin/bash
S=${JSON.stringify(d)}
[ -n "\${STUB_REFUSE:-}" ] && { echo "refused" >&2; exit 1; }
args=" $* "
case "$args" in
  *" -V "*) echo "tmux 3.8" ;;
  *" new-session "*|*" new-window "*) [ -f "$S/server.pid" ] || { sleep 300 </dev/null >/dev/null 2>&1 & echo $! > "$S/server.pid"; } ;;
  *" display "*) cat "$S/server.pid" ;;
  *" -C attach "*) while read -r line; do [ -n "\${STUB_SILENT:-}" ] || printf '%%begin 1 1 0\\n%%end 1 1 0\\n'; done ;;
  *" capture-pane "*) echo "frame" ;;
  *" kill-server "*) [ -f "$S/server.pid" ] && kill "$(cat "$S/server.pid")" 2>/dev/null; rm -f "$S/server.pid" ;;
esac
exit 0
`);
  return d;
}

describe.skipIf(process.platform !== "linux")("leak-repro.sh (reads /proc)", () => {
  const go = (via: string, env: Record<string, string> = {}) => {
    const d = stubTmuxDir();
    return run("leak-repro.sh", { PATH: `${join(d, "bin")}:${process.env.PATH}`, SOCKET: "agend-test-leak", VIA: via, PANE: "static", N: "2", SAMPLE_EVERY: "1", ...env });
  };

  it.each(["control", "cli"])("passing control (%s): numeric pid and RSS samples, captures answered — exit 0", (via) => {
    const r = go(via);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.match(/VmRSS=\d+ kB/g)?.length).toBe(3);
    expect(r.stdout).toMatch(/captures answered: \d+/);
  });

  it("negative control: a tmux that refuses everything — exit 1 (no pid, no samples)", () => {
    const r = go("control", { STUB_REFUSE: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/new-session failed/);
  });

  it("negative control: a control client that answers no capture — exit 1", () => {
    const r = go("control", { STUB_SILENT: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/only 0 captures were answered/);
  });
});

/**
 * container-legs.sh through a stub docker that runs the container's script on this host: /m is the matrix directory,
 * /opt/t the bundle (the stub tmux), the -e variables passed through.
 */
describe.skipIf(process.platform !== "linux")("container-legs.sh", () => {
  function go(env: Record<string, string>) {
    const tm = stubTmuxDir();
    const d = scratch();
    mkdirSync(join(d, "bin"));
    exe(join(d, "bin", "docker"), `#!/bin/bash
envs=(); script=""; while [ $# -gt 0 ]; do case "$1" in -e) envs+=("$2"); shift 2 ;; -c) script=$2; shift 2 ;; *) shift ;; esac; done
script=\${script//\\/opt\\/t/${tm}}; script=\${script//\\/m\\//${M}/}
env "\${envs[@]}" bash -c "$script"
`);
    return run("container-legs.sh", { PATH: `${join(d, "bin")}:${process.env.PATH}`, LEAK_SECONDS: "2", LEAK_SAMPLE_EVERY: "1", ...env }, [tm, "leak"]);
  }

  it("passing control: both leak legs measured — exit 0, the tested binary's sha256 printed", () => {
    const r = go({});
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/== bundle .* sha256 [0-9a-f]{64}/);
    expect(r.stdout).toMatch(/\[leak control\] captures answered/);
    expect(r.stdout).toMatch(/\[leak cli\] captures answered/);
  });

  it("negative control: a tmux that refuses everything — exit non-zero (was: exit 0 with empty RSS lines)", () => {
    const r = go({ STUB_REFUSE: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/\[leak control\] FAILED/);
    expect(r.stdout).toMatch(/\[leak cli\] FAILED/);
  });
});

/**
 * scripts/tmux/smoke-tmux.sh against a stand-in bundle: the server's end is proved (its pid gone and a clean exit-1
 * "no server"), never assumed; the pane program runs in argv form.
 * STUB_STICKY=1: kill-server leaves the server running. STUB_HAS=<code>: has-session's answer after the kill.
 * STUB_WIDTH=<n>: the cursor column the line ends at.
 */
describe("smoke-tmux.sh", () => {
  function bundle() {
    const d = scratch();
    mkdirSync(join(d, "bin")); mkdirSync(join(d, "share", "terminfo"), { recursive: true });
    exe(join(d, "bin", "tmux"), `#!/bin/bash
S=${JSON.stringify(d)}
alive() { [ -f "$S/server.pid" ] && kill -0 "$(cat "$S/server.pid")" 2>/dev/null; }
args=" $* "
case "$args" in
  *" -V "*) echo "tmux 3.8" ;;
  *" new-session "*) case "$args" in *" /bin/sh -c "*) ;; *) echo "no argv-form pane program" >&2; exit 7 ;; esac
    sleep 300 </dev/null >/dev/null 2>&1 & echo $! > "$S/server.pid"; : > "$S/sock" ;;
  *"#{pid}"*) cat "$S/server.pid" ;;
  *"#{socket_path}"*) echo "$S/sock" ;;
  *"#{cursor_x}"*) echo "\${STUB_WIDTH:-8}" ;;
  *" capture-pane "*) printf '中文🫨ok\\n' ;;
  *" has-session -t "*) alive || exit 1 ;;
  *" has-session "*) if alive; then exit 0; fi; exit "\${STUB_HAS:-1}" ;;
  *" kill-server "*) alive || exit 1; [ -n "\${STUB_STICKY:-}" ] || kill "$(cat "$S/server.pid")" ;;
esac
exit 0
`);
    return d;
  }
  const go = (env: Record<string, string> = {}) => spawnSync("sh", [join(process.cwd(), "scripts/tmux/smoke-tmux.sh"), bundle(), "3.8"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });

  it("passing control: started, captured at width 8, the server pid gone, a clean exit-1 no-server — exit 0", () => {
    const r = go();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/smoke ok: tmux 3\.8, .* server pid \d+ gone/);
  });

  it.each([
    ["the server survives kill-server", { STUB_STICKY: "1" }, /still running after kill-server/],
    ["the no-server answer is not a clean exit 1 (a timeout/signal/error)", { STUB_HAS: "124" }, /could not be confirmed \(has-session exit 124\)/],
    ["the line is the wrong width", { STUB_WIDTH: "7" }, /7 cells wide, not 8/],
  ])("negative control: %s — exit 1", (_why, env, reason) => {
    const r = go(env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(reason);
  });
});
