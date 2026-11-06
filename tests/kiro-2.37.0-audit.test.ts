/**
 * kiro-cli 2.37.0 against 2.36.0, statically (tests/fixtures/kiro-2.37.0-audit/README.md): the V2-format agent-config
 * upgrade prompt is gone — a printed hint replaces it, and that hint trips none of AgEnD's detectors. The evidence for
 * the new Kiro CLI 3.0 launch machinery is kept here too; AgEnD does not handle it yet (see the README).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { KiroBackend, probeKiroCliCompatibility } from "../src/backend/kiro.js";

const DIR = join(import.meta.dirname, "fixtures", "kiro-2.37.0-audit");
const evidence = (name: string) => readFileSync(join(DIR, name), "utf-8");
/** The `count '<needle>': N` lines of one version's section. */
function counts(file: string, version: string): Record<string, number> {
  const text = evidence(file), at = text.indexOf(`## ${version} kiro-cli-chat`), end = text.indexOf("\n## ", at + 1);
  const section = text.slice(at, end < 0 ? undefined : end);
  return Object.fromEntries([...section.matchAll(/^count '(.+)': (\d+)$/gm)].map(m => [m[1]!, Number(m[2])]));
}
const HELP_234 = readFileSync(join(import.meta.dirname, "fixtures", "kiro-help", "chat-help-2.34.0.txt"), "utf-8");
const backend = () => {
  const b = new KiroBackend("/tmp/kiro-237", probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => (args[0] === "--version" ? "kiro-cli 2.34.0\n" : HELP_234)));
  (b as unknown as { activeTrustAll: boolean }).activeTrustAll = true;
  return b;
};
const active = (dialogs: RuntimeDialog[], screen: string) =>
  dialogs.filter(d => (d.isActive ? d.isActive(screen) : (d.pattern.lastIndex = 0, d.pattern.test(screen))));

describe("kiro-cli 2.37.0: the V2-format agent-config upgrade prompt is removed, not reworded", () => {
  it("the binary evidence: 2.36.0 has the prompt and its options, 2.37.0 has none of them", () => {
    const before = counts("kiro-cli-chat-agent-upgrade.strings.txt", "2.36.0"), after = counts("kiro-cli-chat-agent-upgrade.strings.txt", "2.37.0");
    for (const needle of ["Enable auto-upgrade", "Not now", "Your agent configs are still in the V2 format"]) {
      expect(before[needle], needle).toBe(1);
      expect(after[needle], needle).toBe(0);
    }
    expect(evidence("kiro-cli-chat-agent-upgrade.strings.txt")).toContain("in the V2 format and may not work as expected on V3. To upgrade");
  });

  it.each([
    "1 agent config is in the V2 format and may not work as expected on V3. To upgrade it, run kiro-cli settings chat.enableAutoAgentUpgrade true",
    "3 agent configs are in the V2 format and may not work as expected on V3. To upgrade them, run kiro-cli settings chat.enableAutoAgentUpgrade true",
  ])("its printed replacement trips nothing above a ready V3 composer: %s", hint => {
    const ready = readFileSync(join(import.meta.dirname, "fixtures", "kiro-2.34.0-audit", "v3-ready-120-2.34.0.pane.txt"), "utf-8");
    const screen = `${hint}\n${ready}`;
    expect(backend().getReadyPattern().test(screen)).toBe(true);
    expect(active(backend().getRuntimeDialogs(), screen)).toEqual([]);
    expect(active(backend().getStartupDialogs(), screen)).toEqual([]);
    expect(backend().getErrorPatterns().filter(p => (p.pattern.lastIndex = 0, p.pattern.test(hint)))).toEqual([]);
  });
});

describe("kiro-cli 2.37.0: the Kiro CLI 3.0 launch machinery (evidence; AgEnD does not handle it yet)", () => {
  it("is new in 2.37.0: the launch prompt, its notice, and Classic ignored under 3.0", () => {
    const before = counts("kiro-cli-chat-v3-launch.strings.txt", "2.36.0"), after = counts("kiro-cli-chat-v3-launch.strings.txt", "2.37.0");
    for (const needle of ["Kiro CLI 3.0 is here", "Stay on V2, remind me later", "Keep V2", "no longer runs Classic", "v3_launch_prompt.rs", "chat.launch30"]) {
      expect(before[needle], needle).toBe(0);
      expect(after[needle], needle).toBeGreaterThan(0);
    }
  });
});
