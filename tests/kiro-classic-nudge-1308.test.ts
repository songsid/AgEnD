/**
 * #1308: kiro-cli 2.28.0 asks, before every Classic session, "Classic is being deprecated with the Kiro CLI 3.0
 * release in October…" with `Switch to 3.0 and upgrade my agent configs` / `Remind me later`. Nothing matched it, so
 * a legacy instance sat on it at launch. "Switch" saves v3 as the machine-wide default and reruns the session in 3.0 —
 * a one-way engine move — so it is never confirmed: one verified Down off it, Enter only on a verified cursor on
 * "Remind me later", anything else held for a human.
 *
 * The panes are real: kiro-cli 2.28.0 (stable, sha256-verified tarball) launched with AgEnD's legacy argv in an isolated
 * HOME, offline (no network namespace, a dummy local token: no account), captured with tmux capture-pane at 80, 60 and
 * 120 columns, before and after one Down, and after "Remind me later". The help is that binary's `chat --help`.
 * No daemon, CLI or tmux runs here (bd0c88aa); the daemon tests stub tmux.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KIRO_CLASSIC_NUDGE, KIRO_TESTED_MAX, KiroBackend, kiroLaunchPromptState, planKiroLaunch, probeKiroCliCompatibility } from "../src/backend/kiro.js";
import type { CliBackendConfig, RuntimeDialog } from "../src/backend/types.js";
import { Daemon } from "../src/daemon.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const pane = (name: string) => readFileSync(join(FIXTURES, "kiro-2.28.0-classic-nudge", `${name}.pane.txt`), "utf-8");
const HELP_228 = readFileSync(join(FIXTURES, "kiro-help", "chat-help-2.28.0.txt"), "utf-8");

const SWITCH = ["80-cursor-switch", "60-cursor-switch", "120-cursor-switch"] as const;
const REMIND = ["80-cursor-remind", "120-cursor-remind"] as const;
const SPEC = KIRO_CLASSIC_NUDGE;

function probe(version: string | null, helpText: string | null) {
  return probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => {
    if (args[0] === "--version") {
      if (version === null) throw new Error("no version");
      return `kiro-cli ${version}\n`;
    }
    if (helpText === null) throw new Error("no help");
    return helpText;
  });
}
const config = (overrides: Partial<CliBackendConfig> = {}): CliBackendConfig =>
  ({ workingDirectory: "/tmp/kiro-1308", instanceName: "kiro-1308", instanceDir: "/tmp/kiro-1308", mcpServers: {}, ...overrides } as CliBackendConfig);

const backend = () => new KiroBackend("/tmp/kiro-1308", probe("2.28.0", HELP_228));
const matches = (dialogs: RuntimeDialog[], screen: string) => dialogs.filter(d => (d.isActive ? d.isActive(screen) : d.pattern.test(screen)));
const startup = (screen: string) => matches(backend().getStartupDialogs(), screen);
const runtime = (screen: string) => matches(backend().getRuntimeDialogs(), screen);
const TABLES = [["startup", startup], ["runtime", runtime]] as const;
/** The daemon acts on the first match; the nudge's catch-all hold follows its answer. */
const answerThenHold = (found: RuntimeDialog[]) => {
  expect(found.slice(1).map(d => d.holdOnly)).toEqual([true]);
  return found[0]!;
};

describe("the captured prompt", () => {
  it.each(SWITCH)("%s: active, cursor on 'Switch to 3.0'", name => {
    expect(kiroLaunchPromptState(pane(name), SPEC)).toEqual({ active: true, cursor: 0 });
  });
  it.each(REMIND)("%s: after one Down, cursor on 'Remind me later'", name => {
    expect(kiroLaunchPromptState(pane(name), SPEC)).toEqual({ active: true, cursor: 1 });
  });
  it("answered: the description stays on screen, the options are gone — no longer a prompt", () => {
    expect(pane("80-answered")).toContain("Classic is being deprecated");
    expect(kiroLaunchPromptState(pane("80-answered"), SPEC)).toEqual({ active: false, cursor: null });
  });
});

