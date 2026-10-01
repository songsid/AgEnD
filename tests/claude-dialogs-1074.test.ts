import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "../src/daemon.js";
import {
  ClaudeCodeBackend,
  CLAUDE_RESUME_PROMPT_DEFAULT,
  claudeBypassDialogState,
  claudeLoginScreenActive,
  claudeResumeMenuState,
  claudeSecurityNotesActive,
  claudeTerminalSetupActive,
  claudeThemePickerActive,
  claudeTrustDialogState,
  claudeUnrecognisedConfirmActive,
} from "../src/backend/claude-code.js";
import { LOGIN_FLOWS } from "../src/login-flows.js";

/**
 * #1074 P0 — Claude Code's first-run / trust / bypass / resume screens.
 *
 * The fixtures are REAL panes captured from the claude 2.1.286 binary in tmux
 * (tests/fixtures/claude-2.1.286-*.pane.txt). Three things were wrong on a first
 * launch: (1) onboarding (theme → login → security) carries the `❯` that the ready
 * pattern matches, so the pane was declared ready while still in the picker;
 * (2) trust and Bypass Permissions are answered only by the 30s startup scan, but
 * on a first run they come after onboarding, long after it ended; (3) the login
 * screen check ran after the ready check, so it never fired for Claude. Plus the
 * resume prompt gained a third option in 2.1.286, which made the old
 * bottom-anchored predicate reject the real screen.
 */

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fx = (name: string): string => readFileSync(join(fixtures, `claude-2.1.286-${name}.pane.txt`), "utf8");

const TRUST = fx("trust-dialog");
const BYPASS = fx("bypass-dialog");
const THEME = fx("onboarding-theme");
const LOGIN_MENU = fx("onboarding-login-method");
const OAUTH_URL = fx("onboarding-oauth-url");
const READY = fx("ready");
const RESUME3 = fx("resume-three-options");
const MCP = fx("mcp-approval");
const SETTINGS_ERROR = fx("settings-error");
const API_KEY = fx("api-key-dialog");
const CLAUDE_MD_EXTERNAL = fx("claude-md-external");

/** A live screen replaced by a quote of it: the real input row follows. */
const quoted = (pane: string): string => `${pane.trimEnd()}\n\n─────\n❯ \n─────\n`;
/** Move the selector between the two option rows of a two-option dialog. */
const cursorOnSecond = (pane: string, first: string, second: string): string =>
  pane.replace(`❯ ${first}`, `  ${first}`).replace(new RegExp(`^(\\s*)${second}`, "m"), `$1❯ ${second}`);

const backend = new ClaudeCodeBackend("/tmp/agend-claude-1074");
const startupDialogs = backend.getStartupDialogs();
const runtimeDialogs = backend.getRuntimeDialogs();

/** What the daemon's runtime scan would do with this pane: first dialog whose structure holds. */
const runtimeHit = (pane: string) => runtimeDialogs.find(d => (d.isActive ? d.isActive(pane) : d.pattern.test(pane)));
const startupHit = (pane: string) => startupDialogs.find(d => (d.isActive ? d.isActive(pane) : d.pattern.test(pane)));

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeDaemon(initialPane: string, backendOverride?: unknown, configBackend = "claude-code") {
  const dir = mkdtempSync(join(tmpdir(), "agend-1074-")); dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@9");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("claude-1074", {
    working_directory: "/tmp",
    backend: configBackend,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, (backendOverride ?? new ClaudeCodeBackend(dir)) as any, undefined, { child: () => logger } as any) as any;
  const state = { pane: initialPane, onKey: null as null | ((key: string) => void) };
  const keys: string[] = [];
  daemon.tmux = {
    capturePane: vi.fn(async () => state.pane),
    isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async (key: string) => { keys.push(key); state.onKey?.(key); return true; }),
    sendKeys: vi.fn(async (key: string) => { keys.push(`text:${key}`); return true; }),
    pasteText: vi.fn(async () => true),
    pasteBuffer: vi.fn(async () => true),
    getWindowId: () => "@9",
    getLastPasteError: () => null,
    isLastPasteFailureRecoverable: () => true,
    getLastSendSpecialKeyError: () => null,
  };
  daemon.controlClient = { isIdle: () => true, waitUntilIdle: async () => true, waitForIdle: async () => true };
  daemon.submitSystemPaste = vi.fn(async () => true);
  const errors: any[] = [];
  daemon.on("pty_error", (e: unknown) => errors.push(e));
  return { daemon, state, keys, logger, errors, dir };
}

