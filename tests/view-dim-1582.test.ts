/**
 * #1582 (suzuke/agend-terminal#3744): Claude Code paints its prompt suggestion and empty-box placeholder in the composer
 * exactly like typed text, but dim (SGR 2). Captured live from 2.1.296 under the production launch
 * (tests/fixtures/claude-2.1.296-sgr/README.md).
 * - /view keeps them dim: ansiToHtml marks SGR 2 runs (and swaps colours for SGR 7, the cursor cell).
 * - The daemon reads the plain pane, where a suggestion IS box text — and that stays a non-event: no delivery decision
 *   treats it as a human draft, a strand, a queue or a dialog.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend, readClaudeInputBox } from "../src/backend/claude-code.js";
import { agendMessageInInput, inputShowsPastedText, pastedTextSignature } from "../src/pane-input-residue.js";

const UI = join(process.cwd(), "src", "ui");
const FIX = join(import.meta.dirname, "fixtures", "claude-2.1.296-sgr");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");
/** The composer row: the last row starting with `❯` (after any SGR prefix). */
const composerRow = (screen: string) => screen.split("\n").filter(row => /^(?:\x1b\[[0-9;]*m)*❯/.test(row)).at(-1)!;

function loadAnsi() {
  const view = readFileSync(join(UI, "shared", "panel-view.js"), "utf8");
  const section = view.slice(view.indexOf("const BASE = ["), view.indexOf("// ── The roster")).replace(/^export /gm, "");
  const c = vm.createContext({});
  vm.runInContext(section, c);
  return c as unknown as { ansiToHtml(t: string): string };
}

describe("/view keeps a CLI's dim text dim (SGR 2)", () => {
  it("the live suggestion is a data-dim run; the typed row has none", () => {
    const { ansiToHtml } = loadAnsi();
    const suggestion = ansiToHtml(composerRow(fixture("suggestion.ansi.txt")));
    expect(suggestion).toContain('<span class="ansi" data-dim>dd a correction note to that decision</span>');
    const placeholder = ansiToHtml(composerRow(fixture("placeholder.ansi.txt")));
    expect(placeholder).toContain('<span class="ansi" data-dim>ry &quot;fix lint errors&quot;</span>');
    const typed = ansiToHtml(composerRow(fixture("typed.ansi.txt")));
    expect(typed).toContain("please fix the bug and run tests");
    expect(typed).not.toContain("data-dim");
    expect(suggestion + placeholder + typed).not.toMatch(/style=/);
  });

  it("the cursor cell (SGR 7) is drawn reversed: the terminal's colours swapped when unset, the run's own when set", () => {
    const { ansiToHtml } = loadAnsi();
    expect(ansiToHtml(composerRow(fixture("suggestion.ansi.txt")))).toContain('<span class="ansi" data-fg="#000000" data-bg="#d0d0d0">a</span>');
    expect(ansiToHtml("\x1b[31;44;7mX\x1b[27mY\x1b[0m")).toBe(
      '<span class="ansi" data-fg="#2472c8" data-bg="#cd3131">X</span><span class="ansi" data-fg="#cd3131" data-bg="#2472c8">Y</span>');
  });

  it("22 (normal intensity) clears dim and bold; 0 clears dim and reverse", () => {
    const { ansiToHtml } = loadAnsi();
    expect(ansiToHtml("\x1b[1;2ma\x1b[22mb")).toBe('<span class="ansi" data-b data-dim>a</span>b');
    expect(ansiToHtml("\x1b[2;7ma\x1b[0mb")).toBe('<span class="ansi" data-fg="#000000" data-bg="#d0d0d0" data-dim>a</span>b');
  });

  it("app.css draws a dim run faint", () => {
    expect(readFileSync(join(UI, "shared", "app.css"), "utf8")).toMatch(/\.v-pre \.ansi\[data-dim\] \{ opacity: \.5; \}/);
  });
});

describe("the daemon's plain read: a suggestion in the box stays a non-event (live 2.1.296 frames)", () => {
  const b = new ClaudeCodeBackend("/nonexistent-1582");
  const emptied = (screen: string) => {
    const rows = screen.split("\n");
    let i = rows.length - 1;
    while (i > 0 && !rows[i]!.startsWith("❯")) i--;
    rows[i] = "❯ ";
    return rows.join("\n");
  };
  const verdicts = (screen: string) => ({
    ready: b.getReadyPattern().test(screen),
    busy: b.getBusyPattern().test(screen),
    startup: b.getStartupDialogs().filter(d => (d.isActive ? d.isActive(screen) : d.pattern.test(screen))).map(d => d.description),
    runtime: b.getRuntimeDialogs().filter(d => (d.isActive ? d.isActive(screen) : d.pattern.test(screen))).map(d => d.description),
    errors: b.getErrorPatterns().filter(p => p.pattern.test(screen)).map(p => p.type),
    quitBlocked: b.quitBlockedByDialog(screen),
  });

  it.each(["suggestion", "placeholder", "enter-on-suggestion"])("%s: every readiness, busy, dialog and error verdict equals the emptied box's", name => {
    const screen = fixture(`${name}.pane.txt`);
    expect(verdicts(screen)).toEqual(verdicts(emptied(screen)));
    expect(verdicts(screen)).toMatchObject({ ready: true, busy: false, startup: [], runtime: [], errors: [] });
  });

  it.each(["suggestion", "placeholder"])("%s: the box reads it as text, but it is no queue, no collapsed paste, no strand and no AgEnD message", name => {
    const box = readClaudeInputBox(fixture(`${name}.pane.txt`))!;
    expect(box.text.length).toBeGreaterThan(0);          // plain text cannot tell it from typing: hence the pins below
    expect(box.queued).toBeUndefined();
    expect(box.collapsedPastes).toBe(0);
    expect(agendMessageInInput(box.text)).toBe(false);
    expect(inputShowsPastedText(box.text, pastedTextSignature("[system:agend] A scheduled reminder fired"))).toBe(false);
    expect(inputShowsPastedText(box.text, "message_id:xmsg-1582")).toBe(false);
  });

  it("claude-code has no inputDraft: a dim suggestion can never become a 'foreign draft' that stops a delivery (#829)", () => {
    // Plain text cannot tell a suggestion from typing (see the fixtures). Giving claude-code an inputDraft reader would
    // turn every suggestion into a refused delivery — it needs the SGR-aware read this issue documents first.
    expect("inputDraft" in b).toBe(false);
  });
});
