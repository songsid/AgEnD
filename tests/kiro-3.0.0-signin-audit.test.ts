/**
 * kiro-cli 3.0.0 against the audited 2.36.0 (tests/fixtures/kiro-3.0.0-signin-audit/README.md): the sign-in, auth-error and
 * V3-onboarding surfaces the upstream precheck flagged, captured offline from the real 3.0.0 binary (the same build as
 * tests/fixtures/kiro-3.0.0-audit). Every one is still recognised by what is on main — no detector change:
 * - `kiro-cli login` opens the same "Select login method" menu with the same four labels the structured sign-in reads;
 * - an expired token lands on "You are not logged in. Login now?" on both launch paths (TUI V2 and V3), which the
 *   auth-error trigger, the startup login-screen pattern and the login-required screen all match, and nothing answers;
 * - the three-choice V3 menu ("Kiro CLI 3.0 is here.") is held, never keyed; the V2 TUI's "Kiro CLI V3 is here." banner is
 *   not that menu, and its trust-all-tools confirmation is answered as before;
 * - 3.0's own success lines ("Logged in with …", "Authenticated with API key") match the login success pattern.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { KiroBackend, kiro3ChoiceActive, probeKiroCliCompatibility } from "../src/backend/kiro.js";
import { KIRO_LOGIN_REQUIRED_SCREEN, LOGIN_FLOWS } from "../src/login-flows.js";
import { structuredSignInPrompt } from "../src/structured-signin.js";

const DIR = join(import.meta.dirname, "fixtures", "kiro-3.0.0-signin-audit");
const pane = (name: string) => readFileSync(join(DIR, `${name}.pane.txt`), "utf-8");
const HELP_300 = readFileSync(join(import.meta.dirname, "fixtures", "kiro-3.0.0-audit", "chat-help.txt"), "utf-8");
const compat = () => probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => (args[0] === "--version" ? "kiro-cli 3.0.0\n" : HELP_300));
const backend = () => {
  const b = new KiroBackend("/tmp/kiro-300", compat());
  (b as unknown as { activeTrustAll: boolean }).activeTrustAll = true;
  return b;
};
const active = (dialogs: RuntimeDialog[], screen: string) =>
  dialogs.filter(d => (d.isActive ? d.isActive(screen) : (d.pattern.lastIndex = 0, d.pattern.test(screen))));
const authError = () => {
  const p = backend().getErrorPatterns().find(e => e.type === "auth_error");
  if (!p) throw new Error("no kiro auth_error pattern");
  return p.pattern;
};
const WIDTHS = [120, 80] as const;
const flow = LOGIN_FLOWS["kiro-cli"]!;
const loginScreen = flow.loginScreenPattern!;

describe("kiro-cli 3.0.0 sign-in surfaces (captured offline from the real binary)", () => {
  it.each(WIDTHS)("`kiro-cli login` at %i: the same menu and labels — the structured sign-in offers the four methods", (w) => {
    const screen = pane(`login-menu-${w}`);
    expect(loginScreen.test(screen)).toBe(true);
    expect(structuredSignInPrompt("kiro-cli", screen)).toEqual({ phase: "method", selected: 0, choices: ["builder_id", "google", "github", "organization"] });
  });

  it.each(["tui", "v3"].flatMap(ui => WIDTHS.map(w => [ui, w] as const)))(
    "an expired token, %s launch at %i: 'You are not logged in. Login now?' — an auth-error trigger and a login screen, never answered",
    (ui, w) => {
      const screen = pane(`expired-${ui}-${w}`);
      const auth = authError(); auth.lastIndex = 0;
      expect(auth.test(screen)).toBe(true);
      expect(KIRO_LOGIN_REQUIRED_SCREEN.test(screen)).toBe(true);
      expect(loginScreen.test(screen)).toBe(true);
      const b = backend();
      expect([...b.getStartupDialogs(), ...b.getRuntimeDialogs()].filter(d => active([d], screen).length && (d.keys?.length ?? 0) > 0)).toEqual([]);
    });

  it.each(WIDTHS)("the three-choice V3 menu at %i (a home that used V2, launched without flags) is held, never keyed", (w) => {
    const screen = pane(`v3-choice-${w}`);
    expect(kiro3ChoiceActive(screen)).toBe(true);
    const b = backend();
    for (const dialogs of [b.getStartupDialogs(), b.getRuntimeDialogs()]) {
      const first = active(dialogs, screen)[0];
      expect(first, "the menu is recognised").toBeDefined();
      expect(first!.keys ?? []).toEqual([]);
      expect(first!.holdOnly).toBe(true);
    }
  });

  it.each(WIDTHS)("the V2 TUI at %i: 'Kiro CLI V3 is here.' is a banner, not the 3.0 menu — its trust-all-tools confirmation is answered as before", (w) => {
    const screen = pane(`tui-banner-${w}`);
    expect(kiro3ChoiceActive(screen)).toBe(false);
    const auth = authError(); auth.lastIndex = 0;
    expect(auth.test(screen)).toBe(false);
    const first = active(backend().getStartupDialogs(), screen)[0];
    expect(first?.description).toMatch(/trust/i);
    expect(first?.holdOnly).not.toBe(true);
  });

  it("3.0's success lines (from its binary) match the login success pattern; 2.x's line still does", () => {
    for (const line of ["Logged in with Builder ID", "Logged in with External IdP", "Logged in with Google", "Authenticated with API key", "Logged in successfully"]) {
      expect(flow.successPattern.test(`\n${line}\n`), line).toBe(true);
    }
  });
});
