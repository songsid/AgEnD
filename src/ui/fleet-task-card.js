// One card of the task board (Fleet › Tasks) as a page of its own: the main column holds what
// the card says (title, goal, scope, definition of done, context — a field nobody filled in is folded into a small "+ Add"
// button, not an empty block), what its agent wrote and does (state, result and the activity, one block: a single line while
// there is nothing to show), the sub tasks (a bordered list with its progress and a line to add one) and the card's activity —
// comments, progress log and history as one timeline, the comment box last. The side column holds the properties in three
// groups, each a chip that opens a menu (the choice saves at once). On a phone it is one column: title, spec, agent line,
// sub tasks, properties, activity. The card has an address of its own (`?card=M-3`, see fleet-tasks.js), so Back returns to
// the board or the list it was opened from.
// Edits carry the version they started from, so saving over an agent's newer write is caught (409): the page then shows
// the newer card with the draft still open, and saving again overwrites on purpose (fleet-task-edit.js).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { Empty, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { Menu } from "/assets/ui-menu.js";
import { toast } from "/assets/ui-toast.js";
import { ProgressBar, StatusPill, Who, answerBlocked, askText, boardApi, errorText, followsSubs, hiddenWaits, moveCard, notesForPeople, relTime, scrollBox, wrapUpText, COLUMNS } from "./fleet-task-common.js";
import { StepButtons, movesFor } from "./fleet-task-menu.js";
import { Checklist, EditableText, InlineTitle, PropChip, QuickAdd } from "./fleet-task-edit.js";
import { Composer, Timeline } from "./fleet-task-activity.js";
import { defaultRecipient, holdsRecipient, recipientGroups } from "./fleet-task-thread.js";
import { FilesField } from "./fleet-task-files.js";
import { AgentRun } from "./fleet-task-run.js";
import { LeaderRow, WatchersRow } from "./fleet-task-follow.js";

