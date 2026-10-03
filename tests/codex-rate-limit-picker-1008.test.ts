import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";

/**
 * #1008 — codex's "Approaching rate limits" model-switch picker parked unattended
 * instances (it waits forever), and its default option (1) SWITCHES THE MODEL.
 *
 * Fixtures are real panes from codex 0.157.1 and 0.159.2, produced against a local
 * mock Responses server that returns the x-codex-*-used-percent headers (isolated
 * CODEX_HOME, tmux). Verified live on both versions:
 *   - the picker is identical; the cursor starts on "1. Switch to <model>";
 *   - Enter takes the cursor row (a stray Enter switched the footer to GPT-6-Luna);
 *   - Down at first paint moves the cursor (no input-refusal window, 3/3 and 4/4);
 *   - Escape at first paint closes it, model unchanged, no repeat in the session (7/7);
 *   - `[notice] hide_rate_limit_model_nudge = true` is a real key and prevents the
 *     picker on both versions. AgEnD already writes it (#1012; its writeConfig test is
 *     in session-expire-and-codex-update.test.ts), so this file covers the picker that
 *     appears ANYWAY: config not applied, an older Codex, a moved key.
 */
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const pane = (n: string) => readFileSync(join(fixtures, `codex-${n}.pane.txt`), "utf8");

const PICKER_157 = pane("0157-rate-limit-picker");
const PICKER_159 = pane("0159-rate-limit-picker");
const DISMISSED_157 = pane("0157-rate-limit-dismissed");
const DISMISSED_159 = pane("0159-rate-limit-dismissed");
const HIDDEN_BY_CONFIG = pane("0159-rate-limit-hidden-by-config");
// #1100: the same picker at 80x24 (AgEnD's legacy size), the option descriptions wrapped under their column.
const PICKER_159_80 = pane("0159-rate-limit-picker-80x24");
const PICKER_160_80 = pane("0160-rate-limit-picker-80x24");
const PICKER_160 = pane("0160-rate-limit-picker");

const backend = new CodexBackend("/tmp/agend-codex-1008");
const startup = backend.getStartupDialogs();
const runtime = backend.getRuntimeDialogs();
// The daemon decides with isActive INSTEAD of pattern whenever a dialog has one (Daemon.dialogMatches).
const hit = (table: typeof runtime, p: string) => table.find(d => (d.isActive ? d.isActive(p) : d.pattern.test(p)));

/** A verbatim quote of a picker with the live composer under it. */
const quoted = (p: string) => `${p.trimEnd()}\n\n› Ask Codex to do anything\n  gpt-5.1-codex default · /tmp/x`;
const reword = (p: string, from: string | RegExp, to: string) => { const r = p.replace(from, to); expect(r).not.toBe(p); return r; };

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeDaemon(initial: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1008-")); dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@9");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("codex-1008", {
    working_directory: "/tmp", backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, new CodexBackend(dir), undefined, { child: () => logger } as any) as any;
  const state = { pane: initial, onKey: null as null | ((k: string) => void) };
  const keys: string[] = [];
  daemon.tmux = {
    capturePane: vi.fn(async () => state.pane),
    isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); state.onKey?.(k); return true; }),
    sendKeys: vi.fn(async (k: string) => { keys.push(`text:${k}`); return true; }),
    pasteText: vi.fn(async (t: string) => { keys.push(`paste:${t}`); return true; }),
    pasteBuffer: vi.fn(async () => true),
    getWindowId: () => "@9",
    getLastPasteError: () => null,
    isLastPasteFailureRecoverable: () => true,
    getLastSendSpecialKeyError: () => null,
  };
  daemon.controlClient = { isIdle: () => true, waitUntilIdle: async () => true, waitForIdle: async () => true };
  return { daemon, state, keys, logger };
}

describe("the real picker (0.157.1 and 0.159.2) is recognised exactly", () => {
  it.each([["0.157.1", PICKER_157], ["0.159.2", PICKER_159]])("%s: Escape, in the startup AND runtime tables, blocking delivery", (_v, p) => {
    for (const table of [startup, runtime]) {
      const d = hit(table, p)!;
      expect(d.keys).toEqual(["Escape"]);
      expect(d.holdOnly).toBeUndefined();
      expect(d.blocksDelivery).toBe(true);
      expect(d.inputBlocked).toBe(true);
      expect(d.description).toMatch(/rate-limit model-switch picker/);
    }
  });

  it("the cursor starts on 'Switch', and that is exactly why nothing may press Enter or Down+Enter on it", () => {
    expect(PICKER_157).toMatch(/^› 1\. Switch to gpt-6-luna/m);
    expect(PICKER_159).toMatch(/^› 1\. Switch to gpt-6-luna/m);
    for (const p of [PICKER_157, PICKER_159]) {
      for (const table of [startup, runtime]) {
        const answered = table.filter(d => d.pattern.test(p) && (!d.isActive || d.isActive(p)));
        for (const d of answered) expect(d.keys.every(k => k === "Escape"), d.description).toBe(true);
      }
    }
  });

  it("once the picker is closed — or never shown because the config key is set — nothing matches", () => {
    for (const p of [DISMISSED_157, DISMISSED_159, HIDDEN_BY_CONFIG]) {
      expect(hit(startup, p)).toBeUndefined();
      expect(hit(runtime, p)).toBeUndefined();
    }
  });

  it("a quote of the picker with the real composer under it gets no key", () => {
    for (const p of [PICKER_157, PICKER_159]) {
      expect(hit(runtime, quoted(p))).toBeUndefined();
      expect(hit(startup, quoted(p))).toBeUndefined();
    }
    const prose = "The picker says: Approaching rate limits — Switch to gpt-6-luna for lower credit usage? Keep current model (never show again)\n› ";
    expect(hit(runtime, prose)).toBeUndefined();
  });
});

