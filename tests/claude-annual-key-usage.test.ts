import { describe, expect, it } from "vitest";
import { resolveClaudeAuth } from "../src/usage/providers.js";

/**
 * The Claude usage provider only read `~/.claude/.credentials.json`. Users on
 * the annual-token flow (`claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN) often
 * have no credentials file at all, or a stale one from an old interactive
 * login — so /usage told them "not logged in" or "token expired" while their
 * CLI authenticated fine the whole time.
 */

const FRESH = {
  accessToken: "sk-ant-oat01-file",
  expiresAt: Date.now() + 3_600_000,
  subscriptionType: "max",
  rateLimitTier: "default_claude_20x",
};

describe("resolveClaudeAuth", () => {
  it("prefers a fresh file token and carries its plan metadata", () => {
    const auth = resolveClaudeAuth(FRESH, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-env" });
    expect(auth).toEqual({ token: "sk-ant-oat01-file", plan: "Max 20x" });
  });

  it("uses the annual env token when there is no credentials file", () => {
    // The reported case: setup-token login, no .credentials.json.
    const auth = resolveClaudeAuth(null, { CLAUDE_CODE_OAUTH_TOKEN: " sk-ant-oat01-env " });
    expect(auth).toEqual({ token: "sk-ant-oat01-env", plan: null });
  });

  it("falls back to the env token when the file token has expired", () => {
    // The other reported shape: a stale interactive login left behind, while the
    // CLI actually authenticates via the env token. "Token expired" was a lie.
    const stale = { ...FRESH, expiresAt: Date.now() - 1 };
    const auth = resolveClaudeAuth(stale, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-env" });
    expect(auth).toEqual({ token: "sk-ant-oat01-env", plan: "Max 20x" });
  });

  it("keeps the explicit expiry error when there is no env fallback", () => {
    const stale = { ...FRESH, expiresAt: Date.now() - 1 };
    const auth = resolveClaudeAuth(stale, {});
    expect(auth).toEqual({ error: "Access token expired. Run `claude` once to refresh it.", plan: "Max 20x" });
  });

  it("returns null (not-logged-in) when neither source exists", () => {
    expect(resolveClaudeAuth(null, {})).toBeNull();
  });

  it("does not treat an empty env token as a login", () => {
    expect(resolveClaudeAuth(null, { CLAUDE_CODE_OAUTH_TOKEN: "  " })).toBeNull();
  });
});
