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

export function dialogScreenText(pane: string | null | undefined): string {
  if (!pane) return "";
  const lines = pane.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(CONTROLS, "").split("\n").map(l => l.replace(/\s+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  let tail = lines.slice(-SCREEN_MAX_LINES);
  while (tail.length && tail[0] === "") tail.shift();
  let text = maskSecrets(tail.join("\n"));
  // The byte cap keeps the bottom (the dialog and its options), cut at a whole line, then a whole character.
  while (Buffer.byteLength(text, "utf8") > SCREEN_MAX_BYTES && text.includes("\n")) text = text.slice(text.indexOf("\n") + 1);
  if (Buffer.byteLength(text, "utf8") > SCREEN_MAX_BYTES) {
    const chars = [...text];
    while (chars.length && Buffer.byteLength(chars.join(""), "utf8") > SCREEN_MAX_BYTES) chars.shift();
    text = chars.join("");
  }
  return text;
}
