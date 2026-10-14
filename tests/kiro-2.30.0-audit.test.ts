/**
 * #1784: kiro-cli 2.30.0 against the 2.29.0 baseline (tests/fixtures/kiro-2.30.0-audit/README.md). 2.30.0 renamed
 * "3.0" to "V3" in all three launch prompts, so the 2.29 specs matched none of them: the Classic nudge AgEnD's pinned
 * legacy launch meets was neither answered nor held. The 2.30 wording gets the same answers — one Down off "Switch to
 * V3", Enter only on the option that changes nothing — and the 2.29 wording keeps its own.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { KIRO_CLASSIC_NUDGE, KIRO_CLASSIC_NUDGE_V3, KiroBackend, kiroLaunchPromptState, planKiroLaunch, probeKiroCliCompatibility } from "../src/backend/kiro.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const live = (name: string) => readFileSync(join(FIXTURES, "kiro-2.30.0-audit", `${name}.pane.txt`), "utf-8");
const live229 = (name: string) => readFileSync(join(FIXTURES, "kiro-2.29.0-audit", `${name}.pane.txt`), "utf-8");
const PROMPTS = readFileSync(join(FIXTURES, "kiro-2.30.0-audit", "kiro-cli-chat-2.30.0.prompts.txt"), "utf-8");
const HELP_230 = readFileSync(join(FIXTURES, "kiro-help", "chat-help-2.30.0.txt"), "utf-8");
const compat = () => probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => (args[0] === "--version" ? "kiro-cli 2.30.0\n" : HELP_230));
const backend = () => new KiroBackend("/tmp/kiro-230", compat());
const active = (dialogs: RuntimeDialog[], screen: string) => dialogs.filter(d => (d.isActive ? d.isActive(screen) : d.pattern.test(screen)));
const tables = [["startup", (b: KiroBackend) => b.getStartupDialogs()], ["runtime", (b: KiroBackend) => b.getRuntimeDialogs()]] as const;

describe("kiro-cli 2.30.0: the Classic nudge, captured live", () => {
  it("the 2.29 spec does not recognise it — the regression this fixes", () => {
    expect(kiroLaunchPromptState(live("120-cursor-switch"), KIRO_CLASSIC_NUDGE)).toEqual({ active: false, cursor: null });
    expect(kiroLaunchPromptState(live("120-cursor-switch"), KIRO_CLASSIC_NUDGE_V3)).toEqual({ active: true, cursor: 0 });
  });

  it.each(tables.flatMap(([table, dialogs]) => (["120", "80"] as const).map(width => [table, width, dialogs] as const)))(
    "%s table, %s columns: ONE Down off 'Switch to V3', Enter only on 'Remind me later'",
    (_table, width, dialogs) => {
      const step = active(dialogs(backend()), live(`${width}-cursor-switch`));
      expect(step[0]!.keys).toEqual(["Down"]);
      expect(step[0]!.autoResolutionKey).toBe("kiro-classic-nudge-step");
      expect(step[0]!.inputBlocked).toBe(true);
      expect(step.some(d => d.keys.includes("Enter"))).toBe(false);

      expect(kiroLaunchPromptState(live(`${width}-cursor-remind`), KIRO_CLASSIC_NUDGE_V3)).toEqual({ active: true, cursor: 1 });
      const confirm = active(dialogs(backend()), live(`${width}-cursor-remind`));
      expect(confirm[0]!.keys).toEqual(["Enter"]);
      expect(confirm[0]!.description).toContain("Remind me later");
    },
  );

  it.each(tables)("%s table: nothing once answered", (_table, dialogs) => {
    expect(active(dialogs(backend()), live("120-answered"))).toEqual([]);
  });

  it.each(tables)("%s table: an unrecognised cursor is held, never keyed", (_table, dialogs) => {
    const screen = live("120-cursor-switch").replace("❯ Switch to V3", "● Switch to V3");
    const found = active(dialogs(backend()), screen);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(d => d.holdOnly && d.keys.length === 0)).toBe(true);
  });

  it("2.29.0's wording is still answered the same way", () => {
    expect(active(backend().getStartupDialogs(), live229("120-cursor-switch"))[0]!.keys).toEqual(["Down"]);
    expect(active(backend().getStartupDialogs(), live229("120-cursor-remind"))[0]!.keys).toEqual(["Enter"]);
  });
});

/** The two prompts not reachable offline, painted the way kiro paints the nudge, from the 2.30.0 binary's own text. */
describe("kiro-cli 2.30.0: the reworded ease-in and agent-config prompts (binary text)", () => {
  const easeOptions = ["Switch to V3 and upgrade my configs", "Remind me later", "Don't ask again"];
  const upgradeOptions = ["Enable auto-upgrade", "Not now — I'll do it later"];
  const paint = (lines: string[], options: string[], cursor: number) =>
    [...lines, ...options.map((o, i) => `${i === cursor ? "❯" : " "} ${o}`)].join("\n");
  const easeIn = (cursor: number) => paint(["You're using Kiro CLI V2. Switch to V3 today.",
    "V3 adds workflows, cloud sessions, and specs. To try it in a new session, run kiro-cli --v3. Learn more: https://kiro.dev/docs/cli/v3/"], easeOptions, cursor);
  const upgrade = (cursor: number) => paint(["You're on Kiro CLI V3 — thanks for giving it a try.",
    "Your agent configs are still in the V2 format. Upgrade them to run on V3? They'll keep working in V2."], upgradeOptions, cursor);

  it("every line painted here is the binary's own text", () => {
    for (const text of [...easeIn(0).split("\n").slice(0, 2), ...upgrade(0).split("\n").slice(0, 2), "Switch to V3 and upgrade my configsRemind me laterDon't ask again", "Enable auto-upgradeNot now"]) {
      expect(PROMPTS, text).toContain(text);
    }
  });

  it.each(tables)("%s table: ease-in — Down off 'Switch to V3', Enter only on 'Remind me later', 'Don't ask again' held", (_table, dialogs) => {
    expect(active(dialogs(backend()), easeIn(0)).map(d => d.keys)).toEqual([["Down"], []]);
    const confirm = active(dialogs(backend()), easeIn(1));
    expect(confirm.map(d => d.keys)).toEqual([["Enter"], []]);
    expect(confirm[0]!.description).toContain("Remind me later");
    expect(active(dialogs(backend()), easeIn(2)).map(d => d.keys)).toEqual([[]]);
  });

  it.each(tables)("%s table: agent configs — Down off 'Enable auto-upgrade', Enter only on 'Not now'", (_table, dialogs) => {
    expect(active(dialogs(backend()), upgrade(0)).map(d => d.keys)).toEqual([["Down"], []]);
    expect(active(dialogs(backend()), upgrade(1)).map(d => d.keys)).toEqual([["Enter"], []]);
  });
});

describe("kiro-cli 2.30.0: the launch is still pinned", () => {
  it("chat-help-2.30.0.txt is the binary's own --help — byte-identical to 2.29.0's", () => {
    const sha = (name: string) => createHash("sha256").update(readFileSync(join(FIXTURES, "kiro-help", name))).digest("hex");
    expect(sha("chat-help-2.30.0.txt")).toBe("34f05faf09a5eacb0df1fb81cbcb6ad8049e02f86f85f143288150a7da6dac39");
    expect(sha("chat-help-2.30.0.txt")).toBe(sha("chat-help-2.29.0.txt"));
  });

  it("legacy → --legacy-ui --agent-engine=v1, tui → --tui --agent-engine=v2", () => {
    const c = compat();
    expect(c).toMatchObject({ source: "version", agentEngines: ["v2", "v1", "v3"], supportsLegacyUi: true, supportsTui: true, supportsV3: true });
    expect(planKiroLaunch("legacy", c)).toEqual({ kind: "launch", ui: "legacy", flags: ["--legacy-ui", "--agent-engine=v1"] });
    expect(planKiroLaunch("tui", c)).toEqual({ kind: "launch", ui: "tui", flags: ["--tui", "--agent-engine=v2"] });
  });
});
