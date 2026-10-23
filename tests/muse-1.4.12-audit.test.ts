/** Isolated 1.4.12-R6909.1 captures; see fixture SOURCES.md for scope. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { MuseBackend, museInputBox } from "../src/backend/muse.js";

const dir = join(process.cwd(), "tests/fixtures/muse-1.4.12");
const pane = (name: string) => readFileSync(join(dir, name), "utf8");
const backend = new MuseBackend("/tmp/agend-muse-1412-audit");
const verdict = (p: string) => ({
  busy: backend.getBusyPattern().test(p),
  idle: backend.isPeriodicRedrawIdlePane(p),
  draft: backend.inputDraft(p)?.rows ?? null,
});

const HINT = "Type @ to search and insert workspace file paths";
const OTHER_HINTS = [
  "Start a message with ! to run a shell command yourself",
  "Paste an image with Ctrl+V — file paths and URLs work too",
  "Press Alt+V to dictate instead of typing",
  "Tab queues or steers while a run is active",
  "Press ? on an empty composer to see keyboard shortcuts",
  "Press Ctrl+O to expand collapsed tool output",
];

function withComposer(idle: string, text: string): string {
  const lines = idle.split("\n");
  const i = lines.findIndex(l => l === "❯");
  if (i < 0) throw new Error("idle fixture has no empty prompt");
  lines[i] = text === "" ? "❯" : `❯ ${text}`;
  return lines.join("\n");
}

describe("Muse 1.4.12: isolated idle, draft and dialog", () => {
  it.each(["echo-idle.pane.txt", "echo-done.pane.txt", "meta-done.pane.txt"])("%s is an empty idle composer", name => {
    const p = pane(name);
    expect(backend.getReadyPattern().test(p)).toBe(true);
    expect(verdict(p)).toEqual({ busy: false, idle: true, draft: [] });
  });

  it("the -e idle frame still reads as empty (SGR stripped for layout)", () => {
    expect(verdict(pane("echo-idle.ansi.txt"))).toEqual({ busy: false, idle: true, draft: [] });
  });

  it("typed text in the isolated draft capture is a draft and cannot prove idle", () => {
    expect(verdict(pane("echo-draft.pane.txt"))).toEqual({ busy: false, idle: false, draft: ["a real user draft"] });
  });

  it("the first-run trust dialog is the 1.4.11 shape and is not ready", () => {
    const p = pane("first-run-trust-dialog.pane.txt");
    const found = backend.getStartupDialogs().filter(d => d.pattern.test(p));
    expect(found.map(d => d.keys)).toEqual([["1", "Enter"]]);
    expect(backend.getReadyPattern().test(p)).toBe(false);
    expect(backend.isPeriodicRedrawIdlePane(p)).toBe(false);
    expect(p).toBe(readFileSync(join(process.cwd(), "tests/fixtures/muse-1.4.11/first-run-trust-dialog.pane.txt"), "utf8"));
  });
});

describe("Muse 1.4.12 empty-composer placeholder is not a draft (#2520)", () => {
  it("the reconstructed grey hint counts as empty, so delivery is not foreign-draft", () => {
    const p = pane("echo-placeholder.pane.txt");
    expect(p).toContain(HINT);
    expect(museInputBox(p)?.rows).toEqual([]);
    expect(verdict(p)).toEqual({ busy: false, idle: true, draft: [] });
  });

  it("the reconstructed -e frame (SGR 2 on the hint) is empty by dim styling", () => {
    const p = pane("echo-placeholder.ansi.txt");
    expect(p).toContain(`\x1b[2m${HINT}`);
    expect(museInputBox(p)?.rows).toEqual([]);
    expect(verdict(p)).toEqual({ busy: false, idle: true, draft: [] });
  });

  it("a prefix of the hint is typed text", () => {
    expect(verdict(pane("echo-placeholder-prefix.pane.txt"))).toEqual({
      busy: false, idle: false, draft: ["Type @ to search"],
    });
  });

  it("the hint plus extra characters is typed text", () => {
    expect(verdict(pane("echo-placeholder-extra.pane.txt"))).toEqual({
      busy: false, idle: false, draft: [`${HINT} please`],
    });
  });

  it("the isolated real draft stays a draft", () => {
    expect(backend.inputDraft(pane("echo-draft.pane.txt"))?.rows).toEqual(["a real user draft"]);
  });

  it.each(OTHER_HINTS)("catalog hint %s is empty", hint => {
    const p = withComposer(pane("echo-idle.pane.txt"), hint);
    expect(verdict(p)).toEqual({ busy: false, idle: true, draft: [] });
  });

  it("dim text that is not a known hint is still empty (placeholder styling)", () => {
    const idleE = pane("echo-idle.ansi.txt");
    const p = idleE.replace("\x1b[0m❯", "\x1b[0m❯ \x1b[2mnot a catalog hint");
    expect(p).toContain("\x1b[2mnot a catalog hint");
    expect(verdict(p)).toEqual({ busy: false, idle: true, draft: [] });
  });

  it("the same words without dim, when not an exact catalog string, stay a draft", () => {
    const p = withComposer(pane("echo-idle.pane.txt"), "not a catalog hint");
    expect(verdict(p)).toEqual({ busy: false, idle: false, draft: ["not a catalog hint"] });
  });

  it("truecolour SGR 38;2 on typed text is not faint, so it stays a draft", () => {
    const p = pane("echo-idle.ansi.txt").replace("\x1b[0m❯", "\x1b[0m❯ \x1b[38;2;128;128;128mlooks grey but is typed");
    expect(verdict(p)).toEqual({ busy: false, idle: false, draft: ["looks grey but is typed"] });
  });

  it("1.4.11 echo-idle is still empty", () => {
    const p = readFileSync(join(process.cwd(), "tests/fixtures/muse-1.4.11/echo-idle.pane.txt"), "utf8");
    expect(verdict(p)).toEqual({ busy: false, idle: true, draft: [] });
  });
});

describe("Muse 1.4.12 faint-placeholder debug log (#2520)", () => {
  const ownerA = new MuseBackend("/tmp/agend-muse-1412-debug-a");
  const ownerB = new MuseBackend("/tmp/agend-muse-1412-debug-b");
  afterEach(() => {
    ownerA.setPlaceholderDebug();
    ownerB.setPlaceholderDebug();
  });

  it("logs the text and SGR once when a faint placeholder is classified as empty", () => {
    const seen: Array<{ text: string; sgr: string }> = [];
    ownerA.setPlaceholderDebug(rec => { seen.push(rec); });
    const p = pane("echo-placeholder.ansi.txt");
    expect(ownerA.inputDraft(p)?.rows).toEqual([]);
    expect(ownerA.inputDraft(p)?.rows).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toBe(HINT);
    expect(seen[0]!.sgr).toContain("\x1b[2m");
    expect(seen[0]!.sgr).toContain(HINT);
  });

  it("does not log a catalog match without SGR (production capture-pane -p)", () => {
    const seen: Array<{ text: string; sgr: string }> = [];
    ownerA.setPlaceholderDebug(rec => { seen.push(rec); });
    expect(ownerA.inputDraft(pane("echo-placeholder.pane.txt"))?.rows).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("logs a faint non-catalog placeholder so a live occurrence leaves a fixture", () => {
    const seen: Array<{ text: string; sgr: string }> = [];
    ownerA.setPlaceholderDebug(rec => { seen.push(rec); });
    const p = pane("echo-idle.ansi.txt").replace("\x1b[0m❯", "\x1b[0m❯ \x1b[2mnot a catalog hint");
    expect(ownerA.inputDraft(p)?.rows).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toBe("not a catalog hint");
    expect(seen[0]!.sgr).toContain("\x1b[2mnot a catalog hint");
  });

  it("another backend does not steal the first logger or reset its once-set", () => {
    const aSeen: Array<{ text: string; sgr: string }> = [];
    const bSeen: Array<{ text: string; sgr: string }> = [];
    ownerA.setPlaceholderDebug(rec => { aSeen.push(rec); });
    const p = pane("echo-placeholder.ansi.txt");
    expect(ownerA.inputDraft(p)?.rows).toEqual([]);
    expect(aSeen).toHaveLength(1);
    ownerB.setPlaceholderDebug(rec => { bSeen.push(rec); });
    expect(ownerA.inputDraft(p)?.rows).toEqual([]);
    expect({ a: aSeen.length, b: bSeen.length }).toEqual({ a: 1, b: 0 });
    expect(ownerB.inputDraft(p)?.rows).toEqual([]);
    expect({ a: aSeen.length, b: bSeen.length }).toEqual({ a: 1, b: 1 });
  });

  it("two Daemon constructors keep the faint-placeholder log on the owner", () => {
    const dirs: string[] = [];
    const make = (name: string) => {
      const instanceDir = mkdtempSync(join(tmpdir(), `agend-muse-ph-${name}-`));
      dirs.push(instanceDir);
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const muse = new MuseBackend(instanceDir);
      new Daemon(name, {
        working_directory: "/tmp",
        restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
        context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
        log_level: "silent",
      } as any, instanceDir, false, muse, undefined, { child: () => logger } as any);
      return { backend: muse, logger };
    };
    try {
      const a = make("a");
      const p = pane("echo-placeholder.ansi.txt");
      expect(a.backend.inputDraft(p)?.rows).toEqual([]);
      const b = make("b");
      expect(a.backend.inputDraft(p)?.rows).toEqual([]);
      expect({ a: a.logger.debug.mock.calls.length, b: b.logger.debug.mock.calls.length }).toEqual({ a: 1, b: 0 });
      expect(a.logger.debug.mock.calls[0]![0]).toEqual(expect.objectContaining({ text: HINT }));
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  });
});
