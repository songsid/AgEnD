/**
 * codex 0.159 pane contract. Every fixture is a real 0.159.0 capture (paths
 * redacted; the /tmp-only "PATH aliases" banner above the header dropped).
 *
 * 0.159 drew the header without its box: `  >_ OpenAI Codex (v0.159.0)`
 * instead of `╭─╮ │ >_ OpenAI Codex │ │ model: loading │`. The resume-loading
 * guard only knew the boxed layout, so all 32 frames of a real 0.159 resume
 * read as idle with the guard off, while the composer was already drawn and
 * input was not yet live. The 32 frames reduce to the two fixtures below.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { PaneStateMachine } from "../src/daemon.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const pane = (name: string): string => readFileSync(join(fixtures, name), "utf8");
const backend = new CodexBackend("/tmp/agend-codex-0159-compat");
const resumeLoading = (p: string) => backend.getInputUnavailableTransients()
  .some(t => (t.isActive ? t.isActive(p) : t.pattern.test(p)));

const loading = pane("codex-0159-resume-loading.pane.txt");
const loadingCwd = pane("codex-0159-resume-loading-cwd.pane.txt");
const fresh = pane("codex-0159-fresh.pane.txt");
const busy = pane("codex-0159-busy.pane.txt");
const idle = pane("codex-0159-idle.pane.txt");

describe("codex 0.159 resume-loading guard", () => {
  it("holds input on both real 0.159 resume-loading frames", () => {
    expect(loading).toContain("     loading");
    expect(loadingCwd).not.toContain("     loading"); // the loading row is gone, the resume is not
    expect(resumeLoading(loading)).toBe(true);
    expect(resumeLoading(loadingCwd)).toBe(true);
  });

  it("still holds with the /tmp PATH-aliases banner above the header", () => {
    const banner = "WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary di\nr \"/tmp\" (codex_home: AbsolutePathBuf(\"/tmp/x\"))\n\n";
    expect(resumeLoading(banner + loading)).toBe(true);
  });

  it("releases on real fresh, busy and idle 0.159 panes", () => {
    for (const p of [fresh, busy, idle]) expect(resumeLoading(p)).toBe(false);
  });

  it("cannot be tripped by a transcript that quotes the loading screen", () => {
    // An assistant reply quoting the screen: same indented rows, but after a
    // transcript row and above a settled composer with its footer.
    const quoted = idle.replace("• OK", "• OK — you saw this while it loaded:\n  >_ OpenAI Codex (v0.159.0)\n     loading\n  Resuming session…");
    expect(quoted).toContain("  Resuming session…");
    expect(resumeLoading(quoted)).toBe(false);
    // Even with no footer below (a status_line without Context), a quote that
    // follows a transcript row is not the loading screen.
    const quotedNoFooter = quoted.replace(/\n {2}Context 99% left[^\n]*/, "");
    expect(quotedNoFooter).not.toContain("Context 99%");
    expect(resumeLoading(quotedNoFooter)).toBe(false);
    // Once the real header has scrolled away, a quote is the only header on
    // screen; the transcript row above it is what gives it away.
    const scrolled = "› what did the resume look like?\n• Like this:\n  >_ OpenAI Codex (v0.159.0)\n     loading\n  Resuming session…\n\n› Ask Codex to do anything\n\n";
    expect(resumeLoading(scrolled)).toBe(false);
    // Nothing may follow the composer on the loading screen (a footer means it settled).
    expect(resumeLoading(loading.trimEnd() + "\n  Context 100% left\n")).toBe(false);
  });
});

describe("codex 0.159 readiness", () => {
  it("reads the real fresh and idle panes as ready, and the working frame as busy", () => {
    expect(backend.getReadyPattern().test(fresh)).toBe(true);
    expect(backend.getReadyPattern().test(idle)).toBe(true);
    expect(backend.getBusyPattern().test(busy)).toBe(true);
    const machine = new PaneStateMachine(backend.getReadyPattern(), 60_000, 0, backend.getBusyPattern());
    expect(machine.observe(busy, 1_000, { settled: true }).state).toBe("working");
  });
});

describe("codex launch pins instant_interrupt off (0.159)", () => {
  it("adds -c features.instant_interrupt=false to every launch", () => {
    for (const skipResume of [true, false]) {
      const cmd = backend.buildCommand({
        workingDirectory: "/tmp", instanceDir: "/tmp/agend-codex-0159-compat", instanceName: "c", mcpServers: {}, skipResume,
      });
      expect(cmd).toContain(" -c features.instant_interrupt=false");
    }
  });
});
