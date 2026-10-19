/**
 * Tests for ls/attach resolution improvements.
 * Covers: CJK display names, row numbers, ambiguity, fuzzy suggestions.
 */
import { describe, expect, it } from "vitest";
import { resolveCandidate, applyLsFilters, pickerDefaultIdx, validateNamesOnlyFilters } from "../src/ls-attach-resolve.js";
import type { Candidate, LsRow } from "../src/ls-attach-resolve.js";

/** Build a minimal fleet candidate list (no tmux calls needed). */
function fleet(...items: Array<{ name: string; displayLabel?: string; status?: Candidate["status"]; teams?: string[] }>): Candidate[] {
  return items.map((item, i) => ({
    idx: i + 1,
    realName: item.name,
    displayLabel: item.displayLabel ?? item.name,
    status: item.status ?? "running",
    teams: item.teams ?? [],
  }));
}

describe("resolveCandidate — row numbers", () => {
  it("resolves by row number", () => {
    const cs = fleet(
      { name: "alpha-t111", displayLabel: "Alpha" },
      { name: "beta-t222",  displayLabel: "Beta" },
      { name: "gamma-t333", displayLabel: "Gamma" },
    );
    expect(resolveCandidate("2", cs)).toEqual({ kind: "exact", candidate: cs[1] });
  });

  it("row 1 works", () => {
    const cs = fleet({ name: "only-t001", displayLabel: "Only" });
    expect(resolveCandidate("1", cs)).toEqual({ kind: "exact", candidate: cs[0] });
  });

  it("out-of-range row returns none", () => {
    const cs = fleet({ name: "a" });
    const r = resolveCandidate("99", cs);
    expect(r.kind).toBe("none");
  });
});

describe("resolveCandidate — CJK display names", () => {
  it("resolves CJK display name by exact match", () => {
    const cs = fleet(
      { name: "agend-reviewer-t1503382598640996543", displayLabel: "稜鏡 Prism" },
      { name: "rd1-a89-dev-fable-t1532671461406277715", displayLabel: "鑄碼副手 Fable" },
    );
    expect(resolveCandidate("稜鏡 Prism", cs)).toEqual({ kind: "exact", candidate: cs[0] });
  });

  it("resolves CJK display name substring (unique)", () => {
    const cs = fleet(
      { name: "agend-reviewer-t1503382598640996543", displayLabel: "稜鏡 Prism" },
      { name: "other-t000", displayLabel: "Sentinel" },
    );
    const r = resolveCandidate("鑄碼副手", cs);
    expect(r.kind).toBe("none"); // "鑄碼副手" is not in any label above → suggestions
  });

  it("resolves partial CJK substring when unique", () => {
    const cs = fleet(
      { name: "rd1-a89-dev-fable-t123", displayLabel: "鑄碼副手 Fable" },
      { name: "other-t000", displayLabel: "Sentinel" },
    );
    expect(resolveCandidate("鑄碼副手", cs)).toEqual({ kind: "exact", candidate: cs[0] });
  });

  it("CJK substring ambiguity returns ambiguous with both candidates", () => {
    const cs = fleet(
      { name: "fable-1", displayLabel: "鑄碼副手 Fable" },
      { name: "fable-2", displayLabel: "鑄碼副手 Beta" },
    );
    const r = resolveCandidate("鑄碼副手", cs);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates).toHaveLength(2);
      expect(r.candidates.map(c => c.realName)).toContain("fable-1");
      expect(r.candidates.map(c => c.realName)).toContain("fable-2");
    }
  });
});

describe("resolveCandidate — ambiguity", () => {
  it("exact display name collision → ambiguous", () => {
    const cs = fleet(
      { name: "a-t111", displayLabel: "Prism" },
      { name: "b-t222", displayLabel: "prism" },  // case-insensitive collision
    );
    const r = resolveCandidate("Prism", cs);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(2);
  });

  it("name substring ambiguity shows both candidates", () => {
    const cs = fleet(
      { name: "alpha-worker-1" },
      { name: "alpha-worker-2" },
      { name: "beta-worker" },
    );
    const r = resolveCandidate("alpha", cs);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates).toHaveLength(2);
      expect(r.reason).toMatch(/name/);
    }
  });
});

