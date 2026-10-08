/**
 * Claude Code 2.1.295 audit (version gate, ffb8104e / af2f9f41): the screens AgEnD acts on, captured from the real
 * 2.1.295 binary with the same rig as 2.1.294 (scripts/manual/claude-version-audit, OLD=294 NEW=295): an isolated
 * HOME, a private tmux socket, a local Anthropic mock, most through the production writeConfig + buildCommand. Each
 * screen was captured from 2.1.294 the same way and diffed, and every frame of both versions (45) was classified with
 * the production predicates: the classifications and the input-box readings are identical. The only differences are
 * the spinner's verbs, the mock's reply counter and the moment the effort hint first paints.
 *
 * 2.1.295 is a large release (~150 changelog entries). Its one new screen on AgEnD's path — the server-gated
 * "Resume this conversation?" cold-cache prompt — never appeared in the rig; it is answered by #1434 (its own PR,
 * binary-derived fixtures). Coverage per surface: scripts/manual/claude-version-audit/README.md.
 *
 * These tests hold the recognitions AgEnD relies on, against the real frames.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ClaudeCodeBackend,
  CLAUDE_RESUME_PROMPT_MENU,
  claudeBackgroundWorkExitActive,
  claudeBashPermissionActive,
  claudeDangerousCommandPromptState,
  readClaudeInputBox,
} from "../src/backend/claude-code.js";

const pane = (name: string) => readFileSync(new URL(`./fixtures/claude-2.1.295-${name}.pane.txt`, import.meta.url), "utf8");
const backend = new ClaudeCodeBackend("/tmp/agend-claude-2.1.295-fixture");
type Dialog = { pattern: RegExp; isActive?: (pane: string) => boolean; description: string };
const hits = (dialogs: Dialog[], p: string) => dialogs.filter(d => (d.isActive ? d.isActive(p) : d.pattern.test(p))).map(d => d.description);
const runtime = (p: string) => hits(backend.getRuntimeDialogs(), p);
const errors = (p: string) => backend.getErrorPatterns().filter(e => e.pattern.test(p)).map(e => e.type);
/** The live retry entries (inProgress) that read a pane, with the notice each would send — the row they matched, not just a type. */
const retrying = (p: string) => backend.getErrorPatterns().filter(e => e.inProgress).flatMap(e => {
  const m = p.match(e.pattern);
  return m ? [{ type: e.type, action: e.action, notice: e.formatMessage ? e.formatMessage(m) : e.message }] : [];
});
/** The entries of one table that would act on a pane. */
const acting = (dialogs: Array<Dialog & { keys?: string[] }>, p: string) => dialogs.filter(d => (d.isActive ? d.isActive(p) : d.pattern.test(p)));

