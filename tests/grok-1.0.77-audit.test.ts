/**
 * Upstream watch 2026-11-06: grok 1.0.77 against the 1.0.70 baseline
 * (tests/fixtures/grok-1.0.77-audit/README.md). Host-isolated live capture (private tmux,
 * scratch HOME, local mock). Ready/busy/429/login/input-box match 1.0.70. After Esc, 1.0.77
 * unbinds Shift+x on the weekly-limit modal; Space restores the picker.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { GrokBackend, readGrokInputBox } from "../src/backend/grok.js";
import { helpOption } from "../src/backend/launch-effort.js";
import { LOGIN_FLOWS } from "../src/login-flows.js";

const DIR = join(import.meta.dirname, "fixtures", "grok-1.0.77-audit");
const pane = (dir: string, step: string) => readFileSync(join(DIR, dir, `${step}.pane.txt`), "utf-8");
const fx = (name: string) => readFileSync(join(DIR, name), "utf-8");
const backend = () => new GrokBackend("/tmp/grok-1077-audit");
const active = (dialogs: RuntimeDialog[], screen: string) =>
  dialogs.filter(d => (d.isActive ? d.isActive(screen) : (d.pattern.lastIndex = 0, d.pattern.test(screen))));

function verdict(screen: string) {
  const b = backend();
  const keys = (dialogs: RuntimeDialog[]) => active(dialogs, screen).map(d => `${d.description.split(" — ")[0]}[${d.keys.join("+")}]`);
  return {
    ready: b.getReadyPattern().test(screen),
    busy: b.getBusyPattern().test(screen),
    errors: b.getErrorPatterns().filter(e => e.pattern.test(screen)).map(e => e.type),
    startup: keys(b.getStartupDialogs()),
    runtime: keys(b.getRuntimeDialogs()),
  };
}

const idle = { ready: true, busy: false, errors: [], startup: [], runtime: [] };
const LOGO = "Grok intro logo[Enter]";
const TRUST = "Grok workspace trust[y]";
const WEEKLY = "Grok Build weekly limit (Grok 週限)[]";
const WEEKLY_RT = "Grok Build weekly limit (Grok 週限)[X]";
const WEEKLY_SB = "Grok Build weekly limit scrollback (Grok 週限)[ ]";
const EMPTY = { text: "", collapsedPastes: 0 };

const STEPS_120: Record<string, ReturnType<typeof verdict>> = {
  "01-trust": { ...idle, startup: [LOGO, TRUST], runtime: [LOGO] },
  "02-ready": idle,
  "03-busy-a": { ...idle, busy: true },
  "04-done": idle,
  "05-busy-before-cancel": { ...idle, busy: true },
  "06-after-cancel": idle,
  "07-err-401": idle,
  "07-err-402": { ...idle, startup: [WEEKLY], runtime: [WEEKLY_RT] },
  "07-err-402-esc": { ...idle, startup: [WEEKLY], runtime: [WEEKLY_SB] },
  "07-err-403": idle,
  "07-err-403-usage": idle,
  "07-err-426": { ...idle, errors: ["outdated_cli"] },
  "07-err-429": { ...idle, errors: ["rate_limit"] },
  "07-err-429-text": { ...idle, errors: ["rate_limit"] },
  "07-err-500": idle,
  "09-tool": idle,
  "10-compact": { ...idle, busy: true },
  "11-new": idle,
};

const STEPS_80: Record<string, ReturnType<typeof verdict>> = {
  "01-trust": STEPS_120["01-trust"]!,
  "02-ready": idle,
  "03-busy-a": { ...idle, busy: true },
  "04-done": idle,
  "07-err-429": { ...idle, errors: ["rate_limit"] },
  "07-err-402": { ...idle, startup: [WEEKLY], runtime: [WEEKLY_RT] },
};

describe("grok 1.0.77: every detector, every captured step", () => {
  it.each(Object.keys(STEPS_120).map(step => ["120", step] as const))(
    "at %s columns, %s",
    (_width, step) => {
      expect(verdict(pane("1.0.77-120", step))).toEqual(STEPS_120[step]);
    },
  );

  it.each(Object.keys(STEPS_80).map(step => ["80", step] as const))(
    "at %s columns, %s",
    (_width, step) => {
      expect(verdict(pane("1.0.77-80", step))).toEqual(STEPS_80[step]);
    },
  );

  it("the approval card raises nothing (AgEnD launches with --always-approve)", () => {
    expect(verdict(pane("1.0.77-approval", "20-approval"))).toEqual(idle);
    expect(pane("1.0.77-approval", "20-approval")).toContain("Yes, and don't ask again for anything (always-approve mode)");
    expect(pane("1.0.77-approval", "20-approval")).toContain("Yes, proceed");
    expect(pane("1.0.77-approval", "20-approval")).toContain("No, reject (type to add feedback)");
  });
});

describe("grok 1.0.77: boxed prompt (#3221)", () => {
  it("ready and busy keep an empty boxed ❯", () => {
    expect(readGrokInputBox(pane("1.0.77-120", "02-ready"))).toEqual(EMPTY);
    expect(readGrokInputBox(pane("1.0.77-120", "03-busy-a"))).toEqual(EMPTY);
    expect(readGrokInputBox(pane("1.0.77-80", "02-ready"))).toEqual(EMPTY);
    expect(readGrokInputBox(pane("1.0.77-80", "03-busy-a"))).toEqual(EMPTY);
  });

  it("06-after-cancel is a live draft still sitting in the boxed prompt", () => {
    expect(readGrokInputBox(pane("1.0.77-120", "06-after-cancel"))).toEqual({ text: "stall forever b", collapsedPastes: 0 });
  });

  it("trust, weekly-limit and approval have no box", () => {
    expect(readGrokInputBox(pane("1.0.77-120", "01-trust"))).toBeNull();
    expect(readGrokInputBox(pane("1.0.77-120", "07-err-402"))).toBeNull();
    expect(readGrokInputBox(pane("1.0.77-approval", "20-approval"))).toBeNull();
  });
});

describe("grok 1.0.77: weekly-limit keys", () => {
  const weekly = (step: string) => fx(`1.0.77-weekly-limit/${step}.pane.txt`);

  it("Shift+x from the picker dismisses with no extra request", () => {
    expect(verdict(weekly("modal"))).toEqual({ ...idle, startup: [WEEKLY], runtime: [WEEKLY_RT] });
    expect(verdict(weekly("after-shift-x"))).toEqual(idle);
    expect(readGrokInputBox(weekly("after-shift-x"))).toEqual(EMPTY);
    const req = fx("1.0.77-weekly-limit/requests.txt");
    expect(req).toMatch(/requests after modal: 5/);
    expect(req).toMatch(/requests after Shift\+x: 5/);
  });

  it("Esc then X leaves the modal up; Esc then Space restores the picker; X then dismisses", () => {
    expect(verdict(weekly("modal-scrollback-focus"))).toEqual({ ...idle, startup: [WEEKLY], runtime: [WEEKLY_SB] });
    expect(verdict(weekly("after-esc-then-shift-x"))).toEqual({ ...idle, startup: [WEEKLY], runtime: [WEEKLY_SB] });
    expect(verdict(weekly("after-esc-then-space"))).toEqual({ ...idle, startup: [WEEKLY], runtime: [WEEKLY_RT] });
    expect(verdict(weekly("after-esc-space-then-x"))).toEqual(idle);
  });
});

describe("grok 1.0.77: login", () => {
  it("TUI without a key is the device-flow hold (Waiting for approval)", () => {
    const screen = pane("1.0.77-login", "01-tui-nokey");
    expect(screen).toMatch(/Waiting for approval/);
    expect(verdict(screen).startup.some(k => /device-flow login/.test(k))).toBe(true);
    expect(LOGIN_FLOWS.grok.loginScreenPattern!.test(screen)).toBe(false);
  });

  it("`grok login` and `--device-auth` still paint a device URL and code", () => {
    for (const step of ["03-grok-login", "04-grok-login-device"] as const) {
      const screen = pane("1.0.77-login", step);
      expect(screen).toMatch(/https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=/);
      expect(screen).toMatch(/Waiting for authorization/);
      expect(LOGIN_FLOWS.grok.codePattern!.test(screen)).toBe(true);
    }
  });

  it("loginScreenPattern still matches the binary's 'Run `grok login`' copy", () => {
    expect(LOGIN_FLOWS.grok.loginScreenPattern!.test("Not logged in. Run `grok login`.")).toBe(true);
  });
});

describe("grok 1.0.77: what the precheck flagged", () => {
  it("launch-path trust is still Yes, proceed y / No, quit n", () => {
    for (const dir of ["1.0.77-120", "1.0.77-80"] as const) {
      const screen = pane(dir, "01-trust");
      expect(screen).toMatch(/Do you trust the contents of this directory\?/);
      expect(screen).toMatch(/Yes, proceed\s+y\n/);
      expect(screen).toMatch(/No, quit\s+n\n/);
      expect(verdict(screen).startup).toContain(TRUST);
    }
  });

  it("a 429 still paints rate_limit_error", () => {
    expect(pane("1.0.77-120", "07-err-429")).toContain("Retry failed: rate_limit_error: Rate limit exceeded");
    expect(pane("1.0.77-80", "07-err-429")).toContain("Retry failed: rate_limit_error: Rate limit exceeded");
    expect(verdict(pane("1.0.77-120", "07-err-429")).errors).toEqual(["rate_limit"]);
  });

  it("'usage limit (needs Grok' is grok usage help, not a TUI", () => {
    const help = fx("help-1.0.77.txt");
    expect(help).toContain("Session ID. Omit for your plan's usage limit (needs Grok's background service)");
    expect(help).toContain("Print the plan's usage limit as JSON");
    expect(fx("help-1.0.70.txt")).not.toContain("needs Grok's background service");
  });

  it("--help still lists the flags AgEnD passes", () => {
    const help = fx("help-1.0.77.txt");
    for (const flag of ["--always-approve", "--resume", "--model"]) expect(helpOption(help, flag).listed, flag).toBe(true);
    expect(helpOption(help, "--reasoning-effort")).toEqual({ listed: true, levels: null });
  });

  it("quit is still a double Ctrl+Q", () => {
    expect(pane("1.0.77-120", "50-quit-single")).toContain("Ctrl+q:press again to quit");
    expect(pane("1.0.77-120", "51-quit-double")).toMatch(/Resume this session with:\n\s+grok --resume [0-9a-f-]{36}\n/);
    expect(backend().getQuitKeyPresses()).toBe(2);
  });
});
