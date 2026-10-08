import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KIRO_TESTED_MAX,
  KiroBackend,
  getCachedKiroCliCompatibility,
  kiroLaunchPromptState,
  parseKiroAgentEngines,
  planKiroLaunch,
  probeKiroCliCompatibility,
  resetKiroCompatibilityCacheForTests,
  type KiroCliCompatibility,
} from "../src/backend/kiro.js";
import { UnsupportedCliError, type CliBackendConfig, type RuntimeDialog } from "../src/backend/types.js";
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { t } from "../src/locale.js";

/**
 * #1109: kiro 3.0 (October 2026) deprecates the classic UI and may default to
 * the V3 engine. An instance's conversation lives in its engine's store, and
 * moving between engines forks it one way — so every launch pins the UI AND
 * the engine, and a binary AgEnD cannot pin to the instance's own engine is
 * refused instead of launched on whatever kiro defaults to.
 *
 * The help samples are `kiro-cli chat --help` from the archived release
 * binaries (prod.download.cli.kiro.dev/stable/<ver>/) and the installed 2.27.0.
 */

const FIXTURES = join(import.meta.dirname, "fixtures");
const help = (version: string) => readFileSync(join(FIXTURES, "kiro-help", `chat-help-${version}.txt`), "utf-8");
const SAMPLES = ["1.26.2", "1.27.0", "2.3.0", "2.4.0", "2.8.0", "2.26.0", "2.27.0"] as const;

/** Probe as if `--version` printed `version` and `chat --help` printed `helpText`. */
function probe(version: string | null, helpText: string | null) {
  const calls: string[][] = [];
  const compat = probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => {
    calls.push(args);
    if (args[0] === "--version") {
      if (version === null) throw new Error("no version");
      return `kiro-cli ${version}\n`;
    }
    if (helpText === null) throw new Error("no help");
    return helpText;
  });
  return { compat, calls };
}

const config = (overrides: Partial<CliBackendConfig> = {}): CliBackendConfig => ({
  workingDirectory: "/tmp/kiro-1109",
  instanceName: "kiro-1109",
  instanceDir: "/tmp/kiro-1109",
  mcpServers: {},
  ...overrides,
} as CliBackendConfig);

/** A kiro 3.0 help built from the real 2.27 one, with `edit` applied. */
const help30 = (edit: (text: string) => string) => edit(help("2.27.0"));
const WITHOUT_LEGACY = (text: string) => text.replace(/^\s*--legacy-ui\n(?:.*\n){1,4}?\n/m, "");
const WITHOUT_V1 = (text: string) => text.replace(/\[possible values: v2, v1, v3\]/, "[possible values: v2, v3]")
  .replace(/"v1", "v2" \(default\), or "v3"/, '"v2", or "v3" (default)');
const WITHOUT_SELECTORS = (text: string) => text
  .replace(/^\s*--agent-engine <ENGINE>\n(?:.*\n){1,5}?\n/m, "")
  .replace(/^\s*--v3\n(?:.*\n){1,3}?\n/m, "");

/** Throws → returns the error; does not throw → null. */
function thrown(fn: () => unknown): unknown {
  try { fn(); return null; } catch (err) { return err; }
}

