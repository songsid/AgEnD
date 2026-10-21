/**
 * #2345: kiro-cli 2.33.0 against the audited 2.32.0 (tests/fixtures/kiro-2.33.0-audit/README.md), every screen captured
 * live from both. The login screens, the TUI trust-all-tools confirmation and the rate-limit text are unchanged. The V3
 * (kas) engine now asks "Trust this workspace?" before its TUI mounts, and on main nothing answered or held it: a V3
 * instance sat on it, and a delivered message's Enter would have picked the highlighted "Trust, continue". Under
 * --trust-all-tools the captured layout with its default cursor gets Enter; everything else is held for a human.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import {
  KIRO_RATE_LIMIT_SCREEN, KIRO_REQUEST_LIMIT_SCREEN, KIRO_TESTED_MAX, KiroBackend, kiroTrustPromptState,
  kiroWorkspaceTrustState, planKiroLaunch, probeKiroCliCompatibility,
} from "../src/backend/kiro.js";
import { KIRO_EXPIRED_LOGIN_SCREEN, LOGIN_FLOWS } from "../src/login-flows.js";

const DIR = join(import.meta.dirname, "fixtures", "kiro-2.33.0-audit");
const fixture = (name: string) => readFileSync(join(DIR, name), "utf-8");
const pane = (name: string) => fixture(`${name}.pane.txt`);
const HELP_233 = readFileSync(join(import.meta.dirname, "fixtures", "kiro-help", "chat-help-2.33.0.txt"), "utf-8");
const compat = (version = "2.33.0") =>
  probeKiroCliCompatibility("/fake/kiro-cli", (_bin, args) => (args[0] === "--version" ? `kiro-cli ${version}\n` : HELP_233));
const backend = (trustAll = true) => {
  const b = new KiroBackend("/tmp/kiro-233", compat());
  (b as unknown as { activeTrustAll: boolean }).activeTrustAll = trustAll;
  return b;
};
const active = (dialogs: RuntimeDialog[], screen: string) => dialogs.filter(d => (d.isActive ? d.isActive(screen) : d.pattern.test(screen)));
const tables = [["startup", (b: KiroBackend) => b.getStartupDialogs()], ["runtime", (b: KiroBackend) => b.getRuntimeDialogs()]] as const;
/** What the daemon does: the first active entry acts. */
const first = (dialogs: RuntimeDialog[], screen: string) => active(dialogs, screen)[0];
const VERSIONS = ["2.32.0", "2.33.0"] as const;

describe("kiro-cli 2.32.0 and 2.33.0: sign-in screens", () => {
  it.each(VERSIONS)("%s: the expiry fallback and the login menu are both kiro sign-in screens", (version) => {
    const expired = pane(`login-expired-${version}`);
    expect(KIRO_EXPIRED_LOGIN_SCREEN.test(expired)).toBe(true);
    expect(LOGIN_FLOWS["kiro-cli"]!.loginScreenPattern!.test(expired)).toBe(true);
    expect(backend().getErrorPatterns().find(p => p.pattern.test(expired))?.type).toBe("auth_error");
    expect(LOGIN_FLOWS["kiro-cli"]!.loginScreenPattern!.test(pane(`login-menu-${version}`))).toBe(true);
  });

  it("2.33.0 paints them exactly as 2.32.0 does, escapes included", () => {
    for (const name of ["login-expired-%s.pane", "login-expired-%s.pane-e", "login-menu-%s.pane"]) {
      expect(fixture(`${name.replace("%s", "2.33.0")}.txt`), name).toBe(fixture(`${name.replace("%s", "2.32.0")}.txt`));
    }
  });

  it("the precheck's two missing literals: 2.33.0's kiro-cli builds the line from styled fragments", () => {
    const old = fixture("kiro-cli-2.32.0.strings.txt");
    const now = fixture("kiro-cli-2.33.0.strings.txt");
    expect(old).toContain("## 'Press enter to continue to the browser or esc to cancel': count 1");
    expect(now).toContain("## 'Press enter to continue to the browser or esc to cancel': count 0");
    expect(now).toContain("## ' to continue to the browser or ': count 1");
    expect(now).toContain("## \", let's get you signed in!\": count 1");
  });
});

