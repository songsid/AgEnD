/**
 * Upstream watch 2026-10-22: grok 1.0.67 against the 1.0.62 baseline (tests/fixtures/grok-1.0.67-audit/README.md).
 * Every pane was captured live from AgEnD's own launch line in an isolated rig (docker --network none, private tmux,
 * scratch HOME, a local API mock), from both binaries, at 120 and 80 columns: each detector gives the same verdict on
 * both. The error turns' prompts are letters and the mock replies "r<n>", so no status code on screen is the rig's echo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { GrokBackend } from "../src/backend/grok.js";
import { helpOption } from "../src/backend/launch-effort.js";

const DIR = join(import.meta.dirname, "fixtures", "grok-1.0.67-audit");
const VERSIONS = ["1.0.62", "1.0.67"];
const pane = (dir: string, step: string) => readFileSync(join(DIR, dir, `${step}.pane.txt`), "utf-8");
const backend = () => new GrokBackend("/tmp/grok-1067-audit");
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
/** The verdict each step gets — the same on 1.0.62 and 1.0.67, at both widths (and the same as 1.0.60's audit). */
const STEPS: Record<string, ReturnType<typeof verdict>> = {
  "01-trust": { ...idle, startup: [LOGO, TRUST], runtime: [LOGO] },
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

describe("grok 1.0.67 vs 1.0.62: every detector, every captured step", () => {
  it.each(VERSIONS.flatMap(version => ["120", "80"].flatMap(width => Object.keys(STEPS).map(step => [version, width, step]))))(
    "%s at %s columns, %s",
    (version, width, step) => {
      expect(verdict(pane(`${version}-${width}`, step))).toEqual(STEPS[step]);
    },
  );

  it.each(VERSIONS)("%s: an MCP call, the quit screens, a resumed session and the approval card raise nothing", version => {
    for (const step of ["32-mcp-call", "50-quit-single", "52-resume"]) expect(verdict(pane(`${version}-120`, step)), step).toEqual(idle);
    for (const step of ["20-approval", "21-approval-esc"]) expect(verdict(pane(`${version}-approval`, step)), step).toEqual(idle);
  });
});

describe("grok 1.0.67: what the precheck flagged", () => {
  it.each(VERSIONS.flatMap(version => ["120", "80"].map(width => [version, width])))(
    "%s at %s columns: the launch-path trust prompt is still 'Yes, proceed y / No, quit n', and AgEnD answers y",
    (version, width) => {
      const screen = pane(`${version}-${width}`, "01-trust");
      expect(screen).toMatch(/Do you trust the contents of this directory\?/);
      expect(screen).toMatch(/Yes, proceed\s+y\n/);
      expect(screen).toMatch(/No, quit\s+n\n/);
      expect(screen).not.toContain("No, cancel");
      expect(verdict(screen).startup).toContain(TRUST);
    },
  );

  it("the moved 'Yes, proceed / No, cancel' trust strings sit by the Agent Dashboard's, which AgEnD never opens; it is unchanged", () => {
    // In the 1.0.67 binary the strings now neighbour the Agent Dashboard's ("Choose", "+ New Agent", box glyphs). That
    // screen is `grok dashboard`, which AgEnD never launches (it runs `grok --no-auto-update [--always-approve]`), and it
    // paints the same on both versions — the strings moved, the screens did not.
    for (const step of ["01-open", "02-enter", "03-enter2", "04-esc"]) {
      const [before, after] = VERSIONS.map(version => pane(`${version}-dashboard`, step).replace(/1\.0\.6[27]/g, "V"));
      expect(after, step).toBe(before);
    }
    const dash = pane("1.0.67-dashboard", "01-open");
    expect(dash).toContain("[Choose Ctrl+l]");
    expect(dash).toContain("+ New Agent");
    for (const version of VERSIONS) expect(verdict(pane(`${version}-dashboard`, "01-open")), version).toEqual(idle);
  });

  it.each(VERSIONS)("%s: a 429 still paints 'rate_limit_error' and reads as a rate limit", version => {
    for (const width of ["120", "80"]) {
      expect(pane(`${version}-${width}`, "07-err-429")).toContain("Retry failed: rate_limit_error: Rate limit exceeded");
      expect(verdict(pane(`${version}-${width}`, "07-err-429")).errors).toEqual(["rate_limit"]);
    }
  });

  it.each(VERSIONS)("%s: a 403 'usage limit reached' body paints the same line on both, and stays unclassified", version => {
    expect(pane(`${version}-120`, "07-err-403-usage")).toContain("Request denied (403): invalid_request_error: usage limit reached");
    expect(verdict(pane(`${version}-120`, "07-err-403-usage")).errors).toEqual([]);
  });

  /**
   * The hard=1 string ("… usage limit reached / status 401 / unauthorized / invalid_request_error") is grok's
   * compaction-error classifier list, unchanged; its new neighbour is a "Compaction failed: …" text. A failed /compact
   * paints the same line on both versions, and each gets the same verdict.
   */
  const COMPACT: Record<string, { line: RegExp; errors: string[] }> = {
    a: { line: /┃ {2}Compaction failed - Unauthorized \(401\) from \S+: invalid_request_error:/, errors: ["auth_error"] }, // the auth second opinion (grok models) still decides
    b: { line: /┃ {2}Compaction failed - API error \(status 402 Payment Required\):/, errors: ["quota"] },
    g: { line: /┃ {2}Compaction failed - API error \(status 403 Forbidden\): invali/, errors: [] },
    f: { line: /┃ {2}Compaction failed - API error \(status 500 Internal Server Er/, errors: [] },
  };
  it.each(VERSIONS.flatMap(version => Object.keys(COMPACT).map(k => [version, k])))("%s: /compact failing (%s) paints the same line and verdict", (version, k) => {
    const screen = pane(`${version}-compact-120`, `60-compact-fail-${k}`);
    expect(screen).toMatch(COMPACT[k]!.line);
    expect(verdict(screen)).toEqual({ ...idle, errors: COMPACT[k]!.errors });
    expect(verdict(pane(`${version}-compact-120`, `62-turn-after-${k}`))).toEqual(idle);
  });

  it.each(VERSIONS)("%s: --help (reformatted in 1.0.67) still lists the flags AgEnD passes, and the effort flag the same way", version => {
    const help = readFileSync(join(DIR, `help-${version}.txt`), "utf-8");
    for (const flag of ["--always-approve", "--resume", "--model"]) expect(helpOption(help, flag).listed, flag).toBe(true);
    // launch-effort.ts: listed, no value list → grok's known three levels (low, medium, high).
    expect(helpOption(help, "--reasoning-effort")).toEqual({ listed: true, levels: null });
  });

  it.each(VERSIONS)("%s: quit is still a double Ctrl+Q; the resume id brings the conversation back", version => {
    expect(pane(`${version}-120`, "50-quit-single")).toContain("Ctrl+q:press again to quit");
    expect(pane(`${version}-120`, "51-quit-double")).toMatch(/Resume this session with:\n\s+grok --resume [0-9a-f-]{36}\n/);
    expect(pane(`${version}-120`, "51-quit-double")).toContain("Pane is dead (status 0,");
    expect(pane(`${version}-120`, "52-resume")).toContain("mcp tool please");
    expect(backend().getQuitKeyPresses()).toBe(2);
  });
});
