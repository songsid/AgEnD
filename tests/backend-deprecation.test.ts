import { describe, it, expect } from "vitest";
import { BACKENDS } from "../src/setup-wizard.js";

// Gemini CLI is deprecated (stops 2026-06-18): it stays a valid config value,
// but every surface that offers backends to users must label it. BACKENDS is
// the single source of truth consumed by the setup wizard picker, quickstart
// detection, and `agend backend doctor`.
describe("backend deprecation labeling", () => {
  it("marks gemini-cli deprecated and no other backend", () => {
    const gemini = BACKENDS.find(b => b.id === "gemini-cli");
    expect(gemini?.deprecated).toBe(true);
    for (const b of BACKENDS) {
      if (b.id !== "gemini-cli") expect(b.deprecated).toBeFalsy();
    }
  });

  it("covers every non-mock backend the factory accepts (doctor derives from this list)", () => {
    // Keep in sync with src/backend/factory.ts — a backend missing here is
    // invisible to `agend backend doctor` (the pre-fix state: antigravity and
    // grok were undiagnosable while deprecated gemini-cli was fully supported).
    const ids = BACKENDS.map(b => b.id);
    for (const required of ["claude-code", "codex", "opencode", "kiro-cli", "antigravity", "grok", "gemini-cli"]) {
      expect(ids).toContain(required);
    }
  });
});
