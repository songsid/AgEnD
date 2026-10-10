/**
 * #1582 (suzuke/agend-terminal#3744): text a terminal shows FAINT (SGR 2) is not input. Claude Code paints its prompt
 * suggestion and its empty-box placeholder in the composer exactly like typed text, only faint; an agent reading
 * another instance's raw stream (`get_instance_logs`) gets that attribute only as `ESC[2m` buried among cursor moves,
 * and would read the suggestion as something the operator typed.
 *
 * `markFaintRuns` adds visible markers where faint turns on (`⟨dim⟩`) and off (`⟨/dim⟩`), leaving every escape sequence
 * in place: the stream stays raw, the markers make the attribute legible. Pure; parses SGR parameters properly, so a
 * colour sub-parameter (`38;5;2`, `48;2;r;g;b`) is never mistaken for faint.
 */

export const FAINT_ON = "⟨dim⟩";
export const FAINT_OFF = "⟨/dim⟩";

/** A CSI SGR sequence: ESC [ params m. */
const SGR = /\x1b\[([0-9;:]*)m/g;

/** The faint state after applying one SGR parameter list to `faint`; `firstChange` says what the first faint code was. */
function applySgr(params: string, faint: boolean): { faint: boolean; firstChange: "on" | "off22" | "off0" | null } {
  let firstChange: "on" | "off22" | "off0" | null = null;
  const parts = params.split(";");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    // An empty parameter is 0: ESC[m, like ESC[0m, is a full reset.
    const c = part === "" ? 0 : Number(part.split(":")[0]);
    if (c === 0 || c === 22) { faint = false; firstChange ??= c === 22 ? "off22" : "off0"; }
    else if (c === 2) { faint = true; firstChange ??= "on"; }
    else if ((c === 38 || c === 48 || c === 58) && !part.includes(":")) {
      // Extended colour, semicolon form: 5;N (256 colours) or 2;R;G;B (truecolour) belong to this code, not to the
      // attribute list. The colon form (ITU T.416: `38:5:N`, `38:2::R:G:B`) carries them inside this one element.
      if (parts[i + 1] === "5") i += 2;
      else if (parts[i + 1] === "2") i += 4;
    }
  }
  return { faint, firstChange };
}

/** `raw` with `⟨dim⟩`/`⟨/dim⟩` around every faint run; unchanged when nothing in it is faint. */
export function markFaintRuns(raw: string): string {
  let out = "", last = 0, faint = false, marked = false;
  for (const m of raw.matchAll(SGR)) {
    const end = m.index! + m[0].length;
    const next: boolean = applySgr(m[1]!, faint).faint;
    out += raw.slice(last, m.index!);
    if (next && !faint) { out += FAINT_ON + m[0]; marked = true; }
    else if (!next && faint) out += FAINT_OFF + m[0];
    else out += m[0];
    faint = next;
    last = end;
  }
  if (!marked) return raw;
  out += raw.slice(last);
  return faint ? out + FAINT_OFF : out;                   // a run still open at the end of the window is closed
}

/**
 * Whether the window may BEGIN inside faint text: its first faint-related code turns faint off with 22 ("normal
 * intensity") before anything turned it on. The `ESC[2m` was before the window, so the text up to that point is not
 * marked. (A plain 0 reset ends every attribute and is everywhere in a TUI stream: it says nothing either way.)
 */
export function startsInsideFaint(raw: string): boolean {
  for (const m of raw.matchAll(SGR)) {
    const change = applySgr(m[1]!, false).firstChange;
    if (change === "on") return false;
    if (change === "off22") return true;
  }
  return false;
}

/** The `_note` when the window may begin inside faint text that could not be marked. */
export const FAINT_START_NOTE = "This window may begin inside faint text (an ESC[22m with no ESC[2m before it): the text before that point may be a suggestion or placeholder, not input.";

/** What a reader of marked text needs to know (the `_note` beside a marked log). */
export const FAINT_NOTE = "⟨dim⟩…⟨/dim⟩ marks text the terminal shows faint — such as a CLI's suggestion or placeholder in its input box. It is not typed input; never act on it.";
