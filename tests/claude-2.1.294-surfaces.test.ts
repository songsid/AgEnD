/**
 * Claude Code 2.1.294 audit (version gate, ffb8104e): every screen AgEnD acts on, captured from the real 2.1.294
 * binary in an isolated HOME, on a private tmux socket, against a local Anthropic mock — most through the production
 * writeConfig + buildCommand (with AgEnD's statusLine, as instances run). Each screen was captured from 2.1.292 the
 * same way and diffed, and every frame of both versions was classified with the production predicates: the
 * classifications and the input-box readings are identical. The only differences are the spinner's verbs and a
 * one-time "Updated to latest" banner for a home last used by an older version.
 *
 * Upstream changes that touch AgEnD's surfaces, checked specifically: 2.1.293's pasted-text detection fix (pastes
 * are recorded the same way in the transcript, and the input box still collapses a long paste) and its queued-message
 * fix (the queue still shows the row, `ctrl+x ctrl+s to send now` and `Press up to edit queued messages`, and the
 * transcript still records enqueue/dequeue). 2.1.294 itself changes only hooks.
 *
 * These tests hold the recognitions AgEnD relies on, against the real frames.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend, claudeBackgroundWorkExitActive, readClaudeInputBox } from "../src/backend/claude-code.js";

const pane = (name: string) => readFileSync(new URL(`./fixtures/claude-2.1.294-${name}.pane.txt`, import.meta.url), "utf8");
const backend = new ClaudeCodeBackend("/tmp/agend-claude-2.1.294-fixture");
type Dialog = { pattern: RegExp; isActive?: (pane: string) => boolean; description: string };
const hits = (dialogs: Dialog[], p: string) => dialogs.filter(d => (d.isActive ? d.isActive(p) : d.pattern.test(p))).map(d => d.description);
const runtime = (p: string) => hits(backend.getRuntimeDialogs(), p);
const errors = (p: string) => backend.getErrorPatterns().filter(e => e.pattern.test(p)).map(e => e.type);

describe("Claude Code 2.1.294 screens (real panes)", () => {
  it("are 2.1.294 captures", () => {
    expect(pane("ready-statusline")).toContain("Claude Code v2.1.294");
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

  it("the ready composer (production statusline, with the upgrade banner) shows no dialog, error or spinner", () => {
    for (const name of ["ready-statusline", "after-turn", "resumed"]) {
      const p = pane(name);
      expect(backend.getReadyPattern().test(p), name).toBe(true);
      expect(backend.getBusyPattern().test(p), name).toBe(false);
      expect(runtime(p), name).toEqual([]);
    }
    expect(errors(pane("ready-statusline"))).toEqual([]);
    expect(pane("ready-statusline")).toContain("Updated to latest");
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

  it("errors: 429/500/401 retry rows and repeated 529 are recognised as before", () => {
    expect(errors(pane("error-429-retrying-statusline"))).toContain("rate_limit");
    expect(errors(pane("error-500-retrying-statusline"))).toContain("rate_limit");
    expect(errors(pane("error-401-retrying-statusline"))).toContain("config_error");
    expect(errors(pane("error-529-repeated"))).toContain("rate_limit");
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
