/**
 * Claude Code 2.1.314 audit (version gate, ffb8104e; the daily upstream watch's MAJOR of 2026-10-30, hard=3; the host
 * had already self-updated to it): the screens AgEnD acts on, captured from the real 2.1.314 binary with the audit rig
 * (scripts/manual/claude-version-audit, OLD=312 NEW=314): an isolated HOME, a private tmux socket, a local Anthropic
 * mock, most through the production writeConfig + buildCommand. Every screen was captured from 2.1.312 the same way and
 * classified with the production predicates: all 62 classify identically (and the 24 error frames) except the instant
 * Down+Enter on the dangerous-command menu, the timing race earlier audits showed. Provenance: the "2.1.312 → 2.1.314"
 * section of scripts/manual/claude-version-audit/README.md.
 *
 * One thing AgEnD reads moved: the permission prompt's auto-deny countdown is reworded ("Claude Code will automatically
 * block this request in M:SS, to avoid holding up an unattended session"; before: "deny … to avoid blocking progress").
 * The dangerous-command and Bash-permission dialogs' request identity left it out by the old words only, so on 2.1.314
 * it ticked every second. The other flags are not screens: "Continue from where you left off and finish the response…"
 * is sent to the model after an output-limit cut, "usage limit resets to show a clock time" is VS Code changelog prose.
 *
 * These tests hold the recognitions AgEnD relies on, against the real 2.1.314 frames.
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

const pane = (name: string) => readFileSync(new URL(`./fixtures/claude-2.1.314-${name}.pane.txt`, import.meta.url), "utf8");
const backend = new ClaudeCodeBackend("/tmp/agend-claude-2.1.314-fixture");
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

describe("Claude Code 2.1.314 screens (real panes)", () => {
  it("are 2.1.314 captures", () => {
    expect(pane("ready-statusline")).toContain("Claude Code v2.1.314");
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

  it("the Background work exit prompt is held, never answered, and blocks the quit (#1217)", () => {
    const p = pane("background-work-exit");
    expect(claudeBackgroundWorkExitActive(p)).toBe(true);
    expect(backend.quitBlockedByDialog(p)).toBe(true);
    // #1436 review: the entry that sees it presses nothing and only holds.
    const held = acting(backend.getRuntimeDialogs(), p) as Array<Dialog & { keys?: string[]; holdOnly?: boolean }>;
    expect(held.map(d => [d.keys, d.holdOnly])).toEqual([[[], true]]);
  });

  it("--continue with nothing to continue says so in the words resumeMissingPattern knows", () => {
    expect(backend.resumeMissingPattern().test(pane("continue-no-conversation"))).toBe(true);
  });
});

describe("Claude Code 2.1.314: keys sent the instant a dialog paints (real panes)", () => {
  it("the startup trust dialog drops keys sent at once (2.1.306 too): the cursor stays on 'No, exit' and AgEnD's next step is Down", () => {
    const p = pane("trust-keys-dropped");
    expect(p).toContain("❯ No, exit");
    for (const table of [backend.getStartupDialogs(), backend.getRuntimeDialogs()]) {
      const trust = acting(table, p).filter(d => d.description.startsWith("Claude workspace trust dialog"));
      expect(trust.map(d => d.keys)).toEqual([["Down"]]);
    }
  });

  it("2.1.304 declined an instant Down+Enter on the dangerous-command menu; 2.1.306 and 2.1.314 move to No and drop the Enter", () => {
    const old = readFileSync(new URL("./fixtures/claude-2.1.304-danger-down-enter-instant.pane.txt", import.meta.url), "utf8");
    expect(old).toContain("Interrupted · What should Claude do instead?");
    expect(claudeDangerousCommandPromptState(old).active).toBe(false);
    const now = pane("danger-enter-swallowed");
    expect(claudeDangerousCommandPromptState(now)).toEqual({ active: true, cursor: "no" });
  });

  it("the menu left on No is confirmed by the next poll with Enter — never Down again", () => {
    expect(acting(backend.getRuntimeDialogs(), pane("danger-enter-swallowed")).map(d => [d.description, d.keys])).toEqual([
      ["Claude dangerous-command prompt — confirm No", ["Enter"]],
    ]);
  });

  it("at AgEnD's cadence (Down, 200 ms, Enter) the command was declined: no prompt left, the composer ready", () => {
    const p = pane("danger-agend-timing-rejected");
    expect(p).toContain("Interrupted · What should Claude do instead?");
    expect(claudeDangerousCommandPromptState(p).active).toBe(false);
    expect(runtime(p)).toEqual([]);
    expect(backend.getReadyPattern().test(p)).toBe(true);
  });
});

describe("Claude Code 2.1.314: API 400 errors (real panes)", () => {
  it("the context-limit 400 paints 'Prompt is too long' and leaves the composer ready; no AgEnD error pattern reads it", () => {
    const p = pane("prompt-too-long");
    expect(p).toContain("Prompt is too long · the request is ~213487 tokens (limit 200000)");
    expect(errors(p)).toEqual([]);
    expect(runtime(p)).toEqual([]);
    expect(backend.getReadyPattern().test(p)).toBe(true);
    expect(backend.getBusyPattern().test(p)).toBe(false);
  });

  it("another 400 keeps its own text, not 'prompt is too long', and matches no error pattern", () => {
    const p = pane("api-error-400");
    expect(p).toContain("● API Error: 400 messages.1.content.0: unexpected field mock_probe");
    expect(p).not.toMatch(/prompt is too long/i);
    expect(errors(p)).toEqual([]);
    expect(backend.getReadyPattern().test(p)).toBe(true);
  });
});

describe("2.1.314: the reworded auto-deny countdown is never part of the request", () => {
  const prompt = pane("bypass-dangerous-rm-prompt");
  const identity = (p: string) => backend.getRuntimeDialogs()
    .filter(d => (d.isActive ? d.isActive(p) : d.pattern.test(p)))
    .map(d => d.requestIdentity?.(p))[0];
  it("the capture shows the new words with a ticking M:SS", () => {
    expect(prompt).toMatch(/Claude Code will automatically block this request in \d+:\d\d, to avoid holding up an unattended session/);
  });
  it("the identity is the same whatever the countdown reads (M:SS, or the 'about N minutes' form)", () => {
    const at = (when: string) => prompt.replace(/(automatically block this request in )\d+:\d\d/, `$1${when}`);
    const base = identity(prompt);
    expect(base).toBeTruthy();
    expect(base).not.toContain("automatically");
    for (const when of ["1:54", "0:07", "about 2 minutes", "about 30 seconds"]) expect(identity(at(when))).toBe(base);
  });
  it("the 2.1.312 wording is still left out too", () => {
    const old = readFileSync(new URL("./fixtures/claude-2.1.312-bypass-dangerous-rm-prompt.pane.txt", import.meta.url), "utf8");
    const id = identity(old);
    expect(id).not.toContain("automatically");
    expect(identity(old.replace(/(automatically deny this request in )\d+:\d\d/, "$10:01"))).toBe(id);
  });
});
