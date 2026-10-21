// The task board's shared pieces (Fleet › Tasks): its words, the numbers a project shows, the requests, asking for a
// reason, moving a card, and the small marks (status pill, progress bar). fleet-tasks.js draws the board and
// fleet-task-card.js one card; both use these. No style attribute anywhere (the CSP): bars are SVG rects.
import { html, useEffect, useState } from "/assets/app-html.js";
import { t, register, lang } from "/assets/app-i18n.js";
import { createStore, useStore } from "/assets/app-store.js";
import { Dialog } from "/assets/ui-dialog.js";
import { toast } from "/assets/ui-toast.js";

register("tasks", {
  en: {
    open: "To do", claimed: "In progress", blocked: "Blocked", review: "Waiting for you", done: "Done", cancelled: "Cancelled",
    main: "Main task", sub: "Sub task", urgent: "Urgent", high: "High", normal: "Normal", low: "Low",
    sizeS: "Small", sizeM: "Medium", sizeL: "Large", sizeNone: "Not sized",
    projects: "Projects", noProject: "No project", noProjectDesc: "Tasks the fleet opened outside any project",
    newProject: "New project", newMain: "Main task", archived: "Archived", archive: "Archive", restore: "Restore",
    rename: "Rename or describe", projectName: "Name", projectDesc: "Description", create: "Create", save: "Save", cancel: "Cancel",
    projectCreated: "Project created", projectSaved: "Project saved",
    noProjects: "No projects yet", noProjectsHint: "A project groups related work — create one, then open main tasks in it.",
    mainCount: "{0} main tasks", mainOne: "1 main task", waiting: "{0} waiting for you", blockedN: "{0} blocked", lastActivity: "Last change {0}",
    percentTitle: "Done: finished sub tasks out of all of them; a main task without sub tasks counts once you confirm it",
    allProjects: "All projects", back: "Projects",
    everyone: "Everyone", nobody: "Unassigned", filterLabel: "Filter by assignee",
    recent: "Last 7 days", all: "All", toggleDone: "Show the last 7 days / everything",
    emptyBoard: "No main tasks here yet", emptyFiltered: "No main tasks match the filter",
    emptyBoardHint: "A main task is an outcome you want. Assign it to an instance: it does a small one directly and splits a big one into sub tasks.",
    subProgress: "Sub tasks {0}/{1}", showSubs: "Show sub tasks", hideSubs: "Hide sub tasks", olderSubs: "{0} more finished earlier",
    acceptance: "Acceptance", definition: "Definition of done", waitsFor: "Waits for {0}", comments: "Comments", agentReplied: "An instance replied",
    needsReview: "Needs review", needsReviewTitle: "Stops at review for your confirmation", urgentTag: "Urgent", highTag: "High",
    waitingTitle: "Waiting for you", waitingEmpty: "Nothing is waiting for you.", confirm: "Confirm", sendBack: "Send back", answer: "Answer",
    confirmed: "{0} confirmed", sentBack: "{0} sent back", answered: "Answered {0}",
    sendBackTitle: "Send back {0}", sendBackLabel: "What needs to change (the assignee reads this)",
    blockTitle: "{0} is blocked", blockLabel: "Blocked on: who has to answer what?", block: "Mark blocked",
    answerTitle: "Answer {0}", answerLabel: "{0} asks: {1}", answerConfirm: "Answer and resume",
    cancelTitle: "Cancel {0}", cancelLabel: "Reason (optional)", cancelConfirm: "Cancel this card",
    derivedMove: "A main task with sub tasks follows them: open it to see its sub tasks, or confirm or send it back when it waits for you",
    createMain: "New main task", createSub: "New sub task", title: "Title", titleHint: "Start with a verb, e.g. Build the leaderboard",
    goal: "Goal", goalHint: "Why, and what done looks like", scope: "Scope", scopeHint: "In: … / Out: …",
    definitionHint: "One per line: conditions anyone can check", acceptanceHint: "One per line",
    context: "Context", contextHint: "Paths, related cards, decisions already made (pointers only)",
    assignee: "Assignee", assigneeHint: "Which instance", project: "Project", size: "Size", priority: "Priority",
    reviewBox: "Stop at review for my confirmation", created: "Opened {0}", titleRequired: "A title is required",
    search: "Search cards", searchHint: "Search titles, fields, checklists and comments", searchEmpty: "No cards match", inField: "in {0}",
    fieldgoal: "goal", fieldscope: "scope", fieldcontext: "context", fieldstate: "state", fieldresult: "result", fieldblockedReason: "blocked reason",
    fieldacceptance: "acceptance", fieldlog: "log", fieldcomment: "comment",
    loadFailed: "The board could not be read", justNow: "just now",
    fieldtitle: "the title", fieldreason: "the reason", fieldprojectName: "the project's name", fieldprojectDescription: "the description",
    readOnly: "The public link shows the board read-only. To change it, open the dashboard on the machine running AgEnD.",
    tileHint: "Enter opens it · Alt+↑/↓ moves it in its column · Alt+←/→ to the next status",
    conflictAgain: "{0} changed meanwhile (it is now {1}). Your text is kept — send it again?", sendAgain: "Send again", conflictLabel: "What you wrote",
    "err.too_long": "{0} is too long: {1} characters, at most {2}", "err.state_lines": "State is at most {0} lines (it has {1})",
    "err.acceptance_empty": "An acceptance item cannot be empty", "err.acceptance_max": "At most {0} acceptance items",
    "err.acceptance_no_item": "There is no acceptance item {0} (there are {1})", "err.project_not_found": "There is no project “{0}”",
    "err.project_name_empty": "A project needs a name", "err.project_name_digits": "A project's name cannot be only digits",
    "err.project_name_taken": "There is already a project named “{0}”", "err.project_archived": "Project “{0}” is archived: it takes no new main tasks",
    "err.card_not_found": "There is no card {0}", "err.title_empty": "A card needs a title", "err.scope_main_only": "Scope is for main tasks only",
    "err.blocked_reason_not_blocked": "Only a blocked card has a blocked reason", "err.block_reason": "Blocking needs a reason: who has to answer what",
    "err.sub_project": "A sub task follows its main task's project: move the main task", "err.already": "{0} is already {1}",
    "err.main_cancelled": "Main task {0} is cancelled: restore it first", "err.sendback_reason": "Sending work back needs a reason",
    "err.cannot_block": "{0} is {1}: it cannot be blocked",
    "err.derived_move": "{0} has sub tasks and follows them: confirm it, send it back, block it or cancel it",
    "err.unfinished_subs": "{0} still has unfinished sub tasks: {1}", "err.parent_is_sub": "{0} is a sub task: sub tasks are not split further",
    "err.parent_cancelled": "{0} is cancelled: it takes no new sub tasks", "err.dep_self": "A card cannot depend on itself",
    "err.dep_own_main": "A sub task cannot depend on its own main task {0}", "err.dep_own_sub": "A main task cannot depend on its own sub task {0}",
    "err.dep_cycle": "These dependencies would wait on each other forever: {0}", "err.conflict": "{0} was changed meanwhile (last by {1})",
    "err.signed_in_only": "The task board takes changes from a signed-in dashboard", "err.not_over_public_link": "The public link can only read the board",
    "note.review_waiting": "{0} “{1}”: every sub task is done — it waits for your confirmation",
    "note.back_to": "{0} has unfinished sub tasks again: it is back to {1}", "note.deps_done": "{0}'s dependencies are all done: it can start",
    "note.deps_unmet": "Note: {0} not done yet",
  },
  "zh-TW": {
    open: "待辦", claimed: "進行中", blocked: "卡住", review: "待確認", done: "完成", cancelled: "取消",
    main: "主任務", sub: "子任務", urgent: "緊急", high: "高", normal: "一般", low: "低",
    sizeS: "小", sizeM: "中", sizeL: "大", sizeNone: "未定",
    projects: "專案", noProject: "未分類", noProjectDesc: "fleet 在專案以外開的 task",
    newProject: "新增專案", newMain: "主任務", archived: "已封存", archive: "封存", restore: "恢復",
    rename: "改名或改說明", projectName: "名稱", projectDesc: "說明", create: "建立", save: "儲存", cancel: "取消",
    projectCreated: "專案已建立", projectSaved: "專案已儲存",
    noProjects: "還沒有專案", noProjectsHint: "專案是一組相關的工作：先建立專案，再在裡面開主任務。",
    mainCount: "{0} 個主任務", mainOne: "1 個主任務", waiting: "等你確認 {0}", blockedN: "卡住 {0}", lastActivity: "最後動態 {0}",
    percentTitle: "完成度：已完成的子任務佔全部的比例；沒有子任務的主任務算一份，你確認後才算完成",
    allProjects: "所有專案", back: "專案",
    everyone: "全部負責人", nobody: "沒人負責", filterLabel: "依負責人篩選",
    recent: "近 7 天", all: "全部", toggleDone: "切換：只看近 7 天／全部",
    emptyBoard: "這個專案還沒有主任務", emptyFiltered: "沒有符合篩選的主任務",
    emptyBoardHint: "主任務是你要的成果，可大可小。指派給 instance，它會自己決定直接做，或先拆成子任務。",
    subProgress: "子任務 {0}/{1}", showSubs: "展開子任務", hideSubs: "收起子任務", olderSubs: "另有 {0} 張比較早完成",
    acceptance: "驗收條件", definition: "完成定義", waitsFor: "等 {0} 完成", comments: "留言", agentReplied: "instance 有新回覆",
    needsReview: "需確認", needsReviewTitle: "做完要停在待確認，等你確認", urgentTag: "緊急", highTag: "優先",
    waitingTitle: "待你處理", waitingEmpty: "沒有等你處理的事。", confirm: "確認", sendBack: "退回", answer: "回覆",
    confirmed: "已確認 {0}", sentBack: "已退回 {0}", answered: "已回覆 {0}",
    sendBackTitle: "退回 {0}", sendBackLabel: "要改什麼（負責人會看到）",
    blockTitle: "{0} 卡住了", blockLabel: "卡住原因：需要誰回答什麼？", block: "標記卡住",
    answerTitle: "回覆 {0}", answerLabel: "{0} 問：{1}", answerConfirm: "回覆並改回進行中",
    cancelTitle: "取消 {0}", cancelLabel: "原因（可以不填）", cancelConfirm: "取消這張卡",
    derivedMove: "有子任務的主任務會跟著子任務自動變化：打開卡片看子任務；待確認時可以確認或退回",
    createMain: "開主任務", createSub: "開子任務", title: "標題", titleHint: "動詞開頭，例如：做排行榜",
    goal: "目標", goalHint: "為什麼做、做完是什麼樣子", scope: "範圍", scopeHint: "做：…／不做：…",
    definitionHint: "一行一項：能客觀判斷是否達成的條件", acceptanceHint: "一行一項",
    context: "背景", contextHint: "檔案路徑、相關卡號、已經做的決定（只放指引）",
    assignee: "負責人", assigneeHint: "交給哪個 instance", project: "專案", size: "大小", priority: "優先度",
    reviewBox: "做完要停在待確認，等我確認", created: "已開 {0}", titleRequired: "標題必填",
    search: "搜尋卡片", searchHint: "搜尋標題、各欄位、驗收條件和留言", searchEmpty: "沒有符合的卡片", inField: "在{0}",
    fieldgoal: "目標", fieldscope: "範圍", fieldcontext: "背景", fieldstate: "目前狀態", fieldresult: "產出", fieldblockedReason: "卡住原因",
    fieldacceptance: "驗收條件", fieldlog: "進度紀錄", fieldcomment: "留言",
    loadFailed: "看板讀不到", justNow: "剛剛",
    fieldtitle: "標題", fieldreason: "原因", fieldprojectName: "專案名稱", fieldprojectDescription: "專案說明",
    readOnly: "公開連結上的任務板只能看。要修改，請在執行 AgEnD 的那台機器上開啟儀表板。",
    tileHint: "Enter 打開 · Alt+↑/↓ 在欄內移動 · Alt+←/→ 移到前一個／下一個狀態",
    conflictAgain: "{0} 在這之間被改過（現在是{1}）。你寫的內容還在，要再送一次嗎？", sendAgain: "再送一次", conflictLabel: "你寫的內容",
    "err.too_long": "{0}太長：{1} 字，上限 {2} 字", "err.state_lines": "目前狀態最多 {0} 行（現在 {1} 行）",
    "err.acceptance_empty": "驗收條件不能是空的", "err.acceptance_max": "驗收條件最多 {0} 項",
    "err.acceptance_no_item": "驗收條件沒有第 {0} 項（共 {1} 項）", "err.project_not_found": "找不到專案「{0}」",
    "err.project_name_empty": "專案名稱不能是空的", "err.project_name_digits": "專案名稱不能只有數字",
    "err.project_name_taken": "已經有專案叫「{0}」", "err.project_archived": "專案「{0}」已封存，不能再開主任務",
    "err.card_not_found": "找不到 {0}", "err.title_empty": "標題不能是空的", "err.scope_main_only": "範圍只用在主任務",
    "err.blocked_reason_not_blocked": "只有卡住的卡才有卡住原因", "err.block_reason": "卡住要寫原因：需要誰回答什麼",
    "err.sub_project": "子任務跟著主任務的專案：要移就移主任務", "err.already": "{0} 已經是{1}",
    "err.main_cancelled": "主任務 {0} 已取消：要繼續做請先恢復主任務", "err.sendback_reason": "退回要寫退回意見",
    "err.cannot_block": "{0} 現在是{1}，不能標卡住",
    "err.derived_move": "{0} 有子任務，狀態會跟著子任務變化：可以確認、退回、標卡住或取消",
    "err.unfinished_subs": "{0} 還有子任務沒完成：{1}", "err.parent_is_sub": "{0} 是子任務：子任務不能再往下拆",
    "err.parent_cancelled": "{0} 已取消：不能在底下開子任務", "err.dep_self": "卡片不能相依自己",
    "err.dep_own_main": "子任務不能相依自己的主任務 {0}", "err.dep_own_sub": "主任務不能相依自己的子任務 {0}",
    "err.dep_cycle": "相依會形成循環，大家會互相等待：{0}", "err.conflict": "{0} 已經被改過（最後由 {1} 修改）",
    "err.signed_in_only": "看板只接受已登入網頁的修改", "err.not_over_public_link": "公開連結只能看看板，不能修改",
    "note.review_waiting": "{0}「{1}」的子任務都完成了，等你確認",
    "note.back_to": "{0} 又有沒完成的子任務，已回到{1}", "note.deps_done": "{0} 的相依都完成了，可以開始",
    "note.deps_unmet": "提醒：{0} 還沒完成",
  },
});

