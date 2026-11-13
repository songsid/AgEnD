/**
 * kiro-cli 3.3.0 against the audited 3.2.1 (tests/fixtures/kiro-3.3.0-audit/README.md): captured offline from the real
 * 3.3.0 binary, every capture repeated on 3.2.1 and diffed. The precheck's MAJOR is one new shutdown string set
 * ("Stopping background jobs (press Ctrl+C to skip)" / "closing the session with running jobs did not complete") that
 * belongs to kiro's dark-shipped `background_execution` feature (0%, internal nightly); the rate-limit, history-overflow,
 * monthly-limit and turn-cancel texts are unchanged, only their neighbours in the binary moved. No detector change:
 * - an expired token lands on "You are not logged in. Login now?" on both launch paths: an auth error and a login
 *   screen, never answered;
 * - Classic's "Kiro CLI 3.0 is here." menu and a V2 home's "Switch to V3 / Keep V2" menu are held, never keyed;
 * - the trust-all-tools confirmation (TUI and V3) and V3's "Trust this workspace?" get their known answers;
 * - the TUI and V3 composers are ready, "Kiro is working · … · Type to steer" is busy, an offline turn end leaves a
 *   ready composer; 3.3.0 only drops the right-aligned `/sessions to resume · /copy to clipboard` hint;
 * - `/session-id` is read on both, and `/quit` at idle ends the session with its resume line (no background-jobs wait).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { KiroBackend, kiro3ChoiceActive, probeKiroCliCompatibility, readKiroSessionIdAlert } from "../src/backend/kiro.js";
import { KIRO_LOGIN_REQUIRED_SCREEN, LOGIN_FLOWS } from "../src/login-flows.js";

const DIR = join(import.meta.dirname, "fixtures", "kiro-3.3.0-audit");
const pane = (name: string) => readFileSync(join(DIR, `${name}.pane.txt`), "utf-8");
const HELP_330 = readFileSync(join(DIR, "chat-help.txt"), "utf-8");
const compat = () => probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => (args[0] === "--version" ? "kiro-cli 3.3.0\n" : HELP_330));
const backend = () => {
  const b = new KiroBackend("/tmp/kiro-330", compat());
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

describe("kiro-cli 3.3.0 (captured offline from the real binary): AgEnD's kiro detectors still hold", () => {
  it("the binary is 3.3.0 and its chat help still offers every launch flag AgEnD uses", () => {
    for (const flag of ["--v3", "--tui", "--legacy-ui", "--agent-engine", "--trust-all-tools", "--resume", "--resume-id", "--agent"]) expect(HELP_330, flag).toContain(flag);
    expect(compat().version).toContain("3.3.0");
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

  it.each(["trust-tui", "v3-trust-all"].flatMap(name => WIDTHS.map(w => [name, w] as const)))(
    "%s at %i: the trust-all-tools confirmation (cursor on 'No, exit') gets the known first step, one Down", (name, w) => {
      const screen = pane(`${name}-${w}`);
      expect(screen).toMatch(/❯ No, exit[\s\S]*Yes, I accept[\s\S]*Yes, and don't ask again/);
      expect(kiro3ChoiceActive(screen)).toBe(false);
      const hit = first(backend().getStartupDialogs(), screen);
      expect(hit?.autoResolutionKey).toBe("kiro-trust-all-tools-step");
      expect(hit?.keys).toEqual(["Down"]);
    });

  it.each(WIDTHS)("V3 at %i: 'Trust this workspace?' gets 'Trust, continue' under --trust-all-tools", (w) => {
    expect(first(backend().getStartupDialogs(), pane(`launch-fresh-${w}`))?.autoResolutionKey).toBe("kiro-workspace-trust-confirm");
  });

  it.each(["v3-after-trust", "v3-after-turn", "tui-idle", "tui-after-turn"].flatMap(name => WIDTHS.map(w => [name, w] as const)))(
    "%s at %i: the composer is ready, not busy, and nothing is held (3.3.0 drops only the right-aligned hint)", (name, w) => {
      const screen = pane(`${name}-${w}`);
      expect(screen).toMatch(/›\s+ask a question or describe a task ↵/);
      expect(screen).not.toContain("/copy to clipboard");
      expect(backend().getReadyPattern().test(screen), name).toBe(true);
      expect(backend().getBusyPattern().test(screen), name).toBe(false);
      expect(active(backend().getRuntimeDialogs(), screen), name).toEqual([]);
    });

  it.each(WIDTHS)("V3 at %i: 'Kiro is working · 0s · Type to steer · Ctrl+S to queue' is busy", (w) => {
    const screen = pane(`v3-working-${w}`);
    expect(screen).toMatch(/›\s+Kiro is working · \d+s · Type to steer/);
    expect(backend().getBusyPattern().test(screen)).toBe(true);
  });

  it.each(WIDTHS)("offline turn ends at %i ('Sign in to Kiro to send a prompt.' on V3, 'dispatch failure' on the TUI) are not rate limits", (w) => {
    const v3 = pane(`v3-after-turn-${w}`), tui = pane(`tui-after-turn-${w}`);
    expect(v3).toContain("• Sign in to Kiro to send a prompt.");
    expect(tui).toContain("• dispatch failure");
    for (const screen of [v3, tui]) expect(errorsOn(screen)).not.toContain("rate_limit");
  });

  it.each(["tui", "v3"].flatMap(ui => WIDTHS.map(w => [ui, w] as const)))("%s at %i: the /session-id alert is read (the id AgEnD resumes with)", (ui, w) => {
    const screen = pane(`${ui}-session-id-${w}`);
    const id = readKiroSessionIdAlert(screen);
    expect(id).toMatch(ui === "v3" ? /^sess_[0-9a-f-]{36}$/ : /^[0-9a-f-]{36}$/);
    expect(screen).toContain(`Resume with: kiro-cli --resume-id ${id}`);
  });

  it.each(["tui", "v3"].flatMap(ui => WIDTHS.map(w => [ui, w] as const)))("%s at %i: /quit at idle ends the session with its resume line, no background-jobs wait", (ui, w) => {
    const screen = pane(`${ui}-quit-${w}`);
    expect(screen).toMatch(/^Session ended\.$/m);
    expect(screen).toMatch(/^Resume with: kiro-cli --resume-id \S+$/m);
    expect(screen).not.toContain("Stopping background jobs");
  });
});
