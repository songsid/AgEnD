import { maskSecrets } from "./log-steps.js";

/**
 * M-2269: what a detected dialog or prompt looked like, for the web Log. Claude Code never writes its permission
 * dialogs, "Resume this conversation?" or limit banners to the transcript, and an alt-screen CLI leaves no tmux
 * scrollback: the capture the scan already took is the only record of them. Read-only bookkeeping — taken from that
 * capture, never a new one.
 *
 * The bottom of the screen (where a TUI draws its dialog), ANSI stripped, secrets masked, at most SCREEN_MAX_LINES
 * lines and SCREEN_MAX_BYTES UTF-8 bytes. Empty when there is nothing to show.
 */
export const SCREEN_MAX_LINES = 30;
export const SCREEN_MAX_BYTES = 2048;

// CSI / OSC / other ESC sequences, and the C0 controls that are not line structure.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * A line that is only base64 (16+ characters, PEM wraps at 64 — or shorter when rewrapped): the body of a key or
 * certificate whose BEGIN line may not even be on screen (scrolled off the top of the capture itself), so the
 * whole-capture mask above cannot see it. A dialog never needs such a line; it is masked whatever it is.
 */
const KEY_BODY = /^(\s*)[A-Za-z0-9+/]{16,}={0,2}\s*$/;
function maskKeyBody(line: string): string {
  const m = KEY_BODY.exec(line);
  return m && /[0-9+/]/.test(line) && /[A-Za-z]/.test(line) ? `${m[1]}[REDACTED]` : line;
}

/** M-2281: the same cleaning with other bounds (the live install view keeps fewer lines, under a chat message's size). */
export function dialogScreenText(pane: string | null | undefined, limits: { lines: number; bytes: number } = { lines: SCREEN_MAX_LINES, bytes: SCREEN_MAX_BYTES }): string {
  if (!pane) return "";
  const stripped = pane.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(CONTROLS, "");
  // #2967 review: mask the WHOLE capture before keeping its bottom — a private key whose BEGIN line sits above the cut
  // would otherwise leave its body and END below it, where no rule can tell them apart from text any more.
  const lines = maskSecrets(stripped).split("\n").map(l => maskKeyBody(l.replace(/\s+$/, "")));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const tail = lines.slice(-limits.lines);
  while (tail.length && tail[0] === "") tail.shift();
  let text = tail.join("\n");
  // The byte cap keeps the bottom (the dialog and its options), cut at a whole line, then a whole character.
  while (Buffer.byteLength(text, "utf8") > limits.bytes && text.includes("\n")) text = text.slice(text.indexOf("\n") + 1);
  if (Buffer.byteLength(text, "utf8") > limits.bytes) {
    const chars = [...text];
    while (chars.length && Buffer.byteLength(chars.join(""), "utf8") > limits.bytes) chars.shift();
    text = chars.join("");
  }
  return text;
}
