// The task board (Fleet › Tasks): projects → main tasks (M-) → sub tasks (S-), ported from taskhall (任務會所).
// Home lists the projects and what waits for the person; a project is a board of its main tasks by status, each able to
// open up its sub tasks; a card opens in a dialog (fleet-task-card.js). Every write goes through /ui/tasks/* as the
// signed-in person, under the same rules an instance's task tool meets (scheduler/task-board.ts). A change from anywhere
// (an agent's tool, another tab) arrives as a "tasks" stream event with the board's revision; the board reads again
// when its revision moved. Over the temporary public link the board is read-only (the server refuses its writes there).
// A card moves by drag, by Alt+arrow keys on its title, or by its dialog ("Move to…", up and down) — touch and keyboard
// need no drag.
import { html, useEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { recordEdit } from "/assets/text-undo.js";
import { appStore, useStore } from "/assets/app-store.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { toast } from "/assets/ui-toast.js";
import { AskHost, COLUMNS, NO_PROJECT, ProgressBar, StatusPill, UNASSIGNED, Who, answerBlocked, boardApi, currentWork, dropNeighbours, errorText, followsSubs, moveCard, onPublicLink, projectKey, projectStats, readStored, recentlyDone, relTime, workersOf, wrapUpText, writeStored } from "./fleet-task-common.js";
import { CardDialog } from "./fleet-task-card.js";
import { InstancesDrawer } from "./fleet-task-work.js";

const PROJECT_KEY = "agend_tasks_project";
const FILTER_KEY = "agend_tasks_assignee";

// ── The tab ───────────────────────────────────────────────

/**
 * Fleet › Tasks. `?card=M-3` in the address opens that card (a link from a notice). The project last looked at is
 * remembered on this device.
 */
export function TaskBoardTab({ lease }) {
  const [state, setState] = useState(null);
  // `ifMoved`: a refresh that only wants the board if its revision moved (a stream event, a reconnect).
  const [version, setVersion] = useState({ n: 0, ifMoved: false });
  const writable = !onPublicLink();
  const [at, setAtRaw] = useState(() => {
    const v = readStored(PROJECT_KEY, "");
    return v === "" ? null : v === NO_PROJECT ? NO_PROJECT : Number(v);
  });
  const [openId, setOpenId] = useState(() => {
    try { return new URLSearchParams(globalThis.location?.search || "").get("card"); } catch { return null; }
  });
  const [tick, setTick] = useState(0);
  const [flashed, setFlashed] = useState(() => new Map());
  const [dialog, setDialog] = useState(null);
  // The Done column's "All": every done main task is read only when asked for (the server keeps recent ones otherwise).
  const [allDone, setAllDone] = useState(false);
  const seq = useRef(0);
  const setAt = (v) => { setAtRaw(v); writeStored(PROJECT_KEY, v === null ? null : String(v)); };
  const reload = (ifMoved = false) => setVersion((v) => ({ n: v.n + 1, ifMoved }));
  const shown = useRef({ rev: null, allDone: false });

  useEffect(() => {
    const mine = ++seq.current;
    (async () => {
      try {
        const q = new URLSearchParams();
        if (allDone) q.set("done", "all");
        // The same board at the same revision is not sent again.
        if (version.ifMoved && shown.current.rev !== null && shown.current.allDone === allDone) q.set("rev", String(shown.current.rev));
        const qs = q.toString();
        const r = await lease.fetch(`/ui/tasks/board${qs ? `?${qs}` : ""}`, { method: "GET", headers: { "Content-Type": "application/json" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (!lease.current() || mine !== seq.current || d.unchanged) return;
        shown.current = { rev: typeof d.rev === "number" ? d.rev : null, allDone };
        setState({ data: d });
      } catch { if (lease.current() && mine === seq.current) setState((s) => (s && s.data ? s : { error: true })); }
    })();
  }, [lease, version, allDone]);

  // Live: a change from anywhere reads the board again (once per burst) and lights up the cards it touched.
  useEffect(() => {
    const sub = appStore.get().streamOn;
    if (!sub) return undefined;
    let timer = null;
    const off = sub("tasks", (change) => {
      // A revision this page has already read (its own write, read again since) brings nothing new.
      if (change && typeof change.rev === "number" && shown.current.rev !== null && change.rev <= shown.current.rev) return;
      const ids = Array.isArray(change && change.ids) ? change.ids : [];
      if (ids.length) {
        const now = Date.now();
        setFlashed((m) => { const next = new Map(m); for (const id of ids) next.set(id, now); return next; });
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; reload(true); setTick((n) => n + 1); }, 250);
    });
    const offConn = sub("connection", (c) => { if (c === "live") reload(true); });
    return () => { off(); offConn(); if (timer) clearTimeout(timer); };
  }, [lease]);

  const openCard = (id) => {
    setOpenId(id);
    try { const u = new URL(globalThis.location.href); u.searchParams.set("card", id); globalThis.history.replaceState(globalThis.history.state, "", u); } catch { /* no address bar */ }
  };
  const closeCard = () => {
    setOpenId(null);
    try { const u = new URL(globalThis.location.href); u.searchParams.delete("card"); globalThis.history.replaceState(globalThis.history.state, "", u); } catch { /* no address bar */ }
  };

  // #2246 step 3: who works on what — the drawer gives way to a card opened from it (one drawer at a time).
  const showInstances = () => setDialog({ kind: "instances" });

  if (!state) return html`<${Skeleton} lines=${5} />`;
  if (state.error) return html`<${ErrorState} message=${t("tasks.loadFailed")} onRetry=${reload} />`;
  const cards = Array.isArray(state.data.cards) ? state.data.cards : [];
  const projects = Array.isArray(state.data.projects) ? state.data.projects : [];
  // #2355 review: the names a project's lead may be, as the server accepts them (the fleet's instances).
  const leads = Array.isArray(state.data.leads) ? state.data.leads : [];
  // The server's numbers cover every card (finished ones are not all on the board); computed here only without them.
  const stats = (key) => (state.data.stats && state.data.stats[String(key)]) || projectStats(key, cards);
  const project = at === null ? null : at === NO_PROJECT ? NO_PROJECT : projects.find((p) => p.id === at) || null;
  const body = project === null
    ? html`<${Home} cards=${cards} projects=${projects} stats=${stats} writable=${writable} onOpenProject=${setAt} onOpen=${openCard} onDialog=${setDialog} onInstances=${showInstances} reload=${reload} />`
    : html`<${ProjectBoard} project=${project} cards=${cards} stats=${stats} flashed=${flashed} allDone=${allDone} writable=${writable} onAllDone=${setAllDone} onBack=${() => setAt(null)}
        onOpen=${openCard} onCreate=${() => setDialog({ kind: "main", project: project === NO_PROJECT ? null : project.id })} onInstances=${showInstances} reload=${reload} />`;
  return html`<div class="tb">
    ${writable ? null : html`<p class="tb-readonly" role="note"><${Icon} name="eye" size=${16} />${t("tasks.readOnly")}</p>`}
    ${body}
    ${openId ? html`<${CardDialog} key=${openId} id=${openId} tick=${tick} projects=${projects} writable=${writable} place=${writable ? placeOf(cards, openId, reload) : null}
      onClose=${closeCard} onOpen=${openCard} reloadBoard=${reload} />` : null}
    ${dialog && dialog.kind === "main" ? html`<${CreateMainDialog} projects=${projects} project=${dialog.project} onClose=${() => setDialog(null)}
      onCreated=${(id) => { if (!lease.current()) return; setDialog(null); reload(); openCard(id); }} />` : null}
    ${dialog && dialog.kind === "instances" ? html`<${InstancesDrawer} tick=${tick} onClose=${() => setDialog(null)} onOpen=${(id) => { setDialog(null); openCard(id); }} />` : null}
    ${dialog && dialog.kind === "project" ? html`<${ProjectDialog} project=${dialog.project} leads=${leads} onClose=${() => setDialog(null)}
      onSaved=${(p) => { if (!lease.current()) return; setDialog(null); reload(); if (!dialog.project) setAt(p.id); }} />` : null}
    <${AskHost} />
  </div>`;
}

// ── Home: the projects, and what waits for the person ─────────

/** The board's Instance button (taskhall's): the fleet's instances and what each works on. */
function InstancesButton({ onClick }) {
  return html`<button type="button" class="btn" title=${t("tasks.instancesTip")} onClick=${onClick}><${Icon} name="team" size=${16} />${t("tasks.instances")}</button>`;
}

function Home({ cards, projects, stats, writable, onOpenProject, onOpen, onDialog, onInstances, reload }) {
  const [showArchived, setShowArchived] = useState(false);
  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);
  const loose = stats(NO_PROJECT).mains > 0;
  return html`<div class="tb-home">
    <div class="list-head tb-head"><span>${t("tasks.projects")}</span>
      <span class="tb-grow"></span>
      <${SearchBox} onOpen=${onOpen} />
      <${InstancesButton} onClick=${onInstances} />
      ${writable ? html`<button type="button" class="btn btn-primary" onClick=${() => onDialog({ kind: "project", project: null })}><${Icon} name="plus" size=${16} />${t("tasks.newProject")}</button>` : null}</div>
    <${Waiting} cards=${cards} writable=${writable} onOpen=${onOpen} reload=${reload} />
    ${active.length || loose ? html`<div class="tb-projects">
      ${active.map((p) => html`<${ProjectTile} key=${p.id} project=${p} stats=${stats(p.id)} onOpen=${() => onOpenProject(p.id)} onDialog=${writable ? onDialog : null} reload=${reload} />`)}
      ${loose ? html`<${ProjectTile} project=${null} stats=${stats(NO_PROJECT)} onOpen=${() => onOpenProject(NO_PROJECT)} />` : null}
    </div>` : html`<${Empty} icon="tasks" title=${t("tasks.noProjects")} hint=${t("tasks.noProjectsHint")} />`}
    ${archived.length ? html`<div class="tb-archived">
      <button type="button" class="btn btn-ghost btn-sm" aria-expanded=${showArchived ? "true" : "false"} onClick=${() => setShowArchived(!showArchived)}>
        <${Icon} name="chevron" size=${14} cls=${showArchived ? "tb-chev open" : "tb-chev"} />${t("tasks.archived")} (${archived.length})</button>
      ${showArchived ? html`<div class="tb-projects">${archived.map((p) => html`<${ProjectTile} key=${p.id} project=${p} stats=${stats(p.id)} onOpen=${() => onOpenProject(p.id)} onDialog=${writable ? onDialog : null} reload=${reload} />`)}</div>` : null}
    </div>` : null}
  </div>`;
}

function ProjectTile({ project, stats, onOpen, onDialog, reload }) {
  async function setArchived(archived) {
    try { await boardApi.updateProject(project.id, { archived }); toast(t("tasks.projectSaved")); reload(); } catch (err) { toast(errorText(err), false); }
  }
  const name = project ? project.name : t("tasks.noProject");
  const desc = project ? project.description : t("tasks.noProjectDesc");
  return html`<div class=${`tb-project${project && project.archived ? " is-archived" : ""}`}>
    <button type="button" class="tb-project-open" onClick=${onOpen}>
      <span class="tb-project-name">${name}</span>
      ${desc ? html`<span class="tb-project-desc">${desc}</span>` : null}
      <span class="tb-project-pct" title=${t("tasks.percentTitle")}><span class="tb-pct">${stats.percent}%</span><${ProgressBar} progress=${stats.units} wide /></span>
      <span class="tb-project-meta">
        <span>${stats.mains === 1 ? t("tasks.mainOne") : t("tasks.mainCount", stats.mains)}</span>
        ${stats.waiting ? html`<span class="tb-flag st-review">${t("tasks.waiting", stats.waiting)}</span>` : null}
        ${stats.blocked ? html`<span class="tb-flag st-blocked">${t("tasks.blockedN", stats.blocked)}</span>` : null}
        ${stats.lastActivity ? html`<span class="muted">${t("tasks.lastActivity", relTime(stats.lastActivity))}</span>` : null}
        ${project && project.leadInstance ? html`<span class="muted tb-project-lead-chip">${t("tasks.projectLeadChip", project.leadInstance)}</span>` : null}
      </span>
    </button>
    ${project && onDialog ? html`<${Menu} cls="tb-project-menu" items=${[
      { key: "edit", label: t("tasks.rename"), icon: "edit", onSelect: () => onDialog({ kind: "project", project }) },
      project.archived
        ? { key: "restore", label: t("tasks.restore"), icon: "restart", onSelect: () => setArchived(false) }
        : { key: "archive", label: t("tasks.archive"), icon: "download", onSelect: () => setArchived(true) },
    ]} />` : null}
  </div>`;
}

/**
 * Cards waiting for the person: to confirm or send back, and blocked ones to answer. A card's buttons take one answer
 * at a time: claimed before the first await, so a double click sends one move.
 */
function Waiting({ cards, writable, onOpen, reload }) {
  const { instances } = useStore(appStore);
  const fleetNames = new Set(instances.map((i) => i.name));
  const pending = useRef(new Set());
  const [busy, setBusy] = useState(() => new Set());
  const review = cards.filter((c) => c.status === "review");
  const blocked = cards.filter((c) => c.status === "blocked");
  if (!review.length && !blocked.length) return null;
  const act = async (fn, done, card) => {
    if (pending.current.has(card.id)) return;
    pending.current.add(card.id);
    setBusy(new Set(pending.current));
    try { const r = await fn(); if (r) { toast(t(done, card.id)); reload(); } }
    finally { pending.current.delete(card.id); setBusy(new Set(pending.current)); }
  };
  return html`<section class="tb-waiting" aria-label=${t("tasks.waitingTitle")}>
    <h3 class="tb-section-title"><${Icon} name="inbox" size=${16} />${t("tasks.waitingTitle")}</h3>
    <ul class="rows">${[...review, ...blocked].map((c) => html`<li key=${c.id} class="row-item tb-wait-row">
      <div class="tb-wait-main">
        <${StatusPill} status=${c.status} />
        <button type="button" class="tb-wait-title" onClick=${() => onOpen(c.id)}><span class="tb-code">${c.id}</span> ${c.title}
          ${c.status === "blocked" && c.blockedReason ? html`<span class="tb-wait-reason">${c.blockedReason}</span>` : null}
          ${c.status === "blocked" && c.dispatcher && c.dispatcher.kind === "instance" && c.dispatcher.name !== c.assignee && fleetNames.has(c.dispatcher.name)
            ? html`<span class="tb-wait-asked muted">${t("tasks.askedFirst", c.dispatcher.name)}</span>` : null}
          ${c.status === "review" && wrapUpText(c) ? html`<span class="tb-wait-reason wrapup">${t("tasks.wrapLine", wrapUpText(c))}</span>` : null}</button>
      </div>
      <div class="tb-wait-actions">
        ${c.assignee ? html`<span class="muted">${c.assignee}</span>` : null}
        ${!writable ? null : c.status === "review" ? html`
          <button type="button" class="btn btn-primary btn-sm" disabled=${busy.has(c.id)} onClick=${() => act(() => moveCard(c, "done"), "tasks.confirmed", c)}><${Icon} name="check" size=${14} />${t("tasks.confirm")}</button>
          <button type="button" class="btn btn-sm" disabled=${busy.has(c.id)} onClick=${() => act(() => moveCard(c, "claimed"), "tasks.sentBack", c)}>${t("tasks.sendBack")}</button>`
        : html`<button type="button" class="btn btn-primary btn-sm" disabled=${busy.has(c.id)} onClick=${() => act(() => answerBlocked(c), "tasks.answered", c)}>${t("tasks.answer")}</button>`}
      </div>
    </li>`)}</ul>
  </section>`;
}

function SearchBox({ onOpen }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState(null);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const text = q.trim();
    if (!text) { setResults(null); return undefined; }
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      try { const r = await boardApi.search(text); if (mine === seq.current) { setResults(r.results || []); setActive(0); } } catch { if (mine === seq.current) setResults([]); }
    }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  const pick = (id) => { setQ(""); setResults(null); onOpen(id); };
  function onKey(e) {
    if (!results || !results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % results.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + results.length) % results.length); }
    else if (e.key === "Enter") { e.preventDefault(); pick(results[active].card.id); }
    else if (e.key === "Escape") { e.stopPropagation(); recordEdit(e.target); setQ(""); }       // #2342: Ctrl+Z brings it back
  }
  return html`<div class="tb-search">
    <${Icon} name="search" size=${16} cls="tb-search-icon" />
    <input type="search" value=${q} placeholder=${t("tasks.search")} aria-label=${t("tasks.searchHint")} title=${t("tasks.searchHint")}
      onInput=${(e) => setQ(e.target.value)} onKeyDown=${onKey} />
    ${results ? html`<ul class="tb-search-results" role="listbox">
      ${results.length ? results.map((r, i) => html`<li key=${r.card.id} role="option" aria-selected=${i === active ? "true" : "false"} class=${i === active ? "active" : ""}>
        <button type="button" onClick=${() => pick(r.card.id)}>
          <span class="tb-code">${r.card.id}</span><span class="tb-search-title">${r.card.title}</span><${StatusPill} status=${r.card.status} />
          <span class="tb-search-where muted">${[r.project, r.parentTitle].filter(Boolean).join(" › ")}${r.match ? ` · ${t("tasks.inField", t(`tasks.field${r.match.field}`))}: ${r.match.text}` : ""}</span>
        </button></li>`) : html`<li class="muted tb-search-none">${t("tasks.searchEmpty")}</li>`}
    </ul>` : null}
  </div>`;
}