describe("fixtures are the screens we think they are", () => {
  it("each captured screen satisfies the ready pattern — the reason none of them can be left to the ready check", () => {
    for (const [name, pane] of Object.entries({ TRUST, BYPASS, THEME, LOGIN_MENU, OAUTH_URL: `${OAUTH_URL}`, MCP, SETTINGS_ERROR, API_KEY, CLAUDE_MD_EXTERNAL })) {
      // the OAuth URL screen alone has no `❯`: it is caught by its own predicate
      if (name === "OAUTH_URL") continue;
      expect(backend.getReadyPattern().test(pane), name).toBe(true);
    }
  });
});

describe("(a) trust + Bypass Permissions are answerable at runtime", () => {
  it("recognises the live 2.1.286 trust dialog: cursor on 'No, exit' → Down ONLY (Enter waits for a verified cursor)", () => {
    expect(claudeTrustDialogState(TRUST)).toEqual({ active: true, cursor: "decline", declineLabel: "No, exit" });
    const hit = runtimeHit(TRUST)!;
    expect(hit.keys).toEqual(["Down"]);
    expect(hit.blocksDelivery).toBe(true);
    expect(hit.description).toMatch(/workspace trust dialog/);
    expect(hit.description).not.toMatch(/Bypass/i);
  });

  it("recognises the live Bypass Permissions warning under ITS OWN description (was mislabelled 'workspace trust')", () => {
    expect(claudeBypassDialogState(BYPASS)).toEqual({ active: true, cursor: "decline", declineLabel: "No, exit" });
    const rt = runtimeHit(BYPASS)!;
    expect(rt.keys).toEqual(["Down"]);
    expect(rt.description).toMatch(/Bypass Permissions/);
    const st = startupHit(BYPASS)!;
    expect(st.keys).toEqual(["Down"]);
    expect(st.description).toMatch(/Bypass Permissions/);
    expect(st.description).not.toMatch(/trust/i);
  });

  it("the two dialogs never answer each other's screen", () => {
    expect(claudeTrustDialogState(BYPASS).active).toBe(false);
    expect(claudeBypassDialogState(TRUST).active).toBe(false);
  });

  it("cursor already on the accepting row → Enter only (a Down would wrap back to 'No, exit')", () => {
    const trustYes = cursorOnSecond(TRUST, "No, exit", "Yes, I trust this folder");
    expect(claudeTrustDialogState(trustYes).cursor).toBe("accept");
    expect(runtimeHit(trustYes)!.keys).toEqual(["Enter"]);
    const bypassYes = cursorOnSecond(BYPASS, "No, exit", "Yes, I accept");
    expect(claudeBypassDialogState(bypassYes).cursor).toBe("accept");
    expect(runtimeHit(bypassYes)!.keys).toEqual(["Enter"]);
    expect(startupHit(bypassYes)!.keys).toEqual(["Enter"]);
  });

  it("an arrangement it cannot navigate is held for a human, never answered", () => {
    const noCursor = TRUST.replace("❯ No, exit", "  No, exit");
    expect(claudeTrustDialogState(noCursor).cursor).toBe("unknown");
    const hit = runtimeHit(noCursor)!;
    expect(hit.holdOnly).toBe(true);
    expect(hit.keys).toEqual([]);
    const bypassNoCursor = BYPASS.replace("❯ No, exit", "  No, exit");
    expect(runtimeHit(bypassNoCursor)!.holdOnly).toBe(true);
    expect(startupHit(bypassNoCursor)!.holdOnly).toBe(true);
  });

  it("the trust backstop variant ('No, continue without these permissions') is answered with Enter, never Down", () => {
    const backstop = TRUST.replace("No, exit", "No, continue without these permissions");
    expect(claudeTrustDialogState(backstop)).toEqual({ active: true, cursor: "decline", declineLabel: "No, continue without these permissions" });
    expect(runtimeHit(backstop)!.keys).toEqual(["Enter"]);
  });

  it("a verbatim quote of either dialog (real input row below) is not active and gets no keys", () => {
    for (const quote of [quoted(TRUST), quoted(BYPASS)]) {
      expect(claudeTrustDialogState(quote).active).toBe(false);
      expect(claudeBypassDialogState(quote).active).toBe(false);
      expect(runtimeHit(quote), quote.slice(0, 40)).toBeUndefined();
    }
    // prose carrying the exact labels in the transcript
    const prose = "The dialog says ❯ No, exit and Yes, I trust this folder.\nWARNING: Claude Code running in Bypass Permissions mode\n❯ ";
    expect(runtimeHit(prose)).toBeUndefined();
  });

  it("a title with no options, or options with no title, is not the dialog", () => {
    const noTitle = ["some text", "", " ❯ No, exit", "   Yes, I trust this folder", " Enter to confirm · Esc to cancel"].join("\n");
    expect(claudeTrustDialogState(noTitle).active).toBe(false);
    const noFooter = TRUST.replace(/Enter to confirm · Esc to cancel/, "");
    expect(claudeTrustDialogState(noFooter).active).toBe(false);
  });

  it("the options must be followed by the confirm footer as the LAST row — an extra trailing row defeats it", () => {
    const trailingRow = `${TRUST.trimEnd().replace(/\n[^\n]*Enter to confirm · Esc to cancel[^\n]*$/, "")}\n   (some later hint row)\n`;
    expect(trailingRow).toContain("Yes, I trust this folder");
    expect(claudeTrustDialogState(trailingRow).active).toBe(false);
    const bypassTrailing = `${BYPASS.trimEnd().replace(/\n[^\n]*Enter to confirm · Esc to cancel[^\n]*$/, "")}\n   (some later hint row)\n`;
    expect(claudeBypassDialogState(bypassTrailing).active).toBe(false);
  });

  it("a composer row between the title and the options means the title is not this dialog's", () => {
    const pane = [" Accessing workspace:", " ❯", " ❯ No, exit", "   Yes, I trust this folder", " Enter to confirm · Esc to cancel"].join("\n");
    expect(claudeTrustDialogState(pane).active).toBe(false);
    const ok = [" Accessing workspace:", " /tmp/x", " ❯ No, exit", "   Yes, I trust this folder", " Enter to confirm · Esc to cancel"].join("\n");
    expect(claudeTrustDialogState(ok).active).toBe(true);
  });

  it("the delivery gate treats both as blocking (no paste into the dialog)", () => {
    const blocking = runtimeDialogs.filter(d => d.blocksDelivery || d.holdOnly);
    for (const pane of [TRUST, BYPASS]) expect(blocking.some(d => (d.isActive ? d.isActive(pane) : d.pattern.test(pane)))).toBe(true);
    expect(blocking.some(d => d.isActive?.(READY))).toBe(false);
  });

  it("NO table ever answers a trust/Bypass screen with a blind Down+Enter pair", () => {
    // Live, claude 2.1.286: the confirm dialog refuses input for a short window
    // after it mounts. A Down sent the instant the dialog is seen is swallowed
    // while the Enter 200 ms later is accepted — selecting "No, exit" and quitting
    // the CLI (3 of 4 trials). Enter may only follow a poll that SAW the cursor
    // on the accepting row.
    for (const pane of [TRUST, BYPASS, TRUST.replace("No, exit", "No, continue without these permissions")]) {
      for (const [name, hit] of [["startup", startupHit(pane)], ["runtime", runtimeHit(pane)]] as const) {
        expect(hit, name).toBeDefined();
        expect(hit!.keys.includes("Down") && hit!.keys.includes("Enter"), `${name}: ${hit!.description}`).toBe(false);
      }
    }
  });

  /** A confirm dialog that swallows the first `refused` Downs, then behaves; Enter only counts on the accepting row. */
  function refusingDialog(first: string, accepting: string, refused: number) {
    let downs = 0; const enters: string[] = [];
    return {
      enters,
      onKey(state: { pane: string }, k: string) {
        if (k === "Down") { downs++; if (downs > refused) state.pane = accepting; }
        else if (k === "Enter") { enters.push(state.pane === accepting ? "accept" : "decline"); state.pane = state.pane === accepting ? READY : "CLI EXITED"; }
      },
      first,
    };
  }

  it("runtime scan: a trust dialog that appears AFTER the startup scan ended is answered Down, then Enter on the verified cursor", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys } = makeDaemon(TRUST);
    const d = refusingDialog(TRUST, cursorOnSecond(TRUST, "No, exit", "Yes, I trust this folder"), 0);
    state.onKey = k => d.onKey(state, k);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_500);
    expect(keys).toEqual(["Down", "Enter"]);
    expect(d.enters).toEqual(["accept"]);
    expect(state.pane).toBe(READY);
    daemon.freezeRuntimeMonitors();
  });

  it("runtime scan: a Down the dialog swallowed is repeated; Enter is never sent while the cursor is on 'No, exit'", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys } = makeDaemon(TRUST);
    const d = refusingDialog(TRUST, cursorOnSecond(TRUST, "No, exit", "Yes, I trust this folder"), 2);
    state.onKey = k => d.onKey(state, k);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(26_000);
    expect(keys).toEqual(["Down", "Down", "Down", "Enter"]);
    expect(d.enters).toEqual(["accept"]);
    expect(state.pane).toBe(READY);
    daemon.freezeRuntimeMonitors();
  });

  it("runtime scan: the Bypass warning is answered the same way", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys } = makeDaemon(BYPASS);
    const d = refusingDialog(BYPASS, cursorOnSecond(BYPASS, "No, exit", "Yes, I accept"), 1);
    state.onKey = k => d.onKey(state, k);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(keys).toEqual(["Down", "Down", "Enter"]);
    expect(d.enters).toEqual(["accept"]);
    daemon.freezeRuntimeMonitors();
  });

  it("startup scan: the real scan loop answers trust and Bypass stepwise even when the first Down is swallowed", async () => {
    for (const [pane, accept] of [[TRUST, "Yes, I trust this folder"], [BYPASS, "Yes, I accept"]] as const) {
      const { daemon, state, keys } = makeDaemon(pane);
      const d = refusingDialog(pane, cursorOnSecond(pane, "No, exit", accept), 1);
      state.onKey = k => d.onKey(state, k);
      expect(await daemon.dismissDialogsUntilReady(8_000, 0)).toBe(true);
      expect(keys, pane.slice(0, 30)).toEqual(["Down", "Down", "Enter"]);
      expect(d.enters).toEqual(["accept"]);
      expect(state.pane).toBe(READY);
    }
  });

  it("while a trust/Bypass dialog is up the daemon reports stdin as blocked, and clears it afterwards", async () => {
    vi.useFakeTimers();
    for (const pane of [TRUST, BYPASS]) {
      const { daemon, state } = makeDaemon(pane);
      const events: Array<{ blocked: boolean; description?: string }> = [];
      daemon.on("input_blocked", (e: any) => events.push(e));
      const accepting = cursorOnSecond(pane, "No, exit", pane === TRUST ? "Yes, I trust this folder" : "Yes, I accept");
      state.onKey = k => { if (k === "Down") state.pane = accepting; else if (k === "Enter") state.pane = READY; };
      daemon.startErrorMonitor();
      await vi.advanceTimersByTimeAsync(16_000);   // Down @5s, Enter @10s, cleared by the @15s poll
      expect(events[0]).toMatchObject({ blocked: true });
      expect(events[0].description).toMatch(pane === TRUST ? /trust/ : /Bypass/);
      expect(events[events.length - 1]).toMatchObject({ blocked: false });
      daemon.freezeRuntimeMonitors();
    }
  });

  it("runtime scan: a held (unknown-cursor) trust dialog gets no key at all", async () => {
    vi.useFakeTimers();
    const { daemon, keys } = makeDaemon(TRUST.replace("❯ No, exit", "  No, exit"));
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(keys).toEqual([]);
    daemon.freezeRuntimeMonitors();
  });

  it("runtime scan: a transcript quoting the dialog gets no key", async () => {
    vi.useFakeTimers();
    const { daemon, keys } = makeDaemon(quoted(TRUST));
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(keys).toEqual([]);
    daemon.freezeRuntimeMonitors();
  });
});

