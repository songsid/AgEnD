/**
 * The codex version audit rig (scripts/manual/codex-version-audit) stays runnable: its shell steps parse, gen-cmd.ts
 * produces AgEnD's production launch with the mock provider in the instance config, and the mock answers each mode
 * the way the audit relies on. No codex runs: a stub binary stands in on PATH.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RIG = fileURLToPath(new URL("../scripts/manual/codex-version-audit/", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "agend-cx-rig-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("rig shell steps", () => {
  it.each(["rig.sh", "pass1.sh", "pass2.sh"])("%s parses", (file) => {
    expect(() => execFileSync("bash", ["-n", join(RIG, file)])).not.toThrow();
  });
});

describe("gen-cmd.ts: the production launch, pointed at the mock", () => {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), "#!/bin/sh\necho codex-cli 0.0.0\n"); chmodSync(join(bin, "codex"), 0o755);
  const gen = (name: string, ...args: string[]) => {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGEND_HOME: join(root, "agend"), CODEX_HOME: join(root, "shared") };
    const cmd = execFileSync("npx", ["tsx", join(RIG, "gen-cmd.ts"), join(root, `inst-${name}`), join(root, `work-${name}`), "18799", ...args],
      { cwd: REPO, env, encoding: "utf8" });
    const home = /^CODEX_HOME='([^']+)'/.exec(cmd)![1]!;
    return { cmd, config: readFileSync(join(home, "config.toml"), "utf8") };
  };

  it("fresh + trusted: AgEnD's flags, the mock provider, the trust entry and the nudge flag", () => {
    const { cmd, config } = gen("a", "fresh", "trust");
    expect(cmd).toContain(`${bin}/codex --dangerously-bypass-approvals-and-sandbox`);
    expect(cmd).toContain("-c check_for_update_on_startup=false --no-alt-screen -c features.instant_interrupt=false");
    expect(config).toContain(`model_provider = "mock"`);
    expect(config).toContain(`base_url = "http://127.0.0.1:18799/v1"`);
    expect(config).toContain(`[projects."${join(root, "work-a")}"]`);
    expect(config).toMatch(/^notice\.hide_rate_limit_model_nudge = true$/m);
  }, 60_000);

  it("untrusted leaves the folder untrusted; nudge drops AgEnD's nudge flag", () => {
    const { config } = gen("b", "fresh", "untrusted", "nudge");
    expect(config).not.toContain("[projects.");
    expect(config).not.toMatch(/hide_rate_limit_model_nudge/);
  }, 60_000);
});

describe("mock.mjs: one response shape per mode", () => {
  let mock: ChildProcess; let port = 0; const modeFile = join(root, "mode");
  beforeAll(async () => {
    port = await new Promise<number>(resolve => { const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
    mock = spawn(process.execPath, [join(RIG, "mock.mjs")], { env: { ...process.env, PORT: String(port), MOCK_MODE_FILE: modeFile, SLOW_MS: "10" }, stdio: "ignore" });
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/v1/models`); return; } catch { await new Promise(r => setTimeout(r, 50)); } }
  });
  afterAll(() => { mock?.kill(); });
  const turn = async (mode: string) => {
    writeFileSync(modeFile, mode);
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: "{}" });
    return { status: res.status, headers: res.headers, body: await res.text() };
  };

  it.each([
    ["ok", 200, "response.completed"],
    ["slow", 200, "response.completed"],
    ["near", 200, "response.completed"],
    ["capacity", 200, "server_is_overloaded"],
    ["usage", 429, "usage_limit_reached"],
    ["e401", 401, "invalid_api_key"],
    ["e500", 500, "server_error"],
  ])("%s → HTTP %i with %s", async (mode, status, marker) => {
    const r = await turn(mode);
    expect(r.status).toBe(status);
    expect(r.body).toContain(marker);
    if (mode === "near") expect(r.headers.get("x-codex-primary-used-percent")).toBe("96");
  });
});

// #1445 review: two audits of the SAME version from different roots must not share or tear down each other's tmux
// server, sessions, homes or mock. Everything here is inert: HOME is a temp dir, `tmux` is a stub that logs (and, for
// new-session, runs the command in the background), and the "app-servers" are sleeps named like one.
describe("rig namespaces: one run's names belong to that run", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "agend-cx-ns-"));
  const fakeHome = join(sandbox, "home");
  const tools = join(sandbox, "tools");
  const tmuxLog = join(sandbox, "tmux.log");
  mkdirSync(fakeHome, { recursive: true }); mkdirSync(tools, { recursive: true });
  writeFileSync(tmuxLog, "");
  writeFileSync(join(tools, "tmux"), `#!/bin/sh
echo "$*" >> '${tmuxLog}'
case "$*" in
  *has-session*) exit 1;;
  *new-session*) for last; do :; done; sh -c "$last" >/dev/null 2>&1 & echo $! >> '${tmuxLog}.pids';;
esac
exit 0
`);
  chmodSync(join(tools, "tmux"), 0o755);
  const rootA = join(sandbox, "audit-a"), rootB = join(sandbox, "audit-b");
  const children: ChildProcess[] = [];
  afterAll(() => {
    for (const c of children) c.kill("SIGKILL");
    try { for (const pid of readFileSync(`${tmuxLog}.pids`, "utf8").split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } } } catch { /* none */ }
    try { execFileSync("pkill", ["-f", `${sandbox}/.*mock[.]mjs`]); } catch { /* none left */ }
    rmSync(sandbox, { recursive: true, force: true });
  });
  const rig = (root: string, args: string[], extra: Record<string, string> = {}) => spawnSync("bash", [join(RIG, "rig.sh"), "0.162.0", ...args], {
    env: { ...process.env, HOME: fakeHome, AUDIT: root, PATH: `${tools}:${process.env.PATH}`, ...extra }, encoding: "utf8", timeout: 30_000,
  });
  const paths = (root: string) => Object.fromEntries(rig(root, ["paths"]).stdout.trim().split(" ").map(kv => kv.split("=") as [string, string]));

  it("socket and homes differ between two roots of one version, and stay under the fake HOME", () => {
    const a = paths(rootA), b = paths(rootB);
    for (const key of ["SOCK", "AH", "SH", "RUN"]) expect(a[key], key).not.toBe(b[key]);
    expect(a.AH!.startsWith(`${fakeHome}/.cxa01620`)).toBe(true);
    expect(paths(rootA)).toEqual(a);                         // stable for the same root
  });

  it("stop only kills its own tmux server", () => {
    writeFileSync(tmuxLog, "");
    expect(rig(rootB, ["stop"]).status).toBe(0);
    expect(readFileSync(tmuxLog, "utf8").trim()).toBe(`-L ${paths(rootB).SOCK} kill-server`);
  });

  it("kill signals only the app-server whose CODEX_HOME is under its own home", async () => {
    const fake = (root: string) => {
      const child = spawn("bash", ["-c", "exec -a codex-app-server-fake sleep 60"], {
        env: { ...process.env, CODEX_HOME: `${paths(root).AH}/cx/deadbeef` }, stdio: "ignore",
      });
      children.push(child);
      return child;
    };
    const a = fake(rootA), b = fake(rootB);
    await new Promise(r => setTimeout(r, 300));
    const out = rig(rootB, ["kill"]);
    expect(out.stdout).toContain(`kill ${b.pid}`);
    expect(out.stdout).not.toContain(`kill ${a.pid}`);
    await new Promise(r => setTimeout(r, 300));
    expect(b.exitCode !== null || b.signalCode !== null).toBe(true);
    expect(a.exitCode === null && a.signalCode === null).toBe(true);
  });

  it("a second run whose mock cannot bind its port fails loudly instead of using the other run's mock", async () => {
    const port = await new Promise<number>(resolve => { const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
    expect(rig(rootA, ["mock"], { PORT: String(port) }).status).toBe(0);
    const second = rig(rootB, ["mock"], { PORT: String(port) });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain(`mock did not start on port ${port}`);
  }, 30_000);
});