describe("AgEnD's answer: Down off 'Switch to 3.0', Enter only on 'Remind me later'", () => {
  it.each(TABLES.flatMap(([table, active]) => SWITCH.map(name => [table, name, active] as const)))(
    "%s, %s: ONE verified Down, never Enter",
    (_table, name, active) => {
      const dialog = answerThenHold(active(pane(name)));
      expect(dialog.keys).toEqual(["Down"]);
      expect(dialog.description).toContain("Switch to 3.0");
      expect(dialog.blocksDelivery).toBe(true);
      expect(dialog.inputBlocked).toBe(true);        // re-verified under the pane lock
      expect(dialog.verifyAfterKeys).toBe(true);     // the next capture decides, not the key
      expect(dialog.autoResolutionKey).toBe("kiro-classic-nudge-step"); // one shot
    },
  );

  it.each(TABLES.flatMap(([table, active]) => REMIND.map(name => [table, name, active] as const)))(
    "%s, %s: Enter, on 'Remind me later'",
    (_table, name, active) => {
      const dialog = answerThenHold(active(pane(name)));
      expect(dialog.keys).toEqual(["Enter"]);
      expect(dialog.description).toContain("Remind me later");
      expect(dialog.autoResolutionKey).toBe("kiro-classic-nudge-confirm");
    },
  );

  it("no entry in either table would ever press Enter while the cursor is on 'Switch to 3.0'", () => {
    for (const dialogs of [backend().getStartupDialogs(), backend().getRuntimeDialogs()]) {
      for (const name of SWITCH) {
        const pressing = dialogs.filter(d => d.keys.some(k => /enter|\r|\n/i.test(k)) && (d.isActive ? d.isActive(pane(name)) : d.pattern.test(pane(name))));
        expect(pressing, name).toEqual([]);
      }
    }
  });

  it("answered: nothing to do", () => {
    expect(startup(pane("80-answered"))).toEqual([]);
    expect(runtime(pane("80-answered"))).toEqual([]);
  });
});

describe("anything else is held for a human, never answered", () => {
  const swapGlyph = (screen: string, glyph: string) => screen.replace("❯ Switch", `${glyph} Switch`);
  it.each([
    ["an unrecognised cursor glyph", swapGlyph(pane("80-cursor-switch"), "●")],
    ["no cursor at all", pane("80-cursor-switch").replace("❯ Switch", "  Switch")],
    ["two cursors", pane("80-cursor-switch").replace("  Remind", "❯ Remind")],
  ])("%s", (_label, screen) => {
    for (const [, active] of TABLES) {
      const found = active(screen);
      expect(found.map(d => ({ hold: d.holdOnly, keys: d.keys }))).toEqual([{ hold: true, keys: [] }]);
      expect(found[0]!.blocksDelivery).toBe(true);
    }
  });

  it("the prompt quoted in history with kiro's composer below it is not a dialog", () => {
    for (const tail of ["some answer text\n12% !> ", "[my-agent] 3% λ !> "]) {
      const quoted = `${pane("80-cursor-remind").trimEnd()}\n${tail}`;
      expect(startup(quoted)).toEqual([]);
      expect(runtime(quoted)).toEqual([]);
    }
  });

  it("2.27's non-interactive banner is still not a dialog", () => {
    const banner = readFileSync(join(FIXTURES, "kiro-2.27.0-legacy-deprecation-ready.pane.txt"), "utf-8");
    expect(startup(banner)).toEqual([]);
    expect(runtime(banner)).toEqual([]);
  });
});

describe("2.28.0 keeps AgEnD's pins", () => {
  it("is above the tested maximum, so its flags come from its own --help, and they are the same pins as 2.27", () => {
    expect(KIRO_TESTED_MAX).toBe("2.27.0");
    const compat = probe("2.28.0", HELP_228);
    expect(compat.source).toBe("help");
    expect(compat.agentEngines).toEqual(["v2", "v1", "v3"]);
    expect(planKiroLaunch("legacy", compat)).toEqual({ kind: "launch", ui: "legacy", flags: ["--legacy-ui", "--agent-engine=v1"] });
    expect(planKiroLaunch("tui", compat)).toEqual({ kind: "launch", ui: "tui", flags: ["--tui", "--agent-engine=v2"] });
    // The same pins right after `chat`; 2.28 also runs the instance as its own agent (#906; a new instance: fresh).
    expect(new KiroBackend("/tmp/kiro-1308", compat).buildCommand(config()))
      .toMatch(/ chat --legacy-ui --agent-engine=v1 --trust-all-tools --agent '[^']+'$/);
  });
});