describe("review #1077 P1-1: every startup key path shares the structural + cursor evidence", () => {
  const noFooterNoCursor = (pane: string, first: string) =>
    pane.replace("Enter to confirm · Esc to cancel", "Press any key to continue").replace(`❯ ${first}`, `  ${first}`);

  it("a verbatim quote of the dialog followed by the real composer gets NO key from the startup scan", async () => {
    for (const pane of [quoted(TRUST), quoted(BYPASS)]) {
      expect(startupHit(pane)).toBeUndefined();
      const { daemon, keys } = makeDaemon(pane);
      expect(await daemon.dismissDialogsUntilReady(1_500, 0)).toBe(true);
      expect(keys).toEqual([]);                      // was ["Down"] via the loose /No, exit/ entry
    }
  });

  it("an unrecognised shape (reworded footer, no cursor) is held — no key, and not declared deliverable", async () => {
    for (const [pane, first] of [[TRUST, "No, exit"], [BYPASS, "No, exit"]] as const) {
      const odd = noFooterNoCursor(pane, first);
      expect(claudeTrustDialogState(odd).active).toBe(false);
      expect(claudeBypassDialogState(odd).active).toBe(false);
      expect(claudeUnrecognisedConfirmActive(odd)).toBe(true);
      for (const hit of [startupHit(odd)!, runtimeHit(odd)!]) {
        expect(hit.holdOnly).toBe(true);
        expect(hit.keys).toEqual([]);                // was ["Enter"] via the loose /I trust|I accept/ entry
        expect(hit.blocksDelivery).toBe(true);
      }
      const { daemon, keys, logger } = makeDaemon(odd);
      expect(await daemon.dismissDialogsUntilReady(1_500, 0)).toBe(true);
      expect(keys).toEqual([]);
      expect(JSON.stringify(logger.warn.mock.calls)).toMatch(/not auto-answering|dialog still on screen/);
    }
  });

  it("the same held shape sends no key from the runtime monitor either", async () => {
    vi.useFakeTimers();
    const { daemon, keys } = makeDaemon(noFooterNoCursor(TRUST, "No, exit"));
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(keys).toEqual([]);
    daemon.freezeRuntimeMonitors();
  });

  it("the hold shape does not fire for a ready pane, a quote, or prose", () => {
    for (const pane of [READY, THEME, LOGIN_MENU, quoted(TRUST), quoted(noFooterNoCursor(BYPASS, "No, exit")), "I trust this is fine. Yes, I accept the plan.\n❯ "]) {
      expect(claudeUnrecognisedConfirmActive(pane), pane.slice(0, 40)).toBe(false);
    }
  });

  it("no startup entry matches trust/Bypass text without going through a structural check", () => {
    for (const d of startupDialogs) {
      if (d.pattern.test("Yes, I trust this folder") || d.pattern.test("❯ No, exit") || d.pattern.test("Yes, I accept")) {
        expect(d.isActive, d.description).toBeTypeOf("function");
      }
    }
  });
});