register("taskcard", {
  en: {
    loading: "Loading…", missing: "There is no card {0}", version: "v{0}", copyLink: "Copy this card's link", linkCopied: "Link copied",
    conflict: "{0} changed while you were editing. The newer card is shown and your edit is still open — save again to overwrite it.",
    followsSubs: "It has sub tasks: its status follows them",
    reopen: "Reopen", cancelCard: "Cancel this card", confirmMain: "Confirm the main task", moreActions: "More actions",
    assignee: "Assignee", nobody: "Unassigned", unassign: "Unassigned", other: "Other…", otherTitle: "Assign to another instance", otherLabel: "The instance's name",
    status: "Status", project: "Project", priority: "Priority", size: "Size", review: "Needs my confirmation", reviewBox: "Stop at review for my confirmation", reviewShort: "Stops at review",
    reviewOn: "Stops at review for your confirmation", reviewOff: "Finishes without your confirmation",
    parent: "Main task", deps: "Waits for", none: "None", edit: "Edit", depsTitle: "What {0} waits for", depsLabel: "Card numbers to finish first, separated by commas or spaces (empty: nothing)",
    depWaiting: "Not done yet", depDone: "Done", opened: "Opened by {0} {1} · changed {2}",
    blockedReason: "Blocked on", goal: "Goal", goalHint: "Why, and what done looks like", scope: "Scope", scopeHint: "In: … / Out: …",
    definition: "Definition of done", acceptance: "Acceptance", context: "Context", contextHint: "Paths, related cards, decisions already made",
    state: "State", stateHint: "Done / next / watch out (the assignee keeps it current)", result: "Result", resultHint: "Which files changed and how it was checked",
    empty: "(empty — click to edit)", clickToEdit: "Click to edit", editHint: "Click away or Ctrl+Enter saves · Esc drops the change",
    saving: "Saving…", notSaved: "Not saved — click away or press Ctrl+Enter to try again",
    conflictInline: "This changed meanwhile. Overwrite it with your text?", overwrite: "Overwrite", discard: "Discard my change",
    checklistEmpty: "(none yet — click to add)", editList: "Edit the list", onePerLine: "One per line; an item whose text changes is unchecked again · click away or Ctrl+Enter saves", items: "{0}/{1} items",
    subs: "Sub tasks", quickAdd: "New sub task: type a title and press Enter (small work needs no split)",
    activity: "Activity", activityShow: "Show", "show.all": "All", "show.comments": "Comments", "show.log": "Progress", "show.history": "History",
    noActivity: "Nothing yet — a comment, a progress note or a change shows here", nothingHere: "Nothing of this kind yet",
    rejectTag: "Sent back", approveTag: "Confirmed", commentTo: "Comment to {0} — @ names an instance (Ctrl+Enter sends)", commentHint: "Comment — @ names an instance (Ctrl+Enter sends)", send: "Send",
    mentionList: "Instances to mention", boardOffShort: "task board off",
    rowMoved: "changed status from {0} to {1}", rowAssigned: "changed assignee from {0} to {1}", activities: "{0} activities", activity1: "1 activity",
    logTip: "A one-line work note an agent or member wrote down — not a comment",
    evCreated: "opened it", evMoved: "{0} → {1}", evAuto: " (automatic)", evAssigned: "assignee {0} → {1}", evUpdated: "changed {0}", evCommented: "commented", evLogged: "log: {0}", evWatchers: "changed watchers: {0}",
    fTitle: "title", fGoal: "goal", fScope: "scope", fContext: "context", fState: "state", fResult: "result", fBlockedReason: "blocked reason", fSize: "size",
    fPriority: "priority", fNeedsReview: "needs review", fDependsOn: "dependencies", fAcceptance: "acceptance", fProjectId: "project",
    position: "Position", moveUp: "Move up", moveDown: "Move down", properties: "Properties", crumbs: "Where this card is", backBoard: "Back to the board", backList: "Back to the list",
    dispatcher: "Dispatched by", dispatcherHint: "A blocked card's question goes to them first", dispatcherMe: "Me", dispatcherNone: "Nobody",
    dispatcherPerson: "{0} (a person)", fDispatcher: "dispatcher",
    today: "Today", yesterday: "Yesterday", repeated: "The same, {0} times in a row",
    groupCore: "Core", groupTeam: "Project and people", groupFlow: "Flow",
    addGoal: "Add goal", addScope: "Add scope", addDefinition: "Add definition of done", addAcceptance: "Add acceptance", addContext: "Add context", addState: "Add state", addResult: "Add result",
    subsDone: "{0} of {1} sub tasks done",
  },
  "zh-TW": {
    loading: "載入中…", missing: "找不到 {0}", version: "v{0}", copyLink: "複製這張卡的連結", linkCopied: "已複製連結",
    conflict: "{0} 在你編輯時被改過了。已載入最新內容，你的修改還在，再存一次就會覆蓋。",
    followsSubs: "有子任務，狀態會跟著子任務自動變化",
    reopen: "重新開啟", cancelCard: "取消這張卡", confirmMain: "確認主任務", moreActions: "更多動作",
    assignee: "負責人", nobody: "沒人負責", unassign: "沒人負責", other: "其他…", otherTitle: "指派給其他 Agent", otherLabel: "Agent 名稱",
    status: "狀態", project: "專案", priority: "優先級", size: "大小", review: "待我確認", reviewBox: "做完要停在待確認，等我確認", reviewShort: "完成前停在待確認",
    reviewOn: "做完會停在待確認，等你確認", reviewOff: "做完直接完成，不等你確認",
    parent: "主任務", deps: "相依卡片", none: "沒有", edit: "編輯", depsTitle: "{0} 的相依", depsLabel: "要先完成的卡號，用逗號或空白分開（留空＝沒有相依）",
    depWaiting: "還沒完成", depDone: "已完成", opened: "{0} 開的 · {1} · 最後更新 {2}",
    blockedReason: "卡住原因", goal: "目標", goalHint: "為什麼做、做完是什麼樣子", scope: "範圍", scopeHint: "做：…／不做：…",
    definition: "完成定義", acceptance: "驗收條件", context: "背景", contextHint: "檔案路徑、相關卡號、已經做的決定",
    state: "目前狀態", stateHint: "已完成／下一步／注意（負責人會隨時覆寫）", result: "產出", resultHint: "改了哪些檔案、怎麼驗證",
    empty: "（未填，點一下編輯）", clickToEdit: "點一下編輯", editHint: "點別處或按 Ctrl+Enter 儲存・Esc 放棄修改",
    saving: "儲存中…", notSaved: "還沒存到 — 點別處或按 Ctrl+Enter 再試一次",
    conflictInline: "這裡剛被別人改過。要用你的文字覆蓋嗎？", overwrite: "覆蓋", discard: "放棄我的修改",
    checklistEmpty: "（還沒有，點一下新增）", editList: "編輯清單", onePerLine: "一行一項；改了文字的項目會變回沒勾・點別處或按 Ctrl+Enter 儲存", items: "{0}/{1} 項",
    subs: "子任務", quickAdd: "新增子任務：輸入標題後按 Enter（小事可以不拆）",
    activity: "動態", activityShow: "顯示", "show.all": "全部", "show.comments": "留言", "show.log": "進度", "show.history": "歷史",
    noActivity: "還沒有動態 — 留言、進度紀錄與變更都會出現在這裡", nothingHere: "這類還沒有內容",
    rejectTag: "退回", approveTag: "確認", commentTo: "留言給 {0} — 輸入 @ 可選 Agent（Ctrl+Enter 送出）", commentHint: "留言 — 輸入 @ 可選 Agent（Ctrl+Enter 送出）", send: "送出",
    mentionList: "可提及的 Agent", boardOffShort: "任務板已關閉",
    rowMoved: "把狀態從 {0} 改成 {1}", rowAssigned: "把負責人從 {0} 改成 {1}", activities: "{0} 項動態", activity1: "1 項動態",
    logTip: "agent 或成員記下的一行工作紀錄，不是留言",
    evCreated: "開卡", evMoved: "{0}→{1}", evAuto: "（自動）", evAssigned: "負責人 {0}→{1}", evUpdated: "修改{0}", evCommented: "留言", evLogged: "紀錄：{0}", evWatchers: "修改關注者：{0}",
    fTitle: "標題", fGoal: "目標", fScope: "範圍", fContext: "背景", fState: "目前狀態", fResult: "產出", fBlockedReason: "卡住原因", fSize: "大小",
    fPriority: "優先級", fNeedsReview: "需要確認", fDependsOn: "相依", fAcceptance: "驗收條件", fProjectId: "專案",
    position: "位置", moveUp: "往上移", moveDown: "往下移", properties: "屬性", crumbs: "這張卡的位置", backBoard: "回到看板", backList: "回到清單",
    dispatcher: "派工", dispatcherHint: "卡住要決定的事會先通知派工者", dispatcherMe: "我", dispatcherNone: "（沒有）",
    dispatcherPerson: "{0}（人）", fDispatcher: "派工者",
    today: "今天", yesterday: "昨天", repeated: "連續 {0} 次相同",
    groupCore: "核心狀態", groupTeam: "專案與協作", groupFlow: "流程控制",
    addGoal: "新增目標", addScope: "新增範圍", addDefinition: "完成定義", addAcceptance: "驗收條件", addContext: "補充背景", addState: "目前狀態", addResult: "產出",
    subsDone: "{0}／{1} 個子任務已完成",
  },
});