afterEach(() => {
  resetKiroCompatibilityCacheForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("--agent-engine values come from the option's own block (#1109)", () => {
  it.each([
    ["1.26.2", null],
    ["1.27.0", null],
    ["2.3.0", ["rust", "kas"]],
    ["2.4.0", ["v2", "v1", "kas"]],
    ["2.8.0", ["v2", "v1", "v3"]],
    ["2.26.0", ["v2", "v1", "v3"]],
    ["2.27.0", ["v2", "v1", "v3"]],
  ])("kiro-cli %s", (version, engines) => {
    expect(parseKiroAgentEngines(help(version))).toEqual(engines);
  });

  it("never reads a neighbouring option's values (Prism #6)", () => {
    const text = [
      "      --agent-engine <ENGINE>",
      "          Choose engine",
      "",
      "      --model <MODEL>",
      "          [possible values: v1, v2]",
    ].join("\n");
    expect(parseKiroAgentEngines(text)).toEqual([]); // present, values unknown
    // A neighbour with a short alias ends the block too.
    expect(parseKiroAgentEngines("  --agent-engine <E>\n  -m, --model <M>\n      [possible values: v1]")).toEqual([]);
  });
});

describe("P1: the launch pins the instance's UI and engine", () => {
  const FROM_TABLE: Record<(typeof SAMPLES)[number], string[]> = {
    "1.26.2": [],                                      // classic was the only UI
    "1.27.0": ["--legacy-ui"],                         // no engine choice yet
    "2.3.0": ["--legacy-ui"],                          // rust|kas: `=v1` would exit 2
    "2.4.0": ["--legacy-ui", "--agent-engine=v1"],
    "2.8.0": ["--legacy-ui", "--agent-engine=v1"],
    "2.26.0": ["--legacy-ui", "--agent-engine=v1"],
    "2.27.0": ["--legacy-ui", "--agent-engine=v1"],
  };

  it.each(SAMPLES)("legacy on kiro-cli %s, from the version table", (version) => {
    const { compat } = probe(version, null);
    expect(compat.source).toBe("version");
    expect(planKiroLaunch("legacy", compat)).toEqual({ kind: "launch", ui: "legacy", flags: FROM_TABLE[version] });
  });

  it.each(["2.4.0", "2.8.0", "2.26.0", "2.27.0"] as const)(
    "the --help of kiro-cli %s yields the same pins as the table",
    (version) => {
      const fromHelp = probe(null, help(version)).compat;
      const fromVersion = probe(version, null).compat;
      expect(fromHelp.source).toBe("help");
      for (const ui of ["legacy", "tui"] as const) {
        expect(planKiroLaunch(ui, fromHelp)).toEqual(planKiroLaunch(ui, fromVersion));
      }
    },
  );

  it.each(["1.26.2", "1.27.0", "2.3.0"] as const)(
    "the --help of kiro-cli %s alone does NOT prove it is old: no selector → refused, never launched unpinned (Prism #1)",
    (version) => {
      const fromHelp = probe(null, help(version)).compat; // unidentifiable version
      expect(planKiroLaunch("legacy", fromHelp).kind).toBe("refuse");
    },
  );

  it("never sends a v1 value to 2.3, whose --agent-engine takes rust|kas", () => {
    const cmd = new KiroBackend("/tmp/kiro-1109", probe("2.3.0", null).compat).buildCommand(config());
    expect(cmd).toContain("chat --legacy-ui");
    expect(cmd).not.toContain("--agent-engine");
  });

  it("pins the terminal UI to v2 where it can", () => {
    expect(planKiroLaunch("tui", probe(null, help("2.27.0")).compat))
      .toEqual({ kind: "launch", ui: "tui", flags: ["--tui", "--agent-engine=v2"] });
    expect(planKiroLaunch("tui", probe("2.3.0", null).compat))
      .toEqual({ kind: "launch", ui: "tui", flags: ["--tui"] });
  });

  it("the command puts the pin right after `chat`", () => {
    const cmd = new KiroBackend("/tmp/kiro-1109", probe("2.27.0", null).compat).buildCommand(config());
    expect(cmd).toMatch(/ chat --legacy-ui --agent-engine=v1 --trust-all-tools --resume$/);
  });
});

describe("P2: a binary AgEnD cannot pin is refused, never launched on kiro's default", () => {
  it("3.0 without --legacy-ui: refused with the reason, not moved to the TUI or V3", () => {
    const { compat } = probe("3.0.0", help30(WITHOUT_LEGACY));
    expect(compat.supportsLegacyUi).toBe(false);
    const plan = planKiroLaunch("legacy", compat);
    expect(plan.kind === "refuse" && plan.reason).toContain("legacy UI");
    expect(thrown(() => new KiroBackend("/tmp/kiro-1109", compat).buildCommand(config()))).toBeInstanceOf(UnsupportedCliError);
  });

  it("3.0 that kept --legacy-ui but dropped the v1 engine: refused", () => {
    const { compat } = probe("3.0.0", help30(WITHOUT_V1));
    expect(compat.agentEngines).toEqual(["v2", "v3"]);
    const plan = planKiroLaunch("legacy", compat);
    expect(plan.kind === "refuse" && plan.reason).toContain("v2, v3");
  });

  it("a recognised 3.0 help without any engine selector: refused, not taken for an old binary (Prism #1)", () => {
    const { compat } = probe("3.0.0", help30(WITHOUT_SELECTORS));
    expect(compat.source).toBe("help");
    expect(compat.agentEngines).toBeNull();
    expect(compat.supportsV3).toBe(false);
    for (const ui of ["legacy", "tui"] as const) {
      expect(thrown(() => new KiroBackend("/tmp/kiro-1109", compat).buildCommand(config({ kiroUi: ui })))).toBeInstanceOf(UnsupportedCliError);
    }
  });

  it.each(["legacy", "tui"] as const)(
    "%s: a 3.0 whose valid help lists rust|kas (no v1/v2) is refused — `rust` alone does not prove 2.3 (Prism r2 #1)",
    (ui) => {
      const { compat } = probe("3.0.0", help("2.3.0"));
      expect(compat.source).toBe("help");
      expect(compat.agentEngines).toEqual(["rust", "kas"]);
      expect(thrown(() => new KiroBackend("/tmp/kiro-1109", compat).buildCommand(config({ kiroUi: ui })))).toBeInstanceOf(UnsupportedCliError);
    },
  );

  it.each([
    ["empty", ""],
    ["truncated", "Usage: kiro-cli chat\n\nOptions:\n  --help\n"],
  ])("3.0 with %s help: unknown → retryable failure, never an unpinned chat (Prism #1)", (_label, text) => {
    const { compat } = probe("3.0.0", text);
    expect(compat.source).toBe("unknown");
    const err = thrown(() => new KiroBackend("/tmp/kiro-1109", compat).buildCommand(config()));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnsupportedCliError); // the fleet retries this one
  });

  it("no plan for a legacy or tui instance ever selects V3 or runs unpinned on a binary with a choice", () => {
    const binaries = [
      ...SAMPLES.map(v => probe(null, help(v)).compat),
      ...SAMPLES.map(v => probe(v, null).compat),
      probe("3.0.0", help30(WITHOUT_LEGACY)).compat,
      probe("3.0.0", help30(WITHOUT_V1)).compat,
      probe("3.0.0", help30(WITHOUT_SELECTORS)).compat,
      probe("3.0.0", help30(text => WITHOUT_V1(WITHOUT_LEGACY(text)))).compat,
    ];
    for (const compat of binaries) {
      for (const ui of ["legacy", "tui"] as const) {
        const plan = planKiroLaunch(ui, compat);
        if (plan.kind !== "launch") continue;
        const flags = plan.flags.join(" ");
        expect(flags).not.toMatch(/v3|kas/);
        // Unpinned only with positive evidence that there is nothing to pin.
        if (!/--agent-engine=v[12]/.test(flags)) {
          expect(compat.source).toBe("version");
        }
      }
    }
  });

  it("3.0 whose --help cannot be read is not guessed about: retryable failure, not a launch", () => {
    const { compat } = probe("3.0.0", null);
    expect(compat.source).toBe("unknown");
    const err = thrown(() => new KiroBackend("/tmp/kiro-1109", compat).buildCommand(config()));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnsupportedCliError);
  });
});