describe("a shape that is not exactly the known one is held, never keyed", () => {
  const VARIANTS: Array<[string, string]> = [
    ["footer reworded", reword(PICKER_159, "enter select · esc back", "enter select · esc cancel")],
    ["options reordered", reword(reword(PICKER_159, "2. Keep current model\n", "2. Switch to gpt-5\n"), "› 1. Switch to gpt-6-luna", "› 1. Keep current model")],
    ["a fourth option", reword(PICKER_159, /^ {2}3\. Keep current model \(never show again\).*$/m, "  3. Keep current model (never show again)\n  4. Something else")],
    ["title changed", reword(PICKER_159, "Approaching rate limits", "Almost out of credits")],
    ["no never-show option", reword(PICKER_159, /^ {2}3\. Keep current model \(never show again\).*\n/m, "")],
    // one thing changed at a time: each row of the shape is load-bearing
    ["option 1 is not a switch", reword(PICKER_159, "› 1. Switch to gpt-6-luna", "› 1. Pick another model")],
    ["option 2 relabelled", reword(PICKER_159, "  2. Keep current model\n", "  2. Keep my model\n")],
    ["option 3 relabelled", reword(PICKER_159, "3. Keep current model (never show again)", "3. Keep current model (always)")],
    ["subtitle changed", reword(PICKER_159, "for lower credit usage?", "for higher quality?")],
    ["a row between subtitle and options", reword(PICKER_159, "› 1. Switch to gpt-6-luna", "  Choose one:\n› 1. Switch to gpt-6-luna")],
  ];
  it.each(VARIANTS)("%s: not the exact picker, no key from any table", (_name, p) => {
    for (const table of [startup, runtime]) {
      const d = hit(table, p);
      expect(d?.keys ?? []).toEqual([]);
    }
  });

  it("the cursor position does not matter for Escape: on row 2 or 3 it is still the exact picker", () => {
    for (const moved of [
      reword(reword(PICKER_159, "› 1. Switch", "  1. Switch"), "  2. Keep current model\n", "› 2. Keep current model\n"),
      reword(reword(PICKER_159, "› 1. Switch", "  1. Switch"), "  3. Keep current model (never show again)", "› 3. Keep current model (never show again)"),
    ]) {
      expect(hit(runtime, moved)!.keys).toEqual(["Escape"]);
    }
  });

  it("the footer/title variants that still read as the rate-limit screen are held by the existing hold-only entry", () => {
    const d = hit(runtime, VARIANTS[0]![1])!;
    expect(d.holdOnly).toBe(true);
    expect(d.blocksDelivery).toBe(true);
  });
});

describe("the daemon answers it unattended: Escape, nothing else", () => {
  it("runtime: a picker that appears after startup gets exactly one Escape, and the instance goes back to work", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys } = makeDaemon(PICKER_159);
    state.onKey = k => { if (k === "Escape") state.pane = DISMISSED_159; };
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(keys).toEqual(["Escape"]);                 // never Enter, never Down, never a digit
    daemon.freezeRuntimeMonitors();
  });

  it("runtime: an Escape the picker swallowed is simply sent again; no other key is ever sent", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys } = makeDaemon(PICKER_157);
    let swallowed = 0;
    state.onKey = k => { if (k === "Escape" && ++swallowed > 2) state.pane = DISMISSED_157; };
    daemon.startErrorMonitor();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(keys).toEqual(["Escape", "Escape", "Escape"]);
    expect(state.pane).toBe(DISMISSED_157);
    daemon.freezeRuntimeMonitors();
  });

  it("runtime: a transcript quoting the picker, or a reworded one, is never sent a key", async () => {
    vi.useFakeTimers();
    for (const p of [quoted(PICKER_159), reword(PICKER_159, "enter select · esc back", "enter select · esc cancel")]) {
      const { daemon, keys } = makeDaemon(p);
      daemon.startErrorMonitor();
      await vi.advanceTimersByTimeAsync(11_000);
      expect(keys).toEqual([]);
      daemon.freezeRuntimeMonitors();
    }
  });

  it("startup: a picker already up when the scan runs is dismissed with Escape, then the pane reads ready", async () => {
    const { daemon, state, keys } = makeDaemon(PICKER_157);
    state.onKey = k => { if (k === "Escape") state.pane = DISMISSED_157; };
    expect(await daemon.dismissDialogsUntilReady(5_000, 0)).toBe(true);
    expect(keys).toEqual(["Escape"]);
  });

  it("delivery is blocked while it is up: no paste, no Enter into the picker", async () => {
    vi.useFakeTimers();
    const { daemon, state, keys } = makeDaemon(PICKER_159);
    void daemon.deliverMessage("[from:leader] hello", { chatId: "c", messageId: "m" }, {});
    await vi.advanceTimersByTimeAsync(4_000);
    expect(keys.filter(k => k.startsWith("paste:") || k === "Enter")).toEqual([]);
    void state;
  });
});

