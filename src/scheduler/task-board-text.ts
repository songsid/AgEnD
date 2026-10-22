/**
 * The task board as an agent reads it through the `task` tool (step 2, docs/design/task-board.md): plain text, one
 * line per card in lists, a card in a dozen short lines — what an instance needs to pick up work after a reset,
 * without JSON keys or empty fields eating its context.
 */
import { confirmerOf, personConfirms, wrapUpGap, type Card, type CardStatus, type MyWork, type Project, type ProjectStats, type TaskBoard } from "./task-board.js";

export const STATUS_WORD: Record<CardStatus, string> = {
  open: "to do", claimed: "in progress", blocked: "blocked", review: "waiting for the person", done: "done", cancelled: "cancelled",
};
/** A card's status in words: an agent's card in review waits for its dispatcher, not the person (#2434). */
const statusOf = (card: Pick<Card, "status" | "dispatcher">) => (card.status === "review" && !personConfirms(card) ? "waiting for confirmation" : STATUS_WORD[card.status]);

/** Text on one line, at most `max` characters. */
export function oneLine(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** "S-34 [in progress] Build the login API @dev-a" */
export function cardLine(card: Card, opts: { status?: boolean } = {}): string {
  return `${card.code}${opts.status === false ? "" : ` [${statusOf(card)}]`} ${card.title}${card.assignee ? ` @${card.assignee}` : ""}`;
}

/** One card: header, where it sits, its fields, its checklist, its sub tasks (a main task) and the comments new to its assignee. */
export function cardText(board: TaskBoard, card: Card): string {
  const lines: string[] = [];
  const kind = card.kind === "main" ? "main task" : "sub task";
  lines.push(`${card.code} ${kind} · ${card.title} [${statusOf(card)}]${card.assignee ? ` @${card.assignee}` : ""}${card.size ? ` size ${card.size}` : ""} v${card.version}`);
  const where: string[] = [];
  if (card.parent) {
    const main = board.findCard(card.parent);
    if (main) where.push(`main ${main.code} ${main.title}`);
  } else if (card.projectId !== null) {
    try { where.push(`project ${board.getProject(card.projectId).name}`); } catch { /* gone */ }
  }
  if (card.deps.length) {
    const unmet = new Set(board.unmetDeps(card).map((c) => c.code));
    where.push(`waits for ${card.deps.map((d) => board.codeOf(d)).map((c) => `${c}${unmet.has(c) ? "" : " (done)"}`).join(", ")}`);
  }
  if (card.dispatcher && card.dispatcher.name !== card.assignee) where.push(`dispatched by ${card.dispatcher.kind === "person" ? `the person (${card.dispatcher.name})` : card.dispatcher.name}`);
  // #2434: the person confirms the cards they handed out; an agent's card its dispatcher (or, nobody's, its assignee).
  const confirmer = confirmerOf(card);
  where.push(!card.needsReview ? "finish it yourself" : `${confirmer} confirms it`);
  lines.push(where.join(" · "));
  const gap = card.status === "review" ? wrapUpGap(card) : null;
  if (gap) lines.push(`before ${confirmer} confirms it: ${gapText(gap, card.kind === "main")} (fill in with update)`);
  if (card.goal) lines.push(`goal: ${card.goal}`);
  if (card.scope) lines.push(`scope: ${card.scope}`);
  if (card.acceptance.length) {
    const done = card.acceptance.filter((a) => a.done).length;
    lines.push(`${card.kind === "main" ? "definition of done" : "acceptance"} (${done}/${card.acceptance.length}):`);
    card.acceptance.forEach((a, i) => lines.push(` ${i + 1}.[${a.done ? "x" : " "}] ${a.text}`));
  }
  if (card.context) lines.push(`context: ${card.context}`);
  if (card.state) lines.push("state:", ...card.state.split("\n").filter((l) => l.trim()).map((l) => ` ${l.trim()}`));
  if (card.status === "blocked" && card.blockedReason) lines.push(`blocked on: ${card.blockedReason}`);
  if (card.result) lines.push(`result: ${card.result}`);
  if (card.kind === "main") {
    const subs = board.children(card.uuid).filter((k) => k.status !== "cancelled");
    if (subs.length) {
      const p = board.progress(card);
      const parts = (["done", "review", "claimed", "blocked", "open"] as const).filter((k) => p[k]).map((k) => `${STATUS_WORD[k]} ${p[k]}`);
      lines.push(`sub tasks ${p.done}/${p.total} (${parts.join(", ")}):`);
      for (const k of subs) lines.push(` ${cardLine(k)}${k.status === "blocked" && k.blockedReason ? ` — blocked on: ${oneLine(k.blockedReason, 80)}` : ""}`);
    }
  }
  // The comments: every one its assignee has not seen, and the latest few — a send-back's reason among them.
  const fresh = board.newComments(card);
  const seen = new Set(fresh.map((e) => e.id));
  const shown = [...board.entries(card.uuid, ["comment", "reject", "approve"], 5).filter((e) => !seen.has(e.id)), ...fresh].sort((a, b) => a.id - b.id);
  if (shown.length) {
    lines.push(fresh.length ? `comments (${fresh.length} new):` : "comments (latest):");
    for (const e of shown) {
      const tag = e.kind === "reject" ? " (sent back)" : e.kind === "approve" ? " (confirmed)" : "";
      lines.push(` ${e.author} ${e.at.slice(5, 16).replace("T", " ")}${tag}${seen.has(e.id) ? " [new]" : ""}: ${e.text}`);
    }
  }
  return lines.join("\n");
}

/** "3 definition-of-done items unchecked, no result". */
export function gapText(gap: { unchecked: number; noResult: boolean }, main: boolean): string {
  const items = gap.unchecked ? `${gap.unchecked} ${main ? "definition-of-done" : "acceptance"} item${gap.unchecked === 1 ? "" : "s"} unchecked` : "";
  return [items, gap.noResult ? "no result" : ""].filter(Boolean).join(", ");
}

/** `task mine`: an instance's work, a section per kind, one line per card; empty sections left out. */
export function myWorkText(board: TaskBoard, name: string, work: MyWork): string {
  const out: string[] = [];
  const section = (title: string, rows: string[]) => { if (rows.length) out.push(`${title}:`, ...rows.map((r) => ` ${r}`)); };
  const parentOf = (c: Card) => (c.parent ? ` (${board.codeOf(c.parent)})` : "");
  section("sent back to you", work.sentBack.map(({ card, entry }) => `${card.code} ${card.title} — ${entry.author}: ${oneLine(entry.text, 160)}`));
  section("in progress", work.doing.map((c) => `${c.code} ${c.title}${parentOf(c)}`));
  // Over its limit (a person moved them there); cards it opened for itself do not count (#2303).
  const over = board.overLimit(name);
  if (over) out.push(over.limit === 1
    ? ` ⚠ ${over.count} cards in progress: one at a time — finish one (or block it with a reason) before the next`
    : ` ⚠ ${over.count} cards in progress: at most ${over.limit} at a time — finish one (or block it with a reason) before the next`);
  section("blocked", work.blocked.map((c) => `${c.code} ${c.title} — on: ${oneLine(c.blockedReason, 120)}`));
  const waiting = (c: Card) => { const gap = wrapUpGap(c); return `${c.code} ${c.title}${gap ? ` — fill in before they confirm: ${gapText(gap, c.kind === "main")}` : ""}`; };
  section("waiting for the person's confirmation", work.review.filter(personConfirms).map(waiting));
  section("waiting for confirmation", work.review.filter((c) => !personConfirms(c)).map((c) => `${waiting(c)} — ${confirmerOf(c) === name ? "yours to confirm: move it to done" : `by ${confirmerOf(c)}`}`));
  // #2434: the cards it handed out that wait for its own confirmation (finish them: move to done, or back with a reason).
  section("for you to confirm", board.toConfirm(name).map((c) => `${c.code} ${c.title}${c.assignee ? ` @${c.assignee}` : ""} — move it to done, or back to claimed with what is missing`));
  section("ready to start", work.ready.map((c) => `${c.code} ${c.title}${parentOf(c)}${c.assignee ? "" : " (unassigned)"}`));
  section("waiting on dependencies", work.waiting.map(({ card, waitsFor }) => `${card.code} ${card.title} — waits for ${waitsFor.join(", ")}`));
  section("new comments", work.newComments.map(({ card, entries }) => `${card.code} ${card.title} — ${entries.length} from ${[...new Set(entries.map((e) => e.author))].join(", ")}`));
  section("main tasks you coordinate", work.mains.map(({ card, progress }) => `${card.code} ${card.title} [${STATUS_WORD[card.status]}] sub tasks ${progress.done}/${progress.total}${progress.blocked ? `, ${progress.blocked} blocked` : ""}`));
  return out.length ? `${name}'s work on the task board\n${out.join("\n")}` : `${name} has nothing on the task board. Cards assigned to you show up here.`;
}

/** `task projects`: one line per project (archived ones last), with its main tasks and what waits. */
export function projectsText(projects: Project[], stats: Record<string, ProjectStats>): string {
  if (!projects.length) return "No projects yet: a person creates them on the dashboard (Fleet › Tasks). A main task can be opened without one.";
  return projects.map((p) => {
    const st = stats[String(p.id)] ?? { mains: 0, percent: 0, waiting: 0, blocked: 0 };
    const counts = ` — ${st.mains} main tasks, ${st.percent}% done${st.waiting ? `, ${st.waiting} waiting for the person` : ""}${st.blocked ? `, ${st.blocked} blocked` : ""}`;
    return `${p.id} ${p.name}${p.archived ? " (archived)" : ""}${counts}${p.description ? ` · ${oneLine(p.description, 80)}` : ""}`;
  }).join("\n");
}

/** A write's answer: "ok M-3 in progress → waiting for the person (v8)", then what the board has to say. */
export function writeText(card: Card, notes: string[], from?: CardStatus): string {
  const head = from && from !== card.status
    ? `ok ${card.code} ${from === "review" ? statusOf({ ...card, status: from }) : STATUS_WORD[from]} → ${statusOf(card)} (v${card.version})`
    : `ok ${card.code} ${card.title} [${statusOf(card)}]${card.assignee ? ` @${card.assignee}` : ""} (v${card.version})`;
  const said = notes.filter((n) => n !== "no change");
  return [head, ...said].join("\n");
}
