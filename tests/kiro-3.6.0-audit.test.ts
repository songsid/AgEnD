/**
 * kiro-cli 3.6.0 against the audited 3.5.0 (M-3752; tests/fixtures/kiro-3.6.0-audit/README.md). The precheck said MAJOR
 * (21 detector literals missing). Static split: every one of them was a plain-text copy in the Rust binary; 15 went with
 * the dead Classic (v1) harness 3.6.0 deleted (its `--legacy-ui` now only "Show[s] the Classic upgrade prompt (Classic no
 * longer runs)"), and 6 are still in the zstd-framed tui.js / engine tar with unchanged counts. These live captures, taken
 * offline from the real 3.6.0 binary, read the same as 3.5.0's apart from scratch paths, and AgEnD's detectors still hold:
 * no detector change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { KiroBackend, kiro3ChoiceActive, planKiroLaunch, probeKiroCliCompatibility } from "../src/backend/kiro.js";
import { KIRO_LOGIN_REQUIRED_SCREEN, LOGIN_FLOWS } from "../src/login-flows.js";

const DIR = join(import.meta.dirname, "fixtures", "kiro-3.6.0-audit");
const pane = (name: string) => readFileSync(join(DIR, `${name}.pane.txt`), "utf-8");
const HELP_360 = readFileSync(join(DIR, "chat-help.txt"), "utf-8");
const compat = () => probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => (args[0] === "--version" ? "kiro-cli 3.6.0\n" : HELP_360));
const backend = () => {
  const b = new KiroBackend("/tmp/kiro-360", compat());
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

describe("kiro-cli 3.6.0 (captured offline from the real binary): AgEnD's kiro detectors still hold", () => {
  it("the binary is 3.6.0; its chat help still offers every launch flag AgEnD uses, and says Classic no longer runs", () => {
    for (const flag of ["--v3", "--tui", "--legacy-ui", "--agent-engine", "--trust-all-tools", "--resume"]) expect(HELP_360, flag).toContain(flag);
    expect(HELP_360).toContain("Show the Classic upgrade prompt (Classic no longer runs)");
    expect(HELP_360).not.toContain("Use the legacy harness");
    expect(compat().version).toContain("3.6.0");
  });

  it("launch plans: V3 gets --v3, the TUI gets the v2 engine, and a Classic (legacy) instance is refused, never launched", () => {
    expect(planKiroLaunch("v3", compat())).toEqual({ kind: "launch", ui: "v3", flags: ["--v3"] });
    expect(planKiroLaunch("tui", compat())).toEqual({ kind: "launch", ui: "tui", flags: ["--tui", "--agent-engine=v2"] });
    expect(planKiroLaunch("legacy", compat()).kind).toBe("refuse");
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

  it.each(WIDTHS)("the deleted Classic harness's texts are not on any 3.6.0 screen at %i", (w) => {
    const names = ["classic", "launch-v2home", "launch-fresh", "trust-tui", "expired-tui", "expired-v3", "v3-after-trust", "v3-working", "v3-after-turn"];
    for (const gone of ["Classic is being deprecated with the Kiro CLI 3.0", "This will erase the conversation history", "Kiro rate limit reached"]) {
      for (const name of names) expect(pane(`${name}-${w}`), `${name}: ${gone}`).not.toContain(gone);
    }
  });

  it.each(WIDTHS)("the TUI at %i: 'Kiro CLI V3 is here.' is a banner; its trust-all-tools confirmation gets the known first step", (w) => {
    const screen = pane(`trust-tui-${w}`);
    expect(kiro3ChoiceActive(screen)).toBe(false);
    expect(first(backend().getStartupDialogs(), screen)?.autoResolutionKey).toBe("kiro-trust-all-tools-step");
  });

  it.each(WIDTHS)("V3 at %i: 'Trust this workspace?' gets 'Trust, continue' under --trust-all-tools", (w) => {
    expect(first(backend().getStartupDialogs(), pane(`launch-fresh-${w}`))?.autoResolutionKey).toBe("kiro-workspace-trust-confirm");
  });

  it.each(WIDTHS)("V3 at %i: the composer past trust is ready and nothing is held; the 'What's new' fold is not a dialog", (w) => {
    for (const name of ["v3-after-trust", "v3-after-turn"]) {
      const screen = pane(`${name}-${w}`);
      expect(screen).toContain("ask a question or describe a task");
      expect(backend().getReadyPattern().test(screen), name).toBe(true);
      expect(backend().getBusyPattern().test(screen), name).toBe(false);
      expect(active(backend().getRuntimeDialogs(), screen), name).toEqual([]);
    }
  });

  it.each(WIDTHS)("V3 at %i: 'Kiro is working · … · Type to steer' is busy", (w) => {
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
