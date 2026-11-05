import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { summarizeProgress } from "../src/tool-progress.js";

/**
 * The channel's progress line never carries a search pattern, and the line's sink masks secrets BEFORE it caps the
 * length: a 40-character token fits under the 48-character cap whole, so the cap is never what keeps a secret out.
 * Synthetic token shapes only, built at run time.
 */
const PAT = "ghp_" + "Ab1".repeat(12);                      // 40 characters, a GitHub-PAT shape
const OPAQUE = "Xy9".repeat(13) + "Z";                     // 40 characters, mixed-case random shape, no known prefix
const ELAPSED = 31_000;                                     // past the threshold: the detail shows

const dir = mkdtempSync(join(tmpdir(), "agend-progress-search-"));
writeFileSync(join(dir, "window-id"), "@1");
const daemon = new Daemon("progress-search", {
  working_directory: "/tmp",
  restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
  context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  log_level: "silent",
} as never, dir, false, { getReadyPattern: () => /READY/ } as never, undefined,
  { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } as never);
const summarize = (name: string, input: unknown) =>
  (daemon as unknown as { summarizeTool(n: string, i: unknown): string }).summarizeTool(name, input);

describe("search patterns never reach the channel progress line", () => {
  it("Grep and Glob with a token-shaped pattern: the tool name only, end to end into progressText", () => {
    expect(PAT).toHaveLength(40);
    for (const name of ["Grep", "Glob"]) {
      for (const pattern of [PAT, OPAQUE, `token=${PAT}`, "plainword"]) {
        const label = summarize(name, { pattern, path: "src" });
        expect(label).toBe(name);
        const line = FleetManager.progressText(ELAPSED, label);
        expect(line).toBe(`⏳ 處理中… (已進行 0m 31s · ${name})`);
        expect(line).not.toContain(PAT.slice(4, 20));
        expect(line).not.toContain(OPAQUE.slice(0, 16));
      }
    }
  });

  it("the semantic bubble label for a search carries no pattern at any level", () => {
    for (const level of ["standard", "verbose"] as const) {
      for (const name of ["Grep", "Glob"]) {
        const label = summarizeProgress(name, { pattern: PAT }, level);
        expect(label).toBe("🔍 搜尋程式碼");
      }
    }
  });

  it("the sink masks a token in any other label before the cap, so no part of it reaches the line", () => {
    // The last one: the cap would leave only the token's first 13 characters — too short for any shape rule to see.
    for (const activity of [`Read /tmp/${PAT}`, `Read ${OPAQUE}`, `$ curl ${PAT}`, `Edit a/${OPAQUE}/b.ts`, `Read ${"d/".repeat(15)}${OPAQUE}`]) {
      const line = FleetManager.progressText(ELAPSED, activity);
      expect(line).toContain("[REDACTED]");
      expect(line).not.toContain(PAT.slice(4, 16));
      expect(line).not.toContain(OPAQUE.slice(0, 12));
    }
    // A harmless label is unchanged; the cap still applies after masking.
    expect(FleetManager.progressText(ELAPSED, "Read src/fleet-manager.ts")).toBe("⏳ 處理中… (已進行 0m 31s · Read src/fleet-manager.ts)");
    expect(FleetManager.progressText(ELAPSED, `Read ${"a/".repeat(60)}x.ts`)).toContain("…)");
  });
});