export const COLUMNS = ["open", "claimed", "blocked", "review", "done"];
export const NO_PROJECT = "none";
const WEEK = 7 * 86_400_000;
export const UNASSIGNED = "\u0000none";

// ── Pure helpers (tests import these) ─────────────────────────

export const emptyProgress = () => ({ total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 });

/**
 * A main task's work units: its sub tasks, or one unit when it has none. A confirmed main task counts all its units
 * as done; one without sub tasks counts as done only once confirmed.
 */
export function addUnits(units, main) {
  if (main.status === "cancelled") return;
  const p = main.progress;
  if (main.status === "done") {
    const n = (p && p.total) || 1;
    units.total += n;
    units.done += n;
  } else if (p && p.total) {
    for (const k of ["total", "open", "claimed", "blocked", "review", "done"]) units[k] += p[k];
  } else {
    units.total++;
    units[main.status]++;
  }
}

export const percentDone = (units) => (units.total ? Math.round((units.done / units.total) * 100) : 0);

/** The key a card's project is filed under: its id, or NO_PROJECT. */
export const projectKey = (card) => (card.projectId === null || card.projectId === undefined ? NO_PROJECT : card.projectId);

/**
 * One project's numbers for its card on Home and its header, from the cards at hand (`key`: a project id or
 * NO_PROJECT). The board's read carries the server's (over every card, finished ones too); this is the fallback.
 */
