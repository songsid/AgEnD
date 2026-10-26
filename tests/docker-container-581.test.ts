/**
 * #581: AgEnD in its container image (docker/). The image sets AGEND_CONTAINER=1: `agend update`, `install` and `stop`
 * say what to run on the host instead, `restart` lets Docker restart the container, the dashboard may listen on the
 * container's interfaces (AGEND_WEB_BIND), and `agend container prepare` writes a first fleet.yaml from the
 * environment and installs the CLIs fleet.yaml uses. Off the image, nothing changes.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTAINER_UPDATE_COMMAND, containerRefusal, inContainer, restartInContainer, webListenHost } from "../src/container.js";
import { fleetBackends, firstRunFleet, installCommand, parseCliVersions, pinnedLayoutVersion, prepareContainer, type PrepareDeps } from "../src/container-prepare.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-581-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const IMAGE = { AGEND_CONTAINER: "1" };

describe("container mode is the image's alone", () => {
  it("only AGEND_CONTAINER=1 is the container", () => {
    expect(inContainer(IMAGE)).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes"]) expect(inContainer({ AGEND_CONTAINER: v })).toBe(false);
  });

  it("the dashboard listens on 127.0.0.1 off the image, whatever AGEND_WEB_BIND says; in it, on a literal IP only", () => {
    expect(webListenHost({ AGEND_WEB_BIND: "0.0.0.0" })).toBe("127.0.0.1");
    expect(webListenHost({ ...IMAGE })).toBe("127.0.0.1");
    expect(webListenHost({ ...IMAGE, AGEND_WEB_BIND: "0.0.0.0" })).toBe("0.0.0.0");
    expect(webListenHost({ ...IMAGE, AGEND_WEB_BIND: " :: " })).toBe("::");
    for (const bad of ["localhost", "example.com", "0.0.0.0:80", "*"]) expect(webListenHost({ ...IMAGE, AGEND_WEB_BIND: bad })).toBe("127.0.0.1");
  });

  it("update, install and stop: refused in the image with what to run on the host; untouched off it", () => {
    for (const cmd of ["update", "install", "stop"] as const) expect(containerRefusal(cmd, {})).toBeNull();
    expect(containerRefusal("update", IMAGE)).toContain(CONTAINER_UPDATE_COMMAND);
    expect(containerRefusal("stop", IMAGE)).toContain("docker compose stop");
    expect(containerRefusal("install", IMAGE)).toContain("restart policy");
  });

  it("restart signals the fleet only when fleet.pid names a running AgEnD fleet (read twice, the same); else nothing", () => {
    const kill = vi.fn();
    const fleetCmd = "node /usr/local/lib/node_modules/@songsid/agend/dist/cli.js fleet start";
    const deps = (lines: string[]) => { let i = 0; return { commandLine: () => lines[Math.min(i++, lines.length - 1)]!, isFleet: (c: string) => /cli\.js fleet start/.test(c), kill }; };
    expect(restartInContainer(7, deps([fleetCmd]))).toMatchObject({ ok: true });
    expect(kill).toHaveBeenCalledWith(7, "SIGTERM");
    for (const pid of [NaN, 0, 1, -3, 1.5]) expect(restartInContainer(pid, deps([fleetCmd])).ok).toBe(false);
    // A stale fleet.pid: the pid now belongs to something else, or nothing readable, or it changed between the reads.
    expect(restartInContainer(8, deps(["/usr/bin/python3 server.py"]))).toMatchObject({ ok: false, message: expect.stringContaining("nothing was signalled") });
    expect(restartInContainer(8, deps([""]))).toMatchObject({ ok: false });
    expect(restartInContainer(8, deps([fleetCmd, "/usr/bin/python3 server.py"]))).toMatchObject({ ok: false });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(restartInContainer(9, { ...deps([fleetCmd]), kill: () => { throw new Error("ESRCH"); } })).toMatchObject({ ok: false });
  });

  it("the fleet's dashboard listener uses that address (0.0.0.0 in the image, 127.0.0.1 otherwise)", async () => {
    for (const [env, want] of [[{}, "127.0.0.1"], [{ ...IMAGE, AGEND_WEB_BIND: "0.0.0.0" }, "0.0.0.0"]] as const) {
      vi.unstubAllEnvs();
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const fm = new FleetManager(scratch()) as any;
      try {
        await fm.startHealthServer(0);
        expect((fm.healthServer.address() as AddressInfo).address).toBe(want);
      } finally {
        await new Promise<void>(r => fm.healthServer ? fm.healthServer.close(() => r()) : r());
        fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); fm.memoryPressure?.stop?.();
      }
    }
  });
});

describe("agend container prepare: pins, installers, the first fleet.yaml", () => {
  it("AGEND_CLI_VERSIONS: backend=version pairs; anything else is reported, not guessed", () => {
    expect(parseCliVersions("claude-code=2.1.300, kiro-cli=2.34.0")).toEqual({ pins: { "claude-code": "2.1.300", "kiro-cli": "2.34.0" }, problems: [] });
    expect(parseCliVersions(undefined)).toEqual({ pins: {}, problems: [] });
    const bad = parseCliVersions("claude-code, nope=1, kiro-cli=$(rm -rf ~), codex=1.2.3");
    expect(bad.pins).toEqual({ codex: "1.2.3" });
    expect(bad.problems).toHaveLength(3);
  });

  it("pinned installs exist only where the installer takes a version; the rest install the newest", () => {
    expect(installCommand("claude-code", "2.1.296")).toBe("curl -fsSL https://claude.ai/install.sh | bash -s 2.1.296");
    expect(installCommand("kiro-cli", "2.34.0", "x64")).toContain("prod.download.cli.kiro.dev/stable/2.34.0/kirocli-x86_64-linux.tar.xz");
    expect(installCommand("kiro-cli", "2.34.0", "arm64")).toContain("kirocli-aarch64-linux.tar.xz");
    for (const b of ["codex", "grok", "opencode", "antigravity", "muse"]) expect(installCommand(b, "1.0.0")).toBeNull();
    expect(installCommand("codex", undefined)).toContain("CODEX_NON_INTERACTIVE=1");
    expect(installCommand("grok", undefined)).toBe("curl -fsSL https://x.ai/cli/install.sh | bash");
    expect(installCommand("no-such", undefined)).toBeNull();
  });

  it("the backends fleet.yaml uses: each instance's, else defaults.backend, else claude-code", () => {
    expect(fleetBackends({ instances: { a: {}, b: { backend: "kiro-cli" } } })).toEqual(["claude-code", "kiro-cli"]);
    expect(fleetBackends({ defaults: { backend: "codex" }, instances: { a: null, b: { backend: "grok" } } })).toEqual(["codex", "grok"]);
    expect(fleetBackends(null)).toEqual([]);
  });

  it("first fleet.yaml: web-only by default; a chat platform only with its group and admins; bad input refused", () => {
    const web = firstRunFleet({});
    expect("yaml" in web && yaml.load(web.yaml)).toEqual({ instances: { dev: { backend: "claude-code", working_directory: "/work/dev" } } });
    const kiro = firstRunFleet({ AGEND_BACKEND: "kiro-cli" });
    expect("yaml" in kiro && yaml.load(kiro.yaml)).toEqual({ instances: { dev: { backend: "kiro-cli", kiro_ui: "tui", working_directory: "/work/dev" } } });
    const tg = firstRunFleet({ AGEND_INSTANCE: "ops", AGEND_BACKEND: "kiro-cli", AGEND_CHANNEL: "telegram", AGEND_GROUP_ID: "-100123", AGEND_ADMIN_IDS: "42, 43" });
    expect("yaml" in tg && yaml.load(tg.yaml)).toEqual({
      instances: { ops: { backend: "kiro-cli", kiro_ui: "tui", working_directory: "/work/ops" } },
      channels: [{ type: "telegram", mode: "topic", bot_token_env: "TELEGRAM_BOT_TOKEN", group_id: "-100123", access: { mode: "locked", allowed_users: ["42", "43"] } }],
    });
    for (const env of [
      { AGEND_INSTANCE: "Dev\nchannels: []" }, { AGEND_BACKEND: "bash" }, { AGEND_CHANNEL: "slack" },
      { AGEND_CHANNEL: "discord" }, { AGEND_CHANNEL: "discord", AGEND_GROUP_ID: "123" },
      { AGEND_CHANNEL: "discord", AGEND_GROUP_ID: "123", AGEND_ADMIN_IDS: "me" },
    ]) expect(firstRunFleet(env)).toHaveProperty("error");
  });

  const deps = (over: Partial<PrepareDeps> & { installed?: Record<string, string> } = {}) => {
    const installed: Record<string, string> = { ...(over.installed ?? {}) };   // backend → version
    const lines: string[] = [], ran: string[] = [];
    const d: PrepareDeps = {
      env: {}, dataDir: scratch(), log: l => lines.push(l),
      find: async b => (installed[b] ? `/home/agend/.local/bin/${b}` : null),
      run: async (cmd) => { ran.push(cmd); const m = /bash -s (\S+)|stable\/(\S+?)\//.exec(cmd); const b = Object.keys({ "claude-code": 1, "kiro-cli": 1, grok: 1, codex: 1 }).find(x => cmd.includes(x === "claude-code" ? "claude.ai" : x === "kiro-cli" ? "kiro.dev" : x === "grok" ? "x.ai" : "chatgpt")); if (b) installed[b] = m ? (m[1] ?? m[2]) : "newest"; return 0; },
      version: async (b) => installed[b] ?? null,
      ...over,
    };
    return { d, lines, ran, installed };
  };

  it("first start: writes fleet.yaml (0600) and installs its backend; an existing fleet.yaml is never touched", async () => {
    const { d, lines, ran } = deps();
    expect(await prepareContainer(d)).toBe(true);
    const path = join(d.dataDir, "fleet.yaml");
    expect(yaml.load(readFileSync(path, "utf8"))).toMatchObject({ instances: { dev: { backend: "claude-code" } } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(ran).toEqual(["curl -fsSL https://claude.ai/install.sh | bash"]);
    expect(lines.at(-1)).toMatch(/^✓ claude-code: /);
    writeFileSync(path, "instances:\n  mine:\n    backend: grok\n");
    const again = deps({ dataDir: d.dataDir, installed: { grok: "1.0.70" } });
    expect(await prepareContainer(again.d)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("instances:\n  mine:\n    backend: grok\n");
    expect(again.ran).toEqual([]);
  });

  it("no fleet.yaml and a bad environment: the fleet cannot start (false), nothing written", async () => {
    const { d, lines } = deps({ env: { AGEND_BACKEND: "nope" } });
    expect(await prepareContainer(d)).toBe(false);
    expect(existsSync(join(d.dataDir, "fleet.yaml"))).toBe(false);
    expect(lines[0]).toContain("AGEND_BACKEND");
  });

  it("pins: a pinned CLI at another version is installed again at the pin; a pin its installer cannot take is said so", async () => {
    const { d, lines, ran } = deps({ env: { AGEND_CLI_VERSIONS: "claude-code=2.1.296,grok=1.0.52" }, installed: { "claude-code": "2.1.310" } });
    writeFileSync(join(d.dataDir, "fleet.yaml"), "instances:\n  a:\n    backend: claude-code\n  b:\n    backend: grok\n");
    expect(await prepareContainer(d)).toBe(true);
    expect(ran).toEqual(["curl -fsSL https://claude.ai/install.sh | bash -s 2.1.296", "curl -fsSL https://x.ai/cli/install.sh | bash"]);
    expect(lines).toContain("⚠ grok: its installer takes no version; the newest is used instead of 1.0.52");
    expect(lines.find(l => l.startsWith("✓ claude-code"))).toMatch(/\(2\.1\.296\) — pinned$/);
    expect(lines.find(l => l.startsWith("✓ grok"))).not.toContain("pinned");
  });

  it("a pinned install's version is read from its own directory (no CLI started)", () => {
    expect(pinnedLayoutVersion("/home/agend/.local/share/agend-cli/kiro-cli/2.34.0/kirocli/bin/kiro-cli")).toBe("2.34.0");
    expect(pinnedLayoutVersion("/home/agend/.local/bin/kiro-cli")).toBeNull();
  });

  it("versions are compared exactly: a pin of 2.1.30 is not met by 2.1.300 (#2697 review)", async () => {
    const { d, ran } = deps({ env: { AGEND_CLI_VERSIONS: "claude-code=2.1.30" }, installed: { "claude-code": "2.1.300" } });
    writeFileSync(join(d.dataDir, "fleet.yaml"), "instances:\n  a:\n    backend: claude-code\n");
    await prepareContainer(d);
    expect(ran).toEqual(["curl -fsSL https://claude.ai/install.sh | bash -s 2.1.30"]);
  });

  it("an install that ends at another version than the pin is reported, never as pinned (#2697 review)", async () => {
    const { d, lines } = deps({ env: { AGEND_CLI_VERSIONS: "claude-code=2.1.296" }, installed: { "claude-code": "2.1.310" }, run: async () => 0 });
    writeFileSync(join(d.dataDir, "fleet.yaml"), "instances:\n  a:\n    backend: claude-code\n");
    await prepareContainer(d);
    expect(lines.at(-1)).toBe("✗ claude-code: 2.1.310 is installed, not the pinned 2.1.296");
    expect(lines.some(l => l.includes("pinned") && l.startsWith("✓"))).toBe(false);
  });

  it("a pinned CLI already at the pin is left alone", async () => {
    const { d, ran } = deps({ env: { AGEND_CLI_VERSIONS: "kiro-cli=2.34.0" }, installed: { "kiro-cli": "2.34.0" } });
    writeFileSync(join(d.dataDir, "fleet.yaml"), "instances:\n  k:\n    backend: kiro-cli\n");
    await prepareContainer(d);
    expect(ran).toEqual([]);
  });

  it("an install that fails is reported and the fleet still starts", async () => {
    const { d, lines } = deps({ run: async () => 7 });
    writeFileSync(join(d.dataDir, "fleet.yaml"), "instances:\n  a:\n    backend: codex\n");
    expect(await prepareContainer(d)).toBe(true);
    expect(lines.at(-1)).toBe("✗ codex: the install exited 7; its instances will report it");
  });

  it("an unreadable fleet.yaml: nothing installed, and the fleet starts to report it", async () => {
    const { d, lines, ran } = deps();
    writeFileSync(join(d.dataDir, "fleet.yaml"), "instances: [unclosed\n");
    expect(await prepareContainer(d)).toBe(true);
    expect(ran).toEqual([]);
    expect(lines[0]).toMatch(/^✗ fleet.yaml could not be read/);
  });
});

describe("the CLI in the image (src/cli.ts, spawned; no fleet, no service manager)", () => {
  /** A scratch AGEND_HOME whose systemctl / launchctl / npm fail loudly if anything reaches them. */
  const home = () => {
    const dir = scratch();
    mkdirSync(join(dir, "bin"));
    for (const name of ["systemctl", "launchctl", "npm"]) {
      writeFileSync(join(dir, "bin", name), `#!/bin/sh\necho "unexpected ${name}" >&2; exit 99\n`);
      chmodSync(join(dir, "bin", name), 0o755);
    }
    writeFileSync(join(dir, "fleet.yaml"), "health_port: 0\ninstances: {}\n");
    return dir;
  };
  const cli = (dir: string, args: string[], env: NodeJS.ProcessEnv = IMAGE) => spawnSync(process.execPath,
    ["--require", join(process.cwd(), "tests/helpers/health-process-stub.cjs"), "--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, AGEND_CONTAINER: "", ...env, AGEND_HOME: dir, HOME: dir, NOTIFY_SOCKET: "", PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });

  it.each([
    [["update"], CONTAINER_UPDATE_COMMAND],
    [["install"], "no service to install"],
    [["stop"], "docker compose stop"],
    [["fleet", "stop"], "docker compose stop"],
  ])("agend %j: refused with what to run on the host, exit 1, nothing else touched", (args, says) => {
    const out = cli(home(), args as string[]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(says);
    expect(out.stderr).not.toContain("unexpected");
  });

  it("agend container prepare runs only in the image", () => {
    const out = cli(home(), ["container", "prepare"], {});
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("runs only in AgEnD's container image");
  });

  it("agend restart in the image signals the fleet in fleet.pid and starts nothing", async () => {
    const dir = home();
    // A stand-in whose command line is an AgEnD fleet's (`… agend fleet start`), as the image's is.
    const fleet = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "agend", "fleet", "start"], { stdio: "ignore" });
    try {
      writeFileSync(join(dir, "fleet.pid"), String(fleet.pid));
      const exited = new Promise<NodeJS.Signals | null>(r => fleet.on("exit", (_c, sig) => r(sig)));
      const out = cli(dir, ["restart", "--yes"], { ...IMAGE, AGEND_ALLOW_TEST_FLEET_CONTROL: "1" });   // a scratch home, a dummy fleet
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain("Docker's restart policy");
      expect(await exited).toBe("SIGTERM");
    } finally { fleet.kill("SIGKILL"); }
  });

  it("agend restart with a stale fleet.pid (another process has that pid) signals nothing (#2697 review)", async () => {
    const dir = home();
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      writeFileSync(join(dir, "fleet.pid"), String(other.pid));
      const out = cli(dir, ["restart", "--yes"], { ...IMAGE, AGEND_ALLOW_TEST_FLEET_CONTROL: "1" });
      expect(out.status).toBe(1);
      expect(out.stderr).toContain("not a running AgEnD fleet");
      expect(other.exitCode).toBeNull();
      expect(() => process.kill(other.pid!, 0)).not.toThrow();
    } finally { other.kill("SIGKILL"); }
  });
});