describe("kiro-cli 2.32.0 and 2.33.0: the TUI trust-all-tools confirmation (--tui --agent-engine=v2)", () => {
  it.each(tables.flatMap(([table, dialogs]) => VERSIONS.map(version => [table, version, dialogs] as const)))(
    "%s table, %s: Down off 'No, exit', Enter on 'Yes, I accept', then the composer is ready",
    (_table, version, dialogs) => {
      expect(kiroTrustPromptState(pane(`tui-trust-cursor0-${version}`))).toEqual({ active: true, cursor: 0 });
      expect(first(dialogs(backend()), pane(`tui-trust-cursor0-${version}`))!.keys).toEqual(["Down"]);
      expect(first(dialogs(backend()), pane(`tui-trust-cursor1-${version}`))!.keys).toEqual(["Enter"]);
      const ready = pane(`tui-ready-${version}`);
      expect(active(dialogs(backend()), ready)).toEqual([]);
      expect(backend().getReadyPattern().test(ready)).toBe(true);
    },
  );

  it("2.33.0 paints it exactly as 2.32.0 does", () => {
    for (const name of ["tui-trust-cursor0", "tui-trust-cursor1"]) expect(pane(`${name}-2.33.0`)).toBe(pane(`${name}-2.32.0`));
  });
});

describe("kiro-cli 2.33.0: V3's 'Trust this workspace?' (--v3 --trust-all-tools), captured live", () => {
  const prompts = ["v3-workspace-120-2.33.0", "v3-workspace-80-2.33.0", "v3-workspace-home-80-2.33.0"];

  it("2.32.0's V3 opens on the trust-all-tools confirmation: no workspace prompt there", () => {
    const screen = pane("v3-2.32.0-first-screen");
    expect(kiroWorkspaceTrustState(screen)).toEqual({ active: false, cursor: null });
    expect(first(backend().getStartupDialogs(), screen)!.autoResolutionKey).toBe("kiro-trust-all-tools-step");
  });

  it.each(tables.flatMap(([table, dialogs]) => prompts.map(name => [table, name, dialogs] as const)))(
    "%s table, %s: under --trust-all-tools, Enter on the default 'Trust, continue'",
    (_table, name, dialogs) => {
      const screen = pane(name);
      expect(kiroWorkspaceTrustState(screen)).toEqual({ active: true, cursor: 0 });
      const hit = first(dialogs(backend()), screen)!;
      expect(hit.keys).toEqual(["Enter"]);
      expect(hit.autoResolutionKey).toBe("kiro-workspace-trust-confirm");
      expect(hit).toMatchObject({ blocksDelivery: true, inputBlocked: true, verifyAfterKeys: true, oncePerLaunch: true });
      // The trust-all-tools entries do not mistake it for their dialog.
      expect(kiroTrustPromptState(screen)).toEqual({ active: false, cursor: null });
    },
  );

  it.each(tables.flatMap(([table, dialogs]) => prompts.map(name => [table, name, dialogs] as const)))(
    "%s table, %s: without --trust-all-tools it is held for a human, never keyed",
    (_table, name, dialogs) => {
      const found = active(dialogs(backend(false)), pane(name));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every(d => d.holdOnly && d.keys.length === 0 && d.blocksDelivery && d.inputBlocked)).toBe(true);
    },
  );

  it.each(tables)("%s table: a cursor someone moved to 'Don't trust, exit' is held, not overridden", (_table, dialogs) => {
    const screen = pane("v3-workspace-cursor-decline-2.33.0");
    expect(kiroWorkspaceTrustState(screen)).toEqual({ active: true, cursor: 1 });
    const found = active(dialogs(backend()), screen);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(d => d.holdOnly && d.keys.length === 0)).toBe(true);
  });

  it.each(tables)("%s table: once declined, kiro has quit — the prompt it left behind is not live", (_table, dialogs) => {
    const screen = pane("v3-workspace-declined-2.33.0");
    expect(kiroWorkspaceTrustState(screen)).toEqual({ active: false, cursor: null });
    expect(active(dialogs(backend()), screen)).toEqual([]);
  });

  it.each(tables)("%s table: after 'Trust, continue' the known trust-all-tools steps follow, then the composer", (_table, dialogs) => {
    for (const name of ["v3-trust-after-workspace-2.33.0", "v3-relaunch-trusted-80-2.33.0"]) {
      expect(kiroWorkspaceTrustState(pane(name)), name).toEqual({ active: false, cursor: null });
      expect(first(dialogs(backend()), pane(name))!.autoResolutionKey, name).toBe("kiro-trust-all-tools-step");
    }
    const ready = pane("v3-ready-2.33.0");
    expect(active(dialogs(backend()), ready)).toEqual([]);
    expect(backend().getReadyPattern().test(ready)).toBe(true);
  });
});