describe("review #1077 P1-3: a sign-in screen after the startup scan is an auth incident", () => {
  it("runtime table holds delivery on the live login screens and ignores quotes", () => {
    for (const pane of [LOGIN_MENU, OAUTH_URL]) {
      const hit = runtimeHit(pane)!;
      expect(hit.holdOnly).toBe(true);
      expect(hit.blocksDelivery).toBe(true);
      expect(hit.keys).toEqual([]);
    }
    expect(runtimeHit(quoted(LOGIN_MENU))).toBeUndefined();
    expect(runtimeHit(quoted(OAUTH_URL))).toBeUndefined();
  });

  it("theme → Enter → login menu AFTER the startup scan ended: one Enter, one auth_error/pause, authFailureUnresolved set, no repeat", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys, errors } = makeDaemon(THEME);
    state.onKey = k => { if (k === "Enter") state.pane = LOGIN_MENU; };
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(keys).toEqual(["Enter"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "auth_error", action: "pause" });
    expect(daemon.authFailureUnresolved).toBe(true);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(errors).toHaveLength(1);                  // once per spawn
    expect(keys).toEqual(["Enter"]);                 // the login menu is never answered
    daemon.freezeRuntimeMonitors();
  });

  it("the OAuth paste-code screen reaching the runtime monitor is the same incident", async () => {
    vi.useFakeTimers();
    const { daemon, errors } = makeDaemon(OAUTH_URL);
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "auth_error", action: "pause" });
    daemon.freezeRuntimeMonitors();
  });

  it("a long-lived transcript that quotes the login menu is not an incident", async () => {
    vi.useFakeTimers();
    const { daemon, errors } = makeDaemon(quoted(LOGIN_MENU));
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(errors).toHaveLength(0);
    expect(daemon.authFailureUnresolved).toBe(false);
    daemon.freezeRuntimeMonitors();
  });

  it("other backends keep their order: runtime never evaluates a loose startup-only login pattern", async () => {
    vi.useFakeTimers();
    const { daemon, errors } = makeDaemon("Welcome to Codex\n  Sign in with ChatGPT to continue.\n› ", undefined, "codex");
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(errors).toHaveLength(0);
    daemon.freezeRuntimeMonitors();
  });
});

