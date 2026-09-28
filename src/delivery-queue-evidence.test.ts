import { describe, expect, it } from "vitest";
import { queueResumePolicyForAttempt, transcriptAbsenceCanProveNotSubmitted } from "./delivery-queue-evidence.js";

describe("durable native-queue recovery policy", () => {
  it.each([
    ["Codex without a captured CLI version", "codex", null, "native_queue_handoff" as const],
    ["Codex at an unvalidated version", "codex", "0.157.0", "native_queue_handoff" as const],
    ["Claude steering at an unvalidated version", "claude-code", "2.1.99", "steer" as const],
    ["an unknown backend", "custom-backend", "1.0.0", "native_queue_handoff" as const],
  ])("defaults %s to an unknown resume contract", (_description, backend, version, mode) => {
    expect(queueResumePolicyForAttempt(backend, version, mode)).toBe("unknown");
  });

  it("marks ordinary idle submissions as outside the CLI-owned queue contract", () => {
    expect(queueResumePolicyForAttempt("codex", "0.157.0", "idle_submit")).toBe("not_applicable");
  });

  it("uses transcript absence as negative proof only when queue ownership cannot replay", () => {
    expect(transcriptAbsenceCanProveNotSubmitted("idle_submit", "not_applicable")).toBe(true);
    expect(transcriptAbsenceCanProveNotSubmitted("native_queue_handoff", "unknown")).toBe(false);
    expect(transcriptAbsenceCanProveNotSubmitted("native_queue_handoff", "may_resume")).toBe(false);
    expect(transcriptAbsenceCanProveNotSubmitted("steer", "does_not_resume")).toBe(true);
    expect(transcriptAbsenceCanProveNotSubmitted(null, null)).toBe(false);
  });
});