export function projectStats(key, cards) {
  const units = emptyProgress();
  let mains = 0, waiting = 0, blocked = 0, lastActivity = null;
  for (const c of cards) {
    if (projectKey(c) !== key) continue;
    if (!lastActivity || c.updatedAt > lastActivity) lastActivity = c.updatedAt;
    if (c.status === "cancelled") continue;
    if (c.status === "review") waiting++;
    if (c.status === "blocked") blocked++;
    if (c.kind !== "main") continue;
    mains++;
    addUnits(units, c);
  }
  return { mains, units, percent: percentDone(units), waiting, blocked, lastActivity };
}

/** A main task with sub tasks follows them; by hand it is only confirmed, sent back, blocked or cancelled. */
export const followsSubs = (card) => card.kind === "main" && !!card.progress && card.progress.total > 0;

/** Done within the last week (the Done column's default). */
export const recentlyDone = (card, now = Date.now()) => !!card.doneAt && now - Date.parse(card.doneAt) < WEEK;

/** Where a dropped card lands in `column` (the cards there now, in order): its neighbours by card number. */
export function dropNeighbours(column, draggedId, index) {
  const others = column.filter((c) => c.id !== draggedId);
  return { after: index > 0 ? others[index - 1]?.id ?? null : null, before: others[index]?.id ?? null };
}