describe("(b) onboarding screens never pass for ready", () => {
  it("theme picker: recognised structurally, answered with Enter, in the startup AND runtime tables", () => {
    expect(claudeThemePickerActive(THEME)).toBe(true);
    expect(startupHit(THEME)!.keys).toEqual(["Enter"]);
    expect(runtimeHit(THEME)!.keys).toEqual(["Enter"]);
    expect(startupHit(THEME)!.description).toMatch(/theme/);
  });

  it("theme picker: a quote of it followed by the real input row is not active; nor is the login menu", () => {
    expect(claudeThemePickerActive(quoted(THEME))).toBe(false);
    expect(claudeThemePickerActive(LOGIN_MENU)).toBe(false);
    expect(claudeThemePickerActive(READY)).toBe(false);
    expect(startupHit(quoted(THEME))).toBeUndefined();
  });

  it("security notes: the 'Press Enter to continue…' prompt (source-derived wording) is answered with Enter", () => {
    const pane = [
      "Welcome to Claude Code v2.1.286",
      "",
      " Security notes:",
      "",
      "  1. Claude can make mistakes.",
      "     You're responsible for Claude's actions and should always",
      "     review them, especially when running code.",
      "  2. Due to prompt injection risks, only use it with code you trust",
      "     For more details see: https://code.claude.com/docs/en/security",
      "",
      " Press Enter to continue…",
    ].join("\n");
    expect(claudeSecurityNotesActive(pane)).toBe(true);
    expect(startupHit(pane)!.keys).toEqual(["Enter"]);
    expect(runtimeHit(pane)!.keys).toEqual(["Enter"]);
    // quoted in a transcript, or prose that merely contains the sentence
    expect(claudeSecurityNotesActive(`${pane}\n\n❯ `)).toBe(false);
    expect(claudeSecurityNotesActive("Press Enter to continue… is what it prints")).toBe(false);
  });

  it("terminal-setup offer (source-derived wording): Escape skips it; a quote does not match", () => {
    const pane = [
      " Use Claude Code's terminal setup?",
      " For the optimal coding experience, enable the recommended settings",
      " for your terminal: Shift+Enter for newlines",
      " ❯ Yes, use recommended settings",
      "   No, maybe later with /terminal-setup",
      " Enter to confirm · Esc to skip",
    ].join("\n");
    expect(claudeTerminalSetupActive(pane)).toBe(true);
    expect(startupHit(pane)!.keys).toEqual(["Escape"]);
    expect(claudeTerminalSetupActive(`${pane}\n❯ `)).toBe(false);
  });

  it("startup scan: a first launch sitting in the theme picker is NOT declared ready; Enter moves it on", async () => {
    const { daemon, state, keys } = makeDaemon(THEME);
    state.onKey = k => { if (k === "Enter") state.pane = READY; };
    expect(await daemon.dismissDialogsUntilReady(5_000, 0)).toBe(true);
    expect(keys).toEqual(["Enter"]);   // before: no key, ready after two polls, picker still on screen
  });

  it("startup scan: theme → sign-in menu ends in ONE auth incident (pause), with no further keys", async () => {
    const { daemon, state, keys, errors } = makeDaemon(THEME);
    state.onKey = k => { if (k === "Enter") state.pane = LOGIN_MENU; };
    expect(await daemon.dismissDialogsUntilReady(5_000, 0)).toBe(true);
    expect(keys).toEqual(["Enter"]);                  // theme only; the login menu is never answered
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "auth_error", action: "pause" });
    expect(daemon.authFailureUnresolved).toBe(true);
  });
});

