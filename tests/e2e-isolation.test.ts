import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INSTANCE_NAME_BUDGET, IsolationError, LIVE_HEALTH_PORT, assertScratchRun, checkScratchFleetConfig, layoutFor, planScratchRun, planTeardown,
  type ScratchPlan, type ScratchRequest, type Seams, type Violation,
} from "../src/e2e-isolation.js";
import { tmuxSessionNameFor, tmuxSocketNameFor } from "../src/paths.js";

/**
 * The gate a real-platform e2e run goes through before it starts anything (E01). Every refusal below is exercised
 * with a MADE-UP machine — the user's real home, realpath, the temp root and the uid are injected — so nothing
 * here touches a real directory, a real tmux server or a real fleet, and nothing starts a process.
 *
 * Background: a scratch fleet once resolved to tmux's default socket and killed sixteen live windows (2026-10-03).
 */
const LIVE_HOME = "/home/alice/.agend";
const SCRATCH = "/tmp/ag-e2e-1a2b3c";
const hashed = (home: string) => "agend-" + createHash("sha256").update(home).digest("hex").slice(0, 6);

/** A parent environment full of everything that must NOT reach the child. */
const PARENT: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin", LANG: "en_US.UTF-8", TERM: "xterm-256color", LC_ALL: "en_US.UTF-8",
  HOME: "/home/alice", AGEND_HOME: LIVE_HOME, AGEND_PORT: "19280", AGEND_TMUX_SESSION: "agend", NOTIFY_SOCKET: "/run/systemd/notify",
  AGEND_BOT_TOKEN: "live-telegram-token", AGEND_DISCORD_BOT_TOKEN: "live-discord-token", AWS_SECRET_ACCESS_KEY: "aws-secret",
  ANTHROPIC_API_KEY: "sk-live", TMUX: "/tmp/tmux-1000/default,1,0",
  E2E_TG_TOKEN: "scratch-tg", E2E_DC_TOKEN: "scratch-dc",
};
const machine = (over: Seams = {}): Seams => ({ realAgendHome: LIVE_HOME, realpath: p => p, tmpRoot: "/tmp", livePorts: [LIVE_HEALTH_PORT], uid: 1000, ...over });
const request = (over: Partial<ScratchRequest> = {}): ScratchRequest =>
  ({ scratchDir: SCRATCH, parentEnv: PARENT, healthPort: 29341, tokenVars: ["E2E_TG_TOKEN", "E2E_DC_TOKEN"], ...over });
const refused = (r: ReturnType<typeof planScratchRun>): Violation[] => { if (r.ok) throw new Error("expected a refusal, got a plan"); return r.violations; };
const rules = (r: ReturnType<typeof planScratchRun>): string[] => refused(r).map(v => v.rule).sort();
const planOf = (over: Partial<ScratchRequest> = {}, seams: Seams = machine()): ScratchPlan => assertScratchRun(request(over), seams);

