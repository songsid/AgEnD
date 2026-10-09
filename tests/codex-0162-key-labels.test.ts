/**
 * Codex 0.162 labels Control as `^` on Linux and `⌃` on macOS, where 0.160 wrote `ctrl+` (codex-rs/tui `key_hint.rs`
 * MODIFIER_LABELS). Two of AgEnD's hold-only screens are anchored on footers drawn from those labels:
 *   session lock   `r retry   f fork   esc/ctrl+c/q exit`   →  `esc/^c/q exit`
 *   resume cwd     `enter continue · esc use session · ctrl+c quit`  →  `^c quit`
 * On 0.162 the lock screen matched nothing (no hold at all), and the cwd picker fell to the generic selection hold.
 *
 * Fixtures are live captures from the codex version audit (scripts/manual/codex-version-audit): a second codex on
 * the same launch command as a running one (the lock), and `codex resume --last` from a worktree whose sibling holds
 * the newer session (the picker). Only the scratch paths are replaced (/home/user/project, /home/user/project-b).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.pane.txt`, import.meta.url), "utf8");
const backend = new CodexBackend(mkdtempSync(join(tmpdir(), "agend-0162-keys-")));
const tables = [["runtime", backend.getRuntimeDialogs()], ["startup", backend.getStartupDialogs()]] as const;
const firstActive = (table: readonly any[], pane: string) => table.find(d => (d.isActive ? d.isActive(pane) : d.pattern.test(pane)));
const LOCK = "Codex session is open in another process (thread lock) — close the other one and press r, or fork manually";
const CWD = "Codex resume selected a session from another directory (sibling git worktree) — needs a human choice";

describe("codex key labels: `ctrl+c` (≤0.160), `^c` (0.162 Linux), `⌃c` (0.162 macOS)", () => {
  it.each([
    ["0.160.0 live", "codex-0160-session-lock", (p: string) => p],
    ["0.162.0 live", "codex-0162-session-lock", (p: string) => p],
    ["0.162 macOS label", "codex-0162-session-lock", (p: string) => p.replace("esc/^c/q exit", "esc/⌃c/q exit")],
  ])("the session-lock screen (%s) is held as the lock, never keyed", (_name, name, edit) => {
    const pane = edit(fixture(name));
    for (const [table, dialogs] of tables) {
      const hit = firstActive(dialogs, pane);
      expect(hit?.description, table).toBe(LOCK);
      expect(hit?.holdOnly, table).toBe(true);
      expect(hit?.keys, table).toEqual([]);
    }
  });

  it.each([
    ["0.160.0 live", "codex-0160-resume-cwd-picker", (p: string) => p],
    ["0.162.0 live", "codex-0162-resume-cwd-picker", (p: string) => p],
    ["0.162 macOS label", "codex-0162-resume-cwd-picker", (p: string) => p.replace("· ^c quit", "· ⌃c quit")],
  ])("the resume working-directory picker (%s) is held as that picker, not as an unknown selection", (_name, name, edit) => {
    const pane = edit(fixture(name));
    for (const [table, dialogs] of tables) {
      const hit = firstActive(dialogs, pane);
      expect(hit?.description, table).toBe(CWD);
      expect(hit?.holdOnly, table).toBe(true);
    }
  });

  it("the live 0.162 captures carry the new labels (so the cases above test them)", () => {
    expect(fixture("codex-0162-session-lock")).toMatch(/esc\/\^c\/q exit {3}\^t transcript\s*$/m);
    expect(fixture("codex-0162-resume-cwd-picker")).toMatch(/enter continue · esc use session · \^c quit\s*$/m);
  });

  it.each([
    ["no Control key at all", "esc/^c/q exit", "esc/c/q exit"],
    ["another modifier", "esc/^c/q exit", "esc/alt+c/q exit"],
    ["a doubled label", "esc/^c/q exit", "esc/ctrl+^c/q exit"],
  ])("the lock footer still has to be the lock footer: %s", (_name, from, to) => {
    const pane = fixture("codex-0162-session-lock").replace(from, to);
    expect(pane).toContain(to);
    for (const [, dialogs] of tables) expect(firstActive(dialogs, pane)?.description).not.toBe(LOCK);
  });

  it("the cwd footer still has to be the cwd footer: another quit key is not it", () => {
    const pane = fixture("codex-0162-resume-cwd-picker").replace("· ^c quit", "· ^d quit");
    for (const [, dialogs] of tables) expect(firstActive(dialogs, pane)?.description).not.toBe(CWD);
  });
});