describe("(c) the sign-in screen is checked BEFORE the ready pattern", () => {
  it("the real login-menu and OAuth-URL screens are recognised; ready, trust and quotes are not", () => {
    expect(claudeLoginScreenActive(LOGIN_MENU)).toBe(true);
    expect(claudeLoginScreenActive(OAUTH_URL)).toBe(true);
    expect(claudeLoginScreenActive(READY)).toBe(false);
    expect(claudeLoginScreenActive(TRUST)).toBe(false);
    expect(claudeLoginScreenActive(THEME)).toBe(false);
    expect(claudeLoginScreenActive(quoted(LOGIN_MENU))).toBe(false);
    expect(claudeLoginScreenActive(quoted(OAUTH_URL))).toBe(false);
    expect(claudeLoginScreenActive("Select login method:")).toBe(false);          // bare phrase (e.g. in prose)
    expect(claudeLoginScreenActive("see the 'Paste code here if prompted >' hint\n❯ ")).toBe(false);
  });

  it("claude's login flow opts into the structural, before-ready check; other backends keep the old order", () => {
    const flow = LOGIN_FLOWS["claude-code"];
    expect(flow.loginScreenBeforeReady).toBe(true);
    expect(flow.loginScreenActive).toBe(claudeLoginScreenActive);
    expect(flow.loginScreenPattern!.test("Select login method:")).toBe(true);
    for (const [name, other] of Object.entries(LOGIN_FLOWS)) {
      if (name === "claude-code") continue;
      expect(other.loginScreenBeforeReady, name).toBeUndefined();
    }
  });

  it("startup scan: the login menu (which carries ❯) reports one auth_error and does not decay into 'ready'", async () => {
    const { daemon, keys, errors } = makeDaemon(LOGIN_MENU);
    expect(await daemon.dismissDialogsUntilReady(3_000, 0)).toBe(true);
    expect(keys).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "auth_error", action: "pause" });
    expect(daemon.authFailureUnresolved).toBe(true);
    // the screen persists: a later pass must not spam a second report
    await daemon.dismissDialogsUntilReady(1_500, 0);
    expect(errors).toHaveLength(1);
  });

  it("startup scan: the OAuth URL / paste-code screen is the same incident", async () => {
    const { daemon, errors } = makeDaemon(OAUTH_URL);
    expect(await daemon.dismissDialogsUntilReady(3_000, 0)).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "auth_error" });
  });

  it("a resumed transcript that quotes the login menu is not an auth incident", async () => {
    const { daemon, errors } = makeDaemon(quoted(LOGIN_MENU));
    expect(await daemon.dismissDialogsUntilReady(3_000, 0)).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("a normal ready pane never reports", async () => {
    const { daemon, errors } = makeDaemon(READY);
    expect(await daemon.dismissDialogsUntilReady(3_000, 0)).toBe(true);
    expect(errors).toHaveLength(0);
  });
});

