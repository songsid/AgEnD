/**
 * Claude Code 2.1.291 audit (version gate, ffb8104e): every screen AgEnD acts on,
 * captured from the real 2.1.291 binary in an isolated HOME, on a private tmux
 * socket, against a local Anthropic mock. Most were launched with the
 * production writeConfig + buildCommand. Each screen was captured from 2.1.289
 * the same way and diffed: apart from the version string, the only change is
 * that the `/` and `@` suggestion lists now mark the selected row with `❯`
 * (2.1.290: "the selected row now starts with a ❯ pointer").
 *
 * These tests hold the recognitions AgEnD relies on, against the real frames.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ClaudeCodeBackend,
  claudeBackgroundWorkExitActive,
  claudeDangerousCommandPromptState,
} from "../src/backend/claude-code.js";

const pane = (name: string) => readFileSync(new URL(`./fixtures/claude-2.1.291-${name}.pane.txt`, import.meta.url), "utf8");
const backend = new ClaudeCodeBackend("/tmp/agend-claude-2.1.291-fixture");
type Dialog = { pattern: RegExp; isActive?: (pane: string) => boolean; description: string };
const hits = (dialogs: Dialog[], p: string) => dialogs.filter(d => (d.isActive ? d.isActive(p) : d.pattern.test(p))).map(d => d.description);
const runtime = (p: string) => hits(backend.getRuntimeDialogs(), p);
const errors = (p: string) => backend.getErrorPatterns().filter(e => e.pattern.test(p)).map(e => e.type);

describe("Claude Code 2.1.291 screens (real panes)", () => {
  it("are 2.1.291 captures", () => {
    expect(pane("ready-statusline")).toContain("Claude Code v2.1.291");
  });

  it("onboarding: theme picker accepted, sign-in held, security notes continued", () => {
    expect(runtime(pane("onboarding-theme"))).toEqual([expect.stringContaining("theme picker")]);
    expect(runtime(pane("onboarding-login-method"))).toEqual([expect.stringContaining("sign-in screen")]);
    expect(runtime(pane("onboarding-oauth-url"))).toEqual([expect.stringContaining("sign-in screen")]);
    expect(runtime(pane("security-notes"))).toEqual([expect.stringContaining("security notes")]);
  });

  it("trust and Bypass Permissions screens are recognised as before", () => {
    expect(runtime(pane("trust-dialog"))).toEqual(expect.arrayContaining([expect.stringContaining("workspace trust dialog")]));
    expect(runtime(pane("bypass-dialog"))).toEqual(expect.arrayContaining([expect.stringContaining("Bypass Permissions warning")]));
  });

  it("the ready composer (production statusline) shows no dialog, error or spinner", () => {
    const p = pane("ready-statusline");
    expect(backend.getReadyPattern().test(p)).toBe(true);
    expect(backend.getBusyPattern().test(p)).toBe(false);
    expect(runtime(p)).toEqual([]);
    expect(errors(p)).toEqual([]);
  });

  it("the new ❯ pointer in the / suggestion list is not read as a dialog, an error or a turn", () => {
    for (const name of ["slash-suggestions-pointer", "exit-command-suggestion"]) {
      const p = pane(name);
      expect(p).toMatch(/^[ \t]+❯ \/\S+/m);
      expect(runtime(p)).toEqual([]);
      expect(errors(p)).toEqual([]);
      expect(backend.getBusyPattern().test(p)).toBe(false);
    }
  });

  it("a running turn is busy by its spinner, with or without the statusline", () => {
    expect(backend.getBusyPattern().test(pane("busy-statusline"))).toBe(true);
    expect(backend.getBusyPattern().test(pane("busy-no-statusline"))).toBe(true);
  });

  it("the Background work exit prompt is held, never answered, and blocks the quit (#1217)", () => {
    const p = pane("background-work-exit");
    expect(claudeBackgroundWorkExitActive(p)).toBe(true);
    expect(backend.quitBlockedByDialog(p)).toBe(true);
    expect(backend.getRuntimeDialogs().filter(d => d.isActive?.(p))).toEqual([
      expect.objectContaining({ keys: [], holdOnly: true, blocksDelivery: true }),
    ]);
  });

  it("the dangerous-rm prompt in bypass mode is declined; the native Bash permission is held", () => {
    expect(claudeDangerousCommandPromptState(pane("bypass-dangerous-rm-prompt"))).toEqual({ active: true, cursor: "yes" });
    expect(runtime(pane("bash-permission-prompt"))).toEqual([expect.stringContaining("Bash permission")]);
  });

  it("--continue with nothing to continue says so in the words resumeMissingPattern knows", () => {
    expect(backend.resumeMissingPattern().test(pane("continue-no-conversation"))).toBe(true);
  });

  it("errors: not logged in pauses as an auth error, repeated 529 notifies", () => {
    expect(errors(pane("not-logged-in"))).toContain("auth_error");
    expect(errors(pane("error-529-repeated"))).toContain("rate_limit");
  });
});