const LIMIT = { title: 100, goal: 300, scope: 600, context: 1000, state: 500, result: 1000, blockedReason: 400, acceptanceItems: 10 };
const PRIORITY_CHOICES = ["urgent", "high", "normal", "low"];

/** One history line, without who and when. */
export function describeEvent(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "created": return t("taskcard.evCreated");
    case "moved": return `${t("taskcard.evMoved", t(`tasks.${d.from}`), t(`tasks.${d.to}`))}${d.auto ? t("taskcard.evAuto") : ""}${d.reason ? `: ${d.reason}` : ""}`;
    case "assigned": return t("taskcard.evAssigned", d.from || "—", d.to || "—");
    case "updated": return t("taskcard.evUpdated", Object.keys(d.changes || {}).map((k) => fieldName(k)).join(", "));
    case "commented": return t("taskcard.evCommented");
    case "logged": return d.watchers ? t("taskcard.evWatchers", watcherChange(d)) : t("taskcard.evLogged", d.text || "");
    default: return ev.type;
  }
}
/**
 * A history line as the activity stream's thin row says it, without who and when: a sentence the name leads —
 * "dev-a changed status from To do to In progress" — for a move and a change of assignee; every other line as `describeEvent`.
 */
export function describeRow(ev) {
  const d = ev.data || {};
  if (ev.type === "moved") return `${t("taskcard.rowMoved", t(`tasks.${d.from}`), t(`tasks.${d.to}`))}${d.auto ? t("taskcard.evAuto") : ""}${d.reason ? `: ${d.reason}` : ""}`;
  if (ev.type === "assigned") return t("taskcard.rowAssigned", d.from || "—", d.to || "—");
  return describeEvent(ev);
}
/**
 * A watcher change as the board wrote it (`data.watchers`: { added, removed }): "+ops, −dev-b" — the true minus sign, not a hyphen,
 * so a narrow line never breaks between the sign and the name; the event's own text when the lists are not there.
 */
const watcherChange = (d) => {
  const w = d.watchers || {};
  const names = (list) => (Array.isArray(list) ? list.filter((n) => typeof n === "string") : []);
  const parts = [...names(w.added).map((n) => `+${n}`), ...names(w.removed).map((n) => `\u2212${n}`)];
  return parts.length ? parts.join(", ") : String(d.text || "").replace(/^watchers:\s*/, "");
};
const fieldName = (k) => { const key = `taskcard.f${k[0].toUpperCase()}${k.slice(1)}`; const s = t(key); return s === key ? k : s; };

// ── What each chip offers (pure: tests import these) ────────

/**
 * The statuses a card's chip lists: every column, the card's own ticked; those a person may not move it to by hand (a
 * main task that follows its sub tasks) are listed too, disabled and saying why — `act(to)` runs a choice.
 */
export function statusItems(card, act) {
  if (card.status === "cancelled") return [];
  const allowed = movesFor(card);
  return COLUMNS.map((to) => ({
    key: to, label: t(`tasks.${to}`), checked: to === card.status, disabled: to !== card.status && !allowed.includes(to),
    title: to !== card.status && !allowed.includes(to) ? t("tasks.derivedMove") : undefined, onSelect: () => act(to),
  }));
}