describe("(d) the 2.1.286 three-option resume prompt", () => {
  it("the real screen is the active menu with the cursor on the destructive default", () => {
    expect(claudeResumeMenuState(RESUME3)).toEqual({ active: true, defaultCursor: true });   // was {active:false}
    expect(CLAUDE_RESUME_PROMPT_DEFAULT.test(RESUME3)).toBe(true);
    expect(startupHit(RESUME3)!.keys).toEqual(["Down", "Enter"]);
    expect(runtimeHit(RESUME3)!.keys).toEqual(["Down", "Enter"]);
    expect(runtimeHit(RESUME3)!.blocksDelivery).toBe(true);
  });

  it("'(instant, recommended)' (a precomputed summary) is the same prompt", () => {
    const instant = RESUME3.replace("(recommended)", "(instant, recommended)");
    expect(CLAUDE_RESUME_PROMPT_DEFAULT.test(instant)).toBe(true);
    expect(claudeResumeMenuState(instant)).toEqual({ active: true, defaultCursor: true });
    expect(runtimeHit(instant)!.keys).toEqual(["Down", "Enter"]);
  });

  it("a cursor anywhere but option 1 is held, never answered — including on the persistent 'Don't ask me again'", () => {
    for (const moved of [
      RESUME3.replace("❯ 1. Resume from summary (recommended)", "  1. Resume from summary (recommended)").replace("  2. Resume full session as-is", "❯ 2. Resume full session as-is"),
      RESUME3.replace("❯ 1. Resume from summary (recommended)", "  1. Resume from summary (recommended)").replace("  3. Don't ask me again", "❯ 3. Don't ask me again"),
    ]) {
      expect(claudeResumeMenuState(moved)).toEqual({ active: true, defaultCursor: false });
      const hit = runtimeHit(moved)!;
      expect(hit.holdOnly).toBe(true);
      expect(hit.keys).toEqual([]);
    }
  });

  it("a quote of the three-option menu followed by the real input row is still not active", () => {
    expect(claudeResumeMenuState(quoted(RESUME3)).active).toBe(false);
    expect(runtimeHit(quoted(RESUME3))).toBeUndefined();
  });

  it("only ONE trailing option row is tolerated: transcript after the menu still defeats it", () => {
    const withTail = `${RESUME3.trimEnd()}\n  some later transcript line\n  another line\n`;
    expect(claudeResumeMenuState(withTail).active).toBe(false);
  });

  it("a single non-option transcript row under the menu is not swallowed as if it were the third option", () => {
    const stray = RESUME3.replace(/^.*Don't ask me again.*$/m, "  an unrelated transcript row");
    expect(claudeResumeMenuState(stray).active).toBe(false);
  });

  it("the original two-option (2.1.261) shape still works", () => {
    const two = RESUME3.replace(/^.*Don't ask me again.*\n/m, "");
    expect(claudeResumeMenuState(two)).toEqual({ active: true, defaultCursor: true });
  });
});

describe("(e) the Bypass Permissions warning is prevented, not just answered", () => {
  const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, "claude-settings.json"), "utf8"));
  const cfg = (extra: Record<string, unknown> = {}) => ({
    instanceName: "t", workingDirectory: "/tmp", mcpServers: {}, instructions: undefined, ...extra,
  }) as any;

  it("claude-settings.json records the acceptance when the instance runs with --dangerously-skip-permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1074-settings-")); dirs.push(dir);
    const b = new ClaudeCodeBackend(dir);
    b.writeConfig(cfg());
    expect(settingsOf(dir).skipDangerousModePermissionPrompt).toBe(true);
    expect(b.buildCommand(cfg())).toContain("--dangerously-skip-permissions");
    expect(b.buildCommand(cfg())).toContain("--settings");
  });

  it("is NOT written when the instance does not skip permissions (no consent is recorded for a launch that asks nothing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1074-settings-")); dirs.push(dir);
    const b = new ClaudeCodeBackend(dir);
    b.writeConfig(cfg({ skipPermissions: false }));
    expect(settingsOf(dir)).not.toHaveProperty("skipDangerousModePermissionPrompt");
    expect(b.buildCommand(cfg({ skipPermissions: false }))).not.toContain("--dangerously-skip-permissions");
  });
});

