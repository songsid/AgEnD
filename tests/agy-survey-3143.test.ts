import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/agy-survey-3143", name), "utf8");
const reported = fixture("reported-rating.txt").trimEnd();
const after = fixture("captured-after-turn.txt");
const emptyBox = "─".repeat(60) + "\n>\n" + "─".repeat(60) + "\n? for shortcuts     auto · Gemini 4 Argon · medium\n";
const backend = () => new AntigravityBackend("/nonexistent-agy-3143", "/nonexistent-home", "/nonexistent-agend");
const matches = (pane: string) => backend().getRuntimeDialogs().filter(dialog => (Daemon as any).dialogMatches(dialog, pane));

describe("agy rating survey: user-reported wording, not a captured screen", () => {
  it.each([reported, reported.replace("’", "'"), reported.replace("? [", "?\n["), reported + "\n" + emptyBox,
    (reported + "\n" + emptyBox).replace(/\n/g, "\r\n")])("skips only the reported bottom menu with literal 0: %s", pane => {
    const dialogs = matches(pane);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.keys).toEqual(["0"]);
  });
  it("retains the old exact option row", () => {
    expect(matches("How's the CLI experience so far? Help us improve:\n [1] Good  [2] Fine  [3] Bad  [0] Skip")[0]!.keys).toEqual(["0"]);
  });
  it.each([
    "The reply quotes: " + reported,
    "  " + reported + "\n" + emptyBox,
    "> " + reported + "\n" + emptyBox,
    "```text\n" + reported + "\n" + emptyBox,
    "```text\n" + reported + "\n```\n" + emptyBox,
    reported + "\nThis is a quotation in a reply.\n" + emptyBox,
    reported.replace(" [1/2/3/0]", ""),
    "[1/2/3/0]",
    reported + "\n" + emptyBox.replace(">\n", "> draft\n"),
    reported + "\nSwitch Model\n> Gemini 4 Carbon",
    "The user said [1] Good [2] Fine [3] Bad [0] Skip in prose.",
  ])("does not type into prose, a quoted reply, drafts or another dialog: %s", pane => {
    expect(matches(pane)).toEqual([]);
  });
  it("holds a visible survey, then settles idle on the real post-turn capture after skip", () => {
    const b = backend();
    const daemon = Object.create(Daemon.prototype) as any;
    daemon.backend = b;
    expect(daemon.paneAuthoritativelyIdle(reported + "\n" + emptyBox)).toBe(false);
    expect(matches(after)).toEqual([]);
    expect(daemon.paneAuthoritativelyIdle(after)).toBe(true);
    const sm = new PaneStateMachine(b.getReadyPattern(), 15_000, 0, b.getBusyPattern());
    sm.observe("working", 0);
    expect(sm.observe(after, 2_000, { settled: true }).state).toBe("idle");
  });
  it("accepts the actual nonblocking announcement and the reported Auto-default prefix", () => {
    const captured = fixture("captured-hydrogen-idle.txt");
    const b = backend();
    expect(b.getReadyPattern().test(captured)).toBe(true);
    // Synthetic prefix from the report; the 1.5.9 account did not show this banner.
    const auto = captured.replace("Introducing Gemini 4 Hydrogen", "Auto is now the default agent mode");
    expect(b.getReadyPattern().test(auto)).toBe(true);
    // Isolate the Auto-placeholder alternative from the independent shortcuts footer.
    const draft = auto.replace(/\? for shortcuts[^\n]*/, "").replace("(shift+tab to cycle)", "(shift+tab to cycle) draft");
    expect(b.getReadyPattern().test(draft)).toBe(false);
  });
});