describe("the plan for a good scratch run", () => {
  it("is one fixed layout under the scratch directory", () => {
    const plan = planOf();
    expect(plan.layout).toEqual({
      scratchDir: SCRATCH, agendHome: `${SCRATCH}/ag`, tmuxTmpdir: `${SCRATCH}/tm`, userHome: `${SCRATCH}/hm`,
    });
    expect(layoutFor(SCRATCH)).toEqual(plan.layout);
  });

  it("gives the child its own tmux socket and session, derived the way the fleet derives them", () => {
    const plan = planOf();
    expect(plan.socketName).toBe(hashed(`${SCRATCH}/ag`));
    expect(plan.socketName).toBe(tmuxSocketNameFor(`${SCRATCH}/ag`, LIVE_HOME));
    expect(plan.sessionName).toBe(tmuxSessionNameFor(`${SCRATCH}/ag`, LIVE_HOME));
    expect(plan.sessionName).not.toBe("agend");
    expect(plan.tmuxSocketPath).toBe(`${SCRATCH}/tm/tmux-1000/${plan.socketName}`);
  });

  it("builds the child environment from an allowlist — nothing of the runner's own leaks through", () => {
    const { childEnv } = planOf();
    expect(childEnv).toEqual({
      PATH: PARENT.PATH, LANG: PARENT.LANG, LC_ALL: PARENT.LC_ALL, TERM: PARENT.TERM,
      AGEND_HOME: `${SCRATCH}/ag`, TMUX_TMPDIR: `${SCRATCH}/tm`, HOME: `${SCRATCH}/hm`, AGEND_E2E: "1",
      E2E_TG_TOKEN: "scratch-tg", E2E_DC_TOKEN: "scratch-dc",
    });
    for (const leaked of ["AGEND_BOT_TOKEN", "AGEND_DISCORD_BOT_TOKEN", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "AGEND_PORT", "AGEND_TMUX_SESSION", "NOTIFY_SOCKET", "TMUX"]) {
      expect(childEnv, leaked).not.toHaveProperty(leaked);
    }
    expect(childEnv.AGEND_HOME).not.toBe(LIVE_HOME);
    expect(childEnv.HOME).not.toBe(PARENT.HOME);
  });

  it("never mutates the runner's environment", () => {
    const before = JSON.stringify(PARENT);
    planOf();
    expect(JSON.stringify(PARENT)).toBe(before);
  });

  it("takes only the token variables it was told about, and only when they are set", () => {
    expect(planOf({ tokenVars: ["E2E_TG_TOKEN"] }).childEnv).not.toHaveProperty("E2E_DC_TOKEN");
    const noValue = planOf({ parentEnv: { ...PARENT, E2E_TG_TOKEN: undefined, E2E_DC_TOKEN: "" } }).childEnv;
    expect(noValue).not.toHaveProperty("E2E_TG_TOKEN");
    expect(noValue).not.toHaveProperty("E2E_DC_TOKEN");
  });

  it("allows the mock backend's MOCK_* knobs and nothing else as extras", () => {
    expect(planOf({ extraEnv: { MOCK_RESPONSE: "pong", MOCK_DELAY: "10" } }).childEnv).toMatchObject({ MOCK_RESPONSE: "pong", MOCK_DELAY: "10" });
  });

  it("leaves a plain scratch run's allowed commands alone", () => {
    for (const command of [["agend", "fleet", "start"], ["agend", "fleet", "restart"], ["agend", "validate"], ["agend", "health"], ["node", "dist/cli.js", "fleet", "start"], ["tmux", "-V"],
      // Only the `agend` CLI is read for subcommands: another program's word "update" or "restart" is not ours to refuse.
      ["echo", "update"], ["curl", "restart"], ["tmux", "start"], ["git", "stop"]]) {
      expect(planScratchRun(request({ command }), machine()).ok, command.join(" ")).toBe(true);
    }
  });
});

