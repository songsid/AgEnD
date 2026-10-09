/**
 * muse 1.4.4 audit (fleet task 2026-10-09; ffb8104e): the screens AgEnD reads, captured live from the 1.4.4 binary
 * (tests/fixtures/muse-1.4.4/SOURCES.md), judged by the production MuseBackend exactly as the 1.4.3 captures were.
 * Same verdicts as 1.4.3 on every surface: ready/busy, the periodic-idle proof, the input draft, the login menu, the
 * trust dialog, no false error hit, the resume-missing message.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseBackend, museLoginScreenActive } from "../src/backend/muse.js";

const DIR = join(process.cwd(), "tests", "fixtures", "muse-1.4.4");
const pane = (name: string) => readFileSync(join(DIR, `${name}.pane.txt`), "utf8");
const b = new MuseBackend("/tmp/agend-muse-1.4.4-audit");
const startup = (p: string) => b.getStartupDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p))).map(d => d.description);
const runtime = (p: string) => b.getRuntimeDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p))).map(d => d.description);
const errors = (p: string) => b.getErrorPatterns().filter(e => e.pattern.test(p)).map(e => e.type);

describe("muse 1.4.4: the screens AgEnD reads, as the production backend judges them", () => {
  it.each([
    ["echo-idle", { busy: false, idle: true, draft: [] as string[] }],
    ["echo-done", { busy: false, idle: true, draft: [] as string[] }],
    ["echo-resumed", { busy: false, idle: true, draft: [] as string[] }],
    ["echo-busy", { busy: true, idle: false, draft: [] as string[] }],
    ["echo-after-escape", { busy: false, idle: false, draft: ["cancel me"] }],
  ])("%s: ready, busy/idle and the input draft", (name, want) => {
    const p = pane(name);
    expect(b.getReadyPattern().test(p)).toBe(true);
    expect(b.getBusyPattern().test(p)).toBe(want.busy);
    expect(b.isPeriodicRedrawIdlePane(p)).toBe(want.idle);
    expect(b.inputDraft(p)?.rows).toEqual(want.draft);
    expect(startup(p)).toEqual([]);
    expect(runtime(p)).toEqual([]);
    expect(errors(p)).toEqual([]);
  });

  it("logged out (with --trust-workspace): the login menu is held, never taken for the idle prompt", () => {
    const p = pane("offline-first-run");
    expect(museLoginScreenActive(p)).toBe(true);
    expect(b.isPeriodicRedrawIdlePane(p)).toBe(false);
    expect(startup(p)).toEqual(expect.arrayContaining([expect.stringContaining("Muse login menu")]));
    expect(runtime(p)).toEqual([expect.stringContaining("Muse login menu")]);
  });

  it("first run without --trust-workspace: the trust dialog, answered by the startup handler (1, Enter)", () => {
    const p = pane("first-run-trust-dialog");
    const trust = b.getStartupDialogs().filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p)));
    expect(trust.map(d => d.keys)).toEqual([["1", "Enter"]]);
    expect(b.getReadyPattern().test(p)).toBe(false);
  });

  it("resume of an unknown session: the message the resume-missing proof reads (#1217)", () => {
    expect(b.resumeMissingPattern().test(pane("resume-missing"))).toBe(true);
  });
});