/** Who a card can go to: nobody, each instance (one with the board off is listed, disabled), and Other… for any name. */
export function assigneeItems(card, names, boardOff, act) {
  const all = [...new Set([...names, card.assignee].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return [
    { key: "none", label: t("taskcard.unassign"), checked: !card.assignee, onSelect: () => act(null) },
    ...all.map((n) => {
      const off = boardOff.includes(n) && n !== card.assignee;
      return { key: `n:${n}`, label: off ? t("tasks.boardOff", n) : n, checked: card.assignee === n, disabled: off, title: off ? t("tasks.boardOffHint") : undefined, onSelect: () => act(n) };
    }),
    { key: "other", label: t("taskcard.other"), onSelect: () => act("\u0000other") },
  ];
}

/** Who dispatched a card: a person (the one at the page), nobody, or an instance. */
export function dispatcherItems(card, names, act) {
  const d = card.dispatcher;
  const isMe = !!d && d.kind === "person", isNone = !d;
  return [
    { key: "me", label: t("taskcard.dispatcherMe"), checked: isMe, onSelect: () => act("\u0000me") },
    { key: "none", label: t("taskcard.dispatcherNone"), checked: isNone, onSelect: () => act("\u0000none") },
    ...names.map((n) => ({ key: `n:${n}`, label: n, checked: !!d && d.kind === "instance" && d.name === n, onSelect: () => act(n) })),
  ];
}

/** The value the page sends for a dispatcher choice. */
export const dispatcherValue = (v) => (v === "\u0000none" ? null : v === "\u0000me" ? { kind: "person" } : { kind: "instance", name: v });

/** The comment box's recipient chip for a card: the groups to list, the name it starts with, and whether that name is held back (the card still waits on another card). */
const recipientsOf = (card, detail, fleet) => {
  const initial = defaultRecipient({ card, fleet });
  return { groups: recipientGroups({ card, detail, fleet }), initial, held: holdsRecipient({ card, initial }) };
};
const radioItems = (list, current, label, act) => list.map((v) => ({ key: String(v), label: label(v), checked: current === v, onSelect: () => act(v) }));

// ── The page ──────────────────────────────────────────────

/**
 * `writable`: false over a read-only link (the card is shown, nothing on it changes). `place`: up and down in its column,
 * for touch and keyboard (null when it cannot move). `steps`: the previous and next card the page showed, and where this
 * one is among them (null: nowhere to step). `where`: the project's name for the breadcrumb (null: none). `back`: what
 * Back says. `onBack` returns to the board or list. `doing`: how many cards each instance has in progress (fleet-task-run.js).
 */
export function CardPage({ id, tick, projects, cards = [], boardOff = [], doing = new Map(), writable = true, place = null, steps = null, where = null, back, onBack, onOpen, onStep, reloadBoard }) {
  const { instances } = useStore(appStore);
  const [detail, setDetail] = useState(null);
  const [missing, setMissing] = useState(false);
  const seq = useRef(0);
  const cardRef = useRef(null);       // the card as last read: a chip's save sends its version, whatever was drawn since
  const chain = useRef(Promise.resolve());   // saves go one after another, each on the version the one before left
  // The empty fields a person opened with their "+ Add" button, for this card (another card starts with none).
  const [opened, setOpened] = useState({ id, keys: [] });
  const openKeys = opened.id === id ? opened.keys : [];
  const openField = (key) => setOpened((o) => ({ id, keys: [...(o.id === id ? o.keys : []).filter((k) => k !== key), key] }));
  const closeField = (key) => setOpened((o) => (o.id === id && o.keys.includes(key) ? { id, keys: o.keys.filter((k) => k !== key) } : o));

  async function load() {
    const mine = ++seq.current;
    try {
      const d = await boardApi.card(id);
      if (mine === seq.current) { cardRef.current = d.card; setDetail(d); setMissing(false); }
    } catch (err) {
      if (mine !== seq.current) return;
      if (err.status === 404 || err.status === 400) setMissing(true);
      else toast(errorText(err), false);
    }
  }
  useEffect(() => { void load(); }, [id, tick]);
  // The page takes the keyboard's place from the tile or row that opened it (once per card: later reads leave the focus be).
  const head = useRef(null);
  const focused = useRef(null);
  useEffect(() => {
    if (!detail || focused.current === id) return;
    focused.current = id;
    try { head.current?.focus({ preventScroll: true }); } catch { /* no focus API */ }
  }, [detail, id]);
  // A card's page starts at its top (the panel it sits in keeps its scroll from the board or the card before).
  const root = useRef(null);
  useEffect(() => { const box = scrollBox(root.current); if (box) box.scrollTop = 0; }, [id]);

  // Esc goes back to the board — unless a box, a menu or a dialog has it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target;
      if (el && typeof el.closest === "function" && (el.closest("dialog, [role=menu], [role=listbox]") || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || "") || el.isContentEditable)) return;
      onBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack]);

  /**
   * A write and what follows: its notes, the card and the board read again. Resolves "ok", "conflict" or "error" — or, with
   * `detail`, `{ outcome, version }`, where `version` is the one the write's own answer gave the card (an edit kept open after
   * its save is pinned to it).
   */
  async function run(fn, detail = false) {
    const done = (outcome, version) => (detail ? { outcome, version } : outcome);
    try {
      const r = await fn();
      const written = r && r.card && typeof r.card.version === "number" ? r.card.version : undefined;
      for (const n of notesForPeople(r && r.notes)) toast(n);
      await load();
      reloadBoard();
      return done("ok", written);
    } catch (err) {
      const conflict = err.status === 409;
      toast(conflict ? t("taskcard.conflict", id) : errorText(err), false);
      if (conflict) await load();
      return done(conflict ? "conflict" : "error");
    }
  }
  /** A move from this page: one at a time (claimed before the first await), then the card and the board read again. */
  const moving = useRef(false);
  const [busy, setBusy] = useState(false);
  async function moved(start) {
    if (moving.current) return;
    moving.current = true;
    setBusy(true);
    try { const r = await start(); if (r) { await load(); reloadBoard(); } }
    finally { moving.current = false; setBusy(false); }
  }

  // Previous / Next: the page's cards (fleet-task-menu.js), from the first frame (no jump once the card loads).
  const tools = steps ? html`<${StepButtons} steps=${steps} onOpen=${onStep || onOpen} />` : null;
  const bar = (card) => html`<div class="tp-bar">
    <button type="button" class="btn btn-ghost btn-sm tp-back" onClick=${onBack}><${Icon} name="back" size=${16} />${back}</button>
    <nav class="tp-crumbs" aria-label=${t("taskcard.crumbs")}>${where ? html`<span class="tp-crumb">${where}</span>` : null}
      ${card && card.parent ? html`<button type="button" class="tb-link tp-crumb" onClick=${() => onOpen(card.parent.id)}><span class="tb-code">${card.parent.id}</span> ${card.parent.title}</button>` : null}
      <span class="tp-crumb tb-code">${id}</span></nav>
    <span class="tp-tools">${tools}${card ? card.actions : null}</span>
  </div>`;
  if (missing || !detail) {
    return html`<div class="tp" ref=${root}>${bar(null)}${missing ? html`<${Empty} icon="tasks" title=${t("taskcard.missing", id)} />` : html`<${Skeleton} lines=${6} />`}</div>`;
  }

  const { card, parent, children } = detail;
  const isMain = card.kind === "main";
  const derived = followsSubs(card);
  const finished = card.status === "done" || card.status === "cancelled";
  /** `version` guards against overwriting a newer card; null skips it (text sent over a conflict on purpose). */
  const save = (patch, version) => {
    const job = chain.current.then(() => run(() => boardApi.update(card.id, version === null ? patch : { ...patch, version: version === undefined ? (cardRef.current || card).version : version }), true));
    chain.current = job.catch(() => {});
    return job;
  };
  const names = [...new Set([...instances.map((i) => i.name), card.assignee].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  // Only the fleet's instances can be mentioned (an assignee that has left the fleet, or a person, would wake nobody); the
  // card's assignee comes first.
  const fleet = instances.map((i) => i.name);
  const mentionNames = [...(fleet.includes(card.assignee) ? [card.assignee] : []), ...fleet.filter((n) => n !== card.assignee)].map((name) => ({ name, off: boardOff.includes(name) }));

  // Comment threads: each is one write on one comment (the board's rules say who may), then the card and the board read again; a
  // refusal is said in the page's words. `viewer` (the card read): who this page writes as — their own comments are theirs to edit.
  const thread = {
    writable, viewer: detail.viewer || null,
    send: (text, extra) => run(() => boardApi.update(card.id, { comment: text, ...extra })),
    edit: (entry, text) => run(() => boardApi.commentEdit(card.id, entry.id, text)),
    react: (entry, emoji, on) => run(() => boardApi.commentReact(card.id, entry.id, emoji, on)),
    resolve: (entry, resolved) => run(() => boardApi.commentResolve(card.id, entry.id, resolved)),
    remove: (entry) => run(() => boardApi.commentDelete(card.id, entry.id)),
  };

  /** Who watches the card: no version (a watch is not an edit of the card), the card and the board read again after. */
  const follow = (change) => run(() => boardApi.watchers(card.id, change));

  async function chooseAssignee(value) {
    if (value === "\u0000other") {
      const name = await askText({ title: t("taskcard.otherTitle"), label: t("taskcard.otherLabel"), required: true });
      if (name) await save({ assignee: name }, null);
      return;
    }
    await save({ assignee: value });
  }
  async function editDeps() {
    const text = await askText({ title: t("taskcard.depsTitle", card.id), label: t("taskcard.depsLabel"), initial: card.dependsOn.join(", ") });
    if (text !== null) await save({ dependsOn: text.split(/[\s,，、]+/).filter(Boolean) }, null);
  }
  function copyLink() {
    try {
      const u = new URL(globalThis.location.href);
      u.searchParams.set("card", card.id);
      void navigator.clipboard?.writeText(u.toString()).then(() => toast(t("taskcard.linkCopied")));
    } catch { /* no clipboard */ }
  }
  const projectName = (pid) => (pid === null ? t("tasks.noProject") : (projects.find((p) => p.id === pid) || {}).name || "—");
  const can = writable;
  const row = (label, body, cls = "") => html`<div class=${`tp-row${cls ? ` ${cls}` : ""}`}><dt>${label}</dt><dd>${body}</dd></div>`;
  const group = (key, title, rows) => html`<div class="tp-group" role="group" aria-labelledby=${`tpg-${key}`}><h4 class="tp-group-title" id=${`tpg-${key}`}>${title}</h4><dl class="tp-props">${rows}</dl></div>`;

  // The header toolbar: Previous / Next (above), the link, Mark blocked (by hand: a main task that follows its sub tasks only) and ⋯.
  const copyBtn = html`<button type="button" class="icon-btn" title=${t("taskcard.copyLink")} aria-label=${t("taskcard.copyLink")} onClick=${copyLink}><${Icon} name="copy" size=${16} /></button>`;
  const blockBtn = can && derived && !finished && card.status !== "blocked"
    ? html`<button type="button" class="btn btn-sm tp-block-btn" disabled=${busy} onClick=${() => moved(() => moveCard(card, "blocked"))}>${t("tasks.block")}</button>` : null;
  const more = can && !finished ? html`<${Menu} cls="tp-more" label=${t("taskcard.moreActions")} items=${[
    { key: "cancel", label: t("taskcard.cancelCard"), icon: "trash", danger: true, onSelect: () => void moved(() => moveCard(card, "cancelled")) },
  ]} />` : null;

  // The text fields of the spec (goal, scope, definition of done, context) and of the agent's block (state, result): one
  // that holds text is a field; an empty one is a "+ Add" button (a writer's way in) until it is opened, and folds back into
  // its button when it is closed still empty. Over a read-only link an empty one is simply not there.
  const textField = (key, field, title, hint, add, limit) => ({ key, title, add, has: !!card[field],
    body: (open) => html`<${EditableText} readOnly=${!can} value=${card[field]} limit=${limit} version=${card.version} placeholder=${hint} open=${open} onClose=${() => closeField(key)}
      onSave=${(v, base) => save({ [field]: v }, base)} />` });
  const parts = (defs) => {
    const shown = [], adders = [];
    for (const d of defs) {
      const isOpen = openKeys.includes(d.key);
      if (d.has || isOpen) shown.push(html`<${Field} key=${d.key} title=${d.title}>${d.body(isOpen)}</${Field}>`);
      else if (can) adders.push(html`<button key=${d.key} type="button" class="tp-add" data-add=${d.key} onClick=${() => openField(d.key)}><${Icon} name="plus" size=${14} />${t(d.add)}</button>`);
    }
    return { shown, adders };
  };
  const spec = parts([
    textField("goal", "goal", t("taskcard.goal"), t("taskcard.goalHint"), "taskcard.addGoal", LIMIT.goal),
    isMain ? textField("scope", "scope", t("taskcard.scope"), t("taskcard.scopeHint"), "taskcard.addScope", LIMIT.scope) : null,
    { key: "definition", title: isMain ? t("taskcard.definition") : t("taskcard.acceptance"), add: isMain ? "taskcard.addDefinition" : "taskcard.addAcceptance", has: card.acceptance.length > 0,
      body: (open) => html`<${Checklist} card=${card} readOnly=${!can} limit=${LIMIT.acceptanceItems} open=${open} onClose=${() => closeField("definition")}
        onToggle=${(n, done) => save(done ? { check: [n] } : { uncheck: [n] })} onReplace=${(items, base) => save({ acceptance: items }, base)} />` },
    textField("context", "context", t("taskcard.context"), t("taskcard.contextHint"), "taskcard.addContext", LIMIT.context),
  ].filter(Boolean));
  const handoff = parts([
    textField("state", "state", t("taskcard.state"), t("taskcard.stateHint"), "taskcard.addState", LIMIT.state),
    textField("result", "result", t("taskcard.result"), t("taskcard.resultHint"), "taskcard.addResult", LIMIT.result),
  ]);

  // The sub tasks: a bordered list — done / total and the bar on top, the sub tasks, a line to add one at the end.
  const prog = card.progress && card.progress.total ? card.progress : null;
  const subs = isMain ? html`<section class="tp-subs" aria-label=${t("taskcard.subs")}>
    <h3>${t("taskcard.subs")}</h3>
    <div class="tc-field-body">
      ${prog ? html`<div class="tp-subs-head"><span class="tp-subs-count" title=${t("taskcard.subsDone", prog.done, prog.total)}>${prog.done} / ${prog.total}</span><${ProgressBar} progress=${prog} wide /></div>` : null}
      ${children.length ? html`<ul class="tc-children">${children.map((c) => html`<li key=${c.id}><button type="button" onClick=${() => onOpen(c.id)}>
        <${StatusPill} status=${c.status} card=${c} /><span class="tb-code">${c.id}</span><span class="tc-child-title">${c.title}</span><span class="tb-who">${c.assignee || ""}</span></button></li>`)}</ul>` : null}
      ${finished || !can ? null : html`<${QuickAdd} placeholder=${t("taskcard.quickAdd")} limit=${LIMIT.title} onAdd=${(title) => run(() => boardApi.create({ parent: card.id, title }))} />`}
    </div>
  </section>` : null;

  return html`<div class="tp" ref=${root} data-card=${card.id}>
    ${bar({ parent, actions: html`${copyBtn}${blockBtn}${more}` })}
    <div class="tp-grid">
      <div class="tp-head">
        <div class="tp-idrow"><span class="tb-code tp-code">${card.id}</span><${StatusPill} status=${card.status} card=${card} />${detail.archived ? html`<span class="tb-tag" title=${t("tasksArchive.tagTip", detail.archiveAfterDays ?? "")}>${t("tasksArchive.tag")}</span>` : null}
          ${derived && !finished ? html`<span class="tp-derived">${t("taskcard.followsSubs")}</span>` : null}</div>
        <div class="tc-head" ref=${head} tabindex="-1" role="heading" aria-level="2">
          ${can ? html`<${InlineTitle} value=${card.title} version=${card.version} limit=${LIMIT.title} onSave=${(title, base) => save({ title }, base)} />` : html`<h2 class="tc-title">${card.title}</h2>`}
        </div>
        ${can ? html`<div class="tc-actions">
          ${card.status === "review" ? html`
            <button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${() => moved(() => moveCard(card, "done"))}><${Icon} name="check" size=${14} />${isMain ? t("taskcard.confirmMain") : t("tasks.confirm")}</button>
            <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => moved(() => moveCard(card, "claimed"))}>${t("tasks.sendBack")}</button>
            ${wrapUpText(card) ? html`<span class="tc-hint wrapup">${t("tasks.wrapLine", wrapUpText(card))}</span>` : null}` : null}
          ${card.status === "blocked" ? html`<button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${() => moved(() => answerBlocked(card))}>${t("tasks.answer")}</button>` : null}
          ${finished ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => moved(() => moveCard(card, card.status === "done" ? "claimed" : "open"))}><${Icon} name="restart" size=${14} />${t("taskcard.reopen")}</button>` : null}
        </div>` : null}
      </div>

      <div class="tp-body">
        ${card.status === "blocked" ? html`<${Field} title=${t("taskcard.blockedReason")} tone="blocked">
          <${EditableText} readOnly=${!can} value=${card.blockedReason} limit=${LIMIT.blockedReason} version=${card.version} onSave=${(v, base) => save({ blockedReason: v }, base)} /></${Field}>` : null}
        ${spec.shown.length ? html`<div class="tp-spec">${spec.shown}</div>` : null}
        ${spec.adders.length ? html`<div class="tp-adders">${spec.adders}</div>` : null}
        <${AgentRun} card=${card} detail=${detail} doing=${doing} derived=${derived} shown=${handoff.shown} adders=${handoff.adders} />
        <${FilesField} files=${(detail && detail.attachments) || []} />
        ${subs}
      </div>

      <aside class="card tp-side" aria-label=${t("taskcard.properties")}>
        ${group("core", t("taskcard.groupCore"), html`
          ${row(t("taskcard.status"), html`<${PropChip} label=${t("taskcard.status")} items=${can ? statusItems(card, (to) => moved(() => moveCard(card, to))) : null} value=${html`<${StatusPill} status=${card.status} card=${card} />`} />`)}
          ${row(t("taskcard.assignee"), html`<${PropChip} label=${t("taskcard.assignee")} items=${can && !finished ? assigneeItems(card, names, boardOff, chooseAssignee) : null} value=${html`<${Who} name=${card.assignee} empty=${t("taskcard.nobody")} />`} />`)}
          ${row(t("taskcard.priority"), html`<${PropChip} label=${t("taskcard.priority")} value=${html`<span class=${`tp-prio p-${card.priority}`}>${t(`tasks.${card.priority}`)}</span>`}
            items=${can ? radioItems(PRIORITY_CHOICES, card.priority, (p) => t(`tasks.${p}`), (p) => save({ priority: p })) : null} />`)}
          ${row(t("taskcard.size"), html`<${PropChip} label=${t("taskcard.size")} value=${card.size ? t(`tasks.size${card.size}`) : t("tasks.sizeNone")}
            items=${can ? [{ key: "none", label: t("tasks.sizeNone"), checked: !card.size, onSelect: () => save({ size: null }) }, ...radioItems(["S", "M", "L"], card.size, (s) => t(`tasks.size${s}`), (s) => save({ size: s }))] : null} />`)}`)}
        ${group("team", t("taskcard.groupTeam"), html`
          ${isMain ? row(t("taskcard.project"), html`<${PropChip} label=${t("taskcard.project")} value=${projectName(card.projectId)}
            items=${can ? [{ key: "none", label: t("tasks.noProject"), checked: card.projectId === null, onSelect: () => save({ projectId: null }) },
              ...projects.filter((p) => !p.archived || p.id === card.projectId).map((p) => ({ key: String(p.id), label: p.name, checked: card.projectId === p.id, onSelect: () => save({ projectId: p.id }) }))] : null} />`) : null}
          ${parent ? row(t("taskcard.parent"), html`<button type="button" class="tb-link" onClick=${() => onOpen(parent.id)}><span class="tb-code">${parent.id}</span> ${parent.title}</button>`) : null}
          <${LeaderRow} detail=${detail} names=${fleet} boardOff=${boardOff} can=${can} follow=${follow} />
          ${row(t("taskcard.dispatcher"), html`<${PropChip} label=${t("taskcard.dispatcher")} items=${can ? dispatcherItems(card, names, (v) => save({ dispatcher: dispatcherValue(v) })) : null}
            value=${html`<span class="tb-who" title=${t("taskcard.dispatcherHint")}>${!card.dispatcher ? t("taskcard.dispatcherNone") : card.dispatcher.kind === "person" ? t("taskcard.dispatcherPerson", card.dispatcher.name) : card.dispatcher.name}</span>`} />`)}
          <${WatchersRow} detail=${detail} names=${fleet} boardOff=${boardOff} can=${can} follow=${follow} />`)}
        ${group("flow", t("taskcard.groupFlow"), html`
          ${row(t("taskcard.review"), can ? html`<label class="tp-switch"><input type="checkbox" role="switch" class="s-ui-toggle" aria-label=${t("taskcard.reviewBox")} checked=${card.needsReview} onChange=${(e) => void save({ needsReview: e.target.checked })} /><span class="tc-hint muted">${t("taskcard.reviewShort")}</span></label>`
            // #2299: read-only: the values as text, not controls that look usable and are not.
            : html`<span class="tc-value">${t(card.needsReview ? "taskcard.reviewOn" : "taskcard.reviewOff")}</span>`, can ? "" : "tp-block")}
          ${row(t("taskcard.deps"), html`${card.dependsOn.length ? card.dependsOn.map((d) => html`<button key=${d} type="button" class=${`tc-dep${card.unmetDeps.includes(d) ? " waiting" : ""}`}
              title=${card.unmetDeps.includes(d) ? t("taskcard.depWaiting") : t("taskcard.depDone")} onClick=${() => onOpen(d)}>${d}</button>`) : hiddenWaits(card) ? null : html`<span class="muted">${t("taskcard.none")}</span>`}
            ${hiddenWaits(card) ? html`<span class="muted" title=${t("taskcard.depWaiting")}>${hiddenWaits(card)}</span>` : null}
            ${can ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${editDeps}>${t("taskcard.edit")}</button>` : null}`)}
          ${place && (place.up || place.down) ? row(t("taskcard.position"), html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!place.up} aria-label=${t("taskcard.moveUp")} title=${t("taskcard.moveUp")} onClick=${place.up}><${Icon} name="up" size=${16} /></button>
            <button type="button" class="btn btn-ghost btn-sm" disabled=${!place.down} aria-label=${t("taskcard.moveDown")} title=${t("taskcard.moveDown")} onClick=${place.down}><${Icon} name="down" size=${16} /></button>`) : null}`)}
        <p class="muted tp-opened">${t("taskcard.opened", card.createdBy, relTime(card.createdAt), relTime(card.updatedAt))} · ${t("taskcard.version", card.version)}</p>
      </aside>

      <div class="tp-activity">
        <${Timeline} detail=${detail} describe=${describeRow} cards=${cards} lead=${((projects || []).find((x) => x.id === card.projectId) || {}).leadInstance || null} names=${mentionNames} thread=${thread} />
        ${can ? html`<${Composer} names=${mentionNames} assignee=${card.assignee} placeholder=${card.assignee ? t("taskcard.commentTo", card.assignee) : t("taskcard.commentHint")}
          recipients=${recipientsOf(card, detail, mentionNames)}
          onSend=${(text, to, held) => run(() => boardApi.update(card.id, { comment: text, ...(held ? {} : { to: to ? [to] : [] }) }))} />` : null}
      </div>
    </div>
  </div>`;
}

/** A labelled row of the page's grid: the label in the first column, whatever it holds (a text, a list, an editor) in the second. */
function Field({ title, tone, children }) {
  return html`<section class=${`tc-field${tone ? ` tone-${tone}` : ""}`}><h3>${title}</h3><div class="tc-field-body">${children}</div></section>`;
}