describe("the 80-column picker, option descriptions wrapped onto indented rows (#1100)", () => {
  const NARROW: Array<[string, string]> = [["0.159.2 @80x24", PICKER_159_80], ["0.160.0 @80x24", PICKER_160_80]];
  const bottom = (p: string) => p.trimEnd().split("\n").slice(-9).join("\n");

  it.each(NARROW)("%s: the real wrapped shape (a description row under option 1, another under option 3)", (_v, p) => {
    expect(bottom(p)).toMatch(/Switch to gpt-6-luna +Fast and affordable model for easier\n {20,}tasks\.\n/);
    expect(bottom(p)).toMatch(/\(never show again\) +Hide future rate limit reminders\n {20,}about switching models\n/);
  });

  it.each(NARROW)("%s: still the exact picker — Escape, in the startup AND runtime tables, blocking delivery", (_v, p) => {
    for (const table of [startup, runtime]) {
      const d = hit(table, p)!;
      expect(d.keys).toEqual(["Escape"]);
      expect(d.holdOnly).toBeFalsy();
      expect(d.blocksDelivery).toBe(true);
    }
  });

  it("the 120-column pictures (0.157.1, 0.159.2, 0.160.0) are unchanged", () => {
    for (const p of [PICKER_157, PICKER_159, PICKER_160]) expect(hit(runtime, p)!.keys).toEqual(["Escape"]);
  });

  it("a quote of the wrapped picker with the real composer under it gets no key", () => {
    for (const [, p] of NARROW) {
      expect(hit(runtime, quoted(p))).toBeUndefined();
      expect(hit(startup, quoted(p))).toBeUndefined();
    }
  });

  it("what wrapping may add is only descriptions: any other change is held, never keyed", () => {
    const base = PICKER_159_80;
    const WRAP = " ".repeat(44);
    const VARIANTS: Array<[string, string]> = [
      ["a wrapped row that starts at the left margin", reword(base, `${WRAP}tasks.`, "tasks.")],
      ["a wrapped row indented like an option", reword(base, `${WRAP}tasks.`, "  tasks.")],
      ["a 'continuation' that is itself an option", reword(base, `${WRAP}tasks.`, `${WRAP}4. Something else`)],
      ["more wrapped rows than a description can take", reword(base, `${WRAP}tasks.`, [1, 2, 3, 4].map(n => `${WRAP}row ${n}`).join("\n"))],
      ["a wrapped row between subtitle and option 1", reword(base, "› 1. Switch to gpt-6-luna", `${WRAP}Choose one:\n› 1. Switch to gpt-6-luna`)],
      ["a wrapped row between title and subtitle", reword(base, "  Switch to gpt-6-luna for lower credit usage?", `${WRAP}wait\n  Switch to gpt-6-luna for lower credit usage?`)],
      ["a wrapped row under the footer", `${base.trimEnd()}\n${WRAP}extra\n`],
      ["footer reworded", reword(base, "enter select · esc back", "enter select · esc cancel")],
      ["options reordered", reword(reword(base, "2. Keep current model\n", "2. Switch to gpt-5\n"), "› 1. Switch to gpt-6-luna", "› 1. Keep current model")],
      ["option 3 relabelled", reword(base, "3. Keep current model (never show again)", "3. Keep current model (always)")],
      ["no never-show option", reword(base, /^ {2}3\. Keep current model \(never show again\).*\n.*\n/m, "")],
    ];
    for (const [name, p] of VARIANTS) {
      for (const table of [startup, runtime]) {
        expect(hit(table, p)?.keys ?? [], name).toEqual([]);
      }
    }
  });

  it("the footer/option variants that still read as the rate-limit screen stay held by the hold-only entry", () => {
    const d = hit(runtime, reword(PICKER_159_80, "enter select · esc back", "enter select · esc cancel"))!;
    expect(d.holdOnly).toBe(true);
    expect(d.blocksDelivery).toBe(true);
  });

  it("through the daemon: the wrapped picker gets exactly one Escape (it used to be parked, unattended, for ever)", async () => {
    vi.useFakeTimers();
    for (const [, p] of NARROW) {
      const { daemon, state, keys } = makeDaemon(p);
      state.onKey = k => { if (k === "Escape") state.pane = DISMISSED_159; };
      daemon.startErrorMonitor();
      await vi.advanceTimersByTimeAsync(11_000);
      expect(keys).toEqual(["Escape"]);
      daemon.freezeRuntimeMonitors();
    }
  });
});
