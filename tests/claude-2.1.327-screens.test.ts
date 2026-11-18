/**
 * Claude Code 2.1.327 audit (M-3336; the daily upstream watch's MAJOR of 2026-11-18, hard=9; the host had already
 * self-updated to it): no detector change. The screens AgEnD acts on, captured from the real 2.1.327 binary (sha256
 * 343c744b…, byte-identical to the host's) with the audit rig (scripts/manual/claude-version-audit, OLD=326 NEW=327): an
 * isolated HOME, a private tmux socket, a local Anthropic mock, most through the production writeConfig + buildCommand.
 * Every screen was captured from 2.1.326 the same way, and the production predicates read all 72 captures and 30 error frames alike except
 * 132-danger-fast, a timing race that is the same on both (danger-probe: Down+Enter in one burst leaves the cursor on No
 * on 2.1.326 and 2.1.327 alike, 4/4 each; AgEnD's Down, 200 ms, Enter declines, 4/4 on both, and 8/8 after a 0.5 s or 1 s wait).
 *
 * The same screens as the 2.1.326 set, each from the same capture of the 2.1.327 pass; the cold-resume prompt
 * (cold-resume/live.mts, 327 cases: 4/4 PASS) and the resume-from-summary menu (cold-resume/resume-menu.mts, 327-menu at
 * 160 and 80 columns: PASS) live; the retry rows; the Cloud gateway sign-in; and, added by this audit, the "Switch model?"
 * confirmation (#1690) with its key-hint footer and the Bash permission prompt with the cursor at No after Down past the
 * last row. The 2.1.327 changelog says "the arrow keys on most permission prompts stop at No instead of wrapping around";
 * on the rig 2.1.326 already did the same on both prompts (Up from Yes lands on No, Down past No stays there), and
 * AgEnD never relies on a wrap: its keys are Down from a verified cursor, and a remote card walks one verified step at
 * a time, never past the list's ends. 2.1.327 draws
 * its dialogs two columns in (2.1.326: three); every predicate reads both. Provenance: the "2.1.326 → 2.1.327" section of
 * scripts/manual/claude-version-audit/README.md.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ClaudeCodeBackend,
  claudeResumeMenuState,
  claudeSwitchDialog,
  claudeLoginScreenActive,
  claudeBackgroundWorkExitActive,
  claudeBashPermissionActive,
  claudeDangerousCommandPromptState,
  readClaudeInputBox,
} from "../src/backend/claude-code.js";

const pane = (name: string) => readFileSync(new URL(`./fixtures/claude-2.1.327-${name}.pane.txt`, import.meta.url), "utf8");
const backend = new ClaudeCodeBackend("/tmp/agend-claude-2.1.327-fixture");
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

describe("Claude Code 2.1.327 screens (real panes)", () => {
  it("are 2.1.327 captures", () => {
    expect(pane("ready-statusline")).toContain("Claude Code v2.1.327");
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

  it("a running turn is busy by its spinner — the slot, never the footer (#1239): 2.1.327 shows `esc to interrupt` under the statusline too (as 2.1.326)", () => {
    expect(backend.getBusyPattern().test(pane("busy-statusline"))).toBe(true);
    expect(backend.getBusyPattern().test(pane("busy-no-statusline"))).toBe(true);
    expect(pane("busy-statusline")).toMatch(/^  ok\n  ⏵⏵ bypass permissions on \(shift\+tab to cycle\) · esc to interrupt$/m);
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

  it("the native queue (#1169): a message submitted mid-turn is queued, read as such (since 2.1.326 its marker is a `⎿ Queued ·` row)", () => {
    const p = pane("busy-queued");
    expect(p).toMatch(/^  ⎿  Queued · ctrl\+x ctrl\+s to send now$/m);
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

describe("Claude Code 2.1.327: keys sent the instant a dialog paints (real panes)", () => {
  it("the startup trust dialog drops keys sent at once (2.1.306 too): the cursor stays on 'No, exit' and AgEnD's next step is Down", () => {
    const p = pane("trust-keys-dropped");
    expect(p).toContain("❯ No, exit");
    for (const table of [backend.getStartupDialogs(), backend.getRuntimeDialogs()]) {
      const trust = acting(table, p).filter(d => d.description.startsWith("Claude workspace trust dialog"));
      expect(trust.map(d => d.keys)).toEqual([["Down"]]);
    }
  });

  it("2.1.304 declined an instant Down+Enter on the dangerous-command menu; 2.1.306 through 2.1.327 move to No and drop the Enter (danger-probe: 2.1.326 the same, 4/4 each)", () => {
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

describe("Claude Code 2.1.327: API 400 errors (real panes)", () => {
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

describe("2.1.327: the auto-deny countdown is never part of the request", () => {
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
  it("a command that merely quotes those words is part of the request: two such commands are two requests (#2885 review)", () => {
    const quoting = (path: string) => prompt.replace(/bash -c 'rm -rf "\$\(echo \/tmp\/agend-safe-probe\)"\/\*'/g, `rg 'Claude Code will automatically block this request in ' ${path}`);
    const a = quoting("src/backend/claude-code.ts"), b = quoting("tests/claude-2.1.327-screens.test.ts");
    expect(a).not.toBe(prompt);
    expect(identity(a)).toContain("rg 'Claude Code will automatically block this request in ' src/backend/claude-code.ts");
    expect(identity(a)).not.toBe(identity(b));
    // …while the countdown row itself still ticks out of it.
    expect(identity(a.replace(/(⚠ Claude Code will automatically block this request in )\d+:\d\d/, "$10:03"))).toBe(identity(a));
  });
  it("the countdown row wrapped by a narrow pane (its tail on the next row) is still left out", () => {
    const wrapped = (when: string) => prompt.replace(/(⚠ Claude Code will automatically block this request in )\d+:\d\d, to avoid holding up an unattended session/, `$1${when}\n   , to avoid holding up an unattended session`);
    expect(identity(wrapped("1:20"))).toBe(identity(wrapped("1:19")));
  });
  it("the 2.1.312 wording is still left out too", () => {
    const old = readFileSync(new URL("./fixtures/claude-2.1.312-bypass-dangerous-rm-prompt.pane.txt", import.meta.url), "utf8");
    const id = identity(old);
    expect(id).not.toContain("automatically");
    expect(identity(old.replace(/(automatically deny this request in )\d+:\d\d/, "$10:01"))).toBe(id);
  });
});

describe("Claude Code 2.1.327: the cold-resume prompt, live (real panes)", () => {
  // cold-resume/live.mts 327-summary-newfocus: the server's summary option and the new-conversation focus; AgEnD's real
  // startup scan answered it with Escape (resume, history kept) on 2.1.327 — the case that dropped an early key on 2.1.322.
  const prompt = pane("cold-resume-live-summary-newfocus"), after = pane("cold-resume-live-after-escape");
  const startup = (p: string) => (backend.getStartupDialogs?.() ?? []).filter(d => (d.isActive ? d.isActive(p) : d.pattern.test(p)));
  it("the prompt is the cold-resume prompt, answered with Escape, at startup and at runtime", () => {
    expect(prompt).toContain("Claude Code v2.1.327");
    const s = startup(prompt);
    expect(s.map(d => d.keys)).toEqual([["Escape"]]);
    expect(acting(backend.getRuntimeDialogs(), prompt).map(d => d.keys)).toEqual([["Escape"]]);
  });
  it("after the Escape: the conversation is back, no dialog is left and the composer is ready", () => {
    expect(startup(after)).toEqual([]);
    expect(runtime(after)).toEqual([]);
    expect(backend.getReadyPattern().test(after)).toBe(true);
  });
});

describe("Claude Code 2.1.327 sign-in screens", () => {
  const signIn = (p: string) => runtime(p).filter(d => d.includes("sign-in screen"));
  it("the OAuth URL screen (2.1.326's boxed paste input and `Esc to go back`) is the sign-in: held, delivery blocked", () => {
    const p = pane("onboarding-oauth-url");
    expect(p).toMatch(/^ Browser didn't open\? Use the URL below to sign in/m);
    expect(p).toMatch(/^ Paste code here if prompted$/m);
    expect(p).toMatch(/^ Esc to go back$/m);
    expect(claudeLoginScreenActive(p)).toBe(true);
    expect(signIn(p)).toHaveLength(1);
  });
  it("…but only with the URL above it: a lone paste box is not a sign-in", () => {
    const p = pane("onboarding-oauth-url").split("\n").filter(r => !/Browser didn't open|oauth|^[0-9A-Za-z%&=_.-]+$|^m%2F|^3A/.test(r)).join("\n");
    expect(claudeLoginScreenActive(p)).toBe(false);
  });
  it("the Cloud gateway URL screen (`Enter to connect · Esc to go back`) is the sign-in", () => {
    const p = pane("gateway-url");
    expect(p).toMatch(/^  Enter to connect · Esc to go back$/m);
    expect(claudeLoginScreenActive(p)).toBe(true);
  });
  it("the login-method menu with its `Esc to cancel` footer is the sign-in", () => {
    const p = pane("login-method-after-gateway-esc");
    expect(p).toMatch(/^  Esc to cancel$/m);
    expect(claudeLoginScreenActive(p)).toBe(true);
  });
  it("the pre-2.1.326 footers still read the same", () => {
    expect(claudeLoginScreenActive(pane("gateway-url").replace("Enter to connect · Esc to go back", "Press Enter to connect · Esc for other login methods"))).toBe(true);
    expect(claudeLoginScreenActive(pane("login-method-after-gateway-esc").replace("  Esc to cancel", ""))).toBe(true);
  });
});

describe("Claude Code 2.1.327: the resume-from-summary menu (live, resume-menu.mts)", () => {
  it("is the active menu with the cursor on the summary default, at 160 and 80 columns", () => {
    for (const name of ["resume-summary-menu", "resume-summary-menu-80"]) {
      expect(pane(name), name).toContain("Claude Code v2.1.327");
      expect(pane(name), name).toMatch(/^[ \t]*3\. Don't ask again[ \t]*$/m);
      expect(claudeResumeMenuState(pane(name)), name).toEqual({ active: true, defaultCursor: true });
    }
  });
  it("both tables answer it the one way that keeps the history: Down, Enter, and hold delivery meanwhile", () => {
    for (const name of ["resume-summary-menu", "resume-summary-menu-80"]) {
      for (const [table, dialogs] of [["startup", backend.getStartupDialogs()], ["runtime", backend.getRuntimeDialogs()]] as const) {
        const first = acting(dialogs as Array<Dialog & { keys?: string[]; blocksDelivery?: boolean }>, pane(name))[0] as (Dialog & { keys?: string[]; blocksDelivery?: boolean }) | undefined;
        expect(first?.description, `${table} ${name}`).toContain("select 'Resume full session as-is'");
        expect([first?.keys, first?.blocksDelivery], `${table} ${name}`).toEqual([["Down", "Enter"], true]);
      }
    }
  });
  it("after Down, Enter: the full session, ready, no menu", () => {
    const p = pane("resume-summary-after-full");
    expect(claudeResumeMenuState(p).active).toBe(false);
    expect(p).toContain("BIG hello");
    expect(backend.getReadyPattern().test(p)).toBe(true);
  });
});

describe("Claude Code 2.1.327: the API-retry row (production launch, with the statusline)", () => {
  const rows = ["error-429-retrying-statusline", "error-401-retrying-statusline", "error-500-retrying-statusline", "error-api-retrying-statusline", "error-429-retrying-no-wait"];
  it("are the lower-case rows of 2.1.326, each busy", () => {
    for (const name of rows) {
      expect(pane(name), name).toMatch(/^✻ .* · retrying(?: in \d+s|…) · attempt \d+\/10$/m);
      expect(backend.getBusyPattern().test(pane(name)), name).toBe(true);
    }
  });
  it("the generic first attempts send no notice; the no-wait form (the real 429 frame, its wait replaced) sends the 429's", () => {
    expect(retrying(pane("error-api-retrying-statusline"))).toEqual([]);
    expect(retrying(pane("error-429-retrying-no-wait"))).toEqual([{ type: "rate_limit", action: "notify",
      notice: "Claude API returned 429 — Claude Code is retrying automatically (attempt 5/10)" }]);
  });
});

describe("Claude Code 2.1.327: the model switch confirmation (#1690) and the arrow keys' stop at No", () => {
  it("\"Switch model?\" is read with its target and cursor; its key-hint footer does not hide it", () => {
    const p = pane("switch-model-opus");
    expect(p).toMatch(/^  Enter to confirm · Esc to cancel$/m);
    expect(claudeSwitchDialog(p)).toEqual({ kind: "model", target: "Opus 5.5", cursor: 1 });
  });
  it("it is held for every delivery, never answered by the scanner (AgEnD's own /model answers it on a verified cursor)", () => {
    const held = acting(backend.getRuntimeDialogs(), pane("switch-model-opus")) as Array<Dialog & { keys?: string[]; holdOnly?: boolean; blocksDelivery?: boolean }>;
    expect(held.map(d => [d.keys, d.holdOnly, d.blocksDelivery])).toEqual([[[], true, true]]);
  });
  it("the Bash permission prompt with the cursor on No (after Down past the last row) is still held, never answered", () => {
    const p = pane("bash-permission-down-past-end");
    expect(p).toMatch(/^ ❯ 4\. No$/m);
    expect(claudeBashPermissionActive(p)).toBe(true);
    expect(acting(backend.getRuntimeDialogs(), p).map(d => [d.description, d.keys])).toEqual([
      ["Claude Bash permission — waiting for a human choice, never auto-approving", []],
    ]);
  });
});
