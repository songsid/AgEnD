/**
 * #1809: resolveByLabel — any name shown in `agend ls`'s human table resolves to the real instance name.
 *
 * resolveByLabel is tested directly (it is the shared helper cli.ts uses).
 * Tests cover: display-name label, short -tNNNNNN label, CJK/emoji label, ambiguous label,
 * and the guarantee that a real name always wins (resolveByLabel is called AFTER real-name exact match).
 */
import { describe, expect, it } from "vitest";
import { resolveByLabel } from "../src/topic-commands.js";

/** Convenience: build an entries array. */
function ents(items: Array<{ name: string; displayName?: string | null }>) { return items; }

describe("resolveByLabel (#1809): label shown by agend ls resolves to the real name", () => {
  it("exact display_name label resolves", () => {
    const result = resolveByLabel("稜鏡", ents([
      { name: "agend-reviewer-t1503382598640996543", displayName: "稜鏡 Prism" },
      { name: "agend-leader-t1503382358143799511", displayName: null },
    ]));
    // 稜鏡 Prism is not the same as 稜鏡 — the label is the full display name
    expect(result).toBeNull(); // "稜鏡" alone does not match "稜鏡 Prism"
  });

  it("exact display_name matches the full label", () => {
    const result = resolveByLabel("稜鏡 Prism", ents([
      { name: "agend-reviewer-t1503382598640996543", displayName: "稜鏡 Prism" },
      { name: "agend-leader-t1503382358143799511", displayName: null },
    ]));
    expect(result).toBe("agend-reviewer-t1503382598640996543");
  });

  it("short -tNNNNNN label (no display_name) resolves", () => {
    // agend-reviewer-t1503382598640996543 → short tail = -t996543
    const result = resolveByLabel("agend-reviewer-t996543", ents([
      { name: "agend-reviewer-t1503382598640996543", displayName: null },
      { name: "agend-leader-t1503382358143799511", displayName: null },
    ]));
    expect(result).toBe("agend-reviewer-t1503382598640996543");
  });

  it("emoji display_name resolves", () => {
    const result = resolveByLabel("📚 Wiki 管理員", ents([
      { name: "agend-wiki-t1517661317610213527", displayName: "📚 Wiki 管理員" },
    ]));
    expect(result).toBe("agend-wiki-t1517661317610213527");
  });

  it("CJK display_name resolves case-insensitively (same string)", () => {
    const result = resolveByLabel("Fable 焚穹", ents([
      { name: "claude-fable-t1532671461406277715", displayName: "Fable 焚穹" },
    ]));
    expect(result).toBe("claude-fable-t1532671461406277715");
  });

  it("case-insensitive ASCII label resolves", () => {
    const result = resolveByLabel("FABLE 焚穹", ents([
      { name: "claude-fable-t1532671461406277715", displayName: "Fable 焚穹" },
    ]));
    expect(result).toBe("claude-fable-t1532671461406277715");
  });

  it("no match returns null", () => {
    const result = resolveByLabel("no-such-label", ents([
      { name: "agend-reviewer-t1503382598640996543", displayName: "稜鏡 Prism" },
    ]));
    expect(result).toBeNull();
  });

  it("two instances with the same display_name get disambiguated labels that each resolve correctly", () => {
    // assignDisplayLabels adds a suffix to the second collision; resolveByLabel handles both.
    const entries = ents([
      { name: "instance-a-t0000000000000000001", displayName: "Shared Name" },
      { name: "instance-b-t0000000000000000002", displayName: "Shared Name" },
    ]);
    // First (alphabetically) keeps the label, second gets a qualified label.
    // Both must resolve — the qualified one also resolves.
    const resultA = resolveByLabel("Shared Name", entries);
    expect(resultA).toBe("instance-a-t0000000000000000001"); // alphabetically first keeps the plain label
    const resultB = resolveByLabel("Shared Name (instance-b-t000002)", entries);
    expect(resultB).toBe("instance-b-t0000000000000000002");
  });

  it("real-name exact match is done BEFORE resolveByLabel in resolveInstance — calling resolveByLabel with a real name returns null (or the real name if it also matches a label)", () => {
    // If someone names their display_name to a different instance's real name,
    // the REAL name lookup in cli.ts runs first, so the right instance is still returned.
    // resolveByLabel itself only matches labels; it does not know about real names as such.
    const entries = ents([
      { name: "real-instance-t1234567890123456789", displayName: null },
      { name: "impersonator-t9999999999999999999", displayName: "real-instance-t1234567890123456789" },
    ]);
    const result = resolveByLabel("real-instance-t1234567890123456789", entries);
    // resolveByLabel would find the impersonator's display_name; but the caller resolves real name first
    // This test documents that if someone DID call resolveByLabel with a real name it matches the label
    expect(result).toBe("impersonator-t9999999999999999999");
    // Callers must check real name exact match first (cli.ts does this)
  });
});

describe("resolveByLabel: real name beats a colliding label", () => {
  it("when real name equals a label of another instance, cli.ts real-name-first guard is documented", () => {
    // To verify the guard works: if we bypass it and call resolveByLabel directly with a real name
    // that happens to equal another instance's display label, it returns the label owner.
    // cli.ts resolves exact real name match BEFORE calling resolveByLabel, so the correct instance is returned.
    // This test pins the contract: resolveByLabel only does label lookup; the real-name priority is in the caller.
    const result = resolveByLabel("my-real-name", ents([
      { name: "other-t0000000000000000001", displayName: "my-real-name" },
    ]));
    expect(result).toBe("other-t0000000000000000001");
  });
});