describe("E01 — it refuses, before anything starts, and says every rule that failed", () => {
  describe("the scratch directory", () => {
    it.each([
      ["a relative path", "ag-e2e-1"],
      ["a path with .. in it", "/tmp/x/../../home/alice/e2e"],
      ["a path with a trailing slash", "/tmp/ag-e2e-1/"],
      ["the temp root itself", "/tmp"],
      ["a directory outside the temp root", "/var/lib/e2e"],
      ["a directory under the user's home", "/home/alice/e2e"],
    ])("%s", (_name, scratchDir) => {
      expect(rules(planScratchRun(request({ scratchDir }), machine()))).toContain("scratch-root");
    });

    it("a symlink that leads out of the temp root", () => {
      const seams = machine({ realpath: p => (p === "/tmp/ag-link" ? "/srv/elsewhere" : p) });
      expect(rules(planScratchRun(request({ scratchDir: "/tmp/ag-link" }), seams))).toContain("scratch-root");
    });

    it("a symlink that leads INTO the live home — it is not a scratch directory", () => {
      const seams = machine({ realpath: p => (p === "/tmp/ag-link" ? LIVE_HOME : p === "/tmp/ag-link/ag" ? `${LIVE_HOME}/ag` : p) });
      const found = rules(planScratchRun(request({ scratchDir: "/tmp/ag-link" }), seams));
      expect(found).toContain("scratch-not-live");
    });

    it("a directory inside the live home, even when it IS under the permitted root", () => {
      const seams = machine({ tmpRoot: "/home/alice" });
      expect(rules(planScratchRun(request({ scratchDir: `${LIVE_HOME}/e2e` }), seams))).toEqual(["scratch-not-live"]);
    });

    it("the live home is resolved too: a scratch directory inside the place a symlinked ~/.agend really lives", () => {
      const seams = machine({ tmpRoot: "/srv", realpath: p => (p === LIVE_HOME ? "/srv/data/agend" : p) });
      expect(rules(planScratchRun(request({ scratchDir: "/srv/data/agend/e2e" }), seams))).toEqual(["scratch-not-live"]);
    });

    it("a directory that contains the live home (a cleanup rooted there could reach it)", () => {
      const seams = machine({ tmpRoot: "/" });
      expect(rules(planScratchRun(request({ scratchDir: "/home/alice" }), seams))).toContain("scratch-not-live");
    });
  });

  describe("the live home and tmux", () => {
    it("cannot be proven when the live home is unknown — nothing is allowed", () => {
      expect(rules(planScratchRun(request(), machine({ realAgendHome: null })))).toContain("real-home-unknown");
    });

    it("the child's AGEND_HOME resolving to the live home (through a symlink)", () => {
      const seams = machine({ realpath: p => (p === `${SCRATCH}/ag` ? LIVE_HOME : p) });
      expect(rules(planScratchRun(request(), seams))).toContain("home-not-live");
    });

    it("the child's tmux socket being the DEFAULT one — the 2026-10-03 failure", () => {
      // The user's real home happening to be the child's home is exactly what selects tmux's default socket.
      const seams = machine({ realAgendHome: `${SCRATCH}/ag` });
      const found = rules(planScratchRun(request(), seams));
      expect(found).toContain("tmux-socket-default");
      expect(found).toContain("tmux-session-live");
      expect(found).toContain("home-not-live");
    });

    it("a changed HOME in the runner's environment does not make the check pass or fail — the passwd home is what counts", () => {
      const moved = planOf({ parentEnv: { ...PARENT, HOME: SCRATCH, AGEND_HOME: `${SCRATCH}/.agend` } });
      expect(moved.socketName).toBe(hashed(`${SCRATCH}/ag`));
      expect(moved.childEnv.HOME).toBe(`${SCRATCH}/hm`);
    });
  });

  describe("socket path length", () => {
    it("a scratch directory so deep that an instance's IPC socket would not fit", () => {
      const scratchDir = `/tmp/${"x".repeat(60)}`;
      const found = refused(planScratchRun(request({ scratchDir }), machine()));
      expect(found.map(v => v.rule)).toContain("socket-path-length");
      expect(found.find(v => v.rule === "socket-path-length")!.detail).toMatch(/IPC socket|tmux socket/);
    });

    it("budgets for a long instance name", () => {
      expect(INSTANCE_NAME_BUDGET).toBeGreaterThanOrEqual(32);
      const justOver = `/tmp/${"y".repeat(108 - `/tmp//ag/instances//channel.sock`.length - INSTANCE_NAME_BUDGET)}`;
      expect(rules(planScratchRun(request({ scratchDir: justOver }), machine()))).toContain("socket-path-length");
    });

    it("an ordinary short scratch directory fits", () => {
      expect(planScratchRun(request(), machine()).ok).toBe(true);
    });
  });

  describe("the health port", () => {
    it("the default live port is 19280, and is refused even when the caller names no live ports of its own", () => {
      expect(LIVE_HEALTH_PORT).toBe(19280);
      const { livePorts: _ignored, ...withoutLivePorts } = machine();
      expect(rules(planScratchRun(request({ healthPort: 19280 }), withoutLivePorts))).toEqual(["health-port"]);
    });

    it.each([LIVE_HEALTH_PORT, 0, 80, 1023, 65536, -1, 3.5, 29341.5, 2000.25, Number.NaN, Number.POSITIVE_INFINITY])("%s", port => {
      expect(rules(planScratchRun(request({ healthPort: port }), machine()))).toEqual(["health-port"]);
    });

    it("any port the caller says is live, not only the default", () => {
      expect(rules(planScratchRun(request({ healthPort: 29341 }), machine({ livePorts: [19280, 29341] })))).toEqual(["health-port"]);
    });

    it("the edges of the usable range are fine", () => {
      expect(planScratchRun(request({ healthPort: 1024 }), machine()).ok).toBe(true);
      expect(planScratchRun(request({ healthPort: 65535 }), machine()).ok).toBe(true);
    });
  });

  describe("the child environment", () => {
    it.each(["AGEND_BOT_TOKEN", "AGEND_DISCORD_BOT_TOKEN", "e2e_tg_token", "E2E_", "E2E", "TELEGRAM_TOKEN", "E2E_lower", "", "AGEND_E2E_TOKEN", "LIVE_E2E_TG", "E2E_TG-TOKEN", "E2E_TG TOKEN"])("a token variable named %j is refused", name => {
      expect(rules(planScratchRun(request({ tokenVars: [name] }), machine()))).toContain("token-var");
    });

    it.each(["AGEND_HOME", "HOME", "TMUX_TMPDIR", "AGEND_PORT", "AGEND_TMUX_SESSION", "NOTIFY_SOCKET", "PATH", "AWS_SECRET_ACCESS_KEY", "E2E_TG_TOKEN", "MOCK", "MOCKING", "MOCKBIRD_KEY", "mock_response", "MOCK_lower"])("%s cannot be added as an extra", key => {
      expect(rules(planScratchRun(request({ extraEnv: { [key]: "x" } }), machine()))).toContain("env-forbidden");
    });
  });

  describe("the command the run means to execute", () => {
    it.each([
      [["agend", "update"]], [["agend", "update", "--beta"]], [["agend", "restart"]], [["agend", "stop"]], [["agend", "start"]],
      [["agend", "install"]], [["agend", "uninstall"]], [["agend", "setup"]], [["agend", "quickstart"]], [["agend", "init"]], [["agend", "reload"]],
      [["/usr/local/bin/agend", "update"]],
      [["node", "dist/cli.js", "update"]], [["tsx", "src/cli.ts", "restart"]], [["agend", "--verbose", "update"]],
      [["systemctl", "--user", "restart", "agend"]], [["launchctl", "kickstart", "x"]], [["sudo", "agend", "fleet", "start"]],
      [["kill", "-9", "1"]], [["pkill", "-f", "agend"]], [["killall", "tmux"]], [["npm", "install", "-g", "@songsid/agend"]], [["npx", "agend"]],
    ])("%j", command => {
      expect(rules(planScratchRun(request({ command }), machine()))).toEqual(["command-forbidden"]);
    });

    it("says which kind of mistake it was", () => {
      const [service] = refused(planScratchRun(request({ command: ["agend", "restart"] }), machine()));
      expect(service!.detail).toMatch(/service/);
      const [program] = refused(planScratchRun(request({ command: ["systemctl", "restart", "x"] }), machine()));
      expect(program!.detail).toMatch(/machine/);
    });
  });

  it("reports every violation together, not only the first", () => {
    const found = rules(planScratchRun(
      request({ scratchDir: "/var/e2e", healthPort: LIVE_HEALTH_PORT, tokenVars: ["AGEND_BOT_TOKEN"], extraEnv: { HOME: "/x" }, command: ["agend", "update"] }),
      machine(),
    ));
    expect(found).toEqual(["command-forbidden", "env-forbidden", "health-port", "scratch-root", "token-var"]);
  });

  it("the throwing form carries the violations and cannot be ignored", () => {
    let caught: unknown;
    try { assertScratchRun(request({ healthPort: LIVE_HEALTH_PORT }), machine()); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(IsolationError);
    expect((caught as IsolationError).violations.map(v => v.rule)).toEqual(["health-port"]);
    expect((caught as IsolationError).message).toContain("health-port");
  });
});

describe("planTeardown — the only cleanup a run may do", () => {
  it("is `tmux -S <socket inside the scratch dir> kill-server` and removes only the scratch dir", () => {
    const plan = planOf();
    const result = planTeardown(plan, machine());
    expect(result).toEqual({ ok: true, argv: ["tmux", "-S", plan.tmuxSocketPath, "kill-server"], removeDir: SCRATCH });
  });

  it("never uses -L, a bare kill-server, or the default socket", () => {
    const result = planTeardown(planOf(), machine());
    if (!result.ok) throw new Error("expected a plan");
    expect(result.argv).not.toContain("-L");
    expect(result.argv[1]).toBe("-S");
    expect(result.argv.join(" ")).not.toMatch(/default/);
  });

  const broken = (over: Partial<ScratchPlan>): ScratchPlan => ({ ...planOf(), ...over });
  const refusedTeardown = (plan: ScratchPlan, seams: Seams = machine()): string[] => {
    const result = planTeardown(plan, seams);
    if (result.ok) throw new Error("expected a refusal");
    return result.violations.map(v => v.rule).sort();
  };

  it.each([
    ["the default socket's path", "/tmp/tmux-1000/default"],
    ["a socket in another directory", "/tmp/tmux-1000/agend-abcdef"],
    ["a path that climbs out with ..", `${SCRATCH}/tm/../../tmux-1000/agend-abcdef`],
    ["a relative path", "tm/tmux-1000/agend-abcdef"],
    ["the scratch directory itself", SCRATCH],
  ])("refuses %s", (_name, tmuxSocketPath) => {
    expect(refusedTeardown(broken({ tmuxSocketPath }))).toContain("teardown-target");
  });

  it("refuses a path that climbs with .. even when it ends in the run's own socket name", () => {
    const plan = planOf();
    expect(refusedTeardown(broken({ tmuxSocketPath: `${SCRATCH}/tm/../tm/tmux-1000/${plan.socketName}` }))).toContain("teardown-target");
    expect(refusedTeardown(broken({ tmuxSocketPath: `${SCRATCH}/tm/tmux-1000/../../../../tmp/tmux-1000/${plan.socketName}` }))).toContain("teardown-target");
  });

  it("refuses the 'default' and empty socket names on their own, without the live home to compare against", () => {
    const noLiveHome = machine({ realAgendHome: null });
    expect(refusedTeardown(broken({ socketName: "default", tmuxSocketPath: `${SCRATCH}/tm/tmux-1000/default` }), noLiveHome)).toContain("teardown-target");
    expect(refusedTeardown(broken({ socketName: "", tmuxSocketPath: `${SCRATCH}/tm/tmux-1000/` }), noLiveHome)).toContain("teardown-target");
  });

  it("refuses a socket that is inside the scratch directory but not the run's own", () => {
    expect(refusedTeardown(broken({ tmuxSocketPath: `${SCRATCH}/tm/tmux-1000/default` }))).toContain("teardown-target");
    expect(refusedTeardown(broken({ tmuxSocketPath: `${SCRATCH}/tm/tmux-1000/agend-ffffff` }))).toContain("teardown-target");
  });

  it("refuses a socket path that resolves out of the scratch directory through a symlink", () => {
    const plan = planOf();
    const seams = machine({ realpath: p => (p === plan.tmuxSocketPath ? `/tmp/tmux-1000/${plan.socketName}` : p) });
    expect(refusedTeardown(plan, seams)).toContain("teardown-target");
  });

  it("refuses when the plan's socket name is empty or 'default'", () => {
    expect(refusedTeardown(broken({ socketName: "" }))).toContain("teardown-target");
    expect(refusedTeardown(broken({ socketName: "default", tmuxSocketPath: `${SCRATCH}/tm/tmux-1000/default` }))).toContain("teardown-target");
  });

  it("refuses when the scratch directory itself is no longer a valid scratch directory", () => {
    const plan = planOf();
    expect(refusedTeardown(plan, machine({ tmpRoot: "/srv" }))).toContain("scratch-root");
    expect(refusedTeardown(plan, machine({ realpath: p => (p === SCRATCH ? LIVE_HOME : p) }))).toContain("scratch-not-live");
  });

  it("refuses a plan whose socket name is not the one its home derives", () => {
    const plan = planOf();
    expect(refusedTeardown(broken({ socketName: "agend-ffffff", tmuxSocketPath: `${SCRATCH}/tm/tmux-1000/agend-ffffff` }), machine())).toContain("teardown-target");
    expect(plan.socketName).not.toBe("agend-ffffff");
  });
});

describe("checkScratchFleetConfig — the config a scratch fleet is given", () => {
  const plan = planOf();
  const good = () => ({
    health_port: 29341,
    defaults: { backend: "mock", tips: false, daily_summary: { enabled: false }, hang_detector: { enabled: false } },
    channels: [
      { id: "discord", type: "discord", bot_token_env: "E2E_DC_TOKEN", group_id: "1", access: { mode: "locked", allowed_users: ["1"] } },
      { id: "telegram", type: "telegram", bot_token_env: "E2E_TG_TOKEN", group_id: "-1", access: { mode: "locked", allowed_users: [1] } },
    ],
    instances: { general: { general_topic: true, backend: "mock" }, worker: {} },
  });
  const rulesOf = (config: object): string[] => checkScratchFleetConfig(config as never, plan).map(v => v.rule).sort();

  it("accepts a quiet, mock-backed, scratch-token config on the scratch port", () => {
    expect(checkScratchFleetConfig(good() as never, plan)).toEqual([]);
  });

  it("refuses the live port, or any port that is not the plan's", () => {
    expect(rulesOf({ ...good(), health_port: 19280 })).toEqual(["config-health-port"]);
    const { health_port: _drop, ...without } = good();
    expect(rulesOf(without)).toEqual(["config-health-port"]);
  });

  it("refuses a channel whose token variable is not one of this run's — a live variable name above all", () => {
    const config = good();
    config.channels[0]!.bot_token_env = "AGEND_DISCORD_BOT_TOKEN";
    expect(rulesOf(config)).toEqual(["config-token-var"]);
    config.channels[0]!.bot_token_env = "E2E_SOMETHING_ELSE";             // E2E_ but not passed to this run
    expect(rulesOf(config)).toEqual(["config-token-var"]);
    const legacy = { ...good(), channels: undefined, channel: { bot_token_env: "AGEND_BOT_TOKEN", access: { mode: "locked" } } };
    expect(rulesOf(legacy)).toEqual(["config-token-var"]);
  });

  it("refuses a channel with no explicit access block", () => {
    const config = good();
    delete (config.channels[1] as { access?: unknown }).access;
    expect(rulesOf(config)).toEqual(["config-access"]);
  });

  it("refuses a real backend, in the defaults or on an instance, and agent_mode: cli", () => {
    expect(rulesOf({ ...good(), defaults: { ...good().defaults, backend: "claude-code" } })).toEqual(["config-backend"]);
    expect(rulesOf({ ...good(), defaults: { ...good().defaults, backend: undefined } })).toEqual(["config-backend"]);
    expect(rulesOf({ ...good(), instances: { general: { backend: "codex" } } })).toEqual(["config-backend"]);
    expect(rulesOf({ ...good(), instances: { general: { agent_mode: "cli" } } })).toEqual(["config-agent-mode"]);
  });

  it.each(["tips", "daily_summary", "hang_detector"])("refuses a config that leaves %s on or unset — they post to the real chat on their own", key => {
    const config = good();
    if (key === "tips") config.defaults.tips = true;
    else (config.defaults as Record<string, unknown>)[key] = { enabled: true };
    expect(rulesOf(config)).toEqual(["config-quiet"]);
    const unset = good();
    delete (unset.defaults as Record<string, unknown>)[key];
    expect(rulesOf(unset)).toEqual(["config-quiet"]);
  });

  it("refuses webhooks", () => {
    expect(rulesOf({ ...good(), defaults: { ...good().defaults, webhooks: [{ url: "https://example.invalid" }] } })).toEqual(["config-webhooks"]);
  });
});
