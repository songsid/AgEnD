/**
 * kiro-cli 3.1.0 against the audited 3.0.0 (tests/fixtures/kiro-3.1.0-audit/README.md): the LIVE half of the audit,
 * captured offline from the real 3.1.0 binary. Fable's static half found the V2→V3 ease-in removed with no replacement
 * and every other AgEnD literal unchanged. These captures confirm the screens AgEnD acts on, with no detector change:
 * - an expired token lands on "You are not logged in. Login now?" on both launch paths: an auth error and a login
 *   screen, never answered;
 * - Classic's "Kiro CLI 3.0 is here. … Continue with V3 / Exit" and a V2 home's flagless "Switch to V3 / Keep V2" menu
 *   are held, never keyed (the ease-in is gone: a V2 home now gets the plain two-choice menu);
 * - the TUI trust-all-tools confirmation and V3's "Trust this workspace?" still get their known answers;
 * - V3's composer is ready, its "Kiro is working · … · Type to steer" row is busy, and the offline model-load failure
 *   leaves an ordinary ready composer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { KiroBackend, kiro3ChoiceActive, probeKiroCliCompatibility } from "../src/backend/kiro.js";
import { KIRO_LOGIN_REQUIRED_SCREEN, LOGIN_FLOWS } from "../src/login-flows.js";

const DIR = join(import.meta.dirname, "fixtures", "kiro-3.1.0-audit");
const pane = (name: string) => readFileSync(join(DIR, `${name}.pane.txt`), "utf-8");
const HELP_310 = readFileSync(join(DIR, "chat-help.txt"), "utf-8");
const compat = () => probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => (args[0] === "--version" ? "kiro-cli 3.1.0\n" : HELP_310));
const backend = () => {
  const b = new KiroBackend("/tmp/kiro-310", compat());
  (b as unknown as { activeTrustAll: boolean }).activeTrustAll = true;
  return b;
};
const active = (dialogs: RuntimeDialog[], screen: string) =>
  dialogs.filter(d => (d.isActive ? d.isActive(screen) : (d.pattern.lastIndex = 0, d.pattern.test(screen))));
const first = (dialogs: RuntimeDialog[], screen: string) => active(dialogs, screen)[0];
const authError = () => {
  const p = backend().getErrorPatterns().find(e => e.type === "auth_error");
  if (!p) throw new Error("no kiro auth_error pattern");
  return p.pattern;
};
const errorsOn = (screen: string) => backend().getErrorPatterns().filter(e => (e.pattern.lastIndex = 0, e.pattern.test(screen))).map(e => e.type);
const WIDTHS = [120, 80] as const;
const loginScreen = LOGIN_FLOWS["kiro-cli"]!.loginScreenPattern!;

describe("kiro-cli 3.1.0 (captured offline from the real binary): AgEnD's kiro detectors still hold", () => {
  it("the binary is 3.1.0 and its chat help still offers every launch flag AgEnD uses", () => {
    for (const flag of ["--v3", "--tui", "--legacy-ui", "--agent-engine", "--trust-all-tools", "--resume"]) expect(HELP_310, flag).toContain(flag);
    expect(compat().version).toContain("3.1.0");
  });

  it.each(["tui", "v3"].flatMap(ui => WIDTHS.map(w => [ui, w] as const)))(
    "an expired token, %s launch at %i: 'You are not logged in. Login now?' — an auth error and a login screen, never answered", (ui, w) => {
      const screen = pane(`expired-${ui}-${w}`), auth = authError(); auth.lastIndex = 0;
      expect(auth.test(screen)).toBe(true);
      expect(KIRO_LOGIN_REQUIRED_SCREEN.test(screen)).toBe(true);
      expect(loginScreen.test(screen)).toBe(true);
      const b = backend();
      expect([...b.getStartupDialogs(), ...b.getRuntimeDialogs()].filter(d => active([d], screen).length && (d.keys?.length ?? 0) > 0)).toEqual([]);
    });

  it.each(["classic", "launch-v2home"].flatMap(name => WIDTHS.map(w => [name, w] as const)))("%s at %i: the 'Kiro CLI 3.0 is here.' menu is held, never keyed", (name, w) => {
    const screen = pane(`${name}-${w}`);
    expect(kiro3ChoiceActive(screen)).toBe(true);
    const b = backend();
    for (const dialogs of [b.getStartupDialogs(), b.getRuntimeDialogs()]) {
      const hit = first(dialogs, screen);
      expect(hit, "the menu is recognised").toBeDefined();
      expect(hit!.keys ?? []).toEqual([]);
      expect(hit!.holdOnly).toBe(true);
    }
  });

  it.each(WIDTHS)("the ease-in is gone: a V2 home at %i shows the plain 'Switch to V3 / Keep V2' menu, no ease-in literal", (w) => {
    const screen = pane(`launch-v2home-${w}`);
    for (const gone of ["You're using Kiro CLI V2", "Switch to V3 and upgrade my configs", "Don't ask again"]) expect(screen).not.toContain(gone);
    expect(screen).toMatch(/Switch to V3[\s\S]*Keep V2/);
  });

  it.each(WIDTHS)("the TUI at %i: 'Kiro CLI V3 is here.' is a banner; its trust-all-tools confirmation gets the known first step", (w) => {
    const screen = pane(`trust-tui-${w}`);
    expect(kiro3ChoiceActive(screen)).toBe(false);
    expect(first(backend().getStartupDialogs(), screen)?.autoResolutionKey).toBe("kiro-trust-all-tools-step");
  });

  it.each(WIDTHS)("V3 at %i: 'Trust this workspace?' gets 'Trust, continue' under --trust-all-tools", (w) => {
    expect(first(backend().getStartupDialogs(), pane(`launch-fresh-${w}`))?.autoResolutionKey).toBe("kiro-workspace-trust-confirm");
  });

  it.each(WIDTHS)("V3 at %i: the composer past trust is ready and nothing is held; 3.1's 'What's new' fold is not a dialog", (w) => {
    for (const name of ["v3-after-trust", "v3-after-turn"]) {
      const screen = pane(`${name}-${w}`);
      expect(screen).toContain("ask a question or describe a task");
      expect(backend().getReadyPattern().test(screen), name).toBe(true);
      expect(backend().getBusyPattern().test(screen), name).toBe(false);
      expect(active(backend().getRuntimeDialogs(), screen), name).toEqual([]);
    }
  });

  it.each(WIDTHS)("V3 at %i: 'Kiro is working · 0s · Type to steer · Ctrl+S to queue' is busy", (w) => {
    const screen = pane(`v3-working-${w}`);
    expect(screen).toMatch(/›\s+Kiro is working · \d+s · Type to steer/);
    expect(backend().getBusyPattern().test(screen)).toBe(true);
  });

  it.each(WIDTHS)("V3 at %i: the offline 'could not load the available models' line is neither an auth error nor a rate limit", (w) => {
    const screen = pane(`v3-after-turn-${w}`);
    expect(screen).toContain("Kiro could not load the available models.");
    expect(errorsOn(screen)).not.toContain("auth_error");
    expect(errorsOn(screen)).not.toContain("rate_limit");
  });
});
