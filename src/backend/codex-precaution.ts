/** Codex rust-v0.169.0 precaution UI. Findings stay in the terminal; only code-owned labels leave it. */
import { createHash } from "node:crypto";
import type { RemoteCardOption, RemoteQuestionCard } from "./types.js";
import { t } from "../locale.js";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const STOPPED = "Chat stopped as a precaution";
const ACK = "Acknowledge findings and continue";
const ROOT = ["Review findings", "Agent command center", "New chat", "Resume another chat"];
const FALLBACK = ["New chat", "Agent command center", "Resume another chat"];
const CONFIRM = [ACK, "Back"];
const LABELS = [...ROOT, ...FALLBACK, ...CONFIRM];
const startsLabel = (fragment: string) => LABELS.some(label => label === fragment || label.startsWith(fragment + " "));
export type CodexPrecautionStage = "root" | "stopped" | "confirmation" | "report";
export interface CodexPrecaution { stage: CodexPrecautionStage; card: RemoteQuestionCard }

export function codexPrecaution(pane: string): CodexPrecaution | null {
  if (!pane || pane.length > 128_000) return null;
  const text = pane.replace(ANSI, "").replace(/\r/g, "");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return null;
  const rows = text.split("\n").map(row => row.trimEnd());
  while (rows.length && !rows.at(-1)) rows.pop();
  const make = (stage: CodexPrecautionStage, options: RemoteCardOption[], cursor: number | null, identityRows: string[]) => ({ stage,
    card: { kind: "question" as const, identity: createHash("sha256").update(`codex-precaution:${stage}\n${identityRows.join("\n")}`).digest("hex"),
      title: "Codex", question: t(stage === "stopped" ? "codex.precaution.stopped" : "codex.precaution.summary"), page: "options" as const, options,
      freeText: false, cursor, typed: null, rowWidth: Math.max(...rows.map(r => r.length)), noSkip: true as const,
      webOnly: true as const, humanOnly: true as const } });
  const option = (n: number, key: string, row: number, submitKey?: "q"): RemoteCardOption => ({
    n, title: t(key), recommended: false, description: null, row, ...(submitKey ? { submitKey } : {}),
  });
  // Static pager owns the whole screen and its two final navigation rows. Never match a report quoted above a composer.
  if (/^\s*q\s+close$/.test(rows.at(-1) ?? "")
      && /^\s*↑\/↓ to scroll\s*·\s*pgup\/pgdn to page\s*·\s*home\/end to jump$/.test(rows.at(-2) ?? "")
      && /^\s*(?:\/\s*)?What we detected\s*$/.test(rows[0] ?? "")) {
    return make("report", [option(1, "codex.precaution.back", 0, "q")], 0, rows);
  }
  let heading = -1, headingColumn = -1, stopped = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const match = /(Chat paused as a precaution|Chat stopped as a precaution)$/.exec(rows[i]);
    if (match) { heading = i; headingColumn = match.index; stopped = match[1] === STOPPED; break; }
  }
  if (heading < 0) return null;
  // The selected row establishes the live popup's column. A torn redraw may leave old composer text to its left.
  const selected = rows.slice(heading + 1).flatMap((row, i) => {
    const m = /[›❯] \d\. (\S.*)$/.exec(row);
    return m && startsLabel(m[1]) ? [{ at: heading + 1 + i, column: m.index }] : [];
  });
  if (selected.length !== 1) return null;
  const column = selected[0].column;
  if (column > headingColumn || headingColumn - column > 4) return null;
  const region = rows.slice(heading + 1).map(row => row.slice(column));
  const first = region.findIndex(row => {
    const m = /^(?:[›❯] |  )(?:(?:\d\. )| {3})(\S.*)$/.exec(row);
    return m !== null && startsLabel(m[1]);
  });
  if (first < 0) return null;
  const labels: string[] = [], numbers: Array<number | null> = [], identityRows = [...rows];
  let cursor: number | null = null;
  for (let i = first; i < region.length; i++) {
    const row = region[i];
    if (!row.trim()) continue;
    const m = /^([›❯] |  )(?:(\d)\. | {3})(\S.*)$/.exec(row);
    if (m && startsLabel(m[3])) {
      if (m[1].trim()) cursor = labels.length;
      numbers.push(m[2] ? Number(m[2]) : null); labels.push(m[3]);
      const at = heading + 1 + i;
      identityRows[at] = rows[at].slice(0, column) + "  " + row.slice(2);
    } else if (/^ {5,}\S/.test(row) && labels.length) {
      labels[labels.length - 1] += " " + row.trim();
    } else return null;
  }
  const same = (want: string[]) => JSON.stringify(labels) === JSON.stringify(want);
  if (cursor === null) return null;
  if (!stopped && same(ROOT) && numbers.every((n, i) => n === i + 1)) {
    return make("root", [option(1, "codex.precaution.review", 0)], cursor, identityRows);
  }
  if (stopped && same(FALLBACK) && numbers.every((n, i) => n === i + 1)) return make("stopped", [{ ...option(1, "codex.precaution.new_chat", 0),
    confirmation: { title: t("codex.precaution.new_chat"), message: t("codex.precaution.new_chat_confirm"), confirmLabel: t("codex.precaution.new_chat") } }], cursor, identityRows);
  if (!stopped && same(CONFIRM)) {
    if (numbers[0] === 1 && numbers[1] === 2) return make("confirmation", [option(1, "codex.precaution.ack", 0), option(2, "codex.precaution.back", 1)], cursor, identityRows);
    // Disabled rows have no shortcut; Back is renumbered to 1. Never offer the disabled acknowledgement.
    if (numbers[0] === null && numbers[1] === 1 && cursor === 1) return make("confirmation", [option(1, "codex.precaution.back", 1)], cursor, identityRows);
  }
  return null;
}