describe("Claude Code 2.1.295 screens (real panes)", () => {
  it("are 2.1.295 captures", () => {
    expect(pane("ready-statusline")).toContain("Claude Code v2.1.295");
  });

  it("onboarding: theme picker accepted, sign-in held, security notes continued", () => {
    expect(runtime(pane("onboarding-theme"))).toEqual([expect.stringContaining("theme picker")]);
    expect(runtime(pane("onboarding-login-method"))).toEqual([expect.stringContaining("sign-in screen")]);
    expect(runtime(pane("onboarding-oauth-url"))).toEqual([expect.stringContaining("sign-in screen")]);
    expect(runtime(pane("security-notes"))).toEqual([expect.stringContaining("security notes")]);
  });

  it("the workspace trust dialog is recognised as before", () => {
    expect(runtime(pane("trust-dialog"))).toEqual(expect.arrayContaining([expect.stringContaining("workspace trust dialog")]));
  });

  it("the ready composer (production statusline) shows no dialog, error or spinner", () => {
    for (const name of ["ready-statusline", "after-turn", "resumed"]) {
      const p = pane(name);
      expect(backend.getReadyPattern().test(p), name).toBe(true);
      expect(backend.getBusyPattern().test(p), name).toBe(false);
      expect(runtime(p), name).toEqual([]);
    }
    expect(errors(pane("ready-statusline"))).toEqual([]);
  });

  it("a running turn is busy by its spinner; `esc to interrupt` only without the statusline (#1239)", () => {
    expect(backend.getBusyPattern().test(pane("busy-statusline"))).toBe(true);
    expect(backend.getBusyPattern().test(pane("busy-no-statusline"))).toBe(true);
    expect(pane("busy-statusline")).not.toContain("esc to interrupt");
    expect(pane("busy-no-statusline")).toContain("esc to interrupt");
  });

  it("the input box (#1200): empty, holding a paste, a collapsed paste, a three-line paste shown in full", () => {
    expect(readClaudeInputBox(pane("ready-statusline"))).toEqual({ text: "", collapsedPastes: 0 });
    expect(readClaudeInputBox(pane("busy-pasted"))).toEqual({ text: "queued while busy MARKQ", collapsedPastes: 0 });
    expect(readClaudeInputBox(pane("paste-placeholder"))).toEqual({ text: "[Pasted text #1 +4 lines]", collapsedPastes: 1 });
    expect(readClaudeInputBox(pane("paste-expanded-same-words"))).toEqual({
      text: "same words start this paste\nmiddle line\nend with same words start this paste", collapsedPastes: 0,
    });
  });

  it("the native queue (#1169): a message submitted mid-turn is queued, read as such", () => {
    const p = pane("busy-queued");
    expect(p).toContain("ctrl+x ctrl+s to send now");
    expect(readClaudeInputBox(p)).toEqual({ text: "", collapsedPastes: 0, queued: true });
    expect(backend.getBusyPattern().test(p)).toBe(true);
  });

  it("errors: the live 429/500/401 retry row is the one read — status, attempt, action — not the 529 above it", () => {
    // The 500 and 401 frames also hold the earlier turn's repeated-529 line (scrollback), which matches a rate_limit
    // entry on its own; only the live retry entry reading the live row proves the retry is recognised.
    expect(retrying(pane("error-429-retrying-statusline"))).toEqual([{ type: "rate_limit", action: "notify",
      notice: "Claude API returned 429 — Claude Code is retrying automatically (attempt 5/10)" }]);
    expect(retrying(pane("error-500-retrying-statusline"))).toEqual([{ type: "rate_limit", action: "notify",
      notice: "Claude API returned 500 — Claude Code is retrying automatically (attempt 5/10)" }]);
    expect(retrying(pane("error-401-retrying-statusline"))).toEqual([{ type: "config_error", action: "notify",
      notice: "Claude API returned 401 — Claude Code is retrying (attempt 5/10); check the credentials" }]);
  });

  it("errors: the repeated 529 notifies; not logged in pauses as an auth error", () => {
    const final529 = backend.getErrorPatterns().filter(e => !e.inProgress && e.pattern.test(pane("error-529-repeated")));
    expect(final529.map(e => `${e.type}/${e.action}/${e.message}`)).toContain("rate_limit/notify/API overloaded");
    expect(retrying(pane("error-529-repeated"))).toEqual([]);
    const auth = backend.getErrorPatterns().filter(e => e.pattern.test(pane("not-logged-in")));
    expect(auth.map(e => `${e.type}/${e.action}`)).toEqual(["auth_error/pause"]);
  });

  it("the Bypass Permissions warning is answered stepwise: Down on 'No, exit', Enter only on 'Yes, I accept'", () => {
    const onDecline = pane("bypass-dialog");
    const onAccept = pane("bypass-dialog-cursor-accept");
    expect(onDecline).toContain("❯ No, exit");
    expect(onAccept).toContain("❯ Yes, I accept");
    for (const table of [backend.getStartupDialogs(), backend.getRuntimeDialogs()]) {
      const bypass = (p: string) => acting(table, p).filter(d => d.description.startsWith("Claude Bypass Permissions warning"));
      expect(bypass(onDecline).map(d => d.keys)).toEqual([["Down"]]);
      expect(bypass(onAccept).map(d => d.keys)).toEqual([["Enter"]]);
    }
    const accepted = pane("bypass-accepted");
    expect(accepted).toContain("bypass permissions on");
    expect(runtime(accepted)).toEqual([]);
    expect(backend.getReadyPattern().test(accepted)).toBe(true);
  });

  it("the dangerous-rm prompt in bypass mode is declined; the native Bash permission is held, never answered", () => {
    const danger = pane("bypass-dangerous-rm-prompt");
    expect(claudeDangerousCommandPromptState(danger)).toEqual({ active: true, cursor: "yes" });
    expect(acting(backend.getRuntimeDialogs(), danger).map(d => [d.description, d.keys])).toEqual([
      ["Claude dangerous-command prompt — select No", ["Down", "Enter"]],
    ]);
    const perm = pane("bash-permission-prompt");
    expect(claudeBashPermissionActive(perm)).toBe(true);
    expect(acting(backend.getRuntimeDialogs(), perm).map(d => [d.description, d.keys])).toEqual([
      ["Claude Bash permission — waiting for a human choice, never auto-approving", []],
    ]);
  });

  it("unanswered by design, as before (claude-dialogs-1074's documented gap): MCP approval and the API-key dialog", () => {
    // Neither table presses Enter on them; each screen's default is the safe choice.
    expect(pane("mcp-approval")).toContain("❯ Continue without using this MCP server");
    expect(pane("api-key-dialog")).toContain("❯ No (recommended)");
    for (const name of ["mcp-approval", "api-key-dialog"]) {
      for (const table of [backend.getStartupDialogs(), backend.getRuntimeDialogs()]) {
        expect(acting(table, pane(name)).flatMap(d => d.keys ?? []), name).not.toContain("Enter");
      }
    }
  });

  it("--continue of a session backdated 4h resumed straight into the conversation: no resume menu was shown", () => {
    const p = pane("continue-aged-session");
    expect(CLAUDE_RESUME_PROMPT_MENU.test(p)).toBe(false);
    expect(runtime(p)).toEqual([]);
    expect(backend.getReadyPattern().test(p)).toBe(true);
  });

  it("the Background work exit prompt is held, never answered, and blocks the quit (#1217)", () => {
    const p = pane("background-work-exit");
    expect(claudeBackgroundWorkExitActive(p)).toBe(true);
    expect(backend.quitBlockedByDialog(p)).toBe(true);
  });

  it("--continue with nothing to continue says so in the words resumeMissingPattern knows", () => {
    expect(backend.resumeMissingPattern().test(pane("continue-no-conversation"))).toBe(true);
  });
});
