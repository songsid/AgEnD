// Built checkout only: npm run build; npx tsx scripts/manual/smoke/smoke-tmux-startup-refusal-3437.mts
// Own foreground tmux child, no panes/agents/adapters. No service, default
// socket, inherited config, credentials or model APIs are used.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve, join } from "node:path";

const repo = resolve(process.env.REPO || ".");
const out = resolve(process.env.OUT || ".artifacts/tmux-refusal-3437");
await mkdir(out, { recursive: true });
const root = await mkdtemp(join(out, "owned-"));
// Relative socket paths stay below the Unix socket address limit even in a deep checkout.
process.chdir(root);
const home = join(root, "home"), agend = join(home, ".agend"), sockets = "sockets";
const label = "guard-owned-3437", socketDir = join(sockets, `tmux-${process.getuid?.() ?? 0}`);
await mkdir(join(agend, "tmux"), { recursive: true });
await mkdir(socketDir, { recursive: true, mode: 0o700 });
await writeFile(join(agend, "fleet.yaml"), "defaults:\n  locale: en\nweb:\n  preview: false\ninstances: {}\n");
const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: home, AGEND_HOME: agend,
  TMUX_TMPDIR: sockets, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
  AGEND_FLEET_START_DIRECT: "1", NOTIFY_SOCKET: "", TZ: "UTC" };
const accepts = () => new Promise<boolean>(done => {
  const socket = connect(join(socketDir, label));
  const finish = (answer: boolean) => { clearTimeout(timer); socket.destroy(); done(answer); };
  const timer = setTimeout(() => finish(false), 500);
  socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
});
const server = spawn("tmux", ["-D", "-S", join(socketDir, label), "-f", "/dev/null"], { cwd: root, env, stdio: "ignore" });
const closed = once(server, "close");
const results: unknown[] = [];
try {
  const deadline = Date.now() + 5000;
  while (!await accepts()) { assert(Date.now() < deadline, "owned tmux did not listen"); await new Promise(r => setTimeout(r, 20)); }
  await writeFile(join(agend, "tmux/server.json"), JSON.stringify({ serverPid: server.pid, socket: label }));
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    const result = await new Promise<{ code: number | string | undefined; signal: string | undefined; stdout: string; stderr: string }>(done => {
      execFile(process.execPath, [join(repo, "dist/cli.js"), "fleet", "start"], { cwd: root, env, timeout: 15_000, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
        done({ code: error?.code ?? 0, signal: error?.signal ?? undefined, stdout, stderr });
      });
    });
    await writeFile(join(out, `attempt-${attempt}.log`), result.stdout + result.stderr);
    assert.equal(result.code, 1); assert.equal(result.signal, undefined);
    const text = result.stdout + result.stderr;
    assert.equal(text.split("AgEnD 2.4's own tmux server is still running").length - 1, 1);
    assert.match(text, /no agent was started.*agend rollback/);
    assert.doesNotMatch(text, /Unhandled rejection|Fleet caught an unhandled error|BundledTmuxStartupError|Fleet started|\n\s+at /);
    assert.equal(await accepts(), true, "refusal must leave the surviving server alone");
    results.push({ attempt, exit: result.code, elapsedMs: Date.now() - started, plainMessageOnce: true, genericNotice: false, oldServerAlive: true });
  }
} finally {
  server.kill("SIGKILL"); assert.deepEqual(await closed, [null, "SIGKILL"]);
  await rm(root, { recursive: true, force: true });
}
await writeFile(join(out, "results.json"), JSON.stringify({ scope: "real built foreground CLI + owned pane-free tmux; no install/rollback or agent lifecycle claim", results }, null, 2) + "\n");
console.log(JSON.stringify(results));
