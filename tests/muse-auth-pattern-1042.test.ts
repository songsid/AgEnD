/**
 * #1042: muse was paused and /quit mid-task because its auth_error pattern
 * matched a bare `401`, and muse's diff view numbers its rows. The error scan
 * reads the whole pane, so editing line 401 of any file "was" an auth error.
 * Muse has no token-free auth check to overrule the hit, so the pattern itself
 * must only match muse's own sign-in failures.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MuseBackend } from "../src/backend/muse.js";

const auth = new MuseBackend("/tmp/agend-muse-1042").getErrorPatterns().find(p => p.type === "auth_error")!;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("muse auth_error matches muse's sign-in failures, not the transcript (#1042)", () => {
  it("still pauses", () => {
    expect(auth.action).toBe("pause");
  });

  it("a real muse diff reaching line 401 is not an auth error", () => {
    const pane = fixture("muse-diff-line-401.pane.txt");
    expect(pane).toMatch(/^\s+401 \+/m); // the row that used to fire
    expect(auth.pattern.test(pane)).toBe(false);
  });

  it("the agent's own words about 401 or unauthorized are not either", () => {
    for (const line of [
      "401/schema/no-last-good + Codex/Google token-expired 仍 loud、39/39、CI 全綠",
      "The endpoint returns 401 Unauthorized when the token is missing.",
      "expect(res.status).toBe(401);",
      "Unauthorized guild tried /start",
      "MCP HTTP authentication failed: 403",
    ]) expect(auth.pattern.test(line), line).toBe(false);
  });

  it("muse's own messages (from the 1.4.1 binary) still are", () => {
    for (const line of [
      "still unauthorized after a token refresh; run `muse login` again",
      "your saved login is no longer valid. Log in again or use a different account.",
      "Not logged in. Run muse login again to log in.",
      "Retry the command. If the problem continues, run `muse login`.",
    ]) expect(auth.pattern.test(line), line).toBe(true);
  });
});
