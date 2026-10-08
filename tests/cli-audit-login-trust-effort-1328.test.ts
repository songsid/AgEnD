import { registerExecutableFixture } from "./support/process-guard.js";
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
  // only "Do you trust" string; the option is "Yes, I trust this folder". Either one pre-filters the prompt; what is
  // answered is decided on the live-captured layout (tests/agy-live-busy-trust-1328.test.ts).
  const patterns = () => new AntigravityBackend(scratch()).getStartupDialogs().filter(d => /trust/i.test(d.description)).map(d => d.pattern);
  it.each([
    ["the title", "Do you trust the contents of this project?\n"],
    ["the option", "> Yes, I trust this folder\n"],
  ])("%s → recognised", (_label, pane) => {
    expect(patterns().some(p => p.test(pane))).toBe(true);
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
    write({ backend: "antigravity", probedAt: Date.now(), models: [], effortLevels: ["max", "low", "nonsense", "xhigh"] });
    expect(agyEffortLevels()).toEqual(["low", "xhigh", "max"]);                         // canonical order, filtered
    expect(readEffortMetadata("antigravity", scratch())).toEqual({ strategy: "runtime", levels: ["low", "xhigh", "max"] });
    expect(new AntigravityBackend(scratch()).getEffortLevels()).toEqual(["low", "xhigh", "max"]);
    write({ backend: "antigravity", probedAt: Date.now(), models: [], effortLevels: [] });
    expect(agyEffortLevels()).toEqual(["low", "medium", "high"]);                       // help read, lists none
    write({ backend: "antigravity", models: [], effortLevels: ["low", "max"] });
    expect(agyEffortLevels()).toEqual(["low", "medium", "high"]);                       // no probedAt: not valid
    writeFileSync(join(home, "cli-env", "antigravity.json"), "{not json");
    expect(agyEffortLevels()).toEqual(["low", "medium", "high"]);
  });

  // A scratch shell script stands in for agy: `--help` prints the given help file (or fails), `--version` the version.
  const fakeAgy = (dir: string, help: string | null, version: string | null) => {
    const fake = join(dir, "agy");
    writeFileSync(fake, `#!/bin/sh\ncase "$1" in\n  --help) ${help ? `cat '${join(FIX, "agy-help", help)}'` : "exit 1"} ;;\n`
      + `  --version) ${version ? `echo 'agy ${version}'` : "exit 1"} ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(fake, 0o755);
    registerExecutableFixture(fake);
    const be = new AntigravityBackend(dir, dir, dir);
    (be as unknown as { binaryPath: string }).binaryPath = fake;
    return be;
  };

  it("the CLI env probe reads them from --help: a list, [] for a help that lists none, absent for no help", async () => {
    const dir = scratch();
    expect((await fakeAgy(dir, "agy-help-1.3.1.txt", "1.3.1").probeCLIEnv()).effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect((await fakeAgy(dir, "agy-help-1.0.10.txt", "1.0.10").probeCLIEnv()).effortLevels).toEqual([]);
    expect((await fakeAgy(dir, null, "1.3.1").probeCLIEnv()).effortLevels).toBeUndefined();
  });

  describe("probe → cache → reader (the exact chain, scratch AGEND_HOME)", () => {
    const fleet = async () => {
      const { FleetManager } = await import("../src/fleet-manager.js");
      const fm = new FleetManager(scratch()) as any;
      fms.push(fm);
      return async (be: AntigravityBackend) => fm.persistCliEnvProbeResult("antigravity", await be.probeCLIEnv());
    };
    const fms: any[] = [];
    afterEach(() => {
      for (const fm of fms.splice(0)) { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); fm.memoryPressure.stop(); }
      vi.useRealTimers();
    });
    const FIVE = ["low", "medium", "high", "xhigh", "max"];
    const THREE = ["low", "medium", "high"];

    it("same version, help failed this time → the cached levels stay", async () => {
      vi.stubEnv("AGEND_HOME", scratch());
      const probe = await fleet(), dir = scratch();
      await probe(fakeAgy(dir, "agy-help-1.3.1.txt", "1.3.1"));
      await probe(fakeAgy(dir, null, "1.3.1"));
      expect(agyEffortLevels()).toEqual(FIVE);
    });

    it("same version, help read and listing none → that answer is written (three), not the cached five", async () => {
      vi.stubEnv("AGEND_HOME", scratch());
      const probe = await fleet(), dir = scratch();
      await probe(fakeAgy(dir, "agy-help-1.3.1.txt", "1.3.1"));
      await probe(fakeAgy(dir, "agy-help-1.0.10.txt", "1.3.1"));
      expect(agyEffortLevels()).toEqual(THREE);
    });

    it("a new binary whose help lists none (1.3.1 → 1.0.10) → three, not the old five", async () => {
      vi.stubEnv("AGEND_HOME", scratch());
      const probe = await fleet(), dir = scratch();
      await probe(fakeAgy(dir, "agy-help-1.3.1.txt", "1.3.1"));
      const env = await probe(fakeAgy(dir, "agy-help-1.0.10.txt", "1.0.10"));
      expect(env.version).toContain("1.0.10");
      expect(agyEffortLevels()).toEqual(THREE);
      expect(new AntigravityBackend(scratch()).getEffortLevels()).toEqual(THREE);
    });

    it("help failed and the version changed, or is unknown → the old levels are not carried", async () => {
      for (const next of ["1.4.0", null]) {
        vi.stubEnv("AGEND_HOME", scratch());
        const probe = await fleet(), dir = scratch();
        await probe(fakeAgy(dir, "agy-help-1.3.1.txt", "1.3.1"));
        await probe(fakeAgy(dir, null, next));
        expect(agyEffortLevels(), String(next)).toEqual(THREE);
      }
    });

    it("past the CLI env TTL the cache is not read, and a later failed help does not revive it", async () => {
      const { CLI_ENV_TTL_MS } = await import("../src/backend/types.js");
      vi.stubEnv("AGEND_HOME", scratch());
      vi.useFakeTimers({ toFake: ["Date"] });
      const t0 = Date.UTC(2026, 9, 7);
      vi.setSystemTime(t0);
      const probe = await fleet(), dir = scratch();
      await probe(fakeAgy(dir, "agy-help-1.3.1.txt", "1.3.1"));
      vi.setSystemTime(t0 + CLI_ENV_TTL_MS - 1);
      expect(agyEffortLevels()).toEqual(FIVE);
      vi.setSystemTime(t0 + CLI_ENV_TTL_MS);
      expect(agyEffortLevels()).toEqual(THREE);
      await probe(fakeAgy(dir, null, "1.3.1"));                                         // same version, but stale
      expect(agyEffortLevels()).toEqual(THREE);
    });
  });
});