/** A progress bar's segments, in percent of its width: done, review, in progress, blocked (to do is the track). */
export function barSegments(progress) {
  const total = progress && progress.total ? progress.total : 0;
  if (!total) return [];
  let x = 0;
  const out = [];
  for (const k of ["done", "review", "claimed", "blocked"]) {
    const w = (progress[k] / total) * 100;
    if (w > 0) out.push({ k, x, w });
    x += w;
  }
  return out;
}

/** "3 min ago" in the dashboard's language. */
export function relTime(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 45_000) return t("tasks.justNow");
  const rtf = new Intl.RelativeTimeFormat(lang() === "zh-TW" ? "zh-TW" : "en", { numeric: "auto" });
  const steps = [[60, "second"], [60, "minute"], [24, "hour"], [7, "day"], [4.35, "week"], [12, "month"], [Infinity, "year"]];
  let v = ms / 1000;
  for (const [n, unit] of steps) {
    if (Math.abs(v) < n) return rtf.format(-Math.round(v), unit);
    v /= n;
  }
  return "";
}

// ── Requests ──────────────────────────────────────────────

/** A board request: the answer's JSON, or a thrown Error carrying the HTTP status and the board's code. */
export async function boardCall(method, path, body) {
  const o = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) o.body = JSON.stringify(body);
  const r = await fetch(path, o);
  let d = {};
  try { d = await r.json(); } catch { /* an empty answer */ }
  if (!r.ok) {
    const err = new Error(d.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.code = d.code;
    err.key = d.key;
    err.args = Array.isArray(d.args) ? d.args : [];
    throw err;
  }
  return d;
}

