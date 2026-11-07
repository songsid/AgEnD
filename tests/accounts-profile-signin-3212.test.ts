/**
 * #3212 PR 4: Codex and Kiro credential profiles sign in from chat and the web dashboard, as Claude Code's do — their
 * logins were checked under a relocated home (issue #3212, 2026-11-07). The dashboard offers Sign in for a named account
 * of exactly these three; another CLI's profile (none today) or a CLI without a reviewed login stays host-only.
 */
import { describe, expect, it } from "vitest";
import { dashboardSignInSupported } from "../src/web-backend-login.js";
import { CHAT_PROFILE_LOGIN_BACKENDS, credentialProfileEnv } from "../src/backend/credential-profile.js";
import { admitProfileLogin } from "../src/login-controller.js";

describe("#3212 PR 4: profile sign-in from chat and the dashboard", () => {
  it("Claude Code, Codex and Kiro profiles; nothing else", () => {
    expect([...CHAT_PROFILE_LOGIN_BACKENDS].sort()).toEqual(["claude-code", "codex", "kiro-cli"]);
    for (const backend of ["claude-code", "codex", "kiro-cli"]) {
      expect([backend, dashboardSignInSupported(backend, "work"), dashboardSignInSupported(backend)]).toEqual([backend, true, true]);
      expect(admitProfileLogin(backend, "work"), backend).toEqual({ profile: "work" });
    }
    expect(dashboardSignInSupported("antigravity", "work")).toBe(false);
  });
  it("each runs with its profile's own variable (the login lands in the profile, nowhere else)", () => {
    const env = (b: string) => Object.keys(credentialProfileEnv("/fleet", b, "work") ?? {});
    expect([env("claude-code"), env("codex"), env("kiro-cli")]).toEqual([["CLAUDE_CONFIG_DIR"], ["CODEX_HOME"], ["XDG_DATA_HOME"]]);
  });
  it("an invalid name is still refused for each", () => {
    for (const backend of ["codex", "kiro-cli"]) expect("refusal" in admitProfileLogin(backend, "../x"), backend).toBe(true);
  });
});
