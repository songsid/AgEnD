import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/agy-survey-3143", name), "utf8");
const title = "How's the CLI experience so far? Help us improve:";
const options = " [1] Good  [2] Fine  [3] Bad  [0] Skip";
const legacy = title + "\n" + options;
const after = fixture("captured-after-turn.txt");
const emptyBox = "─".repeat(60) + "\n>\n" + "─".repeat(60) + "\n? for shortcuts     auto · Gemini 4 Argon · medium\n";
const backend = () => new AntigravityBackend("/nonexistent-agy-3143", "/nonexistent-home", "/nonexistent-agend");
const matches = (pane: string) => backend().getRuntimeDialogs().filter(dialog => (Daemon as any).dialogMatches(dialog, pane));

describe("agy legacy rating survey: reconstructed from exact 1.5.9 binary rendering", () => {
  it.each([31, 32, 33, 34, 35, 36, 37])("skips the menu physically wrapped at width%i", width => {
    const pane = fixture(`legacy-width-${width}.txt`);
    const dialogs = matches(pane);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.keys).toEqual(["0"]);
  });
  it.each(["", "S", "Sk", "Ski", "Skip"])("accepts the complete option tokens with final label clipped to %s", suffix => {
    const pane = title + "\n" + options.replace("Skip", suffix);
    expect(matches(pane)).toHaveLength(1);
    expect(matches(pane)[0]!.keys).toEqual(["0"]);
  });
  it("pins the clipped fixture and whitespace wrapping/CRLF", () => {
    expect(matches(fixture("legacy-clipped-skip.txt"))).toHaveLength(1);
    expect(matches(legacy.replace(/  /g, "\n"))).toHaveLength(1);
    expect(matches(fixture("legacy-width-31.txt").replace(/\n/g, "\r\n"))).toHaveLength(1);
    expect(matches(legacy + "\n" + emptyBox)).toHaveLength(1);
  });
  it("recognizes the live bottom menu after an old menu remains in scrollback", () => {
    expect(matches(legacy + "\nEarlier menu was answered.\n" + fixture("legacy-width-33.txt"))).toHaveLength(1);
  });
  it.each([
    "The reply quotes: " + legacy,
    legacy.split("\n").map(row => "  " + row).join("\n") + "\n" + emptyBox,
    legacy.split("\n").map(row => "> " + row).join("\n") + "\n" + emptyBox,
    "```text\n" + legacy + "\n" + emptyBox,
    "```text\n" + legacy + "\n```\n" + emptyBox,
    legacy + "\nThis is a quotation in a reply.\n" + emptyBox,
    title, options,
    legacy.replace("[0] Skip", "[0"),
    legacy.replace("[2] Fine", "[2] Great"),
    legacy + "\n" + emptyBox.replace(">\n", "> draft\n"),
    legacy + "\nSwitch Model\n> Gemini 4 Carbon",
    "The user said [1] Good [2] Fine [3] Bad [0] Skip in prose.",
  ])("does not type into prose, quoted replies, partial option tokens or drafts: %s", pane => {
    expect(matches(pane)).toEqual([]);
  });
  it("holds a visible wrapped survey, then settles idle after skip", () => {
    const b = backend();
    const daemon = Object.create(Daemon.prototype) as any;
    daemon.backend = b;
    expect(daemon.paneAuthoritativelyIdle(fixture("legacy-width-31.txt") + "\n" + emptyBox)).toBe(false);
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

const timingDirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of timingDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("legacy survey after a turn, actual daemon with inert pane and fake clock", () => {
  it.each([4_999, 5_001])("skips a wrapped survey painted at +%i ms around the runtime scan", async finishAt => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-15T02:00:00Z"));
    const dir = mkdtempSync(join(tmpdir(), "agend-agy-3143-timing-")); timingDirs.push(dir);
    const b = backend();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const d = new Daemon("agy-survey-test", {
      working_directory: dir, backend: "antigravity", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    } as any, dir, false, b, undefined, { child: () => logger } as any) as any;
    let pane = "⣯  Generating...\n" + emptyBox;
    const keys: string[] = [];
    d.instanceState = "working";
    d.tmux = {
      capturePane: vi.fn(async () => pane), capturePaneWithHistory: vi.fn(async () => pane),
      isWindowAlive: vi.fn(async () => true), getWindowId: () => "@owned-stub",
      pasteText: vi.fn(async (key: string) => { keys.push(key); pane = emptyBox; return true; }),
      sendSpecialKey: vi.fn(async () => true),
    };
    d.startErrorMonitor();
    try {
      setTimeout(() => { pane = fixture("legacy-width-31.txt"); d.instanceStateLastOutputAt = Date.now(); }, finishAt);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(keys).toEqual(["0"]);
      expect(d.tmux.sendSpecialKey).not.toHaveBeenCalled();
      expect(d.paneAuthoritativelyIdle(pane)).toBe(true);
    } finally { d.freezeRuntimeMonitors(); }
  });
});
