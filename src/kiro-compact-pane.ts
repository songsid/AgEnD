/**
 * Board 907c7899: whether a /compact AgEnD wrote into a kiro instance's own pane has ended, read from that pane.
 * kiro records a compaction where AgEnD cannot tie it to the instance (a session log or store row shared with other
 * kiro sessions in the directory); its own pane can only be this instance's. Verified on kiro-cli 2.30.0
 * (tests/fixtures/kiro-2.30.0-compact-pane):
 *
 * - **Classic (`--legacy-ui`, V1).** The command is echoed (`2% > /compact`), a spinner says `Creating summary...`, and a
 *   compaction ends with kiro's own line "The conversation history has been replaced with this summary." An empty
 *   conversation answers "Conversation too short to compact." at once; Ctrl-C stops it and the prompt (`1% >`) comes
 *   back with nothing said. Either way nothing was compacted.
 * - **TUI (`--tui`, V2).** The command is not echoed. `• Compacting conversation...` shows while it runs and is replaced
 *   by the summary when it ends; "• Conversation too short to compact." shows for about ten seconds, then goes. Esc
 *   and Ctrl-C do not stop it (each such compaction still finished). A failure other than "too short" was not seen,
 *   so "done" here means the running line came and went — and only on a screen read as kiro's: no piece of that line
 *   anywhere in the look (a narrower pane wraps it, #1925 review) and the idle composer in view. Not "fewer than
 *   before": a piece from before can leave the bounded look while this one's stays, so a piece in view keeps it
 *   unknown — even an old one, until it scrolls away or the deadline ends the watch.
 * - **Anything else** (kiro V3, another layout) is not read: no follower is made for it.
 *
 * The follower starts from the pane just before the command's own write (the daemon holds its paste lock, so no other
 * input lands in between) and counts only what appears after it: an older /compact's lines never count. What can't be
 * told stays unknown (null); the caller's deadline then ends it — a compaction may be missed, never invented.
 */
export type KiroCompactUi = "legacy" | "tui";
export type KiroCompactOutcome = "done" | "not_compacted";

/** Lines of history each look reads: a summary is tens of lines; an older /compact this far up is never ours. */
export const KIRO_COMPACT_PANE_LINES = 1000;

const CLASSIC_ECHO = /^\s*\d+% > \/compact\s*$/;
const CLASSIC_PROMPT = /^\s*\d+% >/;
const CLASSIC_DONE = "The conversation history has been replaced with this summary.";
const TOO_SHORT = "Conversation too short to compact.";
const TUI_RUNNING = /^\s*•\s+Compacting conversation\.\.\.\s*$/;
const TUI_TOO_SHORT = /^\s*•\s+Conversation too short to compact\.\s*$/;
/** Any piece of the running line: its start, or its wrapped end on a row of its own. */
const TUI_RUNNING_PART = /^\s*(?:•\s+)?Compacting\b|^\s*conversation\.\.\.\s*$/;
/** The TUI's empty composer: the screen is kiro's own, not a dialog or another layout over it. */
const TUI_IDLE_COMPOSER = /ask a question or describe a task/;

const lines = (pane: string) => pane.split("\n");
const count = (all: string[], re: RegExp) => all.reduce((n, l) => n + (re.test(l) ? 1 : 0), 0);

export class KiroCompactPaneFollower {
  private readonly echoes: number;
  private readonly running: number;
  private readonly tooShort: number;
  private seenRunning = false;

  /** `before`: the pane (with KIRO_COMPACT_PANE_LINES of history) just before the command was written. */
  constructor(readonly ui: KiroCompactUi, before: string) {
    const all = lines(before);
    this.echoes = count(all, CLASSIC_ECHO);
    this.running = count(all, TUI_RUNNING);
    this.tooShort = count(all, TUI_TOO_SHORT);
  }

  /** One look at the pane (same history depth): how the command ended, or null while it runs or can't be told. */
  look(pane: string): KiroCompactOutcome | null {
    const all = lines(pane);
    if (this.ui === "legacy") {
      if (count(all, CLASSIC_ECHO) <= this.echoes) return null;              // ours is not on the pane (yet)
      let at = all.length - 1;
      while (at >= 0 && !CLASSIC_ECHO.test(all[at]!)) at--;
      const after = all.slice(at + 1).map(l => l.trim());
      if (after.includes(CLASSIC_DONE)) return "done";
      if (after.includes(TOO_SHORT)) return "not_compacted";
      return after.some(l => CLASSIC_PROMPT.test(l)) ? "not_compacted" : null; // the prompt is back with nothing said
    }
    if (count(all, TUI_TOO_SHORT) > this.tooShort) return "not_compacted";
    const running = count(all, TUI_RUNNING) > this.running;
    if (running) { this.seenRunning = true; return null; }
    if (!this.seenRunning || all.some(l => TUI_RUNNING_PART.test(l))) return null;   // may still be running, wrapped
    return all.some(l => TUI_IDLE_COMPOSER.test(l)) ? "done" : null;
  }
}
