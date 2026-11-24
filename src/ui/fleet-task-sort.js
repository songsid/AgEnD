// "No project" made hard to miss (Fleet › Tasks). A card an agent opens without a project lands in No project; the tile for
// it was the last on Home and only there, and the page remembers the project last looked at, so a person who stays in one
// project never saw it. When the board has projects and some live main task has none:
//   - Home opens with a "No project: N to file" list (the newest cards, each with a project picker that files it at once) above the
//     projects, and the No project tile moves first and says how many are waiting;
//   - a project's board says so in its header, with a link to No project;
//   - the No project board says what the place is for.
// A board with no project at all is not asked to sort anything: there, No project is the whole board.
// Pure helpers are exported (tests import them); the rest draws from what the board read already carries.
import { html, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { NO_PROJECT, boardApi, errorText, projectKey, relTime } from "./fleet-task-common.js";

register("tasksort", {
  en: {
    title: "No project: {0} to file", hint: "Agents open a card in No project when nobody said which project it is for. Pick a project to file it.",
    pick: "File in…", pickFor: "{0}: file in a project", moved: "{0} filed in {1}", by: "by {0}",
    openAll: "Open No project", seeAll: "See all {0}",
    tileBadge: "{0} to file", headerLink: "{0} in No project", headerLinkTip: "Open No project and file them",
    placeLead: "Cards opened without a project. Open one and choose its project, or file them from Home.",
  },
  "zh-TW": {
    title: "未分類：{0} 張待歸檔", hint: "沒有人說這張卡屬於哪個專案時，Agent 會先把卡開在未分類。選一個專案就能歸檔。",
    pick: "歸到…", pickFor: "{0}：歸到專案", moved: "{0} 已歸到 {1}", by: "{0} 建立",
    openAll: "開啟未分類", seeAll: "看全部 {0} 張",
    tileBadge: "{0} 張待歸檔", headerLink: "未分類 {0} 張", headerLinkTip: "開啟未分類並歸檔",
    placeLead: "沒指定專案時開出來的卡。打開卡片選專案，或在首頁直接歸檔。",
  },
});

/** The most cards Home lists to sort (the rest are one click away in No project). */
export const SORT_SHOWN = 5;

/** A main task nobody put in a project, still alive (open, in progress, waiting or blocked): what there is to sort. */
export const isLoose = (card) => card.kind === "main" && projectKey(card) === NO_PROJECT && card.status !== "done" && card.status !== "cancelled";

/** The live cards with no project, newest first. */
export function looseCards(cards) {
  const number = (c) => Number(String(c.id).replace(/\D/g, "")) || 0;           // M-10 comes after M-9 (the text sorts it before)
  return cards.filter(isLoose).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || number(b) - number(a));
}

/**
 * How many cards wait to be sorted, or 0 when there is nothing to ask: a board with no active project has only No project, and
 * sorting means putting them somewhere that is not there yet.
 */
export function sortCount(cards, projects) {
  return projects.some((p) => !p.archived) ? cards.filter(isLoose).length : 0;
}

/** Home's list: the newest cards with no project, each with a picker that files it. Nothing is drawn when there is nothing to sort. */
export function ToSort({ cards, projects, writable, onOpen, onOpenNoProject, reload }) {
  const active = projects.filter((p) => !p.archived);
  const loose = looseCards(cards);
  const pending = useRef(new Set());
  const [busy, setBusy] = useState(() => new Set());
  if (!active.length || !loose.length) return null;
  const shown = loose.slice(0, SORT_SHOWN);
  // One filing at a time per card (claimed before the first await): a double change sends one write.
  const file = async (card, value) => {
    const id = Number(value);
    const project = active.find((p) => p.id === id);
    if (!project || pending.current.has(card.id)) return;
    pending.current.add(card.id);
    setBusy(new Set(pending.current));
    try {
      await boardApi.update(card.id, { projectId: project.id, version: card.version });
      toast(t("tasksort.moved", card.id, project.name));
      reload();
    } catch (err) { toast(errorText(err), false); reload(); }
    finally { pending.current.delete(card.id); setBusy(new Set(pending.current)); }
  };
  return html`<section class="tb-waiting tb-sort" aria-label=${t("tasksort.title", loose.length)}>
    <h3 class="tb-section-title"><${Icon} name="inbox" size=${16} />${t("tasksort.title", loose.length)}</h3>
    <p class="note tb-sort-hint">${t("tasksort.hint")}</p>
    <ul class="rows">${shown.map((c) => html`<li key=${c.id} class="row-item tb-sort-row" data-sort=${c.id}>
      <button type="button" class="tb-wait-title" onClick=${() => onOpen(c.id)}><span class="tb-code">${c.id}</span> ${c.title}</button>
      <span class="muted tb-sort-meta">${c.createdBy ? `${t("tasksort.by", c.createdBy)} · ` : ""}${relTime(c.createdAt)}</span>
      ${writable ? html`<select class="tb-select tb-sort-pick" value="" disabled=${busy.has(c.id)} aria-label=${t("tasksort.pickFor", c.id)} onChange=${(e) => { const v = e.target.value; e.target.value = ""; void file(c, v); }}>
        <option value="">${t("tasksort.pick")}</option>${active.map((p) => html`<option key=${p.id} value=${String(p.id)}>${p.name}</option>`)}</select>` : null}
    </li>`)}</ul>
    <div class="tb-sort-foot">
      <button type="button" class="btn btn-ghost btn-sm" onClick=${onOpenNoProject}>${loose.length > shown.length ? t("tasksort.seeAll", loose.length) : t("tasksort.openAll")}</button>
    </div>
  </section>`;
}