describe("resolveCandidate — no-match suggestions", () => {
  it("no match returns top-5 fuzzy suggestions, not the full list", () => {
    const cs = fleet(
      { name: "agend-reviewer-t001", displayLabel: "稜鏡 Prism" },
      { name: "agend-leader-t002", displayLabel: "Leader" },
      { name: "agend-coordinator-t003", displayLabel: "Coord" },
      { name: "doupo-server-t004", displayLabel: "Server" },
      { name: "unrelated-t005", displayLabel: "Zephyr" },
      { name: "unrelated-t006", displayLabel: "Alpha" },
      { name: "unrelated-t007", displayLabel: "Beta" },
    );
    const r = resolveCandidate("reviewr", cs);  // typo
    expect(r.kind).toBe("none");
    if (r.kind === "none") {
      expect(r.suggestions.length).toBeLessThanOrEqual(5);
      // The reviewer should score highest
      expect(r.suggestions[0]?.realName).toBe("agend-reviewer-t001");
    }
  });

  it("no match with zero score returns empty suggestions", () => {
    const cs = fleet({ name: "abc", displayLabel: "Abc" });
    const r = resolveCandidate("xyz", cs);
    expect(r.kind).toBe("none");
    if (r.kind === "none") expect(r.suggestions).toHaveLength(0);
  });

  it("leading-char typo still gets a suggestion (charOverlapScore, not greedy LCS)", () => {
    // "xreviewer" vs "agend-reviewer": shared chars r,e,v,i,e,w,e,r → score > 0
    const cs = fleet(
      { name: "agend-reviewer-t1503382598640996543", displayLabel: "稜鏡 Prism" },
      { name: "unrelated-t000", displayLabel: "Zephyr" },
    );
    const r = resolveCandidate("xreviewer", cs);
    expect(r.kind).toBe("none");
    if (r.kind === "none") {
      expect(r.suggestions.length).toBeGreaterThan(0);
      expect(r.suggestions[0]?.realName).toBe("agend-reviewer-t1503382598640996543");
    }
  });
});

describe("resolveCandidate — real name resolution", () => {
  it("exact real name wins over display label", () => {
    // Edge case: display label of one matches real name of another
    const cs = fleet(
      { name: "display-t111", displayLabel: "actual-t222" },
      { name: "actual-t222",  displayLabel: "Actual" },
    );
    expect(resolveCandidate("actual-t222", cs)).toEqual({ kind: "exact", candidate: cs[1] });
  });

  it("real name prefix resolves uniquely", () => {
    const cs = fleet(
      { name: "agend-reviewer-t1503382598640996543" },
      { name: "agend-leader-t1503382358143799511" },
    );
    const r = resolveCandidate("agend-reviewer", cs);
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.candidate.realName).toBe("agend-reviewer-t1503382598640996543");
  });

  it("short -tNNNNNN display label resolves", () => {
    const cs = fleet(
      { name: "agend-dev1-t1503382407284265082", displayLabel: "agend-dev1-t265082" },
    );
    expect(resolveCandidate("agend-dev1-t265082", cs)).toEqual({ kind: "exact", candidate: cs[0] });
  });
});

// ── P2-3: numeric instance names ────────────────────────────────────────────

describe("P2-3: numeric real name wins over row number", () => {
  it("instance named '2' is found by exact real name before row-2 lookup", () => {
    // Object.keys order: "2" at idx=1 (row 1), "alpha" at idx=2 (row 2).
    // attach "2" must resolve to the instance named "2", not to row 2 ("alpha").
    const cs: Candidate[] = [
      { idx: 1, realName: "2",     displayLabel: "2",     status: "running", teams: [] },
      { idx: 2, realName: "alpha", displayLabel: "Alpha", status: "running", teams: [] },
    ];
    expect(resolveCandidate("2", cs)).toEqual({ kind: "exact", candidate: cs[0] });
  });

  it("row-number lookup still works when no exact real name matches the digit string", () => {
    const cs: Candidate[] = [
      { idx: 1, realName: "alpha", displayLabel: "Alpha", status: "running", teams: [] },
      { idx: 2, realName: "beta",  displayLabel: "Beta",  status: "running", teams: [] },
    ];
    expect(resolveCandidate("2", cs)).toEqual({ kind: "exact", candidate: cs[1] });
  });
});

// ── P2-1: stable global indices survive filtering ────────────────────────────

