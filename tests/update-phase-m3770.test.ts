// M-3770 slice 2.5, wiring part 1 (design update-wiring-m3770.md §1, §10.1): the Phase 1/2 selection and V_tx.
// Pure: no npm runs (the runner is a stand-in), and nothing selects Phase 2 unless every condition holds.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIN_UPDATE_TX, selectUpdatePhase, targetUpdateTx, updateTxOf, type PhaseInputs } from "../src/update-phase.js";

const all: PhaseInputs = { switchedOn: true, preflightClass: "self", runningTx: 1, targetTx: 1, service: "systemd", requestContext: "off", journal: "none" };

describe("M-3770 2.5 wiring part 1: which update path", () => {
  it("Phase 2 only when every condition holds; each failing condition alone keeps Phase 1, and says why", () => {
    expect(selectUpdatePhase(all)).toEqual({ phase: 2, why: "both versions speak the update transaction" });
    expect(selectUpdatePhase({ ...all, service: null })).toMatchObject({ phase: 2 });                              // a detached fleet
    const cases: [Partial<PhaseInputs>, RegExp][] = [
      [{ switchedOn: false }, /isn't switched on yet/],
      [{ preflightClass: "admin-only" }, /says admin-only, not self/],
      [{ preflightClass: "stop" }, /says stop/],
      [{ runningTx: 0 }, /running AgEnD doesn't speak/],
      [{ targetTx: 0 }, /target AgEnD doesn't speak/],
      [{ service: "launchd" }, /S-260/],
      [{ requestContext: "on" }, /request-based contact approvals are on/],
      [{ requestContext: "unknown" }, /can't be read/],
    ];
    for (const [over, why] of cases) {
      const r = selectUpdatePhase({ ...all, ...over });
      expect(r, JSON.stringify(over)).toMatchObject({ phase: 1, why: expect.stringMatching(why) });
    }
  });

  it("an open or unresolved attempt refuses BOTH updaters — with the switch on or off (Fable #4551 F1)", () => {
    const attempt = { id: "20261127T100000Z-0a0a0a0a", stage: "trial" };
    const cases: [PhaseInputs["journal"], RegExp][] = [
      ["open", /an update is already in progress \(20261127T100000Z-0a0a0a0a, trial\)/],
      ["closing", /still finishing; try again shortly/],
      ["manual", /20261127T100000Z-0a0a0a0a, trial needs manual recovery\. Run `agend update --resolve`/],
      ["unknown", /journal can't be read\. Run `agend update --resolve`/],
    ];
    for (const switchedOn of [true, false]) for (const [journal, why] of cases) {
      expect(selectUpdatePhase({ ...all, switchedOn, journal, attempt }), `${journal} ${switchedOn}`).toEqual({ refuse: true, why: expect.stringMatching(why) });
    }
    // none keeps the outcomes: Phase 2 switched on, Phase 1 switched off.
    expect(selectUpdatePhase({ ...all, journal: "none" })).toMatchObject({ phase: 2 });
    expect(selectUpdatePhase({ ...all, journal: "none", switchedOn: false })).toMatchObject({ phase: 1 });
  });

  it("updateTx is declared in package.json; absent, zero, negative, fractional or a string is 0", () => {
    expect(updateTxOf({ agend: { updateTx: 1 } })).toBe(1);
    expect(updateTxOf({ agend: { updateTx: 3 } })).toBe(3);
    for (const v of [undefined, 0, -1, 1.5, "1", null]) expect(updateTxOf({ agend: { updateTx: v } }), String(v)).toBe(0);
    expect(updateTxOf({})).toBe(0);
    expect(updateTxOf(null)).toBe(0);
  });

  it("the target's updateTx comes from npm view of the EXACT version — never a dist-tag; any failure is 0", () => {
    const calls: string[][] = [];
    const run = (answer: { status: number | null; stdout: string }) => (command: string, args: string[]) => { calls.push([command, ...args]); return answer; };
    expect(targetUpdateTx(run({ status: 0, stdout: "1\n" }), "npm", "@songsid/agend", "2.5.0")).toBe(1);
    expect(calls).toEqual([["npm", "view", "@songsid/agend@2.5.0", "agend.updateTx", "--json"]]);
    expect(targetUpdateTx(run({ status: 0, stdout: "1" }), "npm", "@songsid/agend", "2.5.0-beta.3")).toBe(1);
    calls.length = 0;
    for (const tag of ["latest", "beta", "^2.5.0", "2.5", ""]) expect(targetUpdateTx(run({ status: 0, stdout: "1" }), "npm", "@songsid/agend", tag), tag).toBe(0);
    expect(calls).toEqual([]);                                                                     // a tag never reaches npm
    expect(targetUpdateTx(run({ status: 0, stdout: "" }), "npm", "@songsid/agend", "2.5.0")).toBe(0);   // the field is absent
    expect(targetUpdateTx(run({ status: 1, stdout: "1" }), "npm", "@songsid/agend", "2.5.0")).toBe(0);
    expect(targetUpdateTx(run({ status: 0, stdout: "not json" }), "npm", "@songsid/agend", "2.5.0")).toBe(0);
  });

  it("no release declares updateTx before the flip (S-261): this package's own is 0, so selection keeps Phase 1", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(updateTxOf(pkg)).toBe(0);
    expect(MIN_UPDATE_TX).toBe(1);
  });
});

describe("M-3770 2.5 (Fable part 5 (c)): a system unit needs root", () => {
  it("a systemd system unit with a non-root updater: Phase 1, today's updater; as root it goes on", () => {
    const base = { switchedOn: true, preflightClass: "self" as const, runningTx: 1, targetTx: 1, service: "systemd" as const, requestContext: "off" as const, journal: "none" as const };
    expect(selectUpdatePhase({ ...base, systemUnit: true, root: false })).toEqual({ phase: 1, why: "the system service needs root; today's updater handles it" });
    expect(selectUpdatePhase({ ...base, systemUnit: true, root: true })).toEqual({ phase: 2, why: "both versions speak the update transaction" });
    expect(selectUpdatePhase({ ...base, systemUnit: false, root: false })).toEqual({ phase: 2, why: "both versions speak the update transaction" });
  });
});
