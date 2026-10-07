import { describe, it, expect } from "vitest";
import { BACKENDS } from "../src/setup-wizard.js";

// BACKENDS is the single source of truth consumed by the setup wizard picker, quickstart detection, and
// `agend backend doctor`. gemini-cli was removed in 2.1.12 (#1280): it is no longer offered anywhere.
describe("backends offered to users", () => {
  it("offers no deprecated backend, and not the removed gemini-cli", () => {
    for (const b of BACKENDS) expect(b.deprecated, b.id).toBeFalsy();
    expect(BACKENDS.map(b => b.id)).not.toContain("gemini-cli");
  });

  it("covers every non-mock backend the factory accepts (doctor derives from this list)", () => {
    // Keep in sync with src/backend/factory.ts — a backend missing here is
    // invisible to `agend backend doctor` (the pre-fix state: antigravity and
    // grok were undiagnosable).
    const ids = BACKENDS.map(b => b.id);
    for (const required of ["claude-code", "codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"]) {
      expect(ids).toContain(required);
    }
  });
});