/** Statuses and field names among a refusal's or a note's values, in the page's words. */
function word(key, arg, i) {
  if (typeof arg !== "string") return arg;
  if ((key === "too_long") && i === 0) { const w = t(`tasks.field${arg}`); return w === `tasks.field${arg}` ? arg : w; }
  if (["open", "claimed", "blocked", "review", "done", "cancelled"].includes(arg) && ["already", "cannot_block", "back_to"].includes(key)) return t(`tasks.${arg}`);
  return arg;
}

/** A refusal in the page's language when the board named it (tasks.err.<key>), else the board's own sentence. */
export function errorText(err) {
  if (err && err.key) {
    const key = `tasks.err.${err.key}`;
    const said = t(key, ...(err.args || []).map((a, i) => word(err.key, a, i)));
    if (said !== key) return said;
  }
  return err && err.message ? err.message : String(err);
}
const enc = encodeURIComponent;
export const boardApi = {
  board: (allDone = false) => boardCall("GET", `/ui/tasks/board${allDone ? "?done=all" : ""}`),
  card: (id) => boardCall("GET", `/ui/tasks/cards/${enc(id)}`),
  create: (spec) => boardCall("POST", "/ui/tasks/cards", spec),
  update: (id, patch) => boardCall("POST", `/ui/tasks/cards/${enc(id)}`, patch),
  move: (id, to, input = {}) => boardCall("POST", `/ui/tasks/cards/${enc(id)}/move`, { to, ...input }),
  reorder: (id, after, before) => boardCall("POST", `/ui/tasks/cards/${enc(id)}/reorder`, { after, before }),
  search: (q) => boardCall("GET", `/ui/tasks/search?q=${enc(q)}`),
  createProject: (name, description) => boardCall("POST", "/ui/tasks/projects", { name, description }),
  updateProject: (id, patch) => boardCall("POST", `/ui/tasks/projects/${id}`, patch),
};

