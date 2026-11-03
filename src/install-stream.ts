/**
 * M-2281 (#2980): the installer's output, live, in the chat that asked `/login` to install a CLI. No page shows the
 * `agend-login-<backend>` window (it is not an instance), so the chat is where its progress is seen.
 *
 * One message, edited in place: the last INSTALL_STREAM_LINES lines of the window, ANSI stripped and secrets masked
 * (dialogScreenText — the whole capture is masked before its bottom is kept), under INSTALL_STREAM_BYTES so it fits
 * a Discord (2000) or Telegram (4096) message. At most one edit per INSTALL_STREAM_EDIT_MIN_MS, one in flight, none
 * for an unchanged frame. The frames come from the session's own poll capture — nothing here reads the pane.
 *
 * Fire-and-forget from the poll: update() only records the frame and arms a timer. finish() stops the edits and
 * writes the final frame (success / failed / timed out / cancelled) over the same message.
 */
import { dialogScreenText } from "./dialog-screen-text.js";

export const INSTALL_STREAM_LINES = 15;
export const INSTALL_STREAM_BYTES = 1_500;
export const INSTALL_STREAM_EDIT_MIN_MS = 5_000;

export interface InstallStreamSink {
  /** Post the message (its plain status line); its id is what the edits change. */
  send(text: string): Promise<{ messageId: string } | undefined>;
  /** Replace the message's text: a code block under the status line, in the stream's style (markdown or html). */
  edit(messageId: string, text: string): Promise<void>;
  warn?(message: string, err: unknown): void;
}

export interface InstallStreamClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: InstallStreamClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * The window's own text, without what tmux adds to it: a dead pane's "Pane is dead (status N, <date>)" line (drawn on
 * the bottom row, below a screenful of blank rows), and runs of blank rows collapsed to one — else the last lines of a
 * finished install would be blanks and that line.
 */
export function installerOutput(pane: string): string {
  return pane.replace(/^Pane is dead\b.*$/gm, "").replace(/\n(?:[ \t]*\n){2,}/g, "\n\n");
}

/**
 * How a frame is written: "markdown" (a fenced code block — Discord) or "html" (Telegram's own `<pre>`: its markdown
 * conversion keeps a fence as literal backticks).
 */
export type InstallFrameStyle = "markdown" | "html";

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The window's last lines as a code block under a status line; just the status line when there are none. */
export function renderInstallFrame(header: string, pane: string, style: InstallFrameStyle = "markdown"): string {
  const body = dialogScreenText(installerOutput(pane), { lines: INSTALL_STREAM_LINES, bytes: INSTALL_STREAM_BYTES });
  if (!body) return style === "html" ? escapeHtml(header) : header;
  // HTML: everything escaped, the only tag is ours. Markdown: a fence inside the output would close the block early,
  // so its backticks become look-alikes.
  return style === "html"
    ? `${escapeHtml(header)}\n<pre>${escapeHtml(body)}</pre>`
    : `${header}\n\`\`\`\n${body.replace(/`/g, "ˋ")}\n\`\`\``;
}

export class InstallStream {
  private messageId: string | undefined;
  private shown = "";
  private wanted = "";
  private pane = "";
  private lastAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly sink: InstallStreamSink,
    private readonly header: string,
    private readonly clock: InstallStreamClock = realClock,
    private readonly editMinMs = INSTALL_STREAM_EDIT_MIN_MS,
    private readonly style: InstallFrameStyle = "markdown",
  ) {}

  /** A new capture of the window. Never awaits; nothing is posted until the window shows something. */
  update(pane: string): void {
    if (this.closed) return;
    this.pane = pane;
    const frame = renderInstallFrame(this.header, pane, this.style);
    if (frame === renderInstallFrame(this.header, "", this.style) && this.messageId === undefined) return;
    this.wanted = frame;
    this.schedule();
  }

  /** Stop editing and write the final frame (the last capture, unless a later one is given) over the message. */
  async finish(header: string, pane?: string): Promise<void> {
    this.closed = true;
    if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; }
    await this.inFlight;
    const frame = renderInstallFrame(header, pane ?? this.pane, this.style);
    // Nothing was ever shown: the result message says it all.
    if (this.messageId === undefined && frame === renderInstallFrame(header, "", this.style)) return;
    // The final edit keeps the rate too: it waits out what is left of the interval rather than skip it.
    const wait = this.lastAt + this.editMinMs - this.clock.now();
    if (wait > 0) await new Promise<void>(resolve => this.clock.setTimeout(resolve, wait));
    await this.write(frame, header);
  }

  private schedule(): void {
    if (this.timer !== null || this.inFlight || this.wanted === this.shown) return;
    const delay = Math.max(0, this.lastAt + this.editMinMs - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.closed) return;
      const frame = this.wanted;
      this.inFlight = this.write(frame, this.header).finally(() => {
        this.inFlight = null;
        if (!this.closed) this.schedule();
      });
    }, delay);
  }

  /** `header`: the frame's status line as plain text — what a new message is first posted as. */
  private async write(frame: string, header: string): Promise<void> {
    if (frame === this.shown) return;
    this.lastAt = this.clock.now();
    try {
      if (this.messageId === undefined) {
        // Posted as its plain status line, and every frame goes in by an edit: the message is then one kind from start
        // to end (Telegram posts a text with a code block as a rich message, but edits text with HTML).
        const sent = await this.sink.send(header);
        if (!sent?.messageId) return;
        this.messageId = sent.messageId;
        await this.sink.edit(this.messageId, frame);
      } else {
        await this.sink.edit(this.messageId, frame);
      }
      this.shown = frame;
    } catch (err) {
      // A refused edit (rate limit, a reconnect) is tried again with the next frame, after the interval.
      this.sink.warn?.("install output edit failed", err);
    }
  }
}
