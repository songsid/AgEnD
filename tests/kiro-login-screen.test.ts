import { describe, expect, it } from "vitest";
import { KiroBackend } from "../src/backend/kiro.js";
import { LOGIN_FLOWS } from "../src/login-flows.js";

/**
 * An external user on AgEnD beta.13 / kiro-cli 2.14.2 had several kiro
 * instances showing "working / possibly stuck", hang warnings ("no screen
 * change for 10 minutes, no ready prompt") and failed deliveries. The pane was
 * none of those things: kiro-cli had dropped to its own sign-in screen because
 * the stored token had expired.
 *
 * kiro prints NO error when it does that — the prompt is simply replaced — so
 * none of the auth strings the monitor looked for appeared, and the pane then
 * sat unchanged until the hang detector complained about the wrong thing.
 *
 * The two lines below are the kiro-cli binary's own strings (`strings` on
 * kiro-cli 2.14.2). The product name is filled in at runtime, so only
 * ", let's get you signed in!" exists as a literal — matching "Welcome to Kiro
 * CLI" would find nothing.
 */
const EXPIRED_LOGIN_PANE = [
  "Welcome to Kiro CLI, let's get you signed in!",
  "",
  "Press enter to continue to the browser or esc to cancel",
].join("\n");

/** The menu `kiro-cli login` opens deliberately — a different screen. */
const LOGIN_MENU_PANE = [
  "? Select login method",
  "> Builder ID",
  "  Google",
  "  GitHub",
  "  Your Organization",
].join("\n");

/** An ordinary working pane: prompt row, tool banner, agent prose. */
const WORKING_PANE = [
  "> summarise the migration plan",
  "I will read the plan first (using tool: fs_read)",
  "Purpose: read the migration plan",
  "51% !>",
].join("\n");

/** Exactly what the monitor does: first pattern in array order wins. */
const classify = (pane: string) =>
  new KiroBackend("/tmp/test").getErrorPatterns().find(ep => ep.pattern.test(pane));

const kiroLoginScreen = () => LOGIN_FLOWS["kiro-cli"].loginScreenPattern!;

describe("kiro sign-in screen after token expiry", () => {
  it("is classified as an auth failure that pauses, not as working", () => {
    const match = classify(EXPIRED_LOGIN_PANE);
    expect(match, "an unrecognised sign-in screen is what produced the fake 'stuck'").toBeDefined();
    expect(match).toMatchObject({ type: "auth_error", action: "pause" });
    // Same remedy as every other kiro auth failure — one message, not two.
    expect(match?.message).toMatch(/kiro-cli login/);
  });

  it("is recognised by the startup scan's login-screen pattern too", () => {
    // Two different moments: the output monitor above catches an instance that
    // was already running; this catches one that restarts onto the screen.
    expect(kiroLoginScreen().test(EXPIRED_LOGIN_PANE)).toBe(true);
  });

  it("still recognises the deliberate login menu", () => {
    expect(kiroLoginScreen().test(LOGIN_MENU_PANE)).toBe(true);
  });

  it("leaves the menu automation pattern matching only the menu", () => {
    // menu.promptPattern drives the option walk; widening it would make the
    // automation try to answer a screen that has no options.
    const menuPrompt = LOGIN_FLOWS["kiro-cli"].menu!.promptPattern;
    expect(menuPrompt.test(LOGIN_MENU_PANE)).toBe(true);
    expect(menuPrompt.test(EXPIRED_LOGIN_PANE)).toBe(false);
  });

  it("does not fire on ordinary kiro output", () => {
    expect(classify(WORKING_PANE)?.type).not.toBe("auth_error");
    expect(kiroLoginScreen().test(WORKING_PANE)).toBe(false);
  });

  // This fleet maintains AgEnD, so an agent discussing this very bug will have
  // the sign-in wording on screen. One line alone is not a sign-in screen.
  it("does not fire on prose quoting a single line of the screen", () => {
    for (const prose of [
      "The kiro pane said: let's get you signed in! — that is the expiry screen.",
      "It printed `Press enter to continue to the browser or esc to cancel` and stopped.",
    ]) {
      expect(classify(prose)?.type, prose).not.toBe("auth_error");
      expect(kiroLoginScreen().test(prose), prose).toBe(false);
    }
  });
});