/** The notes a write brings that a person wants to hear, in the page's language (the rest are for agents). */
const PERSON_NOTES = new Set(["review_waiting", "back_to", "deps_done", "deps_unmet"]);
export function notesForPeople(notes) {
  return (notes || []).filter((n) => n && typeof n === "object" && PERSON_NOTES.has(n.key))
    .map((n) => t(`tasks.note.${n.key}`, ...(n.args || []).map((a, i) => word(n.key, a, i))));
}

/** Over the temporary public link the board is read-only (its writes are refused there). */
export const onPublicLink = () => typeof document !== "undefined" && !!document.body && document.body.dataset.publicLink === "1";

// ── Asking for a line of text (a reason, an answer) ──────────

let askStore = null;
let askSeq = 0;
/** Made on first use, so loading this module runs nothing but its words (tests read them that way). */
const asks = () => askStore || (askStore = createStore({ queue: [] }));

/** Ask for text in the app's dialog. Resolves the trimmed text, or null when the person backs out. */
export function askText({ title, label, confirmLabel, required = false, danger = false, initial = "" }) {
  return new Promise((resolve) => {
    asks().set((s) => ({ queue: [...s.queue, { id: ++askSeq, title, label, confirmLabel: confirmLabel || t("tasks.save"), required, danger, initial, resolve }] }));
  });
}
function answerAsk(id, value) {
  const item = asks().get().queue.find((q) => q.id === id);
  if (!item) return;
  asks().set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
  item.resolve(value);
}
/** Rendered once by the board: the oldest question. */
export function AskHost() {
  const { queue } = useStore(asks());
  const q = queue[0];
  const [text, setText] = useState("");
  useEffect(() => { setText(q ? q.initial : ""); }, [q && q.id]);
  if (!q) return null;
  const ok = !q.required || text.trim() !== "";
  const submit = () => { if (ok) answerAsk(q.id, text.trim()); };
  return html`<${Dialog} key=${q.id} title=${q.title} onClose=${() => answerAsk(q.id, null)}
    actions=${html`<button type="button" class="btn" onClick=${() => answerAsk(q.id, null)}>${t("tasks.cancel")}</button>
      <button type="button" class=${`btn ${q.danger ? "btn-danger" : "btn-primary"}`} disabled=${!ok} onClick=${submit}>${q.confirmLabel}</button>`}>
    <form class="form" onSubmit=${(e) => { e.preventDefault(); submit(); }}>
      <label class="field"><span>${q.label}</span>
        <textarea rows="3" value=${text} onInput=${(e) => setText(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}></textarea></label>
    </form></${Dialog}>`;
}

