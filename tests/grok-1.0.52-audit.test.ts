/**
 * #1792: grok 1.0.52 against the 1.0.50 baseline (tests/fixtures/grok-1.0.52-audit/README.md). Every pane here was
 * captured live from AgEnD's own launch line in an isolated rig, from both binaries, at 120 and 80 columns: each
 * detector gives the same verdict on both. The fix the audit found is older than either version: grok quits on a
 * *double* Ctrl+Q, and AgEnD sent one. The error turns' prompts are letters and the mock replies "r<n>", so no status
 * code on screen is the rig's own echo.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeDialog } from "../src/backend/types.js";
import { GrokBackend } from "../src/backend/grok.js";
import { Daemon } from "../src/daemon.js";

const DIR = join(import.meta.dirname, "fixtures", "grok-1.0.52-audit");
const pane = (version: string, width: string, step: string) => readFileSync(join(DIR, `${version}-${width}`, `${step}.pane.txt`), "utf-8");
const backend = () => new GrokBackend("/tmp/grok-1052-audit");
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
/** The verdict each step gets — the same on 1.0.50 and 1.0.52, at both widths. */
const STEPS: Record<string, ReturnType<typeof verdict>> = {
  "01-trust": { ...idle, startup: [LOGO, "Grok workspace trust[y]"], runtime: [LOGO] },
  "02-ready": idle,
  "03-busy-a": { ...idle, busy: true },
  "04-done": idle,
  "05-busy-before-cancel": { ...idle, busy: true },
  "06-after-cancel": idle,
  "07-err-401": idle, // grok's own 401 text has no status code; pinned unmatched, see "grok auth" below
  "07-err-402": { ...idle, startup: [WEEKLY], runtime: [WEEKLY] },
  "07-err-402-esc": idle,
  "07-err-403": idle,
  "07-err-426": { ...idle, errors: ["outdated_cli"] },
  "07-err-429": { ...idle, errors: ["rate_limit"] },
  "07-err-500": idle,
  "09-tool": idle,
  "10-compact": { ...idle, busy: true },
  "11-new": idle,
};

describe("grok 1.0.52 vs 1.0.50: every detector, every captured step", () => {
  it.each(["1.0.50", "1.0.52"].flatMap(version => ["120", "80"].flatMap(width => Object.keys(STEPS).map(step => [version, width, step]))))(
    "%s at %s columns, %s",
    (version, width, step) => {
      expect(verdict(pane(version, width, step))).toEqual(STEPS[step]);
    },
  );

  it.each(["1.0.50", "1.0.52"])("%s: the approval card, an MCP call and the quit screens raise nothing", version => {
    for (const step of ["20-approval", "32-mcp-call", "50-quit-single"]) expect(verdict(pane(version, "120", step)), step).toEqual(idle);
  });
});

describe("grok 1.0.52: what the precheck flagged", () => {
  it.each(["1.0.50", "1.0.52"])("%s: the launch-path trust prompt is still 'y Yes, proceed / n No, quit' — 'No, cancel' is the dashboard's", version => {
    const screen = pane(version, "120", "01-trust");
    expect(screen).toMatch(/Do you trust the contents of this directory\?/);
    expect(screen).toMatch(/Yes, proceed\s+y\n/);
    expect(screen).toMatch(/No, quit\s+n\n/);
    expect(screen).not.toContain("No, cancel");
  });

  it.each(["1.0.50", "1.0.52"])("%s: the weekly-limit modal has a third choice, and is held only while it has the keyboard", version => {
    expect(pane(version, "120", "07-err-402")).toContain("3 (○) Try Again");
    expect(pane(version, "120", "07-err-402")).toContain("Tab:next answer  │  Esc:scrollback  │  Shift+x:dismiss");
    expect(pane(version, "120", "07-err-402-esc")).toContain("3 (○) Try Again");
  });
});

/**
 * Not fixed here (#1792 follow-up): grok's own 401 text matches no auth pattern, and a pattern alone would not pause
 * anything — every grok auth hit gets the second opinion `grok models` (LOGIN_FLOWS.grok.authCheck), which exits 0
 * whatever the credential: valid, rejected (401), unreachable, or none at all. These pin both facts.
 */
describe("grok auth: what the audit found and left for a follow-up", () => {
  it.each(["1.0.50", "1.0.52"].flatMap(version => ["120", "80"].map(width => [version, width])))("%s at %s columns: the 401 screen carries no status code and is not an auth hit", (version, width) => {
    const screen = pane(version, width, "07-err-401");
    expect(screen).toMatch(/Authentication required: your session has expired or your credentials/);
    expect(verdict(screen).errors).toEqual([]);
  });

  it.each(["1.0.50", "1.0.52"])("%s: `grok models` exits 0 for a valid, rejected, unreachable or absent credential", version => {
    const receipt = readFileSync(join(DIR, "models", `grok-models-${version}.txt`), "utf-8");
    expect([...receipt.matchAll(/^=== \S+ (\S+) rc=(\d+)$/gm)].map(m => [m[1], m[2]])).toEqual([
      ["valid-key", "0"], ["rejected-key", "0"], ["unreachable", "0"], ["no-credentials", "0"],
    ]);
    expect(receipt).toContain("You are not authenticated.");
  });
});

describe("grok quit: a double Ctrl+Q (#1792)", () => {
  it.each(["1.0.50", "1.0.52"])("%s: one press only asks for another; two exit and print the resume line", version => {
    expect(pane(version, "120", "50-quit-single")).toContain("Ctrl+q:press again to quit");
    expect(pane(version, "120", "51-quit-double")).toMatch(/Resume this session with:\n\s+grok --resume [0-9a-f-]{36}\n/);
    expect(pane(version, "120", "51-quit-double")).toContain("Pane is dead (status 0,");
  });

  it("GrokBackend asks for two presses", () => {
    expect(backend().getQuitCommand()).toBeNull();
    expect(backend().getQuitKey()).toBe("C-q");
    expect(backend().getQuitKeyPresses()).toBe(2);
  });

  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("a grok stop sends Ctrl+Q twice, inside grok's 1000 ms window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-grok-quit-"));
    dirs.push(dir);
    writeFileSync(join(dir, "window-id"), "@1");
    const presses: Array<{ key: string; at: number }> = [];
    const tmux = {
      sendKeys: vi.fn(async () => true),
      sendSpecialKey: vi.fn(async (key: string) => { presses.push({ key, at: performance.now() }); return true; }),
      getPaneStatus: vi.fn(async () => ({ alive: true })),
      capturePane: vi.fn(async () => ""),
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const d = new Daemon("grok-quit", {
      working_directory: "/tmp",
      backend: "grok",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as never, dir, false, backend(), undefined, { child: () => logger } as never) as unknown as {
      tmux: unknown; sendQuitSequence(reason: string, caller: string): Promise<boolean>;
    };
    d.tmux = tmux;

    expect(await d.sendQuitSequence("graceful stop", "stop")).toBe(true);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(presses.map(p => p.key)).toEqual(["C-q", "C-q"]);
    expect(presses[1]!.at - presses[0]!.at).toBeLessThan(1000);
  });
});