/** Shapes kiro's tui.js can paint but no capture shows, built from the captured 120-column prompt (the component's own
 *  strings: tui-2.33.0-workspace-trust.js.txt). None has a known cursor: all held, never keyed. */
describe("kiro-cli 2.33.0: other workspace-trust shapes are held", () => {
  const base = pane("v3-workspace-120-2.33.0");
  const component = fixture("tui-2.33.0-workspace-trust.js.txt");
  const held = (screen: string) => {
    expect(kiroWorkspaceTrustState(screen)).toEqual({ active: true, cursor: null });
    for (const [, dialogs] of tables) {
      const found = active(dialogs(backend()), screen);
      expect(found.length).toBeGreaterThan(0);
      expect(found.every(d => d.holdOnly && d.keys.length === 0)).toBe(true);
    }
  };

  it("every string used below is the component's own", () => {
    for (const text of ['"Trust, continue"', '"Don\'t trust"', '"Trust this workspace?"', "`${hLn}, ${o}`", 'declineAction:o="exit"',
      "closeMenuActionLabel:`to ${o}`", "p=a?[{label:d", 'g("warning")(eE(u))', "Revoke later by removing workspaceTrusted from"]) {
      expect(component, text).toContain(text);
    }
  });

  it("the error variant: only 'Don't trust, exit', with the error text", () => {
    held(base.replace(/^.*This folder can contain[\s\S]*?execute files here\.\n/m, " Could not resolve this folder.\n")
      .replace(/^ ❯ Trust, continue\n {3}Don't trust, exit$/m, " ❯ Don't trust, exit"));
  });

  it("the mid-session variant: 'Don't trust, cancel' and 'esc to cancel'", () => {
    held(base.replace("Don't trust, exit", "Don't trust, cancel").replace(" esc to exit ·", " esc to cancel ·"));
  });

  it("a notice below the revoke path", () => {
    held(base.replace(/permissions\.yaml\n/, "permissions.yaml\n Could not save trust: read-only file system\n"));
  });

  it("an added option, reordered options, an unknown cursor glyph, two cursors, or no divider", () => {
    held(base.replace("   Don't trust, exit\n", "   Don't trust, exit\n   Trust once\n"));
    held(base.replace(" ❯ Trust, continue\n   Don't trust, exit", " ❯ Don't trust, exit\n   Trust, continue"));
    held(base.replace(" ❯ Trust, continue", " ● Trust, continue"));
    held(base.replace("   Don't trust, exit", " ❯ Don't trust, exit"));
    held(base.replace(/^( Trust this workspace\?\n) ─+\n/m, "$1"));
  });

  // One change each, every other row as captured: no later check may be what catches it.
  it("one row changed: a divider, the key-hint tail, or the decline label", () => {
    const dividers = [...base.matchAll(/^ ─+$/gm)].map(m => m.index!);
    expect(dividers.length).toBe(3);   // above the header, below it, above the tail
    for (const at of dividers) held(`${base.slice(0, at)} ·${base.slice(base.indexOf("\n", at))}`);
    held(base.replace(" esc to exit ·", " esc to cancel ·"));
    held(base.replace(" esc to exit · ↑↓ to navigate · ↵ to select", " esc to exit · ↑↓ to navigate"));
    held(base.replace("Don't trust, exit", "Don't trust, leave"));
  });

  it("the grant text reworded or missing, in the folder and the home layout", () => {
    const grant = "Kiro will be able to read, edit, and execute files here.";
    const home = pane("v3-workspace-home-80-2.33.0");
    expect(base).toContain(grant);
    held(base.replace(grant, "Kiro will be able to read and edit files here."));
    held(base.replace(/^ Trusting lets Kiro use this workspace's configuration\.[^\n]*\n/m, ""));
    expect(home).toMatch(/^ Trusting lets Kiro/m);
    held(home.replace(/^( Trusting lets Kiro use this workspace's) configuration/m, "$1 settings"));
    held(home.replace(/^ Trusting lets Kiro[\s\S]*?files here\.\n/m, ""));
  });

  it("the folder text replaced, or the home text with a revoke path", () => {
    held(base.replace("Only trust folders\n you know.", "Trust only folders\n you know."));
    const home = pane("v3-workspace-home-80-2.33.0");
    held(home.replace(/(↵ to select\n)/, "$1 Revoke later by removing workspaceTrusted from\n /x/.kiro/workspace-roots/ab12/permissions.yaml\n"));
  });

  it("a revoke path that is not kiro's workspace-roots permissions file", () => {
    held(base.replace(/workspace-roots\/[0-9a-f]+\/permissions\.yaml/, "elsewhere/permissions.yaml"));
  });

  it("not a prompt: the question alone, or a quoted copy with the composer below it", () => {
    const quiet = { active: false, cursor: null };
    expect(kiroWorkspaceTrustState(" Trust this workspace?\n some reply text\n")).toEqual(quiet);
    expect(kiroWorkspaceTrustState(`${base}\n${pane("v3-ready-2.33.0").split("\n").filter(row => row.trim()).slice(-6).join("\n")}`)).toEqual(quiet);
  });
});

describe("kiro-cli 2.33.0: rate-limit and quota text (static; not reachable offline)", () => {
  const LITERALS = [" ⚠️  Kiro rate limit reached:", "Request quota exceeded. Please wait a moment and try again.",
    "Monthly request limit reached", "The limits reset on", "Kiro is having trouble responding right now",
    "ThrottlingException", "TooManyRequestsException", "RequestThrottledException", "SlowDownException", "ExpiredTokenException"];

  it.each(VERSIONS)("%s's kiro-cli-chat still holds every literal the error patterns match", (version) => {
    const strings = fixture(`kiro-cli-chat-${version}.strings.txt`);
    for (const literal of LITERALS) expect(strings, literal).toMatch(new RegExp(`## '${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}': count [1-9]`));
  });

  it("the hinted 'new prompt' is a re-ordered string pool: the rate-limit header now sits next to an existing sentence", () => {
    const old = fixture("kiro-cli-chat-2.32.0.strings.txt");
    const now = fixture("kiro-cli-chat-2.33.0.strings.txt");
    expect(old).toContain(" ⚠️  Kiro rate limit reached:Monthly request limit reached");
    expect(now).toContain(" ⚠️  Kiro rate limit reached:Your prompt is too long even after truncation.");
    expect(old).toContain("## 'Your prompt is too long even after truncation.': count 1");
  });

  it("the patterns still match the screens kiro builds from them", () => {
    expect(KIRO_RATE_LIMIT_SCREEN.test(" ⚠️  Kiro rate limit reached:\n    Request quota exceeded. Please wait a moment and try again.\n")).toBe(true);
    expect(KIRO_REQUEST_LIMIT_SCREEN.test("Monthly request limit reached - The limits reset on 11/01.\n")).toBe(true);
  });
});

describe("kiro-cli 2.33.0 is the tested maximum", () => {
  it("is read from the version table, with the pins 2.27–2.32 had; its --help is 2.32.0's", () => {
    expect(KIRO_TESTED_MAX).toBe("2.33.0");
    const table = compat();
    expect(table.source).toBe("version");
    expect(planKiroLaunch("legacy", table)).toEqual({ kind: "launch", ui: "legacy", flags: ["--legacy-ui", "--agent-engine=v1"] });
    expect(planKiroLaunch("tui", table)).toEqual({ kind: "launch", ui: "tui", flags: ["--tui", "--agent-engine=v2"] });
    expect(planKiroLaunch("v3", table)).toEqual({ kind: "launch", ui: "v3", flags: ["--v3"] });
    const help = compat("2.33.1");
    expect(help.source).toBe("help");
    expect(help.agentEngines).toEqual(["v2", "v1", "v3"]);
    expect(planKiroLaunch("tui", help)).toEqual(planKiroLaunch("tui", table));
  });
});
