/**
 * Upstream watch 2026-10-24: grok 1.0.70 against the 1.0.67 baseline (tests/fixtures/grok-1.0.70-audit/README.md).
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

const DIR = join(import.meta.dirname, "fixtures", "grok-1.0.70-audit");
const VERSIONS = ["1.0.67", "1.0.70"];
const pane = (dir: string, step: string) => readFileSync(join(DIR, dir, `${step}.pane.txt`), "utf-8");
const backend = () => new GrokBackend("/tmp/grok-1070-audit");
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
/** The verdict each step gets — the same on 1.0.67 and 1.0.70, at both widths (and the same as the 1.0.60 and 1.0.67 audits). */
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

describe("grok 1.0.70 vs 1.0.67: every detector, every captured step", () => {
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

describe("grok 1.0.70: what the precheck flagged", () => {
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

  it("the 'Yes, proceed / No, cancel' trust strings are the Agent Dashboard's, which AgEnD never opens; 1.0.70 only moves its folder label", () => {
    // `grok dashboard` is never launched by AgEnD (it runs `grok --no-auto-update [--always-approve]`). In 1.0.70 the
    // folder line above the box ("/tmp/… [Choose Ctrl+l]") moved into the box's top border ("/tmp/… · Ctrl+l"); the
    // rest of every step is the same, and nothing on it reads as ready-only, busy, an error or a dialog.
    const norm = (t: string) => t.replace(/1\.0\.(67|70)/g, "V").split("\n").map(l => l.trimEnd()).filter(l => !/untrusted-V|^\s*$|^\s*╭─+╮$/.test(l)).join("\n");
    for (const step of ["01-open", "02-enter", "03-enter2", "04-esc"]) {
      const [before, after] = VERSIONS.map(version => norm(pane(`${version}-dashboard`, step)));
      expect(after, step).toBe(before);
    }
    expect(pane("1.0.67-dashboard", "01-open")).toContain("/tmp/untrusted-1.0.67 [Choose Ctrl+l]");
    expect(pane("1.0.70-dashboard", "01-open")).toMatch(/╭─+ \/tmp\/untrusted-1\.0\.70 · Ctrl\+l ╮/);
    for (const version of VERSIONS) {
      expect(pane(`${version}-dashboard`, "01-open"), version).toContain("+ New Agent");
      expect(verdict(pane(`${version}-dashboard`, "01-open")), version).toEqual(idle);
    }
  });

  it("the new Ctrl+C texts are `grok worker controller`'s (new in 1.0.70, never launched by AgEnD): a log line, not a screen", () => {
    // "stopping after the running hooks finish; press Ctrl+C again to kill them" / "killing the running hooks …; press
    // Ctrl+C again to exit now" / "forced stop: …" belong to the Cursor Cloud Agent pool controller. Captured offline
    // (--network none): it logs the first one on Ctrl+C and exits when no hook runs. AgEnD's stop is grok's own double
    // Ctrl+Q on the interactive session, whose screens are unchanged (50-quit-single, 51-quit-double).
    const help = readFileSync(join(DIR, "help-1.0.70.txt"), "utf-8");
    expect(help).toMatch(/controller {2}Claim pending Cloud Agent requests for team pools and run a spawn hook for each/);
    expect(readFileSync(join(DIR, "help-1.0.67.txt"), "utf-8")).toContain("error: unrecognized subcommand 'controller'");
    const ctrlC = pane("1.0.70-controller", "02-ctrl-c");
    expect(ctrlC).toMatch(/INFO stopping after the running hooks finish; press Ctrl\+C again to kill them\n/);
    expect(ctrlC).toContain("Pane is dead (status 0,");
    expect(verdict(ctrlC)).toEqual({ ...idle, ready: false });
  });

  it.each(["120", "80"])("the welcome card lists Resume session before New worktree in 1.0.70 (at %s columns); ready reads the same", width => {
    const order = (version: string) => [...pane(`${version}-${width}`, "02-ready").matchAll(/(Resume session|New worktree)/g)].map(m => m[1]);
    expect(order("1.0.67")).toEqual(["New worktree", "Resume session"]);
    expect(order("1.0.70")).toEqual(["Resume session", "New worktree"]);
    for (const version of VERSIONS) expect(verdict(pane(`${version}-${width}`, "02-ready")), version).toEqual(idle);
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

  it.each(VERSIONS)("%s: --help still lists the flags AgEnD passes, and the effort flag the same way", version => {
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