// ── A project's board ─────────────────────────────────────

function ProjectBoard({ project, cards, stats: statsOf, flashed, allDone, writable, onAllDone, onBack, onOpen, onCreate, onInstances, reload }) {
  const { instances } = useStore(appStore);
  const [assignee, setAssigneeRaw] = useState(() => readStored(FILTER_KEY, ""));
  const [expanded, setExpanded] = useState({});
  const [drag, setDrag] = useState(null);
  const [spot, setSpot] = useState(null);
  const setAssignee = (v) => { setAssigneeRaw(v); writeStored(FILTER_KEY, v || null); };
  const key = project === NO_PROJECT ? NO_PROJECT : project.id;
  const archived = project !== NO_PROJECT && project.archived;
  const stats = statsOf(key);
  const now = Date.now();

  const subsOf = useMemo(() => {
    const m = new Map();
    for (const c of cards) if (c.kind === "sub" && c.parentId && c.status !== "cancelled") m.set(c.parentId, [...(m.get(c.parentId) || []), c]);
    return m;
  }, [cards]);
  const matches = (c) => !assignee || (assignee === UNASSIGNED ? c.assignee === null : c.assignee === assignee);
  const mains = cards.filter((c) => c.kind === "main" && projectKey(c) === key && c.status !== "cancelled"
    && (c.status !== "done" || allDone || recentlyDone(c, now))
    && (matches(c) || (subsOf.get(c.id) || []).some(matches)));
  const names = [...new Set([...instances.map((i) => i.name), ...cards.map((c) => c.assignee).filter(Boolean)])].sort();

  const dropping = useRef(false);
  // A card moved from the keyboard is drawn again in its new place, and the focus it had goes with the old tile: give it
  // back to the card's title once it is there — only while nothing else took the focus, and for a few seconds at most.
  const refocus = useRef(null);
  useEffect(() => {
    const r = refocus.current;
    if (!r) return;
    if (Date.now() > r.until) { refocus.current = null; return; }
    const el = document.querySelector(`[data-tile="${r.id}"] .tb-tile-title`);
    const lost = !document.activeElement || document.activeElement === document.body;
    if (el && lost) el.focus();
  });
  async function drop(card, to, after, before) {
    if (dropping.current) return;
    dropping.current = true;
    try { await place(card, to, after, before); } finally { dropping.current = false; }
  }
  async function place(card, to, after, before) {
    if (to !== card.status) {
      // By hand, a main task that follows its sub tasks is confirmed or sent back, or blocked and unblocked.
      const allowed = !followsSubs(card) || (card.status === "review" && (to === "done" || to === "claimed"))
        || (to === "blocked" && card.status !== "done") || (card.status === "blocked" && to === "claimed");
      if (!allowed) { toast(t("tasks.derivedMove"), false); return; }
      const r = await moveCard(card, to);
      if (!r) return;
    }
    if (after || before) { try { await boardApi.reorder(card.id, after, before); } catch (err) { toast(errorText(err), false); } }
    reload();
  }
  /** Alt+arrows on a card's title: ↑/↓ within its column, ←/→ to the status before or after (as a drop there would). */
  function keyMove(card, e) {
    if (!writable || !e.altKey || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    refocus.current = { id: card.id, until: Date.now() + 5000 };
    const column = mains.filter((c) => c.status === card.status);
    const i = column.findIndex((c) => c.id === card.id);
    if (e.key === "ArrowUp" && i > 0) void drop(card, card.status, column[i - 2]?.id ?? null, column[i - 1].id);
    else if (e.key === "ArrowDown" && i < column.length - 1) void drop(card, card.status, column[i + 1].id, column[i + 2]?.id ?? null);
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const to = COLUMNS[COLUMNS.indexOf(card.status) + (e.key === "ArrowLeft" ? -1 : 1)];
      if (to) void drop(card, to, null, null);
    }
  }
  const end = () => { setDrag(null); setSpot(null); };
  function over(e, status) {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const tiles = [...e.currentTarget.querySelectorAll("[data-tile]")].filter((el) => el.dataset.tile !== drag.id);
    let index = tiles.findIndex((el) => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (index < 0) index = tiles.length;
    if (!spot || spot.status !== status || spot.index !== index) setSpot({ status, index });
  }
  function dropOn(e, status, column) {
    e.preventDefault();
    const d = drag, at = spot;
    end();
    if (!d || !at) return;
    const { after, before } = dropNeighbours(column, d.id, at.index);
    void drop(d, status, after, before);
  }

  return html`<div class="tb-board-page">
    <div class="tb-bar-head">
      <button type="button" class="btn btn-ghost btn-sm" onClick=${onBack}><${Icon} name="back" size=${16} />${t("tasks.back")}</button>
      <div class="tb-title">
        <h2>${project === NO_PROJECT ? t("tasks.noProject") : project.name}</h2>
        ${archived ? html`<span class="tb-flag">${t("tasks.archived")}</span>` : null}
        ${project !== NO_PROJECT && project.description ? html`<span class="tb-project-desc">${project.description}</span>` : null}
      </div>
      <div class="tb-stats" title=${t("tasks.percentTitle")}>
        <span class="tb-pct">${stats.percent}%</span><${ProgressBar} progress=${stats.units} />
        <span class="muted">${stats.mains === 1 ? t("tasks.mainOne") : t("tasks.mainCount", stats.mains)}</span>
        ${stats.waiting ? html`<span class="tb-flag st-review">${t("tasks.waiting", stats.waiting)}</span>` : null}
        ${stats.blocked ? html`<span class="tb-flag st-blocked">${t("tasks.blockedN", stats.blocked)}</span>` : null}
      </div>
      <span class="tb-grow"></span>
      <select class="tb-select" value=${assignee} aria-label=${t("tasks.filterLabel")} onChange=${(e) => setAssignee(e.target.value)}>
        <option value="">${t("tasks.everyone")}</option>
        <option value=${UNASSIGNED}>${t("tasks.nobody")}</option>
        ${names.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
      </select>
      <${InstancesButton} onClick=${onInstances} />
      ${archived || !writable ? null : html`<button type="button" class="btn btn-primary" onClick=${onCreate}><${Icon} name="plus" size=${16} />${t("tasks.newMain")}</button>`}
    </div>
    ${mains.length === 0 && !drag ? html`<${Empty} icon="tasks" title=${assignee ? t("tasks.emptyFiltered") : t("tasks.emptyBoard")} hint=${assignee || archived ? undefined : t("tasks.emptyBoardHint")} />`
    : html`<div class="tb-scroll"><div class="tb-columns">
      ${COLUMNS.map((status) => {
        const list = mains.filter((c) => c.status === status);
        const line = spot && spot.status === status ? spot.index : -1;
        return html`<section key=${status} class=${`tb-col st-${status}${drag ? " can-drop" : ""}${line >= 0 ? " over" : ""}`} aria-label=${t(`tasks.${status}`)}
          onDragOver=${(e) => over(e, status)} onDrop=${(e) => dropOn(e, status, list)}>
          <h3 class="tb-col-head"><span class="tb-dot"></span>${t(`tasks.${status}`)}
            ${status === "done" ? html`<button type="button" class="tb-link" title=${t("tasks.toggleDone")} onClick=${() => onAllDone(!allDone)}>${allDone ? t("tasks.all") : t("tasks.recent")}</button>` : null}
            <span class="tb-count">${list.length}</span></h3>
          ${cellItems(list, drag ? drag.id : null, line, (card, dragging) => {
            const lit = Math.max(flashed.get(card.id) || 0, ...(subsOf.get(card.id) || []).map((s) => flashed.get(s.id) || 0));
            return html`<${Tile} key=${card.id} card=${card} dragging=${dragging} flash=${now - lit < 4000} subs=${subsOf.get(card.id)} writable=${writable}
              expanded=${!!expanded[card.id]} onToggleSubs=${() => setExpanded({ ...expanded, [card.id]: !expanded[card.id] })}
              onOpen=${onOpen} onKeyMove=${(e) => keyMove(card, e)}
              onDragStart=${(e) => { e.dataTransfer.setData("text/plain", card.id); e.dataTransfer.effectAllowed = "move"; setDrag(card); }} onDragEnd=${end} />`;
          })}
        </section>`;
      })}
    </div></div>`}
  </div>`;
}

/** A column's cards, with a line where a dragged card would land. */
function cellItems(list, draggingId, lineAt, render) {
  const items = [];
  let k = 0;
  for (const card of list) {
    const dragging = draggingId === card.id;
    if (!dragging) {
      if (lineAt === k) items.push(html`<div key=${`line-${k}`} class="tb-drop-line"></div>`);
      k++;
    }
    items.push(render(card, dragging));
  }
  if (lineAt === k) items.push(html`<div key="line-end" class="tb-drop-line"></div>`);
  return items;
}

/** A card on the board: a main task shows its sub-task progress, and can open up the list. */
function Tile({ card, dragging, flash, subs = [], expanded, writable, onToggleSubs, onOpen, onKeyMove, onDragStart, onDragEnd }) {
  const accepted = card.acceptance.filter((a) => a.done).length;
  const progress = card.progress;
  const hasSubs = !!progress && progress.total > 0;
  // The board carries only recently finished sub tasks; older ones are counted, not listed.
  const older = hasSubs ? progress.total - subs.length : 0;
  const replied = card.lastComment && card.lastComment.authorKind !== "person";
  const gap = card.status === "review" ? wrapUpText(card) : "";
  // Who works on a main task now (a step may be its reviewer's), rather than who owns it.
  const now = hasSubs ? currentWork(card, subs) : null;
  const workers = now ? workersOf(now.cards) : [];
  // The tile is a group, not a button: its title is the control (keyboard, screen readers); a click anywhere opens it.
  return html`<div class=${`tb-tile st-${card.status}${dragging ? " dragging" : ""}${flash ? " flash" : ""}`} data-tile=${card.id}
    draggable=${writable} onDragStart=${writable ? onDragStart : undefined} onDragEnd=${writable ? onDragEnd : undefined}
    onClick=${() => onOpen(card.id)}>
    <div class="tb-tile-top">
      <span class="tb-code">${card.id}</span>
      ${card.priority === "urgent" || card.priority === "high" ? html`<span class=${`tb-tag p-${card.priority}`}>${t(card.priority === "urgent" ? "tasks.urgentTag" : "tasks.highTag")}</span>` : null}
      ${card.kind === "sub" && card.needsReview && card.status !== "done" ? html`<span class="tb-tag st-review" title=${t("tasks.needsReviewTitle")}>${t("tasks.needsReview")}</span>` : null}
      ${gap ? html`<span class="tb-tag wrapup" title=${t("tasks.wrapLine", gap)}>${t("tasks.wrapTag")}</span>` : null}
      <span class="tb-grow"></span>
      ${card.size ? html`<span class="tb-size" title=${t("tasks.size")}>${t(`tasks.size${card.size}`)}</span>` : null}
    </div>
    <button type="button" class="tb-tile-title" title=${writable ? t("tasks.tileHint") : undefined}
      onClick=${(e) => { e.stopPropagation(); onOpen(card.id); }} onKeyDown=${onKeyMove}>${card.title}</button>
    ${card.status === "blocked" && card.blockedReason ? html`<div class="tb-tile-note st-blocked"><${Icon} name="alert" size=${13} /><span>${card.blockedReason}</span></div>` : null}
    ${hasSubs ? html`<button type="button" class="tb-tile-progress" aria-expanded=${expanded ? "true" : "false"} title=${expanded ? t("tasks.hideSubs") : t("tasks.showSubs")}
        onClick=${(e) => { e.stopPropagation(); onToggleSubs(); }}>
      <${ProgressBar} progress=${progress} wide />
      <span>${t("tasks.subProgress", progress.done, progress.total)}</span>
      ${progress.blocked ? html`<span class="tb-flag st-blocked"><${Icon} name="alert" size=${12} />${progress.blocked}</span>` : null}
      <${Icon} name="chevron" size=${14} cls=${expanded ? "tb-chev open" : "tb-chev"} />
    </button>` : null}
    ${hasSubs && expanded ? html`<ul class="tb-subs" onClick=${(e) => e.stopPropagation()}>
      ${subs.map((s) => html`<li key=${s.id}><button type="button" onClick=${() => onOpen(s.id)} title=${`${s.id} ${s.title} (${t(`tasks.${s.status}`)})`}>
        <span class=${`tb-dot st-${s.status}`} aria-label=${t(`tasks.${s.status}`)}></span><span class="tb-code">${s.id}</span><span class="tb-sub-title">${s.title}</span>
        ${s.assignee ? html`<span class="tb-who">${s.assignee}</span>` : null}</button>
        ${s.status === "blocked" && s.blockedReason ? html`<div class="tb-sub-blocked">${s.blockedReason}</div>` : null}</li>`)}
      ${older > 0 ? html`<li class="muted tb-sub-more">${t("tasks.olderSubs", older)}</li>` : null}
    </ul>` : null}
    ${now ? html`<div class="tb-tile-now" title=${now.cards.map((c) => `${c.id} ${c.title}`).join("\n")}>
      <span class=${`tb-now-label st-${now.tone}`}>${t(now.label)}</span><span class="tb-code">${now.cards[0].id}</span>
      <span class="tb-now-title">${now.cards[0].title}</span>${now.cards.length > 1 ? html`<span class="muted">${t("tasks.moreCards", now.cards.length - 1)}</span>` : null}</div>` : null}
    <div class="tb-tile-foot">
      ${now ? html`<span class="tb-people">${workers.map((w) => html`<${Who} key=${w} name=${w} empty=${t("tasks.nobody")} title=${t("tasks.ownerTip", card.assignee || t("tasks.nobody"))} />`)}</span>`
        : hasSubs && card.status === "review" ? html`<span class="tb-who tb-now-label st-review" title=${t("tasks.ownerTip", card.assignee || t("tasks.nobody"))}>${t("tasks.review")}</span>`
        : html`<${Who} name=${card.assignee} empty=${t("tasks.nobody")} />`}
      <span class="tb-tile-stats">
        ${card.acceptance.length ? html`<span class=${accepted === card.acceptance.length ? "all" : ""} title=${t(card.kind === "main" ? "tasks.definition" : "tasks.acceptance")}><${Icon} name="check" size=${13} />${accepted}/${card.acceptance.length}</span>` : null}
        ${card.unmetDeps.length ? html`<span title=${t("tasks.waitsFor", card.unmetDeps.join(", "))}><${Icon} name="clock" size=${13} /></span>` : null}
        ${card.commentCount ? html`<span class=${replied ? "reply" : ""} title=${replied ? t("tasks.agentReplied") : t("tasks.comments")}><${Icon} name="chat" size=${13} />${card.commentCount}</span>` : null}
      </span>
    </div>
  </div>`;
}

// ── Dialogs: a new main task, a project ───────────────────

function CreateMainDialog({ projects, project, onClose, onCreated }) {
  const { instances } = useStore(appStore);
  const active = projects.filter((p) => !p.archived);
  const [f, setF] = useState({ project: project === null || project === undefined ? "" : String(project), title: "", goal: "", scope: "", acceptance: "", context: "", size: "", priority: "normal", assignee: "", needsReview: true });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => { const v = e.target.type === "checkbox" ? e.target.checked : e.target.value; setF((cur) => ({ ...cur, [k]: v })); };
  async function submit() {
    if (!f.title.trim()) { toast(t("tasks.titleRequired"), false); return; }
    setBusy(true);
    try {
      const { card } = await boardApi.create({
        kind: "main", project: f.project === "" ? null : Number(f.project), title: f.title, goal: f.goal, scope: f.scope,
        acceptance: f.acceptance.split("\n").map((l) => l.trim()).filter(Boolean), context: f.context,
        size: f.size || null, priority: f.priority, assignee: f.assignee.trim() || null, needsReview: f.needsReview,
      });
      toast(t("tasks.created", card.id));
      onCreated(card.id);
    } catch (err) { toast(errorText(err), false); setBusy(false); }
  }
  const field = (label, input) => html`<label class="field"><span>${label}</span>${input}</label>`;
  return html`<${Dialog} title=${t("tasks.createMain")} onClose=${onClose} busy=${busy} wide
    actions=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${t("tasks.cancel")}</button>
      <button type="button" class="btn btn-primary" onClick=${submit} disabled=${busy || !f.title.trim()}>${t("tasks.create")}</button>`}>
    <form class="form" onSubmit=${(e) => { e.preventDefault(); submit(); }}><fieldset class="form" disabled=${busy}>
      ${field(`${t("tasks.title")} *`, html`<input value=${f.title} maxlength="100" placeholder=${t("tasks.titleHint")} onInput=${set("title")} required />`)}
      ${field(t("tasks.project"), html`<select value=${f.project} onChange=${set("project")}><option value="">${t("tasks.noProject")}</option>${active.map((p) => html`<option key=${p.id} value=${String(p.id)}>${p.name}</option>`)}</select>`)}
      ${field(t("tasks.goal"), html`<textarea rows="2" maxlength="300" placeholder=${t("tasks.goalHint")} value=${f.goal} onInput=${set("goal")}></textarea>`)}
      ${field(t("tasks.scope"), html`<textarea rows="2" maxlength="600" placeholder=${t("tasks.scopeHint")} value=${f.scope} onInput=${set("scope")}></textarea>`)}
      ${field(t("tasks.definition"), html`<textarea rows="3" placeholder=${t("tasks.definitionHint")} value=${f.acceptance} onInput=${set("acceptance")}></textarea>`)}
      ${field(t("tasks.context"), html`<textarea rows="2" maxlength="1000" placeholder=${t("tasks.contextHint")} value=${f.context} onInput=${set("context")}></textarea>`)}
      <div class="tb-form-row">
        ${field(t("tasks.assignee"), html`<select value=${f.assignee} onChange=${set("assignee")}><option value="">${t("tasks.nobody")}</option>${instances.map((i) => html`<option key=${i.name} value=${i.name}>${i.name}</option>`)}</select>`)}
        ${field(t("tasks.size"), html`<select value=${f.size} onChange=${set("size")}><option value="">${t("tasks.sizeNone")}</option><option value="S">${t("tasks.sizeS")}</option><option value="M">${t("tasks.sizeM")}</option><option value="L">${t("tasks.sizeL")}</option></select>`)}
        ${field(t("tasks.priority"), html`<select value=${f.priority} onChange=${set("priority")}>${["urgent", "high", "normal", "low"].map((p) => html`<option key=${p} value=${p}>${t(`tasks.${p}`)}</option>`)}</select>`)}
      </div>
      <label class="tb-check"><input type="checkbox" checked=${f.needsReview} onChange=${set("needsReview")} />${t("tasks.reviewBox")}</label>
    </fieldset></form></${Dialog}>`;
}

/**
 * #2355 review: what an edit of a project sends — its fields, and its lead only when it changed (an unchanged retired
 * lead would be refused on an unrelated rename); "" is no lead.
 */
export function projectPatch(was, f) {
  const { leadInstance, ...rest } = f;
  return leadInstance !== (was || "") ? { ...rest, leadInstance: leadInstance || null } : rest;
}

function ProjectDialog({ project, leads = [], onClose, onSaved }) {
  const was = (project && project.leadInstance) || "";
  const [f, setF] = useState({ name: project ? project.name : "", description: project ? project.description : "", leadInstance: was });
  // #2352: a lead no longer in the fleet stays listed (marked) until it is changed; #2355 review: only the server's names.
  const leadGone = !!f.leadInstance && !leads.includes(f.leadInstance);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!f.name.trim()) return;
    setBusy(true);
    try {
      const body = projectPatch(was, f);
      const r = project ? await boardApi.updateProject(project.id, body) : await boardApi.createProject(f.name, f.description, f.leadInstance || null);
      toast(t(project ? "tasks.projectSaved" : "tasks.projectCreated"));
      onSaved(r.project);
    } catch (err) { toast(errorText(err), false); setBusy(false); }
  }
  return html`<${Dialog} title=${project ? t("tasks.rename") : t("tasks.newProject")} onClose=${onClose} busy=${busy}
    actions=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${t("tasks.cancel")}</button>
      <button type="button" class="btn btn-primary" onClick=${submit} disabled=${busy || !f.name.trim()}>${project ? t("tasks.save") : t("tasks.create")}</button>`}>
    <form class="form" onSubmit=${(e) => { e.preventDefault(); submit(); }}><fieldset class="form" disabled=${busy}>
      <label class="field"><span>${t("tasks.projectName")} *</span><input value=${f.name} maxlength="60" onInput=${(e) => { const v = e.target.value; setF((c) => ({ ...c, name: v })); }} required /></label>
      <label class="field"><span>${t("tasks.projectDesc")}</span><input value=${f.description} maxlength="300" onInput=${(e) => { const v = e.target.value; setF((c) => ({ ...c, description: v })); }} /></label>
      <label class="field"><span>${t("tasks.projectLead")}</span><select class="tb-project-lead" value=${f.leadInstance} onChange=${(e) => { const v = e.target.value; setF((c) => ({ ...c, leadInstance: v })); }}>
        <option value="">${t("tasks.projectLeadNone")}</option>
        ${leadGone ? html`<option value=${f.leadInstance}>${t("tasks.projectLeadGone", f.leadInstance)}</option>` : null}
        ${leads.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}</select>
        <small class="note">${t("tasks.projectLeadHint")}</small></label>
    </fieldset></form></${Dialog}>`;
}

/**
 * Up and down for the open card in its column — a main task among its project's main tasks of the same status, a sub
 * task among its main task's — for touch and keyboard, where a drag is not there.
 */
function placeOf(cards, id, reload) {
  const card = cards.find((c) => c.id === id);
  if (!card || card.status === "cancelled") return null;
  const column = cards.filter((c) => c.status !== "cancelled" && (card.kind === "sub"
    ? c.kind === "sub" && c.parentId === card.parentId
    : c.kind === "main" && projectKey(c) === projectKey(card) && c.status === card.status)).sort((a, b) => a.sort - b.sort);
  const i = column.findIndex((c) => c.id === id);
  const go = (after, before) => async () => { try { await boardApi.reorder(id, after, before); reload(); } catch (err) { toast(errorText(err), false); } };
  return {
    up: i > 0 ? go(column[i - 2]?.id ?? null, column[i - 1].id) : null,
    down: i >= 0 && i < column.length - 1 ? go(column[i + 1].id, column[i + 2]?.id ?? null) : null,
  };
}