/**
 * Moving a card: the text a move needs (why it is blocked, why it is sent back), then the request with the version the
 * person saw. When an agent changed the card in between (409), typed text is not lost: the card is read again and the
 * person is asked once more, the text in place, before it is sent to the card as it now is.
 * Resolves the board's answer, or null (backed out or refused; the refusal is toasted).
 */
export async function moveCard(card, to, extra = {}) {
  const { again: _again, ...given } = extra;
  const input = { ...given };
  if (to === "blocked" && !input.reason) {
    const r = await askText({ title: t("tasks.blockTitle", card.id), label: t("tasks.blockLabel"), required: true, confirmLabel: t("tasks.block") });
    if (r === null) return null;
    input.reason = r;
  }
  if (card.status === "review" && (to === "claimed" || to === "open") && !input.reason) {
    const r = await askText({ title: t("tasks.sendBackTitle", card.id), label: t("tasks.sendBackLabel"), required: true, confirmLabel: t("tasks.sendBack") });
    if (r === null) return null;
    input.reason = r;
  }
  if (to === "cancelled" && input.reason === undefined) {
    const r = await askText({ title: t("tasks.cancelTitle", card.id), label: t("tasks.cancelLabel"), confirmLabel: t("tasks.cancelConfirm"), danger: true });
    if (r === null) return null;
    if (r) input.reason = r;
  }
  input.version = card.version;
  try {
    const r = await boardApi.move(card.id, to, input);
    for (const n of notesForPeople(r.notes)) toast(n);
    return r;
  } catch (err) {
    // Someone changed the card meanwhile: what was typed is not lost — read the card again and offer to send it there.
    if (err.status === 409 && (input.reason || input.comment) && !extra.again) {
      try {
        const { card: fresh } = await boardApi.card(card.id);
        const typed = input.reason || input.comment;
        const again = await askText({ title: t("tasks.conflictAgain", card.id, t(`tasks.${fresh.status}`)), label: t("tasks.conflictLabel"), initial: typed, required: true, confirmLabel: t("tasks.sendAgain") });
        if (again === null) return null;
        return moveCard(fresh, to, { ...extra, ...(input.reason ? { reason: again } : { comment: again }), again: true });
      } catch (e) { toast(errorText(e), false); return null; }
    }
    toast(errorText(err), false);
    return null;
  }
}

/** Answering a blocked card: the answer as a comment, and the card back in progress. */
export async function answerBlocked(card) {
  const text = await askText({ title: t("tasks.answerTitle", card.id), label: t("tasks.answerLabel", card.assignee || "—", card.blockedReason), required: true, confirmLabel: t("tasks.answerConfirm") });
  if (!text) return null;
  return moveCard(card, "claimed", { comment: text });
}

// ── Small pieces ──────────────────────────────────────────

export function ProgressBar({ progress, wide = false }) {
  return html`<svg class=${`tb-bar${wide ? " wide" : ""}`} viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <rect class="tb-bar-track" width="100" height="6" />
    ${barSegments(progress).map((s) => html`<rect key=${s.k} class=${`tb-seg st-${s.k}`} x=${s.x} width=${s.w} height="6" />`)}</svg>`;
}

export function StatusPill({ status }) {
  return html`<span class=${`tb-pill st-${status}`}>${t(`tasks.${status}`)}</span>`;
}

/** A per-device preference (localStorage may be unavailable: then nothing is remembered). */
export function readStored(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
}
export function writeStored(key, value) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ }
}
