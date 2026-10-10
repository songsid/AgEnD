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
import { KIRO_CLASSIC_NUDGE, KiroBackend, kiroLaunchPromptState, planKiroLaunch, probeKiroCliCompatibility } from "../src/backend/kiro.js";

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
