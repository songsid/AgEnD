/**
 * #1809: resolveName — any name shown in `agend ls`'s human table resolves to the real instance name.
 *
 * Tests use `resolveName` (the pure pipeline function exported from topic-commands.ts and called by
 * resolveInstance in cli.ts). This wires up the full resolution order:
 *   1. exact real-name match → wins
 *   2. exact label match (assignDisplayLabels) → resolved
 *   3. ambiguous (case-collision between two labels) → refused
 *   4. nothing → none
 *
 * Each mutation below should turn red:
 *  M1: remove real-name-first guard → "display_name equals another instance's real name" test fails
 *  M2: replace label match with `return names[0]` → specific-name tests fail
 */
import { describe, expect, it } from "vitest";
import { resolveName, resolveByLabel } from "../src/topic-commands.js";

/** Convenience: build an entries array. */
function ents(items: Array<{ name: string; displayName?: string | null }>) { return items; }

describe("resolveName (#1809): full resolution pipeline", () => {
  it("exact real-name match resolves (case-insensitive)", () => {
    const result = resolveName("CODE-REVIEWER", ents([
      { name: "code-reviewer", displayName: "Reviewer" },
    ]));
    expect(result).toEqual({ kind: "name", realName: "code-reviewer" });
  });

  it("display_name label resolves when it differs from real name", () => {
    const result = resolveName("Reviewer", ents([
      { name: "code-reviewer", displayName: "Reviewer" },
    ]));
    expect(result).toEqual({ kind: "name", realName: "code-reviewer" });
  });

  it("short -tNNNNNN label resolves", () => {
    const result = resolveName("code-reviewer-t111111", ents([
      { name: "code-reviewer-t1111111111111111111", displayName: null },
      { name: "fleet-lead", displayName: null },
    ]));
    expect(result).toEqual({ kind: "name", realName: "code-reviewer-t1111111111111111111" });
  });

  it("emoji display_name resolves", () => {
    const result = resolveName("📚 Wiki 管理員", ents([
      { name: "wiki-keeper", displayName: "📚 Wiki 管理員" },
    ]));
    expect(result).toEqual({ kind: "name", realName: "wiki-keeper" });
  });

  it("label resolves case-insensitively", () => {
    const result = resolveName("STORY HELPER", ents([
      { name: "story-writer", displayName: "Story helper" },
    ]));
    expect(result).toEqual({ kind: "name", realName: "story-writer" });
  });

  it("real name wins over a label of the same text (real-name-first priority)", () => {
    // instance-a's display_name happens to equal instance-b's real name.
    // resolveName must return instance-b (the real name), not instance-a.
    const result = resolveName("instance-b-t0000000000000000002", ents([
      { name: "instance-a-t0000000000000000001", displayName: "instance-b-t0000000000000000002" },
      { name: "instance-b-t0000000000000000002", displayName: null },
    ]));
    expect(result).toEqual({ kind: "name", realName: "instance-b-t0000000000000000002" });
  });

  it("no match returns none", () => {
    const result = resolveName("no-such-thing", ents([
      { name: "code-reviewer", displayName: "Reviewer" },
    ]));
    expect(result).toEqual({ kind: "none" });
  });

  it("two instances with the same display_name get disambiguated labels that each resolve correctly", () => {
    const entries = ents([
      { name: "instance-a-t0000000000000000001", displayName: "Shared Name" },
      { name: "instance-b-t0000000000000000002", displayName: "Shared Name" },
    ]);
    // Alphabetically first keeps the plain label, second gets a qualified one.
    const resultA = resolveName("Shared Name", entries);
    expect(resultA).toEqual({ kind: "name", realName: "instance-a-t0000000000000000001" });

    const resultB = resolveName("Shared Name (instance-b-t000002)", entries);
    expect(resultB).toEqual({ kind: "name", realName: "instance-b-t0000000000000000002" });
  });

  it("case-collision between two display_names returns ambiguous (#1809 P3-1)", () => {
    // "Prism" and "prism" fold to the same key — assignDisplayLabels cannot disambiguate this.
    const result = resolveName("prism", ents([
      { name: "instance-a-t0000000000000000001", displayName: "Prism" },
      { name: "instance-b-t0000000000000000002", displayName: "prism" },
    ]));
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.realNames.sort()).toEqual([
        "instance-a-t0000000000000000001",
        "instance-b-t0000000000000000002",
      ]);
    }
  });
});

describe("resolveByLabel: standalone label lookup (used inside resolveName)", () => {
  it("returns null for a real name passed without a matching label", () => {
    // Callers must use resolveName (which checks real names first);
    // resolveByLabel itself only looks at labels.
    const result = resolveByLabel("code-reviewer", ents([
      { name: "code-reviewer", displayName: "Reviewer" },
    ]));
    expect(result).toBeNull(); // real name is not a label here
  });
});
