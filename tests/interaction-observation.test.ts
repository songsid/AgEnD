import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionObservation, presentationState, interactionSummary, INTERACTION_STALE_MS } from "../src/interaction-observation.js";
import { setLocale, t } from "../src/locale.js";
import type { InteractionOwner } from "../src/backend/types.js";

const owner: InteractionOwner = { bootId: "boot", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 };
const proof = { kind: "permission" as const, identity: "private-command-secret" };
beforeEach(() => { vi.useFakeTimers(); setLocale("en"); });
afterEach(() => { vi.useRealTimers(); setLocale("en"); });

describe("the single interaction observation", () => {
  it("requires two fresh observations separated by the complete 500ms window", () => {
    const o = new InteractionObservation();
    o.observe(proof, owner, 100, 0);
    expect(o.snapshot(owner, 0).phase).toBe("candidate");
    o.observe(proof, owner, 599, 499);
    expect(o.snapshot(owner, 499).phase).toBe("candidate");
    o.observe(proof, owner, 600, 500);
    expect(o.snapshot(owner, 500)).toMatchObject({ phase: "waiting", confirmedAt: 600, episode: 1 });
    expect(JSON.stringify(o.snapshot(owner, 500))).not.toContain("private-command-secret");
  });
  it("does not confirm a transient or a different request with the old timer", () => {
    const o = new InteractionObservation();
    o.observe(proof, owner, 0, 0);
    o.observe(null, owner, 200, 200);
    expect(o.snapshot(owner, 200).phase).toBe("clear");
    o.observe(proof, owner, 400, 400);
    o.observe({ ...proof, identity: "new-request" }, owner, 900, 900);
    expect(o.snapshot(owner, 900)).toMatchObject({ phase: "candidate", episode: 3 });
    o.observe({ ...proof, identity: "new-request" }, owner, 1400, 1400);
    expect(o.snapshot(owner, 1400).phase).toBe("waiting");
  });
  it("keeps an episode across redraws, becomes stale at 15s, and requires reconfirmation", () => {
    const o = new InteractionObservation();
    o.observe(proof, owner, 0, 0); o.observe(proof, owner, 500, 500);
    expect(o.snapshot(owner, 15_499).phase).toBe("waiting");
    expect(o.snapshot(owner, 15_500)).toMatchObject({ phase: "unverified", stale: true, ageMs: INTERACTION_STALE_MS, episode: 1 });
    o.observe(proof, owner, 16_000, 16_000);
    expect(o.snapshot(owner, 16_000)).toMatchObject({ phase: "candidate", episode: 1 });
    o.observe(proof, owner, 16_500, 16_500);
    expect(o.snapshot(owner, 16_500).phase).toBe("waiting");
  });
  it("failed capture is not proof of clear and cannot spend the old confirmation timer", () => {
    const o = new InteractionObservation();
    o.observe(proof, owner, 0, 0); o.unverify(owner, 450);
    expect(o.snapshot(owner, 450)).toMatchObject({ phase: "unverified", kind: "permission" });
    o.observe(proof, owner, 500, 500);
    expect(o.snapshot(owner, 500).phase).toBe("candidate");
    o.observe(proof, owner, 1000, 1000);
    expect(o.snapshot(owner, 1000).phase).toBe("waiting");
  });
  it("rejects older success and failure completions without renewing freshness", () => {
    const o = new InteractionObservation();
    o.observe(proof, owner, 1000, 1000); o.observe(proof, owner, 1500, 1500);
    expect(o.observe(null, owner, 999, 999)).toBe(false);
    expect(o.unverify(owner, 1200)).toBe(false);
    expect(o.snapshot(owner, 2000)).toMatchObject({ phase: "waiting", observedAt: 1500, ageMs: 500 });
    o.unverify(owner, 2100);
    expect(o.observe(proof, owner, 2000, 2000)).toBe(false);
    expect(o.snapshot(owner, 2200).phase).toBe("unverified");
  });
  it("capture serial breaks ties when overlapping captures started in the same millisecond", () => {
    const o = new InteractionObservation();
    o.observe(proof, owner, 100, 100, false, 1);
    o.observe(null, owner, 100, 100, false, 3);
    expect(o.observe(proof, owner, 100, 100, false, 2)).toBe(false);
    expect(o.unverify(owner, 100, 2)).toBe(false);
    expect(o.snapshot(owner, 100).phase).toBe("clear");
  });
  it.each(["bootId", "spawnGeneration", "launchAttempt", "launchFenceEpoch"] as const)("%s owns the observation", key => {
    const o = new InteractionObservation();
    o.observe(proof, owner, 0, 0); o.observe(proof, owner, 500, 500);
    const next = { ...owner, [key]: key === "bootId" ? "other" : owner[key] as number + 1 };
    expect(o.snapshot(next)).toMatchObject({ phase: "unverified", kind: null, episode: null });
  });
  it("weak terminal text retains 10s grace and output continuity without granting authority", () => {
    const o = new InteractionObservation();
    const weak = { kind: "suspected_terminal_input" as const, identity: "Password:", suspected: true };
    o.observe(weak, owner, 0, 0); o.observe(weak, owner, 9999, 9999);
    expect(o.snapshot(owner, 9999).phase).toBe("candidate");
    o.observe(weak, owner, 10_000, 10_000);
    expect(o.snapshot(owner, 10_000)).toMatchObject({ phase: "waiting", suspected: true });
    expect(presentationState("working", o.snapshot(owner, 10_000))).toBe("working");
    o.observe(weak, owner, 10_001, 10_001, true);
    expect(o.snapshot(owner, 10_001).phase).toBe("candidate");
  });
  it("projects only fresh confirmed strong evidence, without modifying execution state", () => {
    const o = new InteractionObservation(); o.observe(proof, owner, 0, 0);
    expect(presentationState("working", o.snapshot(owner, 0))).toBe("working");
    o.observe(proof, owner, 500, 500);
    expect(presentationState("working", o.snapshot(owner, 500))).toBe("awaiting_input");
    expect(presentationState("paused", o.snapshot(owner, 500))).toBe("paused");
    expect(presentationState(null, o.snapshot(owner, 500))).toBe("awaiting_input");
    expect(presentationState("working", o.snapshot(owner, 15500))).toBe("working");
  });
  it.each(["en", "zh-TW"] as const)("%s explains fresh/candidate/stale and suspected using static categories", locale => {
    setLocale(locale);
    const o = new InteractionObservation();
    o.observe(proof, owner, 0, 0);
    expect(interactionSummary(o.snapshot(owner, 0))).not.toMatch(/interaction\./);
    o.observe(proof, owner, 500, 500);
    expect(interactionSummary(o.snapshot(owner, 500))).toContain(t("interactive.kind.permission"));
    const stale = interactionSummary(o.snapshot(owner, 15500));
    expect(stale).toContain("15"); expect(stale).not.toContain("private-command-secret");
    expect(stale).toContain(locale === "en" ? "cannot confirm" : "無法確認");
    o.observe({ kind: "suspected_terminal_input", identity: "pw", suspected: true }, owner, 16000, 16000);
    expect(interactionSummary(o.snapshot(owner, 16000))).toContain(locale === "en" ? "not confirmed" : "尚未確認");
    for (const key of ["permission", "dangerous_command", "login", "dialog", "suspected_terminal_input"]) {
      expect(t(`interactive.kind.${key}`)).not.toContain("interactive.kind.");
    }
    expect(t("inst.interaction_parked", "w", "permission")).not.toContain("inst.interaction_parked");
    expect(t("fleet.interaction_parked", "w", "permission")).not.toContain("fleet.interaction_parked");
  });
});
