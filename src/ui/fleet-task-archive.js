// M-3668 (the user, 11-24): finished main tasks leave a project's board some days after they finish (the server's
// defaults.task_board.archive_after_days, default 3) and wait in its Archive list here — newest first, a page at a time,
// filtered by who had them; a card opens from it as from the board, and moving it to To do reopens it. The Done column
// shows its newest 20 at a time. A module of its own (a new URL): a tab holding an older fleet-tasks.js or
// fleet-task-common.js is never linked against a name it lacks.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { lang, register, t } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { StatusPill, Who, relTime } from "./fleet-task-common.js";

register("tasksArchive", {
  en: {
    link: "Archived · {0}", linkTip: "Finished more than {0} days ago: off the board, still found by search and by their number",
    title: "{0} · archived", lead: "Main tasks finished more than {0} days ago. Search finds them too, and a card's number opens it; move one to To do to reopen it.",
    who: "Assigned to", everyone: "Everyone", more: "Show more", none: "Nothing archived here.", noneWho: "Nothing archived for {0}.", failed: "The archive could not be read.",
    done: "Done {0}", cancelled: "Cancelled {0}", count: "{0} of {1}",
    week: "{0} done this week", weekArchived: "{0} archived", weekTip: "Main tasks done in the last 7 days. The archived ones are off the board: the header's Archived link lists them",
    showMore: "Show {0} more", doneShow: "Show", tag: "Archived", tagTip: "Finished more than {0} days ago: off the board, not deleted", tile: "{0} archived",
  },
  "zh-TW": {
    link: "已封存 · {0}", linkTip: "完成超過 {0} 天：已離開看板，仍可用搜尋或卡片編號找到",
    title: "{0} · 已封存", lead: "完成超過 {0} 天的主任務。搜尋也找得到，用卡片編號也能開啟；移回「待辦」即可重新開啟。",
    who: "負責", everyone: "所有人", more: "顯示更多", none: "這裡沒有封存的卡片。", noneWho: "{0} 沒有封存的卡片。", failed: "無法讀取封存清單。",
    done: "{0} 完成", cancelled: "{0} 取消", count: "{0} / {1}",
    week: "本週完成 {0} 張", weekArchived: "其中 {0} 張已封存", weekTip: "近 7 天完成的主任務。已封存的不在看板上，可從標題列的「已封存」查看",
    showMore: "再顯示 {0} 張", doneShow: "顯示", tag: "已封存", tagTip: "完成超過 {0} 天：已離開看板，沒有刪除", tile: "已封存 {0} 張",
  },
});

/** The Done column's page: its newest finished cards, this many more at a time. */
export const DONE_PAGE = 20;
/** Finished cards, the most recently finished first (when they finished, else their last change). */
export const newestDone = (cards) => [...cards].sort((a, b) => String(b.doneAt || b.updatedAt || "").localeCompare(String(a.doneAt || a.updatedAt || "")) || String(b.id).localeCompare(String(a.id)));

/**
 * The Done column's "this week" line: how many main tasks were done in the last 7 days, and how many of them are
 * archived ("48 done this week · 11 archived"). Two unbreakable parts: a narrow column wraps it only at the "·".
 */
export function weekLabel(stats) {
  const done = html`<span class="tb-nowrap">${t("tasksArchive.week", (stats && stats.doneWeek) || 0)}</span>`;
  return stats && stats.archivedWeek > 0 ? html`${done} · <span class="tb-nowrap">${t("tasksArchive.weekArchived", stats.archivedWeek)}</span>` : done;
}

/** A finish time as the Archive shows it: "Nov 21, 14:05" / "11月21日 14:05" (with the year when it isn't this year's). */
export function finishedAt(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) };
  return new Intl.DateTimeFormat(lang() === "zh-TW" ? "zh-TW" : "en", opts).format(d);
}

/** The board header's way to the Archive list (none when nothing is archived). */
export function ArchivedLink({ count, days, onOpen }) {
  if (!count) return null;
  return html`<button type="button" class="tb-link tb-archived-link" title=${t("tasksArchive.linkTip", days)} onClick=${onOpen}>${t("tasksArchive.link", count)}</button>`;
}

