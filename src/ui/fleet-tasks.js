// The task board (Fleet › Tasks): projects → main tasks (M-) → sub tasks (S-), ported from taskhall (任務會所).
// Home lists the projects and what waits for the person; a project is a board of its main tasks by status, each able to
// open up its sub tasks; a card opens as a page of its own (fleet-task-card.js). Every write goes through /ui/tasks/* as the
// signed-in person, under the same rules an instance's task tool meets (scheduler/task-board.ts). A change from anywhere
// (an agent's tool, another tab) arrives as a "tasks" stream event with the board's revision; the board reads again
// when its revision moved. Over the temporary public link the board is read-only (the server refuses its writes there).
// A card moves by drag, by Alt+arrow keys on its title, by its ⋯ menu or its page's Status chip, up and down — touch and
// keyboard need no drag. A project shows as the board or as a list (a switch in the toolbar, with search and filters in
// the same row, fleet-task-view.js); on a phone the board shows one status at a time (a row of pills that scrolls sideways), the head and
// the toolbar are laid out for the width, and every control is a 44px box that is not drawn bigger (task-board.css). A card's ⋯ (or a right click, or the
// menu key) opens its menu; its page steps to the previous / next card (fleet-task-menu.js). The open card is in the
// address (`?card=`): opening one adds a history entry, so Back returns to the board or the list.
import { html, useEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { recordEdit } from "/assets/text-undo.js";
import { appStore } from "/assets/app-store.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { toast } from "/assets/ui-toast.js";
import { AskHost, BoardOffNote, COLUMNS, NO_PROJECT, boardReadOnly, ProgressBar, StatusPill, Who, answerBlocked, askText, boardApi, currentWork, dropNeighbours, errorText, followsSubs, moveCard, notesForPeople, onPublicLink, projectKey, projectStats, readStored, relTime, scrollBox, tileStatus, waitsForYou, waitsList, waitsOn, workersOf, wrapUpText, writeStored } from "./fleet-task-common.js";
import { CardPage, assigneeItems } from "./fleet-task-card.js";
import { CardMenu, cardAt, cardMenuItems, pageOrder, stepsOf } from "./fleet-task-menu.js";
import { ListView, NO_REACH, SubList, TaskToolbar, doneShown, formatFilters, keepFilters, listRows, mainMatches, readDisplay, scrollReach, startFilters, writeDisplay } from "./fleet-task-view.js";
import { CreateMainDialog } from "./fleet-task-create.js";
import { InstancesDrawer } from "./fleet-task-work.js";
import { RunMark, inProgressBy, runOf, useRunContext } from "./fleet-task-run.js";
import { OwnerChip, otherWorkers, quietInfo } from "./fleet-task-owner.js";
import { InsightsDialog } from "./fleet-task-stats.js";
import { ToSort, sortCount } from "./fleet-task-sort.js";
import { ArchiveDialog, ArchivedLink, ArchivedTag, DONE_PAGE, newestDone, weekLabel } from "./fleet-task-archive.js";

const PROJECT_KEY = "agend_tasks_project";
const QUERY_KEY = "agend_tasks_query";

/** The card the address names (`?card=`), or null. */
const cardInAddress = () => { try { return new URLSearchParams(globalThis.location?.search || "").get("card") || null; } catch { return null; } };


// ── The tab ───────────────────────────────────────────────

/**
 * Fleet › Tasks. `?card=M-3` in the address opens that card (a link from a notice). The project last looked at is
 * remembered on this device; on a project's board the address says which (`?tp=`) and its filters (`?tf=`), so the
 * filtered board can be sent as a link — and such a link opens it.
 */
export function TaskBoardTab({ lease }) {
  const [state, setState] = useState(null);
  // `ifMoved`: a refresh that only wants the board if its revision moved (a stream event, a reconnect).
  const [version, setVersion] = useState({ n: 0, ifMoved: false });
  // Whether this page changes the board. A guest and a read-only session over the public link only read — nothing that edits, creates or moves is
  // drawn for them (the host refuses their writes too); an admin session over the link writes as itself (M-3278), as the dashboard does.
  const writable = !boardReadOnly();
  const [at, setAtRaw] = useState(() => {
    let v = readStored(PROJECT_KEY, "");
    try { v = new URLSearchParams(globalThis.location?.search || "").get("tp") ?? v; } catch { /* no address bar */ }
    return v === "" ? null : v === NO_PROJECT ? NO_PROJECT : Number.isInteger(Number(v)) ? Number(v) : null;
  });
  const [openId, setOpenId] = useState(() => {
    try { return new URLSearchParams(globalThis.location?.search || "").get("card"); } catch { return null; }
  });
  const [tick, setTick] = useState(0);
  const [flashed, setFlashed] = useState(() => new Map());
  const [dialog, setDialog] = useState(null);
  // A card's menu ({ card, x, y, el }), and the cards the page showed when a card's dialog opened (its Previous / Next).
  const [menu, setMenu] = useState(null);
  // The assignee picker a tile's or a row's avatar opens ({ id, x, y, el, names }), the card page's list of choices.
  const [ownerMenu, setOwnerMenu] = useState(null);
  const [trail, setTrail] = useState(() => []);
  // How a project shows (board or list, …) and its filters: remembered on this device, the filters also in the address.
  const [display, setDisplayRaw] = useState(readDisplay);
  const [filters, setFiltersRaw] = useState(() => startFilters(globalThis.location?.search));
  // The project's search words, kept on this device with the filters and the view (and cleared on the way to another project).
  const [query, setQueryRaw] = useState(() => readStored(QUERY_KEY, ""));
  const setQuery = (q) => { setQueryRaw(q); writeStored(QUERY_KEY, q === "" ? null : q); };
  const setDisplay = (d) => { setDisplayRaw(d); writeDisplay(d); };
  const setFilters = (f) => { setFiltersRaw(f); keepFilters(f); };
  // Finished cards "All": every done main task is read only when asked for (the server keeps recent ones otherwise).
  const allDone = display.done === "all";
  const seq = useRef(0);
  const setAt = (v) => { setAtRaw(v); setQuery(""); writeStored(PROJECT_KEY, v === null ? null : String(v)); };
  const reload = (ifMoved = false) => setVersion((v) => ({ n: v.n + 1, ifMoved }));
  const shown = useRef({ rev: null, epoch: null, allDone: false });

  useEffect(() => {
    const mine = ++seq.current;
    (async () => {
      try {
        const q = new URLSearchParams();
        if (allDone) q.set("done", "all");
        // The same board at the same revision is not sent again.
        if (version.ifMoved && shown.current.rev !== null && shown.current.allDone === allDone) {
          q.set("rev", String(shown.current.rev));
          // #4428 review: and where time had left the board's lines (a card archived since is a new board).
          if (shown.current.epoch !== null) q.set("epoch", shown.current.epoch);
        }
        const qs = q.toString();
        const r = await lease.fetch(`/ui/tasks/board${qs ? `?${qs}` : ""}`, { method: "GET", headers: { "Content-Type": "application/json" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (!lease.current() || mine !== seq.current || d.unchanged) return;
        shown.current = { rev: typeof d.rev === "number" ? d.rev : null, epoch: typeof d.epoch === "string" ? d.epoch : null, allDone };
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

  // The project and its filters in the address (Home has neither), for a link to this very board.
  useEffect(() => {
    try {
      const u = new URL(globalThis.location.href);
      const before = u.search;
      const f = formatFilters(filters);
      if (at === null) { u.searchParams.delete("tp"); u.searchParams.delete("tf"); }
      else { u.searchParams.set("tp", String(at)); if (f) u.searchParams.set("tf", f); else u.searchParams.delete("tf"); }
      if (u.search !== before) globalThis.history.replaceState(globalThis.history.state, "", u);
    } catch { /* no address bar */ }
  }, [at, filters]);

  // The open card is in the address. Opening one from the board adds a history entry (Back returns to the board or the
  // list), and so does opening another from the card (a sub task, a dependency); stepping to the previous / next card
  // replaces it. The entry says how many cards deep it is, so "Back" on the page can go all the way to the board.
  const depthNow = () => { try { const d = globalThis.history.state && globalThis.history.state.tbCard; return Number.isInteger(d) ? d : 0; } catch { return 0; } };
  const putCard = (id, replace) => {
    try {
      const u = new URL(globalThis.location.href);
      if (id === null) u.searchParams.delete("card"); else u.searchParams.set("card", id);
      if (/^#c\d+$/.test(u.hash)) u.hash = "";           // a comment's anchor (#c42) belongs to the card it was made for
      const depth = id === null ? 0 : replace ? Math.max(1, depthNow()) : depthNow() + 1;
      const state = id === null ? null : { ...(globalThis.history.state || {}), tbCard: depth };
      if (replace || id === null) globalThis.history.replaceState(state, "", u); else globalThis.history.pushState(state, "", u);
    } catch { /* no address bar */ }
  };
  const openCard = (id, replace = false) => {
    if (!openId) { setTrail(pageOrder()); rememberScroll(); }   // the cards the page shows now are the walk (Previous / Next)
    setOpenId(id);
    putCard(id, replace && !!openId);
  };
  const stepToCard = (id) => openCard(id, true);
  const lastOpen = useRef(null);      // the card whose page was just left: its tile or row takes the focus back
  const openRef = useRef(openId);
  openRef.current = openId;
  const closeCard = () => {
    const depth = depthNow();
    lastOpen.current = openId;
    setTrail([]);
    if (depth > 0) { try { globalThis.history.go(-depth); return; } catch { /* fall through: just drop the address */ } }
    setOpenId(null);
    putCard(null, true);
  };
  // Back and Forward bring the card the address names (or the board).
  useEffect(() => {
    const onPop = () => { const id = cardInAddress(); if (!id && openRef.current) lastOpen.current = openRef.current; setOpenId(id); if (!id) setTrail([]); };
    if (typeof window === "undefined") return undefined;
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // The board is where it was left when Back brings it again.
  const scrolled = useRef(null);
  const rememberScroll = () => { try { scrolled.current = scrollBox()?.scrollTop ?? null; } catch { scrolled.current = null; } };
  useEffect(() => {
    if (openId) return;
    if (scrolled.current !== null) {
      const box = scrollBox(), top = scrolled.current;
      scrolled.current = null;
      if (box) box.scrollTop = top;
    }
    const id = lastOpen.current;
    if (!id) return;
    const at = document.querySelector(`[data-tile="${id}"] .tb-tile-title, [data-row="${id}"] .tb-row-title`);
    if (at) { lastOpen.current = null; at.focus({ preventScroll: true }); }
  }, [openId, state]);

  // #2246 step 3: who works on what — the drawer gives way to a card opened from it (one drawer at a time).
  const showInstances = () => setDialog({ kind: "instances" });

  if (!state) return html`<${Skeleton} lines=${5} />`;
  if (state.error) return html`<${ErrorState} message=${t("tasks.loadFailed")} onRetry=${reload} />`;
  const cards = Array.isArray(state.data.cards) ? state.data.cards : [];
  const projects = Array.isArray(state.data.projects) ? state.data.projects : [];
  // #2355 review: the names a project's lead may be, as the server accepts them (the fleet's instances).
  const leads = Array.isArray(state.data.leads) ? state.data.leads : [];
  // The instances with the task board switched off: the board hands them no cards, so the pickers do not offer them.
  const boardOff = Array.isArray(state.data.boardOff) ? state.data.boardOff : [];
  // The server's numbers cover every card (finished ones are not all on the board); computed here only without them.
  const stats = (key) => (state.data.stats && state.data.stats[String(key)]) || projectStats(key, cards);
  const project = at === null ? null : at === NO_PROJECT ? NO_PROJECT : projects.find((p) => p.id === at) || null;
  // M-3668: how many days after it finished a main task leaves the board (0: never; an older server says nothing).
  const archiveDays = typeof state.data.archiveAfterDays === "number" ? state.data.archiveAfterDays : 0;
  const body = project === null
    ? html`<${Home} cards=${cards} projects=${projects} stats=${stats} writable=${writable} onOpenProject=${setAt} onOpen=${openCard} onDialog=${setDialog} onInstances=${showInstances} reload=${reload} archiveDays=${archiveDays} />`
    : html`<${ProjectBoard} project=${project} cards=${cards} stats=${stats} flashed=${flashed} display=${display} filters=${filters} query=${query} writable=${writable}
        archiveDays=${archiveDays} onArchive=${() => setDialog({ kind: "archive", project })}
        onDisplay=${setDisplay} onFilters=${setFilters} onQuery=${setQuery} onBack=${() => setAt(null)} onMore=${openMenuFor} onOwner=${openOwnerMenu}
        notSorted=${sortCount(cards, projects)} onOpenNoProject=${() => setAt(NO_PROJECT)}
        onOpen=${openCard} onCreate=${() => setDialog({ kind: "main", project: project === NO_PROJECT ? null : project.id })} onInstances=${showInstances} reload=${reload} />`;

  /** A right click on a card, or the keyboard's menu key on it (no pointer: the menu goes under the card). */
  function onMenu(e) {
    const hit = cardAt(e);
    const card = hit && cards.find((c) => c.id === hit.id);
    if (!card) return;
    e.preventDefault();
    let x = e.clientX || 0, y = e.clientY || 0;
    if (!x && !y && typeof hit.el.getBoundingClientRect === "function") { const r = hit.el.getBoundingClientRect(); x = r.left + 8; y = r.bottom; }
    setMenu({ id: card.id, x, y, el: hit.el });
  }
  /** A card's ⋯ button (board tile, list row): the same menu as a right click, under the button — for touch, which has no right click. */
  function openMenuFor(card, el) {
    const r = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : { left: 0, bottom: 0 };
    setMenu({ id: card.id, x: r.left, y: r.bottom, el });
  }
  /** The avatar of a tile or a row: the card page's assignee picker, under the button (the instances as the page knows them now). */
  function openOwnerMenu(card, el) {
    const r = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : { left: 0, bottom: 0 };
    const names = (appStore.get().instances || []).map((i) => i.name);
    setMenu(null);
    setOwnerMenu({ id: card.id, x: r.left, y: r.bottom, el, names });
  }
  function closeOwnerMenu(refocus) {
    const el = ownerMenu && ownerMenu.el;
    setOwnerMenu(null);
    if (refocus && el && document.contains?.(el)) { quietInfo(); el.focus?.(); }
  }
  /**
   * A new assignee for a card (a name, null for nobody, or "\u0000other" to ask for any name) — the menu's and the avatar's, one
   * write with the version the board showed: a card changed since (409) says so as the card page does, and the board reads again.
   */
  async function assignTo(card, value) {
    try {
      const name = value === "\u0000other" ? await askText({ title: t("taskcard.otherTitle"), label: t("taskcard.otherLabel"), required: true }) : value;
      if (value === "\u0000other" && !name) return;
      const r = await boardApi.update(card.id, { assignee: name, version: card.version });
      for (const n of notesForPeople(r.notes)) toast(n);
      reload();
    } catch (err) {
      if (err.status === 409) { toast(t("taskowner.conflict", card.id), false); reload(); } else toast(errorText(err), false);
    }
  }
  function closeMenu(refocus) {
    const el = menu && menu.el;
    setMenu(null);
    if (refocus && el && document.contains?.(el)) (el.querySelector(".tb-tile-title, .tb-row-title, .tb-wait-title") || el.querySelector("button") || el).focus?.();
  }
  /** A menu choice, through the calls and questions the card's dialog uses. */
  async function menuAct(card, a) {
    const after = (r, said) => { if (r) { if (said) toast(t(said, card.id)); reload(); } };
    try {
      if (a.kind === "open") openCard(card.id);
      else if (a.kind === "confirm") after(await moveCard(card, "done"), "tasks.confirmed");
      else if (a.kind === "sendBack") after(await moveCard(card, "claimed"), "tasks.sentBack");
      else if (a.kind === "answer") after(await answerBlocked(card), "tasks.answered");
      else if (a.kind === "move") after(await moveCard(card, a.to));
      else if (a.kind === "cancel") after(await moveCard(card, "cancelled"));
      else if (a.kind === "assign") await assignTo(card, a.value);
      else if (a.kind === "assignOther") await assignTo(card, "\u0000other");
      else if (a.kind === "priority") {
        const r = await boardApi.update(card.id, { priority: a.value, version: card.version });
        for (const n of notesForPeople(r.notes)) toast(n);
        reload();
      } else if (a.kind === "copyLink" || a.kind === "copyId") {
        const u = new URL(globalThis.location.href);
        u.searchParams.set("card", card.id);
        const text = a.kind === "copyLink" ? u.toString() : card.id;
        // Without a clipboard (a plain-http address) the text is shown to copy by hand.
        if (navigator.clipboard) { await navigator.clipboard.writeText(text); toast(t("taskmenu.copied", text)); } else toast(text);
      }
    } catch (err) { toast(errorText(err), false); }
  }
  const menuCard = menu ? cards.find((c) => c.id === menu.id) : null;
  const ownerCard = ownerMenu ? cards.find((c) => c.id === ownerMenu.id) : null;
  // The assignees a card's menu offers: who has cards in its project (Other… names anyone else).
  const names = menuCard ? cards.filter((c) => projectKey(c) === projectKey(menuCard) && c.assignee).map((c) => c.assignee) : [];

  // The card's breadcrumb: its project (a sub task's is its main task's).
  const openCardRow = openId ? cards.find((c) => c.id === openId) : null;
  const rootRow = openCardRow && openCardRow.kind === "sub" ? cards.find((c) => c.id === openCardRow.parentId) : openCardRow;
  const where = rootRow ? (rootRow.projectId === null || rootRow.projectId === undefined ? t("tasks.noProject") : (projects.find((p) => p.id === rootRow.projectId) || {}).name || null) : null;

  return html`<div class="tb" onContextMenu=${onMenu}>
    ${writable ? null : html`<p class="tb-readonly" role="note"><${Icon} name="eye" size=${16} />${t("tasks.readOnly")}</p>`}
    ${writable && !openId ? html`<${BoardOffNote} names=${boardOff} />` : null}
    ${openId ? html`<${CardPage} key=${openId} id=${openId} tick=${tick} projects=${projects} cards=${cards} boardOff=${boardOff} doing=${inProgressBy(cards)} writable=${writable} place=${writable ? placeOf(cards, openId, reload) : null}
      steps=${stepsOf(trail, openId, cards)} where=${where} back=${t(display.view === "list" ? "taskcard.backList" : "taskcard.backBoard")}
      onBack=${closeCard} onOpen=${openCard} onStep=${stepToCard} reloadBoard=${reload} />` : body}
    ${menuCard ? html`<${CardMenu} at=${{ x: menu.x, y: menu.y }} label=${t("taskmenu.label", menuCard.id)} onClose=${closeMenu}
      items=${cardMenuItems(menuCard, { writable, names, act: (a) => menuAct(menuCard, a) })} />` : null}
    ${ownerCard ? html`<${CardMenu} at=${{ x: ownerMenu.x, y: ownerMenu.y }} label=${t("taskowner.changeOf", ownerCard.assignee || t("tasks.nobody"))} onClose=${closeOwnerMenu}
      items=${assigneeItems(ownerCard, ownerMenu.names, boardOff, (v) => void assignTo(ownerCard, v))} />` : null}
    ${dialog && dialog.kind === "main" ? html`<${CreateMainDialog} projects=${projects} project=${dialog.project} boardOff=${boardOff} onClose=${() => setDialog(null)}
      onCreated=${(id) => { if (!lease.current()) return; setDialog(null); reload(); openCard(id); }} />` : null}
    ${dialog && dialog.kind === "instances" ? html`<${InstancesDrawer} tick=${tick} onClose=${() => setDialog(null)} onOpen=${(id) => { setDialog(null); openCard(id); }} />` : null}
    ${dialog && dialog.kind === "archive" ? html`<${ArchiveDialog} project=${dialog.project === NO_PROJECT ? "none" : dialog.project.id}
      name=${dialog.project === NO_PROJECT ? t("tasks.noProject") : dialog.project.name} days=${archiveDays} onClose=${() => setDialog(null)}
      onOpen=${(c) => { setDialog(null); openCard(c.id); }}
      fetchJson=${async (url) => { const r = await lease.fetch(url, { method: "GET" }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }} />` : null}
    ${dialog && dialog.kind === "project" ? html`<${ProjectDialog} project=${dialog.project} leads=${leads} onClose=${() => setDialog(null)}
      onSaved=${(p) => { if (!lease.current()) return; setDialog(null); reload(); if (!dialog.project) setAt(p.id); }} />` : null}
    <${AskHost} />
  </div>`;
}

// ── Home: the projects, and what waits for the person ─────────

/** The board's Instance button (taskhall's): the fleet's instances and what each works on. */
function InstancesButton({ onClick }) {
  // The label is its own span: a phone narrower than 390px keeps only the icon (the label stays for a screen reader), so the head fits.
  return html`<button type="button" class="btn" title=${t("tasks.instancesTip")} onClick=${onClick}><${Icon} name="team" size=${16} /><span class="tb-btn-label">${t("tasks.instances")}</span></button>`;
}

function Home({ cards, projects, stats, writable, onOpenProject, onOpen, onDialog, onInstances, reload, archiveDays = 0 }) {
  const [showArchived, setShowArchived] = useState(false);
  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);
  const loose = stats(NO_PROJECT).mains > 0;
  // Cards with no project, while the board has projects to put them in: the list below, and the tile first with its badge.
  const toSort = sortCount(cards, projects);
  const looseTile = loose ? html`<${ProjectTile} project=${null} stats=${stats(NO_PROJECT)} sorting=${toSort} onOpen=${() => onOpenProject(NO_PROJECT)} />` : null;
  return html`<div class="tb-home">
    <div class="list-head tb-head s-page-head"><div class="s-page-title"><h2>${t("tasks.projects")}</h2></div>
      <div class="tb-head-actions">
        <${SearchBox} onOpen=${onOpen} archiveDays=${archiveDays} />
        <${InstancesButton} onClick=${onInstances} />
        ${writable ? html`<button type="button" class="btn btn-primary" onClick=${() => onDialog({ kind: "project", project: null })}><${Icon} name="plus" size=${16} />${t("tasks.newProject")}</button>` : null}</div>
    </div>
    <${Waiting} cards=${cards} writable=${writable} onOpen=${onOpen} reload=${reload} />
    <${ToSort} cards=${cards} projects=${projects} writable=${writable} onOpen=${onOpen} onOpenNoProject=${() => onOpenProject(NO_PROJECT)} reload=${reload} />
    ${active.length || loose ? html`<div class="tb-projects">
      ${toSort ? looseTile : null}
      ${active.map((p) => html`<${ProjectTile} key=${p.id} project=${p} stats=${stats(p.id)} onOpen=${() => onOpenProject(p.id)} onDialog=${writable ? onDialog : null} reload=${reload} />`)}
      ${toSort ? null : looseTile}
    </div>` : html`<${Empty} icon="tasks" title=${t("tasks.noProjects")} hint=${t("tasks.noProjectsHint")} />`}
    ${archived.length ? html`<div class="tb-archived">
      <button type="button" class="btn btn-ghost btn-sm" aria-expanded=${showArchived ? "true" : "false"} onClick=${() => setShowArchived(!showArchived)}>
        <${Icon} name="chevron" size=${14} cls=${showArchived ? "tb-chev open" : "tb-chev"} />${t("tasks.archived")} (${archived.length})</button>
      ${showArchived ? html`<div class="tb-projects">${archived.map((p) => html`<${ProjectTile} key=${p.id} project=${p} stats=${stats(p.id)} onOpen=${() => onOpenProject(p.id)} onDialog=${writable ? onDialog : null} reload=${reload} />`)}</div>` : null}
    </div>` : null}
  </div>`;
}

function ProjectTile({ project, stats, sorting = 0, onOpen, onDialog, reload }) {
  async function setArchived(archived) {
    try { await boardApi.updateProject(project.id, { archived }); toast(t("tasks.projectSaved")); reload(); } catch (err) { toast(errorText(err), false); }
  }
  const name = project ? project.name : t("tasks.noProject");
  const desc = project ? project.description : t("tasks.noProjectDesc");
  return html`<div class=${`tb-project${project && project.archived ? " is-archived" : ""}${sorting ? " needs-sort" : ""}`}>
    <button type="button" class="tb-project-open" onClick=${onOpen}>
      <span class="tb-project-name">${name}</span>
      ${desc ? html`<span class="tb-project-desc">${desc}</span>` : null}
      <span class="tb-project-pct" title=${t("tasks.percentTitle")}><span class="tb-pct">${stats.percent}%</span><${ProgressBar} progress=${stats.units} wide /></span>
      <span class="tb-project-meta">
        <span>${stats.mains === 1 ? t("tasks.mainOne") : t("tasks.mainCount", stats.mains)}</span>
        ${sorting ? html`<span class="tb-flag st-review tb-sort-flag">${t("tasksort.tileBadge", sorting)}</span>` : null}
        ${stats.waiting ? html`<span class="tb-flag st-review">${t("tasks.waiting", stats.waiting)}</span>` : null}
        ${stats.blocked ? html`<span class="tb-flag st-blocked">${t("tasks.blockedN", stats.blocked)}</span>` : null}
        ${stats.archived ? html`<span class="muted tb-project-archived">${t("tasksArchive.tile", stats.archived)}</span>` : null}
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
 * Cards waiting for the person: to confirm or send back, and blocked ones to answer — #2080: only those the person
 * handed out (waitsForYou, Needs you's rule); an agent's card in review is its confirmer's, and a blocked one asks its
 * dispatcher, not the person. A card's buttons take one answer at a time: claimed before the first await, so a double
 * click sends one move.
 */
function Waiting({ cards, writable, onOpen, reload }) {
  const pending = useRef(new Set());
  const [busy, setBusy] = useState(() => new Set());
  const review = cards.filter((c) => c.status === "review" && waitsForYou(c));
  const blocked = cards.filter((c) => c.status === "blocked" && waitsForYou(c));
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
    <ul class="rows">${[...review, ...blocked].map((c) => html`<li key=${c.id} class="row-item tb-wait-row" data-wait=${c.id}>
      <div class="tb-wait-main">
        <${StatusPill} status=${c.status} />
        <button type="button" class="tb-wait-title" onClick=${() => onOpen(c.id)}><span class="tb-code">${c.id}</span> ${c.title}
          ${c.status === "blocked" && c.blockedReason ? html`<span class="tb-wait-reason">${c.blockedReason}</span>` : null}
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

function SearchBox({ onOpen, archiveDays = 0 }) {
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
          <span class="tb-code">${r.card.id}</span><span class="tb-search-title">${r.card.title}</span><${StatusPill} status=${r.card.status} card=${r.card} />${r.archived ? html`<${ArchivedTag} days=${archiveDays} />` : null}
          <span class="tb-search-where muted">${[r.project, r.parentTitle].filter(Boolean).join(" › ")}${r.match ? ` · ${t("tasks.inField", t(`tasks.field${r.match.field}`))}: ${r.match.text}` : ""}</span>
        </button></li>`) : html`<li class="muted tb-search-none">${t("tasks.searchEmpty")}</li>`}
    </ul>` : null}
  </div>`;
}

// ── A project's board ─────────────────────────────────────

function ProjectBoard({ project, cards, stats: statsOf, flashed, display, filters, query, writable, notSorted = 0, onOpenNoProject, onDisplay, onFilters, onQuery, onBack, onOpen, onMore, onOwner, onCreate, onInstances, reload, archiveDays = 0, onArchive = null }) {
  const [expanded, setExpanded] = useState({});
  // M-3668: the Done column (and the list's done rows) shows its newest DONE_PAGE, DONE_PAGE more at a time.
  const [doneLimit, setDoneLimit] = useState(DONE_PAGE);
  // A phone shows one status at a time: the one picked here, else the first that has cards (the person's own first).
  const [phoneStatus, setPhoneStatus] = useState(null);
  const [drag, setDrag] = useState(null);
  const [spot, setSpot] = useState(null);
  const key = project === NO_PROJECT ? NO_PROJECT : project.id;
  // The project's lead instance (the owner info card says so of the instance that is it).
  const lead = project === NO_PROJECT ? null : project.leadInstance || null;
  const archived = project !== NO_PROJECT && project.archived;
  const [insights, setInsights] = useState(false);
  const stats = statsOf(key);
  const now = Date.now();

  const subsOf = useMemo(() => {
    const m = new Map();
    for (const c of cards) if (c.kind === "sub" && c.parentId && c.status !== "cancelled") m.set(c.parentId, [...(m.get(c.parentId) || []), c]);
    return m;
  }, [cards]);
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  // What each instance with a card in progress is doing, and how many cards it has — one read of the store for
  // the whole board; a tile or row says "running" only when it is the instance's one.
  const runs = useRunContext(cards);
  const live = cards.filter((c) => c.kind === "main" && projectKey(c) === key && c.status !== "cancelled");
  // What the filters offer: this project's main tasks and their sub tasks.
  const own = live.flatMap((c) => [c, ...(subsOf.get(c.id) || [])]);
  const matched = live.filter((c) => doneShown(c, display.done, now) && mainMatches(c, subsOf.get(c.id), filters, query));
  const doneAll = newestDone(matched.filter((c) => c.status === "done"));
  const doneCut = new Set(doneAll.slice(doneLimit).map((c) => c.id));
  // What the page draws: every unfinished main task, the newest finished ones; `matched` still counts them all.
  const mains = matched.filter((c) => !doneCut.has(c.id));
  const moreDone = doneCut.size ? html`<button type="button" class="btn btn-sm tb-done-more" onClick=${() => setDoneLimit((n) => n + DONE_PAGE)}>${t("tasksArchive.showMore", Math.min(DONE_PAGE, doneCut.size))}</button>` : null;
  const searching = filters.length > 0 || query.trim() !== "";
  // Finished cards hidden: no Done column (a card is still confirmed or finished from its dialog).
  const columns = display.done === "hide" ? COLUMNS.filter((s) => s !== "done") : COLUMNS;
  const current = columns.includes(phoneStatus) ? phoneStatus : ["review", "claimed", "blocked", "open", "done"].find((s) => columns.includes(s) && mains.some((c) => c.status === s)) || columns[0];
  const toggleSubs = (id) => setExpanded({ ...expanded, [id]: !expanded[id] });
  // Nothing left by a search says so, with the way out (the search is kept on the device, so a reload would show it again).
  const empty = () => html`<${Empty} icon="tasks" title=${searching ? t("tasks.emptyFiltered") : t("tasks.emptyBoard")} hint=${searching || archived ? undefined : t("tasks.emptyBoardHint")}
    action=${query.trim() !== "" ? html`<button type="button" class="btn" onClick=${() => onQuery("")}>${t("taskview.clearSearch")}</button>` : null} />`;
  // Insights counts what the page shows. A list with sub-task rows shows exactly its rows (each matched by the filter, a
  // finished one as Done shows it); the board, or a list without them, shows a main task with all its sub tasks.
  const insightCards = () => (display.view === "list" && display.subs
    ? listRows(matched, subsOf, display, filters, now, query)
    : matched.flatMap((c) => [c, ...(subsOf.get(c.id) || [])]));
  const listBody = () => {
    const rows = listRows(mains, subsOf, display, filters, now, query);
    return rows.length === 0 ? empty() : html`<${ListView} rows=${rows} display=${display} subsOf=${subsOf} byId=${byId} flashed=${flashed} now=${now} runs=${runs}
      expanded=${expanded} onToggleSubs=${toggleSubs} onOpen=${onOpen} onMore=${onMore} onOwner=${onOwner} cards=${cards} lead=${lead} writable=${writable} onDisplay=${onDisplay} scope=${String(key)} />${moreDone}`;
  };

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
  // The columns scroll sideways when they do not fit (at 1366 px the fourth is cut and the fifth is out of sight). A platform may hide its
  // scrollbar until it is used, so while some columns are out of sight the toolbar has buttons that scroll them.
  const scrollEl = useRef(null);
  const [reach, setReach] = useState(NO_REACH);
  const showsColumns = display.view !== "list" && mains.length > 0;
  // On a phone the statuses are one row of pills that scrolls sideways: the picked one is brought into view (the first time at
  // once, then smoothly) — by the person's tap, or because it is the status that opens first (Review may be the fourth).
  const pillRow = useRef(null);
  const pillsSeen = useRef(false);
  useEffect(() => {
    const row = pillRow.current;
    const on = row && row.querySelector(".tb-seg-btn.active");
    if (!on || !row.clientWidth || row.scrollWidth <= row.clientWidth + 1) return;   // not drawn (a desk), or all of it fits
    const a = on.getBoundingClientRect(), b = row.getBoundingClientRect();
    const left = row.scrollLeft + (a.left - b.left) - (b.width - a.width) / 2;
    const calm = !pillsSeen.current || !!(globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches);
    pillsSeen.current = true;
    if (typeof row.scrollTo === "function") row.scrollTo({ left, behavior: calm ? "auto" : "smooth" }); else row.scrollLeft = left;
  }, [current, showsColumns]);
  useEffect(() => {
    const el = scrollEl.current;
    if (!showsColumns || !el) { setReach(NO_REACH); return undefined; }
    const measure = () => {
      const next = scrollReach(el);
      setReach((r) => (r.over === next.over && r.left === next.left && r.right === next.right ? r : next));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (watch) { watch.observe(el); if (el.firstElementChild) watch.observe(el.firstElementChild); }
    return () => { el.removeEventListener("scroll", measure); if (watch) watch.disconnect(); };
  }, [showsColumns, columns.length]);
  const scrollColumns = (direction) => {
    const el = scrollEl.current;
    if (!el) return;
    const step = Math.max(272, Math.round(el.clientWidth * 0.8));
    const calm = !!(globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (typeof el.scrollBy === "function") el.scrollBy({ left: direction * step, behavior: calm ? "auto" : "smooth" });
    else el.scrollLeft += direction * step;
  };
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
      const to = columns[columns.indexOf(card.status) + (e.key === "ArrowLeft" ? -1 : 1)];
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
    <div class="tb-bar-head s-page-head">
      <div class="tb-head-main">
        <div class="tb-title s-page-title">
          <button type="button" class="btn btn-ghost btn-sm tb-head-back" onClick=${onBack}><${Icon} name="back" size=${16} />${t("tasks.back")}</button>
          <div class="tb-name">
            <h2>${project === NO_PROJECT ? t("tasks.noProject") : project.name}</h2>
            ${archived ? html`<span class="s-scope">${t("tasks.archived")}</span>` : null}
          </div>
        </div>
        ${project !== NO_PROJECT && project.description ? html`<p class="s-page-lead tb-head-lead">${project.description}</p>` : null}
        ${project === NO_PROJECT ? html`<p class="s-page-lead tb-head-lead">${t("tasksort.placeLead")}</p>` : null}
        <div class="tb-stats" title=${t("tasks.percentTitle")}>
          <div class="tb-progress">
            <span class="tb-pct">${stats.percent}%</span><${ProgressBar} progress=${stats.units} />
            <span class="muted">${stats.mains === 1 ? t("tasks.mainOne") : t("tasks.mainCount", stats.mains)}</span>
            ${stats.waiting ? html`<span class="tb-flag st-review">${t("tasks.waiting", stats.waiting)}</span>` : null}
            ${stats.blocked ? html`<span class="tb-flag st-blocked">${t("tasks.blockedN", stats.blocked)}</span>` : null}
          </div>
          ${project !== NO_PROJECT && notSorted ? html`<button type="button" class="tb-flag st-review tb-sort-link" title=${t("tasksort.headerLinkTip")} onClick=${onOpenNoProject}><${Icon} name="inbox" size=${16} /><span class="tb-sort-link-short">${t("tasksort.headerLink", notSorted)}</span><span class="tb-sort-link-long">${t("tasksort.title", notSorted)}</span><span class="tb-sort-link-go">${t("tasksort.go")}</span> →</button>` : null}
          <${ArchivedLink} count=${stats.archived} days=${archiveDays} onOpen=${onArchive} />
          <button type="button" class="btn btn-ghost btn-sm tb-insights" title=${t("taskstats.buttonTip")} onClick=${() => setInsights(true)}><${Icon} name="chart" size=${16} />${t("taskstats.button")}</button>
        </div>
      </div>
      <div class="tb-head-actions">
        <${InstancesButton} onClick=${onInstances} />
        ${archived || !writable ? null : html`<button type="button" class="btn btn-primary" onClick=${onCreate}><${Icon} name="plus" size=${16} />${t("tasks.newMain")}</button>`}
      </div>
    </div>
    <${TaskToolbar} cards=${own} display=${display} onDisplay=${onDisplay} filters=${filters} onFilters=${onFilters} query=${query} onQuery=${onQuery} archiving=${archiveDays > 0}
      scroller=${display.view === "list" ? null : { reach, by: scrollColumns }} />
    ${display.view === "list" ? listBody() : mains.length === 0 && !drag ? empty()
    : html`${html`<div class="tb-seg tb-status-seg" role="group" aria-label=${t("taskview.statusTabs")} ref=${pillRow}>${columns.map((status) => {
        const count = (status === "done" ? doneAll : mains.filter((c) => c.status === status)).length;
        return html`<button key=${status} type="button" aria-pressed=${current === status ? "true" : "false"} class=${`tb-seg-btn${current === status ? " active" : ""}${count === 0 ? " is-empty" : ""}`}
          onClick=${() => setPhoneStatus(status)}><span class=${`tb-dot st-${status}`} aria-hidden="true"></span>${t(`tasks.${status}`)} <span class="tb-count">${count}</span></button>`;
      })}</div>`}
      <div class="tb-scroll" ref=${scrollEl}><div class="tb-columns">
      ${columns.map((status) => {
        const list = status === "done" ? doneAll.slice(0, doneLimit) : mains.filter((c) => c.status === status);
        const line = spot && spot.status === status ? spot.index : -1;
        return html`<section key=${status} class=${`tb-col st-${status}${status === current ? " is-current" : ""}${drag ? " can-drop" : ""}${line >= 0 ? " over" : ""}`} aria-label=${t(`tasks.${status}`)}
          onDragOver=${(e) => over(e, status)} onDrop=${(e) => dropOn(e, status, list)}>
          <h3 class="tb-col-head"><span class="tb-dot"></span>${t(`tasks.${status}`)}
            ${status === "done" && archiveDays === 0 ? html`<button type="button" class="tb-link" title=${t("tasks.toggleDone")} onClick=${() => onDisplay({ ...display, done: display.done === "all" ? "recent" : "all" })}>${display.done === "all" ? t("tasks.all") : t("tasks.recent")}</button>` : null}
            <span class="tb-count">${status === "done" ? doneAll.length : list.length}</span></h3>
          ${status === "done" && archiveDays > 0 ? html`<p class="muted tb-done-week tb-done-week-line" title=${t("tasksArchive.weekTip")}>${weekLabel(stats)}</p>` : null}
          ${cellItems(list, drag ? drag.id : null, line, (card, dragging) => {
            const lit = Math.max(flashed.get(card.id) || 0, ...(subsOf.get(card.id) || []).map((s) => flashed.get(s.id) || 0));
            return html`<${Tile} key=${card.id} card=${card} dragging=${dragging} flash=${now - lit < 4000} subs=${subsOf.get(card.id)} runs=${runs} writable=${writable} cards=${cards} lead=${lead}
              expanded=${!!expanded[card.id]} onToggleSubs=${() => toggleSubs(card.id)}
              onOpen=${onOpen} onMore=${onMore} onOwner=${onOwner} onKeyMove=${(e) => keyMove(card, e)}
              onDragStart=${(e) => { e.dataTransfer.setData("text/plain", card.id); e.dataTransfer.effectAllowed = "move"; setDrag(card); }} onDragEnd=${end} />`;
          })}
          ${status === "done" ? moreDone : null}
        </section>`;
      })}
    </div></div>`}
    ${insights ? html`<${InsightsDialog} name=${project === NO_PROJECT ? t("tasks.noProject") : project.name} onClose=${() => setInsights(false)}
      cards=${insightCards()} />` : null}
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

/** A main task's sub task at work, blocked or next, in one line: its label, number and title (+ how many more). */
function NowLine({ now, label = true }) {
  return html`<div class="tb-tile-now" title=${now.cards.map((c) => `${c.id} ${c.title}`).join("\n")}>
    ${label ? html`<span class=${`tb-now-label st-${now.tone}`}>${t(now.label)}</span>` : null}<span class="tb-code">${now.cards[0].id}</span>
    <span class="tb-now-title">${now.cards[0].title}</span>${now.cards.length > 1 ? html`<span class="muted">${t("tasks.moreCards", now.cards.length - 1)}</span>` : null}</div>`;
}

/**
 * A card on the board: rows from the top — the number, the priority and the size (and ⋯); the title (two lines at
 * most, its whole text the tooltip); ONE line of status (`tileStatus`: why it is stuck, whom it waits for, what runs, what is
 * next, the sub tasks' progress); the foot with the assignee (a button: the card page's picker, and an info card on hover) and
 * the counts. The tile is as tall as its content; a main task can open up its sub tasks. No coloured bar at its left edge.
 * A card whose agent is running says so with the "Running" mark in its status line (and keeps its accent edge and tint).
 */
function Tile({ card, dragging, flash, subs = [], runs, expanded, writable, cards, lead, onToggleSubs, onOpen, onMore, onOwner, onKeyMove, onDragStart, onDragEnd }) {
  const accepted = card.acceptance.filter((a) => a.done).length;
  const progress = card.progress;
  const hasSubs = !!progress && progress.total > 0;
  // The board carries only recently finished sub tasks; older ones are counted, not listed.
  const older = hasSubs ? progress.total - subs.length : 0;
  const replied = card.lastComment && card.lastComment.authorKind !== "person";
  const gap = card.status === "review" ? wrapUpText(card) : "";
  // Who works on a main task now (a step may be its reviewer's), rather than who owns it.
  const now = hasSubs ? currentWork(card, subs) : null;
  const workers = now ? otherWorkers(workersOf(now.cards), card.assignee || "") : [];
  // Its assignee (or, for a main task, a sub task's) is working on it now.
  const run = runOf(card, runs, subs);
  const running = !!run && run.state === "working" && !run.shared;
  const status = tileStatus(card, { now, run, hasSubs });
  const toggle = (e) => { e.stopPropagation(); onToggleSubs(); };
  const toggleTitle = expanded ? t("tasks.hideSubs") : t("tasks.showSubs");
  // The tile is a group, not a button: its title is the control (keyboard, screen readers); a click anywhere opens it.
  return html`<div class=${`tb-tile st-${card.status}${dragging ? " dragging" : ""}${flash ? " flash" : ""}${running ? " running" : ""}`} data-tile=${card.id}
    draggable=${writable} onDragStart=${writable ? onDragStart : undefined} onDragEnd=${writable ? onDragEnd : undefined}
    onClick=${(e) => { if (e.target && e.target.closest && e.target.closest(".tb-owner-pop")) return; onOpen(card.id); }}>
    <div class="tb-tile-top">
      <span class="tb-code">${card.id}</span>
      ${card.priority === "urgent" || card.priority === "high" ? html`<span class=${`tb-tag p-${card.priority}`}>${t(card.priority === "urgent" ? "tasks.urgentTag" : "tasks.highTag")}</span>` : null}
      <span class="tb-tile-tags">
        ${card.kind === "sub" && card.needsReview && card.status !== "done" ? html`<span class="tb-tag st-review" title=${t("tasks.needsReviewTitle")}>${t("tasks.needsReview")}</span>` : null}
        ${gap ? html`<span class="tb-tag wrapup" title=${t("tasks.wrapLine", gap)}>${t("tasks.wrapTag")}</span>` : null}
      </span>
      <span class="tb-grow"></span>
      ${card.size ? html`<span class="tb-size" title=${t("tasks.size")}>${t(`tasks.size${card.size}`)}</span>` : null}
      ${onMore ? html`<button type="button" class="icon-btn tb-more tb-tile-more" aria-label=${t("taskview.more")} title=${t("taskview.more")}
        onClick=${(e) => { e.stopPropagation(); onMore(card, e.currentTarget); }}><${Icon} name="more" size=${16} /></button>` : null}
    </div>
    <button type="button" class="tb-tile-title" title=${writable ? `${card.title}\n${t("tasks.tileHint")}` : card.title}
      onClick=${(e) => { e.stopPropagation(); onOpen(card.id); }} onKeyDown=${onKeyMove}><span>${card.title}</span></button>
    ${status ? html`<div class=${`tb-tile-status k-${status.kind}`}>
      ${status.kind === "blocked" ? (status.reason
          ? html`<div class="tb-tile-note st-blocked" title=${status.reason}><${Icon} name="alert" size=${13} /><span>${status.reason}</span></div>`
          : html`<${NowLine} now=${status.now} />`)
        : status.kind === "review" ? html`<div class=${`tb-tile-waits${status.you ? " you" : ""}`} title=${status.label}>${status.label}</div>`
        : status.kind === "running" ? (status.run
          ? html`<div class="tb-tile-run"><${RunMark} run=${status.run} />${status.now ? html`<${NowLine} now=${status.now} label=${false} />` : null}</div>`
          : html`<${NowLine} now=${status.now} />`)
        : status.kind === "next" ? html`<${NowLine} now=${status.now} />`
        : html`<button type="button" class="tb-tile-progress" aria-expanded=${expanded ? "true" : "false"} title=${toggleTitle} onClick=${toggle}>
            <${ProgressBar} progress=${progress} wide />
            <span>${t("tasks.subProgress", progress.done, progress.total)}</span>
            ${progress.blocked ? html`<span class="tb-flag st-blocked"><${Icon} name="alert" size=${12} />${progress.blocked}</span>` : null}
            <${Icon} name="chevron" size=${14} cls=${expanded ? "tb-chev open" : "tb-chev"} />
          </button>`}
    </div>` : null}
    ${hasSubs && expanded ? html`<${SubList} subs=${subs} older=${older} onOpen=${onOpen} />` : null}
    <div class="tb-tile-foot">
      <${OwnerChip} card=${card} cards=${cards} lead=${lead} canAssign=${writable && card.status !== "done" && card.status !== "cancelled"} onPick=${onOwner} />
      ${workers.length ? html`<span class="tb-people" title=${t("tasks.subWorkers")}><span class="tb-people-sep" aria-hidden="true">›</span>${workers.map((w) => html`<${Who} key=${w} name=${w} empty=${t("tasks.nobody")} />`)}</span>` : null}
      <span class="tb-tile-stats">
        ${hasSubs && status && status.kind !== "progress" ? html`<button type="button" class=${`tb-tile-subs${progress.blocked ? " has-blocked" : ""}`} aria-expanded=${expanded ? "true" : "false"} title=${toggleTitle} onClick=${toggle}>
          <${Icon} name="chevron" size=${13} cls=${expanded ? "tb-chev open" : "tb-chev"} />${progress.done}/${progress.total}${progress.blocked ? html`<${Icon} name="alert" size=${12} />` : null}</button>` : null}
        ${card.acceptance.length ? html`<span class=${accepted === card.acceptance.length ? "all" : ""} title=${t(card.kind === "main" ? "tasks.definition" : "tasks.acceptance")}><${Icon} name="check" size=${13} />${accepted}/${card.acceptance.length}</span>` : null}
        ${waitsOn(card) ? html`<span title=${t("tasks.waitsFor", waitsList(card, ", "))}><${Icon} name="clock" size=${13} /></span>` : null}
        ${card.commentCount ? html`<span class=${replied ? "reply" : ""} title=${replied ? t("tasks.agentReplied") : t("tasks.comments")}><${Icon} name="chat" size=${13} />${card.commentCount}</span>` : null}
        ${card.attachmentCount ? html`<span title=${t("taskfiles.title")}><${Icon} name="attach" size=${13} />${card.attachmentCount}</span>` : null}
      </span>
    </div>
  </div>`;
}

// ── Dialogs: a project (a new main task: fleet-task-create.js) ──

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
    ? c.kind === "sub" && !!card.parentId && c.parentId === card.parentId
    : c.kind === "main" && projectKey(c) === projectKey(card) && c.status === card.status)).sort((a, b) => a.sort - b.sort);
  const i = column.findIndex((c) => c.id === id);
  const go = (after, before) => async () => { try { await boardApi.reorder(id, after, before); reload(); } catch (err) { toast(errorText(err), false); } };
  return {
    up: i > 0 ? go(column[i - 2]?.id ?? null, column[i - 1].id) : null,
    down: i >= 0 && i < column.length - 1 ? go(column[i + 1].id, column[i + 2]?.id ?? null) : null,
  };
}
