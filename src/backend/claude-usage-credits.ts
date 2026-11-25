/**
 * M-3757 (Claude Code 2.1.332): the usage-credits prompt Claude shows before a turn on a model its plan bills to usage
 * credits (Fable on Pro and Team plans, behind the server flag tengu_saffron_lattice). Captured live on 2.1.332:
 *
 *      Fable 5.2 now uses usage credits
 *      Fable 5.2 runs on usage credits, purchased separately from your plan.
 *      Learn more: https://support.claude.com/…
 *      ❯ Switch to Opus 5.5 and continue
 *        Continue with Fable 5.2
 *      Enter to confirm · Esc to cancel
 *
 * Its options have no numbers and its focus starts on the switch, so an Enter meant for a delivery would change the
 * agent's model. AgEnD never answers it: the turn is held and a person chooses on a Needs-you card (switching the model,
 * spending credits, or the dialog's own third choice). Its shapes (the 2.1.332 bundle's renderer): the title
 * "<model> now uses usage credits", "<model> now runs on usage credits", "You've reached your Fable limit" or, from the
 * /model picker, "Switch to <model>?"; the first option "Switch to <model> and continue", "Not now" or "No, keep my
 * current model"; then the credits option ("Continue with …", "Turn on usage credits and continue", "Buy usage credits",
 * "Request usage credits from your admin", …) and perhaps "Upgrade to Max or Ultra"; the footer last.
 */
import { createHash } from "node:crypto";
import type { RemoteCardOption, RemoteQuestionCard } from "./types.js";
import { t } from "../locale.js";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const FOOTER = /^[ \t]*Enter to confirm · Esc to cancel[ \t]*$/;
const TITLE = /^[ \t]*(\S.* now uses usage credits|\S.* now runs on usage credits|You've reached your Fable limit|Switch to \S.*\?)[ \t]*$/;
/** The first option: the one that keeps the turn off usage credits. */
const FIRST = /^(?:Switch to \S.* and continue|Not now|No, keep my current model)$/;
/** An option row: the cursor `❯` two columns in, or the label four columns in (the body sits two columns in). */
const OPTION = /^( {2})(❯| ) (\S.*)$/;
/** Choices that spend credits (or ask an admin for them): confirmed before the key goes. */
const SPENDS = /usage credits|^Continue with |^Yes, (?:re-enable|buy)|^Buy /;

export interface ClaudeUsageCreditsPrompt { title: string; options: string[]; cursor: number; card: RemoteQuestionCard }

export function claudeUsageCreditsPrompt(pane: string): ClaudeUsageCreditsPrompt | null {
  if (!pane || pane.length > 128_000) return null;
  const text = pane.replace(ANSI, "").replace(/\r/g, "");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return null;
  const rows = text.split("\n").map(row => row.trimEnd()).filter(row => row.trim() !== "");
  // Bottom-anchored: the footer is the pane's last row, so a transcript quoting the prompt is never one.
  if (rows.length < 4 || !FOOTER.test(rows[rows.length - 1]!)) return null;
  const options: string[] = [];
  let cursor = -1, i = rows.length - 2;
  for (; i >= 0 && options.length < 4; i--) {
    const m = OPTION.exec(rows[i]!);
    if (!m || TITLE.test(rows[i]!)) break;
    if (m[2] === "❯") { if (cursor >= 0) return null; cursor = options.length; }
    options.push(m[3]!);
  }
  options.reverse();
  if (cursor >= 0) cursor = options.length - 1 - cursor;
  if (options.length < 2 || options.length > 3 || cursor < 0 || !FIRST.test(options[0]!)) return null;
  // The title: within the dialog's few rows above the options, with "usage credits" (or the Fable limit) said there.
  const above = rows.slice(Math.max(0, i - 8), i + 1);
  let at = -1;
  for (let k = above.length - 1; k >= 0; k--) if (TITLE.test(above[k]!)) { at = k; break; }
  if (at < 0) return null;
  const title = TITLE.exec(above[at]!)![1]!;
  const body = above.slice(at + 1).map(row => row.trim());
  if (!/usage credits|Fable limit/.test([title, ...body].join(" "))) return null;
  const identity = createHash("sha256").update(`claude-usage-credits\n${title}\n${options.join("\n")}`).digest("hex");
  const cardOptions: RemoteCardOption[] = options.map((label, n) => ({
    n: n + 1, title: label, recommended: false, description: null, row: n,
    ...(SPENDS.test(label) ? { confirmation: { title: t("claude.usage_credits.confirm_title"), message: t("claude.usage_credits.confirm_message", label), confirmLabel: label } } : {}),
  }));
  const card: RemoteQuestionCard = {
    kind: "question", identity, title: "Claude Code", question: [title, ...body.filter(row => !/^Learn more:/.test(row))].join("\n"),
    page: "options", options: cardOptions, freeText: false, cursor, typed: null, rowWidth: Math.max(...rows.map(row => row.length)),
    noSkip: true, humanOnly: true,
  };
  return { title, options, cursor, card };
}