/** An executable kiro-cli stub that answers --version and chat --help. */
function writeKiroStub(dir: string, version: string, helpText: string): void {
  const path = join(dir, "kiro-cli");
  const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(path, [
    "#!/bin/sh",
    `if [ "$1" = "--version" ]; then printf '%s\\n' ${quoted(`kiro-cli ${version}`)}; exit 0; fi`,
    `if [ "$1" = "chat" ] && [ "$2" = "--help" ]; then printf '%s' ${quoted(helpText)}; exit 0; fi`,
    "exit 2",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  registerExecutableFixture(path); // pin each deliberately rewritten fake binary
}

describe("P2: a kiro-cli replaced in place is re-read at every launch (Prism #2)", () => {
  it("the same backend that launched 2.27 refuses after the binary becomes a 3.0 without --legacy-ui", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-kiro-stub-"));
    try {
      vi.stubEnv("PATH", `${dir}:/usr/bin:/bin`);
      writeKiroStub(dir, "2.27.0", help("2.27.0"));
      const backend = new KiroBackend("/tmp/kiro-1109");
      expect(backend.buildCommand(config())).toContain(`${join(dir, "kiro-cli")} chat --legacy-ui --agent-engine=v1`);

      writeKiroStub(dir, "3.0.0", help30(WITHOUT_LEGACY)); // auto-update in place
      expect(thrown(() => backend.buildCommand(config()))).toBeInstanceOf(UnsupportedCliError);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("crash-respawn on the replaced binary stops supervision with the refusal — real health tick, real backend, real stub", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-kiro-stub-"));
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-kiro-respawn-"));
    vi.useFakeTimers();
    try {
      vi.stubEnv("PATH", `${dir}:/usr/bin:/bin`);
      writeKiroStub(dir, "2.27.0", help("2.27.0"));
      const backend = new KiroBackend(instanceDir);
      const launched: string[] = [];
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const daemon = new Daemon("kiro-respawn", {
        working_directory: "/tmp",
        backend: "kiro-cli",
        restart_policy: { max_retries: 3, backoff: "linear", reset_after: 0, health_check_interval_ms: 25 },
        context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
        log_level: "silent",
      } as any, instanceDir, false, backend as any, undefined, { child: () => logger } as any) as any;
      daemon.tmux = {
        getPaneStatus: vi.fn(async () => ({ alive: false, exitCode: 1 })),
        capturePaneWithHistory: vi.fn(async () => "kiro exited"),
        capturePane: vi.fn(async () => ""),
        killWindow: vi.fn(async () => {}),
      };
      vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([]); // no real tmux server here
      daemon.stopInstanceStateMonitor = vi.fn();
      daemon.startInstanceStateMonitor = vi.fn();
      daemon.killProcessTree = vi.fn(async () => {});
      // The spawn layer below buildCommand needs a real tmux; everything above
      // it — the tick, the crash branch, spawnClaudeWindow, the backend's
      // re-probe of the binary on disk — is the production path.
      daemon.trySpawn = vi.fn(async () => {
        launched.push(backend.buildCommand(config({ instanceDir })));
        return true;
      });
      const ended: Array<{ reason: string }> = [];
      daemon.on("supervision_ended", (e: { reason: string }) => ended.push(e));

      writeKiroStub(dir, "3.0.0", help30(WITHOUT_LEGACY)); // updated under the running instance
      daemon.startHealthCheck();
      await vi.advanceTimersByTimeAsync(25);     // tick: the pane is dead → crash branch
      await vi.advanceTimersByTimeAsync(10_000); // linear backoff, then the respawn's own settle waits

      expect(launched).toEqual([]);              // nothing was launched on the 3.0 binary
      expect(daemon.healthCheckPaused).toBe(true);
      expect(ended).toHaveLength(1);
      expect(ended[0].reason).toContain("no longer offers the legacy UI");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ended).toHaveLength(1);             // stopped, not failing every tick
    } finally {
      vi.clearAllTimers();
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

describe("P3: version gate", () => {
  it("a version AgEnD has run is answered from the table — no second CLI call", () => {
    expect(probe(KIRO_TESTED_MAX, help("2.27.0")).calls).toEqual([["--version"]]);
  });

  it.each(["2.27.1", "2.28.0", "3.0.0"])("kiro-cli %s (newer than tested) is read from its --help", (version) => {
    const { calls, compat } = probe(version, help("2.27.0"));
    expect(calls).toEqual([["--version"], ["chat", "--help"]]);
    expect(compat.source).toBe("help");
  });

  it("an untested 2.x whose help cannot be read falls back to the 2.x table", () => {
    const { compat } = probe("2.28.0", null);
    expect(compat.source).toBe("version");
    expect(planKiroLaunch("legacy", compat)).toEqual({ kind: "launch", ui: "legacy", flags: ["--legacy-ui", "--agent-engine=v1"] });
  });

  it("warns below the supported minimum and above the tested maximum — once per binary, never blocking", () => {
    const old = new KiroBackend("/tmp/kiro-1109", probe("2.14.2", null).compat);
    expect(thrown(() => old.buildCommand(config()))).toBeNull();
    expect(old.consumeLaunchWarning()).toBe(t("kiro.version_below_supported", "kiro-cli 2.14.2", "2.21.0"));
    expect(old.consumeLaunchWarning()).toBeNull();

    const tested = new KiroBackend("/tmp/kiro-1109", probe("2.24.0", null).compat);
    tested.buildCommand(config());
    expect(tested.consumeLaunchWarning()).toBeNull();

    const newer = new KiroBackend("/tmp/kiro-1109", probe("2.28.0", help("2.27.0")).compat);
    newer.buildCommand(config());
    expect(newer.consumeLaunchWarning()).toBe(t("kiro.version_untested", "kiro-cli 2.28.0", KIRO_TESTED_MAX));
    newer.buildCommand(config());
    expect(newer.consumeLaunchWarning()).toBeNull(); // once per binary generation
  });

  it("an unknown probe result is re-probed after a minute, not cached for the binary's lifetime", () => {
    vi.useFakeTimers();
    let answer = false;
    const run = vi.fn((_bin: string, args: string[]) => {
      if (!answer) throw new Error("timed out");
      return args[0] === "--version" ? "kiro-cli 2.27.0\n" : help("2.27.0");
    });
    const binary = join(FIXTURES, "kiro-help", "chat-help-2.27.0.txt"); // any existing file: a stable cache key
    expect(getCachedKiroCliCompatibility(binary, run).source).toBe("unknown");
    answer = true;
    expect(getCachedKiroCliCompatibility(binary, run).source).toBe("unknown"); // within the TTL
    vi.advanceTimersByTime(60_001);
    expect(getCachedKiroCliCompatibility(binary, run).source).toBe("version");
  });
});

describe("P4: launch prompts that would move an instance off its engine", () => {
  const backend = () => new KiroBackend("/tmp/kiro-1109", probe("2.27.0", null).compat);
  const matches = (dialogs: RuntimeDialog[], pane: string) =>
    dialogs.filter(d => (d.isActive ? d.isActive(pane) : d.pattern.test(pane)));
  // The daemon acts on the FIRST matching entry; a catch-all hold always
  // follows the answer entries, so every active prompt also matches it.
  const startup = (pane: string) => matches(backend().getStartupDialogs(), pane);
  const runtime = (pane: string) => matches(backend().getRuntimeDialogs(), pane);
  const onlyHoldAfter = (found: RuntimeDialog[]) => expect(found.slice(1).map(d => d.holdOnly)).toEqual([true]);

  const EASE_IN = ["Switch to 3.0 and upgrade my configs", "Remind me later", "Don't ask again"];
  const easeIn = (cursor: number, glyph = "❯") => [
    "CLI 3.0 is becoming the default experience.",
    "It brings cloud sessions, tangents, specs, global hooks, and other enhancements. Learn more: https://kiro.dev/docs/cli/v3/",
    "",
    ...EASE_IN.map((o, i) => `${i === cursor ? glyph : " "} ${o}`),
  ].join("\n");
  const UPGRADE_HEADER = ["You're on Kiro 3.0 — thanks for giving it a try.",
    "Your agent configs are still in the 2.0 format. Upgrade them to run on 3.0? They'll keep working in 2.0."];
  const upgrade = (cursor: number) => [...UPGRADE_HEADER,
    ...["Enable auto-upgrade", "Not now — I'll do it later"].map((o, i) => `${i === cursor ? "❯" : " "} ${o}`)].join("\n");

  it("state: bottom-anchored, cursor known only for one recognised glyph", () => {
    const spec = { header: "CLI 3.0 is becoming the default experience", options: EASE_IN };
    expect(kiroLaunchPromptState(easeIn(0), spec)).toEqual({ active: true, cursor: 0 });
    expect(kiroLaunchPromptState(easeIn(1), spec)).toEqual({ active: true, cursor: 1 });
    expect(kiroLaunchPromptState(easeIn(1, "●"), spec)).toEqual({ active: true, cursor: null });
    expect(kiroLaunchPromptState(`${easeIn(0)}\n↑/↓ to navigate · enter to select`, spec)).toEqual({ active: true, cursor: 0 });
  });

  it.each([["startup", startup], ["runtime", runtime]] as const)(
    "%s: cursor on 'Switch to 3.0' → ONE Down, never Enter",
    (_table, active) => {
      const found = active(easeIn(0));
      const [dialog] = found;
      onlyHoldAfter(found);
      expect(dialog.keys).toEqual(["Down"]);
      expect(dialog.inputBlocked).toBe(true);    // re-verified under the pane lock
      expect(dialog.verifyAfterKeys).toBe(true);
      expect(dialog.autoResolutionKey).toBeTruthy(); // one shot
    },
  );

  it.each([["startup", startup], ["runtime", runtime]] as const)(
    "%s: only a capture showing the cursor on 'Remind me later' gets Enter",
    (_table, active) => {
      const found = active(easeIn(1));
      const [dialog] = found;
      onlyHoldAfter(found);
      expect(dialog.keys).toEqual(["Enter"]);
      expect(dialog.description).toContain("Remind me later");
    },
  );

  it.each([
    ["the cursor on 'Don't ask again' (saved for the whole machine)", easeIn(2)],
    ["an unrecognised cursor glyph", easeIn(0, "●")],
    ["no cursor at all", easeIn(9)],
  ])("held for a human, in both tables: %s", (_label, pane) => {
    for (const active of [startup, runtime]) {
      const found = active(pane);
      expect(found.map(d => d.holdOnly)).toEqual([true]);
      expect(found[0].blocksDelivery).toBe(true);
      expect(found[0].inputBlocked).toBe(true);
    }
  });

  it("a Down that did not move the cursor is held, not followed by Enter (one-shot step, then hold)", () => {
    const dialogs = backend().getStartupDialogs();
    const step = dialogs.find(d => d.keys.join() === "Down" && d.isActive?.(easeIn(0)))!;
    // The daemon skips an attempted one-shot; what is left for the same screen:
    const after = dialogs.filter(d => d !== step && d.isActive?.(easeIn(0)));
    expect(after.map(d => ({ hold: d.holdOnly, keys: d.keys }))).toEqual([{ hold: true, keys: [] }]);
  });

  it.each([
    ["V3 ease-in", easeIn(0)],
    ["agent-config upgrade", upgrade(0)],
  ])("%s quoted in history, cursor glyph and all, with the composer back below it: not a dialog (Prism #3a)", (_label, prompt) => {
    for (const tail of ["some answer text\n12% !> ", "12% !> ", "[my-agent] 3% λ !> "]) {
      const pane = `${prompt}\n${tail}`;
      expect(startup(pane)).toEqual([]);
      expect(runtime(pane)).toEqual([]);
    }
  });

  it("a header in history with the composer between it and option-looking rows below is not a dialog", () => {
    // e.g. the user pasted the prompt's header, then kiro's reply listed the
    // choices: the composer row shows the header belongs to an earlier screen.
    const pane = [
      "CLI 3.0 is becoming the default experience.",
      "12% !> what are the options?",
      ...EASE_IN.map((o, i) => `${i === 0 ? "❯" : " "} ${o}`),
    ].join("\n");
    expect(startup(pane)).toEqual([]);
    expect(runtime(pane)).toEqual([]);
  });

  it("2.0-format agent-config upgrade: one Down off 'Enable auto-upgrade', Enter only on 'Not now'", () => {
    expect(startup(upgrade(0)).map(d => d.keys)).toEqual([["Down"], []]);
    expect(startup(upgrade(1)).map(d => d.keys)).toEqual([["Enter"], []]);
  });

  it("2.27's 'Classic is being deprecated' banner leaves a ready, idle, dialog-free legacy pane (live capture)", () => {
    const pane = readFileSync(join(FIXTURES, "kiro-2.27.0-legacy-deprecation-ready.pane.txt"), "utf-8");
    expect(pane).toContain("Classic is being deprecated");
    const be = backend();
    be.buildCommand(config());
    expect(be.getReadyPattern().test(pane)).toBe(true);
    expect(be.getBusyPattern().test(pane)).toBe(false);
    const lastRow = pane.trimEnd().split("\n").at(-1)!;
    expect(be.getBottomReadyPattern()!.test(lastRow)).toBe(true);
    expect(startup(pane)).toEqual([]);
    expect(runtime(pane)).toEqual([]);
  });
});

describe("P4 on the real daemon: startup scan and runtime probe (Prism #3, #4)", () => {
  const EASE = ["Switch to 3.0 and upgrade my configs", "Remind me later", "Don't ask again"];
  const prompt = (cursor: number, glyph = "❯") => [
    "CLI 3.0 is becoming the default experience.",
    "It brings cloud sessions, tangents, specs, global hooks, and other enhancements. Learn more: https://kiro.dev/docs/cli/v3/",
    "",
    ...EASE.map((o, i) => `${i === cursor ? glyph : " "} ${o}`),
  ].join("\n");
  const READY = "All tools are now trusted (!).\n1% !> What would you like to do?";

  function makeDaemon(initial: string, onKey: (key: string, pane: string) => string) {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-kiro-prompt-"));
    writeFileSync(join(instanceDir, "window-id"), "@1");
    const backend = new KiroBackend(instanceDir, probe("2.27.0", null).compat);
    backend.buildCommand(config({ instanceDir }));
    const daemon = new Daemon("kiro-prompt", {
      working_directory: "/tmp", backend: "kiro-cli",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
    } as any, instanceDir, false, backend, undefined,
    { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as any) as any;
    const screen = { pane: initial };
    const keys: string[] = [];
    daemon.tmux = {
      capturePane: vi.fn(async () => screen.pane),
      isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (key: string) => { keys.push(key); screen.pane = onKey(key, screen.pane); return true; }),
      sendKeys: vi.fn(async () => true),
    };
    daemon.controlClient = { waitForIdle: async () => {} };
    return { daemon, screen, keys, cleanup: () => rmSync(instanceDir, { recursive: true, force: true }) };
  }

  it("steps Down, re-reads the screen, and confirms 'Remind me later' only once the cursor is seen there", async () => {
    const { daemon, keys, cleanup } = makeDaemon(prompt(0), (key, pane) =>
      key === "Down" && pane === prompt(0) ? prompt(1) : key === "Enter" && pane === prompt(1) ? READY : pane);
    try {
      expect(await daemon.dismissDialogsUntilReady(3_000, 0)).toBe(true);
      expect(keys).toEqual(["Down", "Enter"]);
    } finally { cleanup(); }
  });

  it("a Down that tmux accepted but the cursor did not follow is never followed by Enter: held and parked", async () => {
    const { daemon, keys, cleanup } = makeDaemon(prompt(0), (_key, pane) => pane); // screen never moves
    try {
      await daemon.dismissDialogsUntilReady(1_500, 0);
      expect(keys).toEqual(["Down"]);
      const probed = await daemon.probeBlockingDialog();
      expect(probed.state).toBe("dialog");
      expect(probed.dialog.holdOnly).toBe(true);
      const parked: unknown[] = [];
      daemon.on("dialog_parked", (event: unknown) => parked.push(event));
      const started = Date.now();
      const clock = vi.spyOn(Date, "now");
      try {
        clock.mockReturnValue(started);
        await daemon.probeBlockingDialog();
        clock.mockReturnValue(started + 61_000);
        await daemon.probeBlockingDialog();
        expect(parked).toEqual([expect.objectContaining({ holdOnly: true })]);
      } finally { clock.mockRestore(); }
      expect(keys).toEqual(["Down"]);
    } finally { cleanup(); }
  });

  it.each([
    ["an unrecognised cursor glyph", prompt(0, "●")],
    ["the cursor on 'Don't ask again'", prompt(2)],
  ])("%s: no key at all, delivery blocked", async (_label, pane) => {
    const { daemon, keys, cleanup } = makeDaemon(pane, (_k, p) => p);
    try {
      await daemon.dismissDialogsUntilReady(800, 0);
      expect(keys).toEqual([]);
      expect((await daemon.probeBlockingDialog()).state).toBe("dialog");
    } finally { cleanup(); }
  });

  it.each([
    "12% !> explain Enter",
    "12% !> describe this selection",
    "[my-agent] 3% λ !> explain esc",
  ])("cursor on 'Remind me later' with the composer right below the options (%s): no Enter (Prism r2 #2)", async (composer) => {
    const quoted = [
      "CLI 3.0 is becoming the default experience.",
      ...EASE.map((o, i) => `${i === 1 ? "❯" : " "} ${o}`),
      composer,
    ].join("\n");
    const { daemon, keys, cleanup } = makeDaemon(quoted, (_k, p) => p);
    try {
      await daemon.dismissDialogsUntilReady(800, 0);
      expect(keys).toEqual([]);
      expect((await daemon.probeBlockingDialog()).state).toBe("clear");
    } finally { cleanup(); }
  });

  it("the prompt quoted in a transcript, cursor glyph and all, with the composer below: ready, no keys, probe clear", async () => {
    const { daemon, keys, cleanup } = makeDaemon(`${prompt(0)}\nsome answer\n12% !> `, (_k, p) => p);
    try {
      expect(await daemon.dismissDialogsUntilReady(1_000, 0)).toBe(true);
      expect(keys).toEqual([]);
      expect((await daemon.probeBlockingDialog()).state).toBe("clear");
    } finally { cleanup(); }
  });
});

describe("compatibility shape", () => {
  it("records what the help offers", () => {
    const c: KiroCliCompatibility = probe(null, help("2.27.0")).compat;
    expect(c).toMatchObject({ supportsLegacyUi: true, supportsTui: true, supportsV3: true, supportsEffortFlag: true, source: "help" });
  });
});
import { registerExecutableFixture } from "./support/process-guard.js";