describe("P2-1: applyLsFilters — stable global indices", () => {
  function rows(...items: Array<{ realName: string; status?: string; teams?: string[]; backend?: string }>): LsRow[] {
    return items.map((item, i) => ({
      globalIdx: i + 1,
      realName: item.realName,
      displayLabel: item.realName,
      status: item.status ?? "running",
      teams: item.teams ?? [],
      backend: item.backend ?? "claude-code",
    }));
  }

  it("--team filter preserves global indices (beta stays at #2 even when alpha is filtered out)", () => {
    const all = rows(
      { realName: "alpha", teams: ["teamA"] },
      { realName: "beta",  teams: ["teamB"] },
      { realName: "gamma", teams: ["teamA"] },
    );
    const filtered = applyLsFilters(all, { team: "teamB" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.globalIdx).toBe(2); // beta's global idx is 2, not 1
    expect(filtered[0]!.realName).toBe("beta");
  });

  it("--running filter preserves global indices", () => {
    const all = rows(
      { realName: "running-1", status: "running" },
      { realName: "paused-1",  status: "paused" },
      { realName: "running-2", status: "running" },
    );
    const filtered = applyLsFilters(all, { running: true });
    expect(filtered).toHaveLength(2);
    expect(filtered[0]!.globalIdx).toBe(1);
    expect(filtered[1]!.globalIdx).toBe(3); // running-2 keeps global idx=3
  });

  it("--backend filter preserves global indices", () => {
    const all = rows(
      { realName: "kiro-1", backend: "kiro-cli" },
      { realName: "claude-1", backend: "claude-code" },
      { realName: "kiro-2", backend: "kiro-cli" },
    );
    const filtered = applyLsFilters(all, { backend: "kiro-cli" });
    expect(filtered[1]!.globalIdx).toBe(3); // kiro-2 keeps global idx=3
  });

  it("no filters returns all rows unchanged", () => {
    const all = rows({ realName: "a" }, { realName: "b" });
    expect(applyLsFilters(all, {})).toHaveLength(2);
  });
});

// ── P2-2: --names-only + filter validation ───────────────────────────────────

describe("P2-2: validateNamesOnlyFilters", () => {
  it("returns null when not namesOnly", () => {
    expect(validateNamesOnlyFilters({ namesOnly: false, running: true })).toBeNull();
    expect(validateNamesOnlyFilters({ running: true })).toBeNull();
  });

  it("returns null when namesOnly with no filters", () => {
    expect(validateNamesOnlyFilters({ namesOnly: true })).toBeNull();
  });

  it("returns error string when namesOnly + --running", () => {
    const err = validateNamesOnlyFilters({ namesOnly: true, running: true });
    expect(err).toContain("--names-only");
    expect(err).toContain("--running");
  });

  it("returns error string when namesOnly + --team", () => {
    const err = validateNamesOnlyFilters({ namesOnly: true, team: "agend-dev" });
    expect(err).toContain("--team");
  });

  it("returns error string when namesOnly + --backend", () => {
    const err = validateNamesOnlyFilters({ namesOnly: true, backend: "codex" });
    expect(err).toContain("--backend");
  });

  it("mentions all active flags when multiple are combined", () => {
    const err = validateNamesOnlyFilters({ namesOnly: true, running: true, team: "dev" });
    expect(err).toContain("--running");
    expect(err).toContain("--team");
  });
});

// ── P2-3 (continued): #N unambiguous row token ───────────────────────────────

describe("P2-3: #N unambiguous row token resolves by row, bypassing exact name", () => {
  it("#2 selects row 2 even when instance named '2' is at row 1", () => {
    const cs: Candidate[] = [
      { idx: 1, realName: "2",     displayLabel: "2",     status: "stopped", teams: [] },
      { idx: 2, realName: "alpha", displayLabel: "Alpha", status: "running", teams: [] },
    ];
    // "#2" → unambiguous row token → alpha
    expect(resolveCandidate("#2", cs)).toEqual({ kind: "exact", candidate: cs[1] });
    // bare "2" → exact real name "2" → the stopped instance
    expect(resolveCandidate("2", cs)).toEqual({ kind: "exact", candidate: cs[0] });
  });

  it("#1 selects row 1 by index, not by real name match", () => {
    const cs: Candidate[] = [
      { idx: 1, realName: "alpha", displayLabel: "Alpha", status: "running", teams: [] },
      { idx: 2, realName: "1",     displayLabel: "1",     status: "running", teams: [] },
    ];
    expect(resolveCandidate("#1", cs)).toEqual({ kind: "exact", candidate: cs[0] });
    expect(resolveCandidate("1", cs)).toEqual({ kind: "exact", candidate: cs[1] }); // exact "1" wins
  });

  it("#N out of range returns none", () => {
    const cs: Candidate[] = [
      { idx: 1, realName: "alpha", displayLabel: "Alpha", status: "running", teams: [] },
    ];
    expect(resolveCandidate("#99", cs).kind).toBe("none");
  });

  it("picker default uses #N form: Enter resolves to the displayed-first row even in collision", () => {
    // Scenario from Prism R2: "2" at idx=1 (stopped), alpha at idx=2 (running).
    // Picker displays alpha first (running-first order) → defaultIdx=2.
    // Picker default token = "#2" → resolves to alpha (idx=2), not "2" (realName).
    const cs: Candidate[] = [
      { idx: 1, realName: "2",     displayLabel: "2",     status: "stopped", teams: [] },
      { idx: 2, realName: "alpha", displayLabel: "Alpha", status: "running", teams: [] },
    ];
    // Simulate picker running-first sort
    const running = cs.filter(c => c.status === "running");
    const rest = cs.filter(c => c.status !== "running");
    const ordered = [...running, ...rest]; // [alpha(idx=2), "2"(idx=1)]
    const defaultIdx = pickerDefaultIdx(ordered); // = 2 (alpha's idx)
    const defaultToken = `#${defaultIdx}`; // = "#2"
    const result = resolveCandidate(defaultToken, cs);
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.candidate.realName).toBe("alpha"); // not "2"
    }
  });
});

describe("P2-4: pickerDefaultIdx uses first displayed candidate", () => {
  it("returns first candidate's idx even when it is not 1", () => {
    const displayed: Pick<Candidate, "idx">[] = [
      { idx: 3 }, { idx: 4 },
    ];
    expect(pickerDefaultIdx(displayed)).toBe(3);
  });

  it("returns 1 when first displayed row has idx=1", () => {
    const displayed: Pick<Candidate, "idx">[] = [
      { idx: 1 }, { idx: 2 },
    ];
    expect(pickerDefaultIdx(displayed)).toBe(1);
  });

  it("returns 1 for empty list (safe fallback)", () => {
    expect(pickerDefaultIdx([])).toBe(1);
  });
});