/** A search hit's or a card page's mark: the board has archived it. */
export function ArchivedTag({ days }) {
  return html`<span class="tb-tag" title=${t("tasksArchive.tagTip", days)}>${t("tasksArchive.tag")}</span>`;
}

/**
 * A project's archived main tasks (`project`: its id, or "none"), the most recently finished first; `fetchJson(url)`
 * reads the server's page (GET /ui/tasks/archive). Picking one opens it (`onOpen(card)`), as from the board.
 */
export function ArchiveDialog({ project, name, days, onOpen, onClose, fetchJson }) {
  const [who, setWho] = useState("");
  const [state, setState] = useState({ phase: "loading", cards: [], next: null, total: 0, assignees: [] });
  const seq = useRef(0);
  const load = async (before = null) => {
    const mine = ++seq.current;
    const q = new URLSearchParams({ project: String(project), limit: "50" });
    if (before) q.set("before", before);
    if (who) q.set("assignee", who);
    try {
      const d = await fetchJson(`/ui/tasks/archive?${q}`);
      if (mine !== seq.current) return;
      setState((s) => ({ phase: "ready", cards: before ? [...s.cards, ...d.cards] : d.cards, next: d.next || null, total: d.total || 0,
        assignees: Array.isArray(d.assignees) ? d.assignees : s.assignees }));
    } catch { if (mine === seq.current) setState((s) => ({ ...s, phase: "failed" })); }
  };
  useEffect(() => { setState((s) => ({ ...s, phase: "loading", cards: [], next: null })); void load(); }, [project, who]);
  // When it finished, as a date and time (#4428 capture check: a relative "3 days ago" rounds 3.3 days down, which read as
  // contradicting "more than 3 days"); the relative time is its tooltip.
  const at = (c) => c.doneAt || c.updatedAt;
  const finished = (c) => t(c.status === "cancelled" ? "tasksArchive.cancelled" : "tasksArchive.done", finishedAt(at(c)));
  const body = state.phase === "failed" ? html`<${ErrorState} message=${t("tasksArchive.failed")} onRetry=${() => load()} />`
    : state.phase === "loading" && !state.cards.length ? html`<${Skeleton} variant="list" lines=${4} />`
    : !state.cards.length ? html`<${Empty} icon="tasks" title=${who ? t("tasksArchive.noneWho", who) : t("tasksArchive.none")} />`
    : html`<div class="tb-list"><ul class="tb-rows">${state.cards.map((c) => html`<li key=${c.id} class="tb-row" onClick=${() => onOpen(c)}>
        <div class="tb-row-line">
          <span class="tb-row-main">${c.id}</span>
          <span class="tb-row-text"><button type="button" class="tb-row-title" title=${c.title} onClick=${(e) => { e.stopPropagation(); onOpen(c); }}>${c.title}</button></span>
          <${StatusPill} status=${c.status} card=${c} />
          <span class="tb-row-who"><${Who} name=${c.assignee} /></span>
          <span class="tb-row-time muted" title=${relTime(at(c))}>${finished(c)}</span>
        </div></li>`)}</ul></div>`;
  const tools = state.assignees.length > 1 || who ? html`<label class="tb-archive-who">${t("tasksArchive.who")}
      <select class="tb-select" value=${who} onChange=${(e) => setWho(e.target.value)}>
        <option value="">${t("tasksArchive.everyone")}</option>${state.assignees.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
      </select></label>` : null;
  const actions = html`${state.cards.length ? html`<span class="muted">${t("tasksArchive.count", state.cards.length, state.total)}</span>` : null}
    ${state.next ? html`<button type="button" class="btn" onClick=${() => load(state.next)}>${t("tasksArchive.more")}</button>` : null}`;
  return html`<${Dialog} title=${t("tasksArchive.title", name)} onClose=${onClose} wide=${true} actions=${actions} cls="tb-archive">
    <p class="muted">${t("tasksArchive.lead", days)}</p>
    ${tools}
    ${body}
  <//>`;
}
