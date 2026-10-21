// #2246 step 3: who works on what on the task board — each instance's cards as its `task mine` reads them (GET
// /ui/tasks/work, the server's myWork): the board's Instance list, a drawer by team as taskhall's, and the block on an
// instance's Details page. A card opens on the board. No style attribute anywhere (the CSP).
import { html, useEffect, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Icon } from "/assets/ui-icons.js";
import { Skeleton } from "/assets/ui-states.js";
import { GroupMark, InstanceAvatar, dotLabel, dotState, groupKind, groupLabel, groupOf, namesOf, namesStore } from "/assets/instance-nav.js";
import { Who, boardApi, errorText } from "./fleet-task-common.js";

const LABEL = { back: "tasks.workSentBack", doing: "tasks.workDoing", blocked: "tasks.workBlocked", review: "tasks.workReview", main: "tasks.workMain", ready: "tasks.workReady", waiting: "tasks.workWaiting" };

/**
 * An instance's work as lines, in taskhall's order: what it works on, is blocked on, waits on the person for, the main
 * tasks it coordinates, what it can start, what waits for other cards. A card sent back to it says so instead.
 */
export function workLines(w) {
  const back = new Set(w.sentBack || []), unread = new Set(w.newComments || []);
  const line = (kind, card, note = "") => ({ kind: kind !== "main" && back.has(card.id) ? "back" : kind, card, note, unread: unread.has(card.id) });
  return [
    ...(w.doing || []).map((c) => line("doing", c)),
    ...(w.blocked || []).map((c) => line("blocked", c)),
    ...(w.review || []).map((c) => line("review", c)),
    ...(w.mains || []).map((c) => line("main", c, c.progress && c.progress.total ? t("tasks.workSubs", c.progress.done, c.progress.total) : "")),
    ...(w.ready || []).map((c) => line("ready", c, c.assignee ? "" : t("tasks.workClaimable"))),
    ...(w.waiting || []).map((c) => line("waiting", c, t("tasks.workWaitsFor", (c.unmetDeps || []).join(t("tasks.workJoin"))))),
  ];
}

export function WorkLines({ lines, onOpen }) {
  if (!lines.length) return html`<p class="muted tw-none">${t("tasks.workNone")}</p>`;
  return html`<ul class="tw-lines">${lines.map((l) => html`<li key=${`${l.kind}:${l.card.id}`}>
    <button type="button" class="tw-line" title=${`${l.card.id} ${l.card.title}`} onClick=${() => onOpen(l.card.id)}>
      <span class=${`tw-kind k-${l.kind}`}>${t(LABEL[l.kind])}</span><span class="tb-code">${l.card.id}</span><span class="tw-title">${l.card.title}</span>
      ${l.note ? html`<span class="muted tw-note">${l.note}</span>` : null}
      ${l.unread ? html`<span class="tw-unread" title=${t("tasks.workNewComments")} aria-label=${t("tasks.workNewComments")}><${Icon} name="chat" size=${13} /></span>` : null}
    </button></li>`)}</ul>`;
}

const OUTSIDE = "\u0000outside";
/** Groups as the sidebar orders them: teams, then tags, then the rest; names nobody in the fleet has last. */
const groupRank = (g) => (g === OUTSIDE ? 3 : groupKind(g) === "team" ? 0 : groupKind(g) === "tag" ? 1 : 2);

/** The board's Instance list: every instance by team, working ones first, each with its cards. Read again on each board change. */
export function InstancesDrawer({ tick, onClose, onOpen }) {
  const { instances, exec, awaiting } = useStore(appStore);
  useStore(namesStore);                                   // the sidebar's Names choice: display name or instance name first
  const [work, setWork] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    boardApi.work().then((d) => { if (live) { setWork(d.instances || []); setError(""); } }, (e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [tick]);
  const byName = new Map((instances || []).map((i) => [i.name, i]));
  const rows = (work || []).map((w) => {
    const it = byName.get(w.name);
    return { w, it, state: it ? dotState(it, exec[w.name], awaiting[w.name]) : null, lines: workLines(w) };
  });
  // Working first, then those with cards, then the running ones; by name.
  const rank = (r) => (r.state === "working" ? 0 : r.lines.length ? 1 : r.it && r.it.status === "running" ? 2 : 3);
  rows.sort((a, b) => rank(a) - rank(b) || a.w.name.localeCompare(b.w.name));
  const groups = new Map();
  for (const r of rows) {
    const g = r.it ? groupOf(r.it) : OUTSIDE;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const ordered = [...groups].sort(([a], [b]) => groupRank(a) - groupRank(b));
  const working = rows.filter((r) => r.state === "working").length;
  return html`<${Dialog} title=${t("tasks.instances")} onClose=${onClose} wide drawer>
    <div class="tw">
      ${work ? html`<p class="muted tw-head">${t("tasks.instancesHead", rows.length, working)}</p>` : null}
      ${error ? html`<p class="tw-error" role="alert">${t("tasks.workFailed", error)}</p>` : null}
      ${!work && !error ? html`<${Skeleton} lines=${4} />` : null}
      ${ordered.map(([g, list]) => html`<section key=${g} class="tw-group">
        <h3 class="tw-group-head">${g === OUTSIDE ? t("tasks.workOutside") : html`<${GroupMark} group=${g} />${groupLabel(g)}`}<span class="tb-count">${list.length}</span></h3>
        ${list.map((r) => html`<div key=${r.w.name} class="tw-inst">
          <div class="tw-inst-head">
            ${r.it ? html`<${InstanceAvatar} it=${r.it} state=${r.state} />` : html`<${Who} name=${r.w.name} />`}
            ${r.it ? (() => { const n = namesOf(r.it); return html`<span class="tw-name" title=${r.w.name}>${n.primary}</span>${n.secondary ? html`<span class="muted tw-alt">${n.secondary}</span>` : null}`; })() : null}
            ${r.state ? html`<span class="muted tw-state">${dotLabel(r.state)}</span>` : null}
          </div>
          ${r.it && r.it.description ? html`<p class="muted tw-desc">${r.it.description}</p>` : null}
          <${WorkLines} lines=${r.lines} onOpen=${onOpen} />
        </div>`)}
      </section>`)}
    </div>
  </${Dialog}>`;
}

/** An instance's Details page: its cards, read once when the page opens (the page reads nothing recurring, #1374). */
export function InstanceBoardWork({ name, onOpen }) {
  const [work, setWork] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setWork(null); setError("");
    boardApi.work(name).then((d) => { if (live) setWork((d.instances || [])[0] || { name }); }, (e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [name]);
  return html`<section class="card d-board"><h3>${t("tasks.detailsBoard")}</h3>
    ${error ? html`<p class="note">${t("tasks.workFailed", error)}</p>` : !work ? html`<${Skeleton} lines=${2} />` : html`<${WorkLines} lines=${workLines(work)} onOpen=${onOpen} />`}
  </section>`;
}
