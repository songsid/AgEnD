/**
 * #1042: muse was paused and /quit mid-task because its auth_error pattern
 * matched a bare `401`, and muse's diff view numbers its rows. The error scan
 * reads the whole pane, transcript included, and muse has no token-free auth
 * check to overrule a hit, so the pattern itself must match only muse's own
 * sign-in failures: whole muse sentences, not on a transcript row.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MuseBackend } from "../src/backend/muse.js";

const auth = new MuseBackend("/tmp/agend-muse-1042").getErrorPatterns().find(p => p.type === "auth_error")!;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
/** How the daemon's error monitor counts occurrences in a pane. */
const hits = (pane: string) => (pane.match(new RegExp(auth.pattern.source, auth.pattern.flags + "g")) ?? []).length;

describe("muse auth_error matches muse's sign-in failures, not the transcript (#1042)", () => {
  it("still pauses", () => {
    expect(auth.action).toBe("pause");
  });

  it("the real rejected-key error muse printed is one (captured live, fake key)", () => {
    expect(hits(fixture("muse-api-key-rejected.pane.txt"))).toBe(1);
  });

  it("muse's other sign-in messages (from the 1.4.1 binary), each on its own row, are", () => {
    for (const line of [
      "response failed (status 401) (still unauthorized after a token refresh; run `muse login` again)",
      "your saved login is no longer valid. Log in again or use a different account.",
      "Not logged in. Run `muse login` again to log in.",
      "Not logged in — run /login to get started, or set META_API_KEY",
    ]) expect(hits(`  some earlier output\n  ${line}\n`), line).toBe(1);
  });

  it("a real muse diff reaching line 401 is not", () => {
    const pane = fixture("muse-diff-line-401.pane.txt");
    expect(pane).toMatch(/^\s+401 \+/m); // the row that used to fire
    expect(hits(pane)).toBe(0);
  });

  it("the conversation mentioning sign-in is not", () => {
    for (const line of [
      "I'm not logged in to GitHub, so I can't open the PR.",
      "Not logged in? Then run `muse login` first.",
      "Retry the command. If the problem continues, run `muse login`.",
      "401/schema/no-last-good + Codex/Google token-expired 仍 loud、39/39、CI 全綠",
      "The endpoint returns 401 Unauthorized when the token is missing.",
      "Unauthorized guild tried /start",
      "MCP HTTP authentication failed: 403",
    ]) expect(hits(`  ${line}\n`), line).toBe(0);
  });

  it("muse's own sentences quoted on a user or assistant row are not", () => {
    for (const quoted of [
      "❯ what does \"your saved login is no longer valid. Log in again or use a different account\" mean?",
      "◆ Muse says \"still unauthorized after a token refresh; run `muse login` again\" when the refresh fails.",
      "◆ If you see \"Not logged in. Run `muse login` again to log in.\", sign in again.",
      "  ◆ The rejected-key error reads \"your API key from META_API_KEY was rejected\".",
    ]) expect(hits(`${quoted}\n`), quoted).toBe(0);
  });
});
