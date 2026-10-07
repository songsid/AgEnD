/**
 * #1328 (CLI audit 2026-10-07): the gaps fixable without a login.
 * - agy logged out was never reported: the pane says "You are currently not signed in. / Select login method:", the
 *   old pattern's "not logged into Antigravity" only reaches agy's log file.
 * - muse 1.4.3 logged out passed as ready: its menu matched none of the login wording, the ready pattern matched the
 *   `Muse Code 1.4.3` header.
 * - agy's trust prompt title is "Do you trust the contents of this project?" (option: "Yes, I trust this folder").
 * - agy's effort levels come from its own --help (1.3.1: low|medium|high|xhigh|max; 1.0.10: none → three).
 *
 * The panes are real offline captures (scratch HOME, no network, private tmux) of the sha-verified binaries, the help
 * files those binaries' own `--help`. No real CLI, fleet or tmux runs here (bd0c88aa): the probe test runs a scratch
 * shell script standing in for agy, the daemon tests stub tmux.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOGIN_FLOWS } from "../src/login-flows.js";
import { AntigravityBackend, agyLoginScreenActive, parseAgyEffortLevels } from "../src/backend/antigravity.js";
import { MuseBackend, museLoginScreenActive } from "../src/backend/muse.js";
import { agyEffortLevels, readEffortMetadata } from "../src/backend/effort-metadata.js";
import { Daemon } from "../src/daemon.js";
import type { InstanceConfig } from "../src/types.js";

const FIX = join(import.meta.dirname, "fixtures");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf-8");
const AGY_131 = fixture("agy-1.3.1-logged-out.pane.txt");
const AGY_1010 = fixture("agy-1.0.10-logged-out.pane.txt");
const MUSE_LOGGED_OUT = fixture("muse-1.4.3-logged-out.pane.txt");
const MUSE_IDLE = fixture("muse-1.4.3-echo-idle.pane.txt");
const HELP_131 = fixture("agy-help/agy-help-1.3.1.txt");
const HELP_1010 = fixture("agy-help/agy-help-1.0.10.txt");

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1328-")); dirs.push(d); return d; };
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("agy: the logged-out screen is recognised (1.0.10 and 1.3.1 captures)", () => {
  it("the flow's structural check matches both versions", () => {
    expect(LOGIN_FLOWS.antigravity!.loginScreenActive).toBe(agyLoginScreenActive);
    expect(agyLoginScreenActive(AGY_131)).toBe(true);
    expect(agyLoginScreenActive(AGY_1010)).toBe(true);
    // The loose pattern knows the wording too (it was log-file-only before).
    expect(LOGIN_FLOWS.antigravity!.loginScreenPattern!.test(AGY_131)).toBe(true);
  });

  it("not for: the screen quoted with more conversation below it, Claude's own login menu, a ready pane", () => {
    expect(agyLoginScreenActive(`${AGY_131.trimEnd()}\n● that was the sign-in screen\n> `)).toBe(false);
    expect(agyLoginScreenActive(fixture("claude-2.1.291-onboarding-login-method.pane.txt"))).toBe(false);
    expect(agyLoginScreenActive("? for shortcuts\n> ")).toBe(false);
    // the not-signed-in line alone, or the title with a single option, is not the menu
    expect(agyLoginScreenActive("Welcome to the Antigravity CLI. You are currently not signed in.\n")).toBe(false);
    expect(agyLoginScreenActive("You are currently not signed in.\nSelect login method:\n> 1. Google OAuth\n")).toBe(false);
  });

  it("the daemon reports it as an auth incident", () => {
    const instanceDir = scratch();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: "info" };
    const daemon = new Daemon("agy-1328", {
      working_directory: "/tmp", backend: "antigravity",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, log_level: "silent",
    } as unknown as InstanceConfig, instanceDir, false, { binaryName: "agy" } as never, undefined, { child: () => logger } as never) as any;
    const events: unknown[] = [];
    daemon.on("pty_error", (e: unknown) => events.push(e));
    expect(daemon.reportLoginScreen(AGY_131)).toBe(true);
    expect(events).toEqual([expect.objectContaining({ type: "auth_error", action: "pause" })]);
    expect(daemon.reportLoginScreen(`${AGY_131.trimEnd()}\n● quoted\n> `)).toBe(false);
  });
});

describe("muse 1.4.3: the logged-out menu holds startup instead of passing as ready", () => {
  const backend = () => new MuseBackend(scratch());
  const startupMatches = (pane: string) => backend().getStartupDialogs()
    .filter(d => (d.isActive ? d.isActive(pane) : d.pattern.test(pane)));

  it("the capture is matched by the new structural dialog (keys: none — a human logs in)", () => {
    expect(museLoginScreenActive(MUSE_LOGGED_OUT)).toBe(true);
    const found = startupMatches(MUSE_LOGGED_OUT);
    expect(found.map(d => d.keys)).toEqual([[]]);
    expect(found[0]!.description).toMatch(/login menu/i);
    // why it matters: the ready pattern alone matches this screen (the `Muse Code 1.4.3` header)
    expect(backend().getReadyPattern().test(MUSE_LOGGED_OUT)).toBe(true);
  });

  it("not for: the idle prompt, or the menu quoted with the composer below it", () => {
    expect(museLoginScreenActive(MUSE_IDLE)).toBe(false);
    expect(startupMatches(MUSE_IDLE)).toEqual([]);
    expect(museLoginScreenActive(`${MUSE_LOGGED_OUT.trimEnd()}\n────\n❯ `)).toBe(false);
  });

  it("the older wording keeps its own dialog", () => {
    expect(startupMatches("Please run muse login to continue").map(d => d.keys)).toEqual([[]]);
  });

  it("held in both tables, deliveries blocked — never answered", () => {
    for (const dialogs of [backend().getStartupDialogs(), backend().getRuntimeDialogs()]) {
      const found = dialogs.filter(d => d.isActive?.(MUSE_LOGGED_OUT));
      expect(found.map(d => ({ hold: d.holdOnly, blocks: d.blocksDelivery, keys: d.keys }))).toEqual([{ hold: true, blocks: true, keys: [] }]);
      expect(dialogs.filter(d => d.isActive?.(MUSE_IDLE))).toEqual([]);
    }
  });

  it("on the real daemon (tmux stubbed): no key is sent, and the screen probes as a held, delivery-blocking dialog", async () => {
    const instanceDir = scratch();
    writeFileSync(join(instanceDir, "window-id"), "@1");
    const be = new MuseBackend(instanceDir);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: "info" };
    const daemon = new Daemon("muse-1328", {
      working_directory: "/tmp", backend: "muse",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, log_level: "silent",
    } as unknown as InstanceConfig, instanceDir, false, be, undefined, { child: () => logger } as never) as any;
    const keys: string[] = [];
    daemon.tmux = {
      capturePane: vi.fn(async () => MUSE_LOGGED_OUT),
      isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); return true; }),
      sendKeys: vi.fn(async (k: string) => { keys.push(k); return true; }),
    };
    daemon.controlClient = { waitForIdle: async () => {} };
    await daemon.dismissDialogsUntilReady(800, 0);       // "alive" at the end of the budget, as for any held dialog
    expect(keys).toEqual([]);
    const probed = await daemon.probeBlockingDialog();
    expect(probed.state).toBe("dialog");
    expect(probed.dialog.holdOnly).toBe(true);
    expect(probed.dialog.description).toMatch(/Muse login menu/);
  });
});

describe("agy: the trust prompt by its real title", () => {
  // Binary strings (agy 1.3.1 ce1bdaed…, 1.0.10 3c9d8806…): "Do you trust the contents of this project?\n\n" is the
  // only "Do you trust" string; the option is "Yes, I trust this folder". The panes are synthetic (the prompt only
  // shows after sign-in), built from those strings.
  const trust = () => new AntigravityBackend(scratch()).getStartupDialogs().find(d => /trust/i.test(d.description))!;
  it.each([
    ["the title alone", "Do you trust the contents of this project?\n"],
    ["title and options", "Do you trust the contents of this project?\n\n> Yes, I trust this folder\n  No, exit\n"],
    ["the option alone (unchanged)", "> Yes, I trust this folder\n"],
  ])("%s → Enter", (_label, pane) => {
    expect(trust().pattern.test(pane)).toBe(true);
    expect(trust().keys).toEqual(["Enter"]);
  });
});

describe("agy: effort levels from the binary's own --help", () => {
  it("1.3.1 lists five; 1.0.10 has no --effort (null → the three-level fallback); unknown names are dropped", () => {
    expect(parseAgyEffortLevels(HELP_131)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(parseAgyEffortLevels(HELP_1010)).toBeNull();
    expect(parseAgyEffortLevels("  --effort   x (low|ultra|max)\n")).toEqual(["low", "max"]);
    expect(parseAgyEffortLevels("  --effort   Reasoning effort\n")).toBeNull();
    expect(parseAgyEffortLevels("  --effortless (low|high)\n")).toBeNull();
  });

  it("readers use the CLI env cache, never the CLI: probed levels, else low|medium|high", () => {
    const home = scratch();
    vi.stubEnv("AGEND_HOME", home);
    expect(agyEffortLevels()).toEqual(["low", "medium", "high"]);                       // no probe yet
    mkdirSync(join(home, "cli-env"), { recursive: true });
    const write = (env: unknown) => writeFileSync(join(home, "cli-env", "antigravity.json"), JSON.stringify(env));
    write({ backend: "antigravity", probedAt: 1, models: [], effortLevels: ["max", "low", "nonsense", "xhigh"] });
    expect(agyEffortLevels()).toEqual(["low", "xhigh", "max"]);                         // canonical order, filtered
    expect(readEffortMetadata("antigravity", scratch())).toEqual({ strategy: "runtime", levels: ["low", "xhigh", "max"] });
    expect(new AntigravityBackend(scratch()).getEffortLevels()).toEqual(["low", "xhigh", "max"]);
    write({ backend: "antigravity", probedAt: 1, models: [], effortLevels: [] });
    expect(agyEffortLevels()).toEqual(["low", "medium", "high"]);
    writeFileSync(join(home, "cli-env", "antigravity.json"), "{not json");
    expect(agyEffortLevels()).toEqual(["low", "medium", "high"]);
  });

  it("the CLI env probe reads them from --help (a scratch script stands in for agy)", async () => {
    const dir = scratch();
    const fake = join(dir, "agy");
    writeFileSync(fake, `#!/bin/sh\ncase "$1" in\n  --help) cat '${join(FIX, "agy-help", "agy-help-1.3.1.txt")}' ;;\n  --version) echo 'agy 1.3.1' ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(fake, 0o755);
    const be = new AntigravityBackend(dir, dir, dir);
    (be as unknown as { binaryPath: string }).binaryPath = fake;
    const env = await be.probeCLIEnv();
    expect(env.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    writeFileSync(fake, "#!/bin/sh\nexit 1\n");                                         // no help → left out
    expect((await be.probeCLIEnv()).effortLevels).toBeUndefined();
  });

  it("a probe without levels keeps the ones already cached", async () => {
    const home = scratch();
    vi.stubEnv("AGEND_HOME", home);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(scratch()) as any;
    try {
      fm.persistCliEnvProbeResult("antigravity", { models: [], effortLevels: ["low", "medium", "high", "xhigh", "max"] });
      fm.persistCliEnvProbeResult("antigravity", { models: [] });
      expect(agyEffortLevels()).toEqual(["low", "medium", "high", "xhigh", "max"]);
    } finally {
      fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); fm.memoryPressure.stop();
    }
  });
});

