/**
 * Tests for ls/attach resolution improvements.
 * Covers: CJK display names, row numbers, ambiguity, fuzzy suggestions.
 */
import { describe, expect, it } from "vitest";
import { resolveCandidate } from "../src/ls-attach-resolve.js";
import type { Candidate } from "../src/ls-attach-resolve.js";

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
