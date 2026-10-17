/**
 * Upstream watch 2026-10-16: grok 1.0.60 against the 1.0.52 baseline (tests/fixtures/grok-1.0.60-audit/README.md).
 * Every pane was captured live from AgEnD's own launch line in an isolated rig (docker --network none, private tmux,
 * scratch HOME, a local API mock), from both binaries, at 120 and 80 columns: each detector gives the same verdict on
 * both. The error turns' prompts are letters and the mock replies "r<n>", so no status code on screen is the rig's echo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { GrokBackend } from "../src/backend/grok.js";

const DIR = join(import.meta.dirname, "fixtures", "grok-1.0.60-audit");
const pane = (dir: string, step: string) => readFileSync(join(DIR, dir, `${step}.pane.txt`), "utf-8");
const backend = () => new GrokBackend("/tmp/grok-1060-audit");
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
const WEEKLY = "Grok Build weekly limit (Grok 週限)[]";
/** The verdict each step gets — the same on 1.0.52 and 1.0.60, at both widths. */
const STEPS: Record<string, ReturnType<typeof verdict>> = {
  "01-trust": { ...idle, startup: [LOGO, "Grok workspace trust[y]"], runtime: [LOGO] },
  "02-ready": idle,
  "03-busy-a": { ...idle, busy: true },
  "04-done": idle,
  "05-busy-before-cancel": { ...idle, busy: true },
  "06-after-cancel": idle,
  "07-err-401": idle, // grok's own 401 text has no status code (unchanged; #1792 follow-up)
  "07-err-402": { ...idle, startup: [WEEKLY], runtime: [WEEKLY] },
  "07-err-402-esc": idle,
  "07-err-403": idle,
  "07-err-403-usage": idle, // a 403 "usage limit reached" body: not classified on either version (#1792 follow-up)
  "07-err-426": { ...idle, errors: ["outdated_cli"] },
  "07-err-429": { ...idle, errors: ["rate_limit"] },
  "07-err-429-text": { ...idle, errors: ["rate_limit"] },
  "07-err-500": idle, // grok's own retry line ends in ASCII "..." and does not read busy (unchanged; #1792 follow-up)
  "09-tool": idle,
  "10-compact": { ...idle, busy: true },
  "11-new": idle,
};

describe("grok 1.0.60 vs 1.0.52: every detector, every captured step", () => {
  it.each(["1.0.52", "1.0.60"].flatMap(version => ["120", "80"].flatMap(width => Object.keys(STEPS).map(step => [version, width, step]))))(
    "%s at %s columns, %s",
    (version, width, step) => {
      expect(verdict(pane(`${version}-${width}`, step))).toEqual(STEPS[step]);
    },
  );

  it.each(["1.0.52", "1.0.60"])("%s: an MCP call, the quit screens and a resumed session raise nothing", version => {
    for (const step of ["32-mcp-call", "50-quit-single", "52-resume"]) expect(verdict(pane(`${version}-120`, step)), step).toEqual(idle);
  });
});

describe("grok 1.0.60: what the precheck flagged", () => {
  it.each(["1.0.52", "1.0.60"].flatMap(version => ["120", "80"].map(width => [version, width])))(
    "%s at %s columns: the launch-path trust prompt is still 'Yes, proceed y / No, quit n', and AgEnD answers y",
    (version, width) => {
      const screen = pane(`${version}-${width}`, "01-trust");
      expect(screen).toMatch(/Do you trust the contents of this directory\?/);
      expect(screen).toMatch(/Yes, proceed\s+y\n/);
      expect(screen).toMatch(/No, quit\s+n\n/);
      expect(screen).not.toContain("No, cancel");
      expect(verdict(screen).startup).toContain("Grok workspace trust[y]");
    },
  );

  it("the approval card's 'Yes, proceed' is option 2, now the default; the runtime net matches neither card", () => {
    const before = pane("1.0.52-approval", "20-approval"), after = pane("1.0.60-approval", "20-approval");
    expect(before).toContain("1 (●) Yes, and don't ask again for anything (always-approve mode)");
    expect(before).toContain("2 (○) Yes, proceed");
    expect(after).toContain("1 (○) Yes, and don't ask again for anything (always-approve mode)");
    expect(after).toContain("2 (●) Yes, proceed");
    // AgEnD's default launch passes --always-approve, so the card does not come up; with skipPermissions: false it can.
    // The runtime net ("Yes, always") matches neither version's card — unchanged (#1792 follow-up), so the new default
    // (option 2) adds no regression.
    for (const screen of [before, after]) expect(verdict(screen).runtime).toEqual([]);
  });

  it.each(["1.0.52", "1.0.60"])("%s: a 429 still paints 'rate_limit' and reads as a rate limit", version => {
    for (const width of ["120", "80"]) {
      expect(pane(`${version}-${width}`, "07-err-429")).toContain("Retry failed: rate_limit_error: Rate limit exceeded");
      expect(verdict(pane(`${version}-${width}`, "07-err-429")).errors).toEqual(["rate_limit"]);
    }
  });

  it.each(["1.0.52", "1.0.60"])("%s: a 403 'usage limit reached' body paints the same line on both, and stays unclassified", version => {
    expect(pane(`${version}-120`, "07-err-403-usage")).toContain("Request denied (403): invalid_request_error: usage limit reached");
    expect(verdict(pane(`${version}-120`, "07-err-403-usage")).errors).toEqual([]);
  });

  it.each(["1.0.52", "1.0.60"])("%s: quit is still a double Ctrl+Q; the resume id brings the conversation back", version => {
    expect(pane(`${version}-120`, "50-quit-single")).toContain("Ctrl+q:press again to quit");
    expect(pane(`${version}-120`, "51-quit-double")).toMatch(/Resume this session with:\n\s+grok --resume [0-9a-f-]{36}\n/);
    expect(pane(`${version}-120`, "51-quit-double")).toContain("Pane is dead (status 0,");
    expect(pane(`${version}-120`, "52-resume")).toContain("mcp tool please");
    expect(backend().getQuitKeyPresses()).toBe(2);
  });
});
