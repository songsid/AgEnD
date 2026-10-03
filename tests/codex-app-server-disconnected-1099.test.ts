/**
 * #1099: when Codex loses its app-server the TUI keeps painting an empty (or
 * draft-holding) composer with the footer `ctrl+c quit` — no Context item. That
 * is exactly the blind spot of the #978 stable-composer escape hatch, so the pane
 * counted as idle after a quiet stretch and messages were delivered into a TUI
 * that accepts text and never submits it.
 *
 * The fixtures are real panes from codex-cli 0.159.2 / 0.160.0 with the
 * app-server killed, stage by stage (the counter keeps running; Codex gives up
 * after a couple of minutes and says so; nothing recovers without a relaunch):
 *   • Reconnecting to app-server… (8s)            0.159.2
 *   • Reconnecting to server… (12s) / (1m 12s)    0.160.0
 *   • Reconnect failed — check the endpoint, then relaunch (2m 24s)
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexBackend, codexAppServerDisconnected } from "../src/backend/codex.js";
import { Daemon, PaneStateMachine, UNKNOWN_LAYOUT_STABLE_MS } from "../src/daemon.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const RECONNECTING_159 = fixture("codex-0159-app-server-reconnecting.pane.txt");
const RECONNECTING_160 = fixture("codex-0160-app-server-reconnecting.pane.txt");
const RECONNECTING_MINUTES = fixture("codex-0160-app-server-reconnecting-minutes.pane.txt");
const FAILED = fixture("codex-0160-app-server-reconnect-failed.pane.txt");
const DISCONNECTED: Array<[string, string]> = [
  ["0.159.2 reconnecting", RECONNECTING_159], ["0.160.0 reconnecting", RECONNECTING_160],
  ["0.160.0 reconnecting, minutes", RECONNECTING_MINUTES], ["0.160.0 reconnect failed", FAILED],
];
const HEALTHY: Array<[string, string]> = [
  "codex-0160-idle", "codex-0160-turn-idle", "codex-0160-busy", "codex-0160-resumed", "codex-0159-idle", "codex-0159-fresh",
].map(name => [name, fixture(`${name}.pane.txt`)]);
const NO_CONTEXT_IDLE = fixture("codex-0157-resumed-no-context-footer.pane.txt");

const backend = new CodexBackend("/tmp/agend-codex-1099");
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the fixtures are the screens they claim to be", () => {
  it("each carries its defining row and the no-Context footer", () => {
    expect(RECONNECTING_159).toMatch(/■\s+Connection lost\. Attempting to reconnect…\n+• Reconnecting to app-server… \(8s\)/);
    expect(RECONNECTING_160).toMatch(/• Reconnecting to server… \(12s\)\n+› Ask Codex to do anything\n+\s+ctrl\+c quit/);
    expect(RECONNECTING_MINUTES).toContain("• Reconnecting to server… (1m 12s)");
    expect(FAILED).toMatch(/■\s+Server connection could not be restored\n+• Reconnect failed — check the endpoint, then relaunch \(2m 24s\)/);
    for (const [label, pane] of DISCONNECTED) {
      expect(pane, label).toContain("ctrl+c quit");
      expect(pane, label).not.toMatch(/Context \d+% (?:left|used)/);
    }
  });
});

describe("a pane with no app-server behind it is never an idle or deliverable pane", () => {
  it.each(DISCONNECTED)("%s: recognised, and refused by every readiness proof", (_label, pane) => {
    expect(codexAppServerDisconnected(pane)).toBe(true);
    // The #978 escape hatch is what used to say yes.
    expect(backend.isStableUnknownLayoutIdlePane(pane)).toBe(false);
    expect(backend.isDeliveryInputReadyPane(pane)).toBe(false);
    expect(backend.isPeriodicRedrawIdlePane(pane)).toBe(false);
  });

  it.each(DISCONNECTED)("%s: a settled capture reads as working, not idle", (_label, pane) => {
    const machine = new PaneStateMachine(backend.getReadyPattern(), 600_000, 0, backend.getBusyPattern());
    expect(machine.observe(pane, 10_000, { settled: true }).state).toBe("working");
  });

  it("the user's own `›` echo higher up is not mistaken for the composer (compact rendering, no blank rows)", () => {
    const compact = (pane: string) => pane.split("\n").filter(row => row.trim() !== "").join("\n");
    const withEcho = DISCONNECTED.filter(([, pane]) => pane.includes("› hello"));
    expect(withEcho).toHaveLength(2);   // the two captures taken after a turn
    for (const [label, pane] of withEcho) {
      const dense = compact(pane);
      expect(dense, label).toMatch(/^› hello$/m);
      expect(dense.split("\n").length, label).toBeLessThan(13);
      expect(codexAppServerDisconnected(dense), label).toBe(true);
      expect(backend.isStableUnknownLayoutIdlePane(dense), label).toBe(false);
    }
  });

  it("a transcript item BELOW the composer means the status row is not the live one", () => {
    for (const [label, pane] of DISCONNECTED) {
      const later = `${pane.trimEnd()}\n• Back online.\n`;
      expect(codexAppServerDisconnected(later), label).toBe(false);
    }
  });

  it("a draft the user left in the composer does not make it deliverable", () => {
    for (const [label, pane] of DISCONNECTED) {
      const draft = pane.replace("› Ask Codex to do anything", "› please remember to rebase\n  before merging");
      expect(draft, label).toContain("› please remember");
      expect(codexAppServerDisconnected(draft), label).toBe(true);
      expect(backend.isDeliveryInputReadyPane(draft), label).toBe(false);
      expect(backend.isStableUnknownLayoutIdlePane(draft), label).toBe(false);
    }
  });

  it("a Context footer under the same rows (a layout variant not yet seen) still does not make it deliverable", () => {
    // Derived from the real panes: only the footer differs. Without the veto the
    // normal Context-footer proof would say "ready".
    for (const [label, pane] of DISCONNECTED) {
      const variant = pane.replace(/ctrl\+c quit/, "Context 100% left · GPT-5.5");
      expect(variant, label).toContain("Context 100% left");
      expect(codexAppServerDisconnected(variant), label).toBe(true);
      expect(backend.isDeliveryInputReadyPane(variant), label).toBe(false);
      expect(backend.isPeriodicRedrawIdlePane(variant), label).toBe(false);
      expect(backend.isStableUnknownLayoutIdlePane(variant), label).toBe(false);
    }
  });
});

describe("healthy panes are untouched", () => {
  it.each(HEALTHY)("%s is not a disconnected pane", (_label, pane) => {
    expect(codexAppServerDisconnected(pane)).toBe(false);
  });

  it("the real idle panes keep their verdicts", () => {
    const idle = fixture("codex-0160-idle.pane.txt");
    expect(backend.isDeliveryInputReadyPane(idle)).toBe(true);
    expect(backend.isPeriodicRedrawIdlePane(idle)).toBe(true);
    expect(backend.isStableUnknownLayoutIdlePane(NO_CONTEXT_IDLE)).toBe(true);
  });

  it("text that merely quotes the rows is not the live row", () => {
    const idle = fixture("codex-0160-turn-idle.pane.txt");
    const row = "• Reconnecting to server… (12s)";
    const cases: Record<string, string> = {
      // inside an answer, followed by more of it and by Codex's own `Worked for` line
      "quoted in an answer": idle.replace("• ok", `• The screen reads:\n  ${row}\n  and then recovers.`),
      "quoted, then a later transcript item": idle.replace("› Ask Codex to do anything", `${row}\n• Back online.\n› Ask Codex to do anything`),
      "row after the composer": idle.replace(/(› Ask Codex to do anything)/, `$1\n${row}`),
      "indented prose": idle.replace("• ok", `  see: ${row}`),
      "not a duration": idle.replace("› Ask Codex to do anything", "• Reconnecting to server… (soon)\n› Ask Codex to do anything"),
      "another status": idle.replace("› Ask Codex to do anything", "• Reconnected to server (3s)\n› Ask Codex to do anything"),
    };
    for (const [label, pane] of Object.entries(cases)) {
      expect(pane, `${label}: the edit must have changed the pane`).not.toBe(idle);
      expect(codexAppServerDisconnected(pane), label).toBe(false);
    }
  });
});

/** The real error monitor over a pane, and the real fallback timer. */
function daemon(): any {
  const dir = mkdtempSync(join(tmpdir(), "agend-1099-"));
  dirs.push(dir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  const real = new CodexBackend(dir);
  return new Daemon("worker", {
    working_directory: "/tmp", backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, false, real, undefined, logger as any) as any;
}

describe("through the real daemon", () => {
  it("the stable-composer fallback no longer arms on a disconnected pane, however long it sits unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    for (const [label, pane] of DISCONNECTED) {
      const d = daemon();
      d.spawnGeneration++;
      d.inputTransientGuardGeneration = d.spawnGeneration;
      expect(d.deliveryInputReadyPane(pane), `${label} at 0s`).toBe(false);
      vi.advanceTimersByTime(UNKNOWN_LAYOUT_STABLE_MS + 1_000);
      expect(d.deliveryInputReadyPane(pane), `${label} after ${UNKNOWN_LAYOUT_STABLE_MS / 1000}s`).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(d.deliveryInputReadyPane(pane), `${label} after a minute`).toBe(false);
    }
  });

  it("control: the same fallback does arm on a real footer-less idle composer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const d = daemon();
    d.spawnGeneration++;
    d.inputTransientGuardGeneration = d.spawnGeneration;
    expect(d.deliveryInputReadyPane(NO_CONTEXT_IDLE)).toBe(false);
    vi.advanceTimersByTime(UNKNOWN_LAYOUT_STABLE_MS + 1_000);
    expect(d.deliveryInputReadyPane(NO_CONTEXT_IDLE)).toBe(true);
  });

  it("only the terminal stage raises a notice, once, and the retry stages stay quiet", () => {
    const patterns = backend.getErrorPatterns();
    const raised = (pane: string) => {
      const d = daemon();
      const errors: Array<{ type: string; action: string; message: string }> = [];
      d.on("pty_error", (e: { type: string; action: string; message: string }) => errors.push(e));
      d.instanceState = "working";
      d.evaluateErrorPatterns(pane, patterns, backend.getReadyPattern(), 10 * 60_000, backend.getBusyPattern());
      d.evaluateErrorPatterns(pane, patterns, backend.getReadyPattern(), 10 * 60_000 + 5_000, backend.getBusyPattern());
      return errors;
    };
    for (const [label, pane] of [["159", RECONNECTING_159], ["160", RECONNECTING_160], ["minutes", RECONNECTING_MINUTES]] as const) {
      expect(raised(pane), label).toEqual([]);
    }
    const failed = raised(FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ type: "network", action: "notify" });
    expect(failed[0].message).toContain("could not reconnect");
  });

  it("a whole old failed TUI quoted in an answer, with the real idle composer below, raises nothing", () => {
    const patterns = backend.getErrorPatterns();
    const turnIdle = fixture("codex-0160-turn-idle.pane.txt");
    const pane = turnIdle.replace("• ok", `${FAILED.trimEnd()}\nThis was an old capture; the request has completed.`);
    expect(pane).not.toBe(turnIdle);
    expect(codexAppServerDisconnected(pane)).toBe(false);
    expect(backend.isDeliveryInputReadyPane(pane)).toBe(true);
    const d = daemon();
    const errors: unknown[] = [];
    d.on("pty_error", (e: unknown) => errors.push(e));
    d.instanceState = "idle";
    d.evaluateErrorPatterns(pane, patterns, backend.getReadyPattern(), 10 * 60_000, backend.getBusyPattern());
    expect(errors).toEqual([]);
  });

  it("the terminal row, an earlier composer, then a finished turn and the real last composer, raises nothing", () => {
    const patterns = backend.getErrorPatterns();
    const turnIdle = fixture("codex-0160-turn-idle.pane.txt");
    const pane = turnIdle.replace("• ok",
      "• Reconnect failed — check the endpoint, then relaunch (2m 24s)\n› Ask Codex to do anything\n  ctrl+c quit\n\n  Worked for 1s • 16:03");
    expect(pane).not.toBe(turnIdle);
    expect(codexAppServerDisconnected(pane)).toBe(false);
    expect(backend.isDeliveryInputReadyPane(pane)).toBe(true);
    const d = daemon();
    const errors: unknown[] = [];
    d.on("pty_error", (e: unknown) => errors.push(e));
    d.instanceState = "idle";
    d.evaluateErrorPatterns(pane, patterns, backend.getReadyPattern(), 10 * 60_000, backend.getBusyPattern());
    expect(errors).toEqual([]);
  });

  it("a quotation of the terminal row does not raise it", () => {
    const patterns = backend.getErrorPatterns();
    const quoting = fixture("codex-0160-turn-idle.pane.txt").replace("• ok", "• Codex then prints:\n  • Reconnect failed — check the endpoint, then relaunch (2m 24s)\n  which means a relaunch.");
    expect(quoting).toContain("• Reconnect failed");
    expect(patterns.filter(ep => ep.pattern.test(quoting)).map(ep => ep.type)).toEqual([]);
  });
});
