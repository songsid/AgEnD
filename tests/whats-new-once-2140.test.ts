/**
 * #2140: the what's-new notice was sent again before almost every message on long-lived Claude sessions. The cause, on
 * the real proof path: a system paste has no unique id, so the only pane evidence that it was submitted is its opening
 * (pastedTextSignature: the first 24 characters of its first line) appearing on the screen more often than before. A
 * session that began long ago gets every entry since then — 4.4 KB, ~45 rows at the default 120 columns — so once
 * Claude paints the submitted message and its reply, that opening line has scrolled above the 36 captured rows: the
 * paste is "unproven", deliverMessage returns false, and the notice stayed pending (fixed in daemon.ts: a notice whose
 * paste reached the pane is recorded). A short notice keeps its head on the screen and is proven — which is why only
 * the long-lived sessions repeated. Nothing here starts a CLI or a tmux server: screens are built from a recorded
 * Claude 2.1.293 box (the fixture) and the real box reader.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { readClaudeInputBox } from "../src/backend/claude-code.js";
import { AGENT_WHATS_NEW, whatsNewNotice } from "../src/agent-whats-new.js";

const FIX = join(__dirname, "fixtures");
const COLS = 120, ROWS = 36;                                   // tmux-manager.ts DEFAULT_TMUX_LOGICAL_SIZE
const roots: string[] = [];
afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The recorded empty box and footer of a Claude screen, as the bottom of every screen built here. */
const FRAME = readFileSync(join(FIX, "claude-2.1.293-after-submit.pane.txt"), "utf8").replace(/\n+$/, "").split("\n").slice(-5);
/** A user message as Claude's transcript shows it: "❯ " then the text wrapped to the pane width. */
function asUserMessage(text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    let rest = (i === 0 ? "❯ " : "  ") + line;
    while (rest.length > COLS) { out.push(rest.slice(0, COLS)); rest = "  " + rest.slice(COLS); }
    out.push(rest);
  });
  return out;
}
/** What capture-pane returns: the last ROWS rows of the transcript above the box. */
const screen = (transcript: string[]) => [...transcript, "", ...FRAME].slice(-ROWS).join("\n");

function claudeDaemon() {
  const dir = mkdtempSync(join(tmpdir(), "agend-2140-")); roots.push(dir);
  const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
  return new Daemon("worker", {
    working_directory: dir, log_level: "error", backend: "claude-code",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { max_age_hours: 0, grace_period_ms: 600_000 },
  } as never, join(dir, "worker"), false,
  { binaryName: "claude", getReadyPattern: () => /❯/, readInputRow: readClaudeInputBox } as any, undefined as any, logger) as any;
}

async function proofFor(notice: string): Promise<string> {
  const d = claudeDaemon();
  const earlier = ["● An earlier reply.", ""];
  const before = screen(earlier);
  const after = screen([...earlier, ...asUserMessage(notice), "", "● Noted.", ""]);
  const signature = d.submissionSignature(notice);
  expect(signature.unique, "a system paste carries no unique id").toBe(false);
  const baseline = d.paneEvidence(before, signature);
  d.tmux = { capturePane: async () => after };
  return d.confirmSubmitted(signature, baseline);
}

describe("#2140: why the notice was never confirmed on long-lived Claude sessions", () => {
  it("the box of every screen here is read and empty (the recorded frame)", () => {
    expect(readClaudeInputBox(screen(["● x"]))).toMatchObject({ text: "", collapsedPastes: 0 });
  });
  it("a long notice (every entry since an old session began): submitted, read and answered — yet unproven, its head scrolled away", async () => {
    const notice = whatsNewNotice("2.3.0-beta.5", AGENT_WHATS_NEW);
    expect(asUserMessage(notice).length, "taller than the captured screen").toBeGreaterThan(ROWS);
    expect(await proofFor(notice)).toBe("unproven");
  });
  it("a short notice (a session that began recently): its head stays on the screen — proven", async () => {
    const notice = whatsNewNotice("2.3.0-beta.5", AGENT_WHATS_NEW.slice(-1));
    expect(asUserMessage(notice).length).toBeLessThan(ROWS - 10);
    expect(await proofFor(notice)).toBe("submitted");
  });
});