describe("on the real daemon (tmux stubbed), from the captured screens", () => {
  const READY = "All tools are now trusted (!).\n1% !> What would you like to do?";

  function makeDaemon(onKey: (key: string, screen: string) => string) {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-kiro-1308-"));
    writeFileSync(join(instanceDir, "window-id"), "@1");
    const be = new KiroBackend(instanceDir, probe("2.28.0", HELP_228));
    be.buildCommand(config({ instanceDir }));
    const daemon = new Daemon("kiro-1308", {
      working_directory: "/tmp", backend: "kiro-cli",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, log_level: "silent",
    } as never, instanceDir, false, be, undefined,
    { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as never) as any;
    const screen = { pane: pane("80-cursor-switch") };
    const keys: string[] = [];
    daemon.tmux = {
      capturePane: vi.fn(async () => screen.pane),
      isWindowAlive: async () => true,
      sendSpecialKey: vi.fn(async (key: string) => { keys.push(key); screen.pane = onKey(key, screen.pane); return true; }),
      sendKeys: vi.fn(async () => true),
    };
    daemon.controlClient = { waitForIdle: async () => {} };
    return { daemon, keys, cleanup: () => rmSync(instanceDir, { recursive: true, force: true }) };
  }

  it("Down, re-read, then Enter on 'Remind me later' — and the session comes up", async () => {
    const { daemon, keys, cleanup } = makeDaemon((key, screen) =>
      key === "Down" && screen === pane("80-cursor-switch") ? pane("80-cursor-remind")
        : key === "Enter" && screen === pane("80-cursor-remind") ? `${pane("80-answered").trimEnd()}\n${READY}`
          : screen);
    try {
      expect(await daemon.dismissDialogsUntilReady(3_000, 0)).toBe(true);
      expect(keys).toEqual(["Down", "Enter"]);
    } finally { cleanup(); }
  });

  it("a Down the cursor did not follow is never followed by Enter: held, deliveries blocked", async () => {
    const { daemon, keys, cleanup } = makeDaemon((_key, screen) => screen);
    try {
      await daemon.dismissDialogsUntilReady(1_500, 0);
      expect(keys).toEqual(["Down"]);
      const probed = await daemon.probeBlockingDialog();
      expect(probed.state).toBe("dialog");
      expect(probed.dialog.holdOnly).toBe(true);
    } finally { cleanup(); }
  });
});

/**
 * The fixtures and the spec are the binary's own text: `binary-strings.txt` holds the nudge's literals copied byte
 * for byte out of kiro-cli-chat 2.28.0 (offsets, the binary's and the tarball's sha256, and the help fixture's sha256
 * recorded in it). A capture or a spec that drifted from what the binary prints fails here.
 */
describe("the fixtures and the spec are the 2.28.0 binary's text", () => {
  const excerpt = readFileSync(join(FIXTURES, "kiro-2.28.0-classic-nudge", "binary-strings.txt"), "utf-8").split("\n");
  const rows = excerpt.filter(l => l && !l.startsWith("#")).map(l => l.split("\t"));
  const description = rows.filter(r => r[0] === "description").map(r => r[2]!);
  const options = rows.filter(r => r[0] === "option").map(r => r[2]!);
  const meta = (key: string) => excerpt.find(l => l.startsWith(`# ${key} `))?.split(" ")[2];

  it("the excerpt names the verified binary", () => {
    expect(meta("tarball-sha256")).toBe("f48ef68df4cc7e83c942ce17e15d2a2c4316d08c6eba8829c4a7b277eba7be5b");
    expect(meta("kiro-cli-chat-sha256")).toMatch(/^[0-9a-f]{64}$/);
    expect(description).toHaveLength(1);
    expect(options).toHaveLength(2);
  });

  it("the spec: its header opens the binary's description, its options are the binary's labels in order", () => {
    expect(description[0]!.startsWith(KIRO_CLASSIC_NUDGE.header)).toBe(true);
    expect(KIRO_CLASSIC_NUDGE.options).toEqual(options);
  });

  /** Only wrapping, ANSI, the cursor glyph and indentation are normalised; every other character must match. */
  const normalise = (screen: string) => {
    const lines = screen.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map(l => l.trimEnd()).filter(Boolean);
    const first = lines.findIndex(l => /^\s*(?:[❯›>]\s+)?Switch to 3\.0/.test(l));
    return {
      description: lines.slice(0, first).join(" "),
      options: lines.slice(first).map(l => l.replace(/^\s*(?:[❯›>]\s+)?/, "")),
    };
  };
  it.each([...SWITCH, ...REMIND])("%s is the binary's text", name => {
    expect(normalise(pane(name))).toEqual({ description: description[0], options });
  });
  it("80-answered keeps the binary's description, and no option", () => {
    expect(normalise(`${pane("80-answered")}\nSwitch to 3.0`).description).toBe(description[0]);
  });

  it("chat-help-2.28.0.txt is the binary's own --help, byte for byte", () => {
    const help = readFileSync(join(FIXTURES, "kiro-help", "chat-help-2.28.0.txt"));
    expect(createHash("sha256").update(help).digest("hex")).toBe(meta("chat-help-2.28.0.txt-sha256"));
  });
});
