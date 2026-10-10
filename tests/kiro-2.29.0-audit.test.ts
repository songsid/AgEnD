/**
 * kiro-cli 2.29.0 against the 2.28.0 baseline (tests/fixtures/kiro-2.29.0-audit/README.md): the Classic nudge 2.29.0
 * paints live is answered exactly as #1308 answers 2.28.0's — one Down off "Switch to 3.0", Enter only on "Remind me
 * later" — and the launch flags read from 2.29.0's own --help still pin the UI and the engine.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { KIRO_CLASSIC_NUDGE, KIRO_TESTED_MAX, KiroBackend, kiroLaunchPromptState, planKiroLaunch, probeKiroCliCompatibility } from "../src/backend/kiro.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const live = (name: string) => readFileSync(join(FIXTURES, "kiro-2.29.0-audit", `${name}.pane.txt`), "utf-8");
const baseline = (name: string) => readFileSync(join(FIXTURES, "kiro-2.28.0-classic-nudge", `${name}.pane.txt`), "utf-8");
const HELP_229 = readFileSync(join(FIXTURES, "kiro-help", "chat-help-2.29.0.txt"), "utf-8");
const compat = () => probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => (args[0] === "--version" ? "kiro-cli 2.29.0\n" : HELP_229));
const backend = () => new KiroBackend("/tmp/kiro-229", compat());
const active = (dialogs: RuntimeDialog[], screen: string) => dialogs.filter(d => (d.isActive ? d.isActive(screen) : d.pattern.test(screen)));
const trimEnd = (screen: string) => screen.replace(/\s+$/, "");

describe("kiro-cli 2.29.0: the Classic nudge, captured live", () => {
  it("is 2.28.0's prompt, row for row", () => {
    expect(trimEnd(live("120-cursor-switch"))).toBe(trimEnd(baseline("120-cursor-switch")));
    expect(trimEnd(live("120-cursor-remind"))).toBe(trimEnd(baseline("120-cursor-remind")));
  });

  it.each([["startup", (b: KiroBackend) => b.getStartupDialogs()], ["runtime", (b: KiroBackend) => b.getRuntimeDialogs()]] as const)(
    "%s table: ONE Down off 'Switch to 3.0', Enter only on 'Remind me later', nothing once answered",
    (_table, dialogs) => {
      expect(kiroLaunchPromptState(live("120-cursor-switch"), KIRO_CLASSIC_NUDGE)).toEqual({ active: true, cursor: 0 });
      const step = active(dialogs(backend()), live("120-cursor-switch"));
      expect(step[0]!.keys).toEqual(["Down"]);
      expect(step[0]!.autoResolutionKey).toBe("kiro-classic-nudge-step");
      expect(step.some(d => d.keys.includes("Enter"))).toBe(false);

      expect(kiroLaunchPromptState(live("120-cursor-remind"), KIRO_CLASSIC_NUDGE)).toEqual({ active: true, cursor: 1 });
      const confirm = active(dialogs(backend()), live("120-cursor-remind"));
      expect(confirm[0]!.keys).toEqual(["Enter"]);
      expect(confirm[0]!.description).toContain("Remind me later");

      expect(active(dialogs(backend()), live("120-answered"))).toEqual([]);
    },
  );
});

describe("kiro-cli 2.29.0: the launch is still pinned", () => {
  it("chat-help-2.29.0.txt is the binary's own --help, byte for byte", () => {
    const help = readFileSync(join(FIXTURES, "kiro-help", "chat-help-2.29.0.txt"));
    expect(createHash("sha256").update(help).digest("hex")).toBe("34f05faf09a5eacb0df1fb81cbcb6ad8049e02f86f85f143288150a7da6dac39");
  });

  it("read from its help (above TESTED_MAX): legacy → --legacy-ui --agent-engine=v1, tui → --tui --agent-engine=v2", () => {
    const c = compat();
    expect(c).toMatchObject({ source: "help", agentEngines: ["v2", "v1", "v3"], supportsLegacyUi: true, supportsTui: true, supportsV3: true, supportsInstanceAgent: true });
    expect(planKiroLaunch("legacy", c)).toEqual({ kind: "launch", ui: "legacy", flags: ["--legacy-ui", "--agent-engine=v1"] });
    expect(planKiroLaunch("tui", c)).toEqual({ kind: "launch", ui: "tui", flags: ["--tui", "--agent-engine=v2"] });
  });
});

describe("a machine-wide chat.agentEngine=v3 refuses only an engine-less --legacy-ui; AgEnD always names the engine", () => {
  const frame = (name: string) => readFileSync(join(FIXTURES, "kiro-2.29.0-audit", "v3-default", `${name}.pane.txt`), "utf-8");
  const REFUSAL = /can't be used because Kiro CLI 3\.0 is your default \(chat\.agentEngine=v3\)/;

  it("captured: the alias alone is refused on 2.28.0 and 2.29.0; with --agent-engine v1 (either form) Classic runs", () => {
    for (const name of ["2.28.0-legacy-ui-alone-refused", "2.29.0-legacy-ui-alone-refused", "2.29.0-classic-alone-refused"]) expect(frame(name), name).toMatch(REFUSAL);
    for (const name of ["2.29.0-pinned-legacy-snoozed", "2.29.0-pinned-legacy-answered", "2.28.0-pinned-legacy-answered", "2.29.0-agent-engine-v1-alone", "2.29.0-legacy-ui-agent-engine-space-v1"]) {
      expect(frame(name), name).not.toMatch(REFUSAL);
      expect(frame(name), name).toContain("Failed to fetch available models");   // the Classic session itself, offline
    }
  });

  it("with v3 as the default, the nudge still appears before the pinned launch and AgEnD still answers 'Remind me later'", () => {
    for (const name of ["2.28.0-pinned-legacy-nudge", "2.29.0-pinned-legacy-nudge"]) {
      expect(kiroLaunchPromptState(frame(name), KIRO_CLASSIC_NUDGE), name).toEqual({ active: true, cursor: 0 });
      expect(active(backend().getStartupDialogs(), frame(name))[0]!.keys, name).toEqual(["Down"]);
    }
  });

  it("every kiro-cli that has a v3 engine gets --legacy-ui only together with --agent-engine=v1 (version table and help)", () => {
    const versionOnly = (v: string) => probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => { if (args[0] === "--version") return `kiro-cli ${v}\n`; throw new Error("no help"); });
    const fromHelp = (v: string) => probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => (args[0] === "--version" ? `kiro-cli ${v}\n` : readFileSync(join(FIXTURES, "kiro-help", `chat-help-${v}.txt`), "utf-8")));
    const cases = [...["2.8.0", "2.21.0", "2.26.0", KIRO_TESTED_MAX].map(versionOnly), ...["2.28.0", "2.29.0"].map(fromHelp)];
    for (const c of cases) {
      expect(c.supportsV3, c.version).toBe(true);
      const plan = planKiroLaunch("legacy", c);
      expect(plan, c.version).toEqual({ kind: "launch", ui: "legacy", flags: ["--legacy-ui", "--agent-engine=v1"] });
    }
  });
});