describe("(f) first launch after /login does not replay onboarding", () => {
  function withConfigDir(initial: Record<string, unknown> | null, run: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "agend-1074-cfg-")); dirs.push(dir);
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      if (initial) writeFileSync(join(dir, ".claude.json"), JSON.stringify(initial));
      run(join(dir, ".claude.json"));
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  }
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

  it("an authenticated account (oauthAccount.accountUuid) gets hasCompletedOnboarding alongside the trust entry", () => {
    withConfigDir({ oauthAccount: { accountUuid: "11111111-2222-3333-4444-555555555555", emailAddress: "a@b.c" } }, path => {
      new ClaudeCodeBackend("/tmp/x").preTrust("/tmp/agend-1074-ws");
      const c = read(path);
      expect(c.hasCompletedOnboarding).toBe(true);
      expect(c.projects["/tmp/agend-1074-ws"].hasTrustDialogAccepted).toBe(true);
      expect(c.oauthAccount.emailAddress).toBe("a@b.c");   // nothing else disturbed
    });
  });

  it("a fresh machine (no account) keeps its onboarding — the sign-in screen is reported instead", () => {
    withConfigDir(null, path => {
      new ClaudeCodeBackend("/tmp/x").preTrust("/tmp/agend-1074-ws");
      expect(read(path)).not.toHaveProperty("hasCompletedOnboarding");
    });
    withConfigDir({ oauthAccount: {} }, path => {
      new ClaudeCodeBackend("/tmp/x").preTrust("/tmp/agend-1074-ws");
      expect(read(path)).not.toHaveProperty("hasCompletedOnboarding");
    });
  });

  it("an explicit false/absent flag is set, an existing true is left alone, and re-running writes nothing", () => {
    withConfigDir({ hasCompletedOnboarding: false, oauthAccount: { accountUuid: "u" } }, path => {
      const b = new ClaudeCodeBackend("/tmp/x");
      b.preTrust("/tmp/agend-1074-ws");
      expect(read(path).hasCompletedOnboarding).toBe(true);
      const before = readFileSync(path, "utf8");
      b.preTrust("/tmp/agend-1074-ws");
      expect(readFileSync(path, "utf8")).toBe(before);
    });
    expect(existsSync("/nonexistent")).toBe(false);
  });
});

describe("unhandled-but-dangerous screens stay unanswered (P1, documented gap)", () => {
  it("the settings-error menu's default is 'Fix with Claude'; the API-key dialog's is 'No (recommended)' — no table answers either with Enter", () => {
    for (const pane of [SETTINGS_ERROR, API_KEY]) {
      for (const table of [startupDialogs, runtimeDialogs]) {
        const hit = table.find(d => (d.isActive ? d.isActive(pane) : d.pattern.test(pane)));
        expect(hit?.keys ?? []).not.toContain("Enter");
      }
    }
    expect(SETTINGS_ERROR).toContain("❯ 1. Fix with Claude");
    expect(API_KEY).toContain("❯ No (recommended)");
  });

  it("the CLAUDE.md external-import default is the safe 'No, disable external imports' (nothing presses it today)", () => {
    expect(CLAUDE_MD_EXTERNAL).toContain("❯ No, disable external imports");
  });

  it("the MCP-approval default is the safe 'Continue without using this MCP server' (nothing presses it today)", () => {
    expect(MCP).toContain("❯ Continue without using this MCP server");
  });
});
