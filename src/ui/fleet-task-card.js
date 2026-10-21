// One card of the task board (Fleet › Tasks), in the app's dialog: every field editable in place, the checklist, the
// moves the person makes (confirm, send back, answer, move, cancel, reopen), its sub tasks, and its comments, progress
// log and history. Edits carry the version they started from, so saving over an agent's newer write is caught (409):
// the dialog then shows the newer card with the draft still open, and saving again overwrites on purpose.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { StatusPill, answerBlocked, askText, boardApi, errorText, followsSubs, moveCard, notesForPeople, relTime } from "./fleet-task-common.js";

register("taskcard", {
  en: {
    loading: "Loading…", missing: "There is no card {0}", version: "v{0}", copyLink: "Copy this card's link", linkCopied: "Link copied",
    conflict: "{0} changed while you were editing. The newer card is shown and your edit is still open — save again to overwrite it.",
    moveTo: "Move to…", moveLabel: "Change the status", followsSubs: "It has sub tasks: its status follows them",
    reopen: "Reopen", cancelCard: "Cancel this card", confirmMain: "Confirm the main task",
    assignee: "Assignee", nobody: "Unassigned", unassign: "(unassign)", other: "Other…", otherTitle: "Assign to another instance", otherLabel: "The instance's name",
    change: "Change…", project: "Project", priority: "Priority", size: "Size", review: "Your confirmation", reviewBox: "Stop at review for my confirmation",
    parent: "Main task", deps: "Waits for", none: "None", edit: "Edit", depsTitle: "What {0} waits for", depsLabel: "Card numbers to finish first, separated by commas or spaces (empty: nothing)",
    depWaiting: "Not done yet", depDone: "Done", opened: "Opened by {0} {1} · changed {2}",
    blockedReason: "Blocked on", goal: "Goal", goalHint: "Why, and what done looks like", scope: "Scope", scopeHint: "In: … / Out: …",
    definition: "Definition of done", acceptance: "Acceptance", context: "Context", contextHint: "Paths, related cards, decisions already made",
    state: "State", stateHint: "Done / next / watch out (the assignee keeps it current)", result: "Result", resultHint: "Which files changed and how it was checked",
    empty: "(empty — click to edit)", clickToEdit: "Click to edit", ctrlEnter: "Ctrl+Enter saves", save: "Save", cancel: "Cancel",
    checklistEmpty: "(none yet — click to add)", editList: "Edit the list", onePerLine: "One per line; an item whose text changes is unchecked again", items: "{0}/{1} items",
    subs: "Sub tasks ({0})", quickAdd: "New sub task: type a title and press Enter (small work needs no split)",
    tabComments: "Comments {0}", tabLog: "Progress log {0}", tabHistory: "History", noComments: "No comments yet", noLog: "No progress log yet",
    rejectTag: "Sent back", approveTag: "Confirmed", commentTo: "Comment to {0} (Ctrl+Enter sends)", commentHint: "Comment (Ctrl+Enter sends)", send: "Send",
    evCreated: "opened it", evMoved: "{0} → {1}", evAuto: " (automatic)", evAssigned: "assignee {0} → {1}", evUpdated: "changed {0}", evCommented: "commented", evLogged: "log: {0}",
    fTitle: "title", fGoal: "goal", fScope: "scope", fContext: "context", fState: "state", fResult: "result", fBlockedReason: "blocked reason", fSize: "size",
    fPriority: "priority", fNeedsReview: "needs review", fDependsOn: "dependencies", fAcceptance: "acceptance", fProjectId: "project",
    position: "Position", moveUp: "Move up", moveDown: "Move down",
  },
  "zh-TW": {
    loading: "載入中…", missing: "找不到 {0}", version: "v{0}", copyLink: "複製這張卡的連結", linkCopied: "已複製連結",
    conflict: "{0} 在你編輯時被改過了。已載入最新內容，你的修改還在，再存一次就會覆蓋。",
    moveTo: "移到…", moveLabel: "改狀態", followsSubs: "有子任務，狀態會跟著子任務自動變化",
    reopen: "重新打開", cancelCard: "取消這張卡", confirmMain: "確認主任務",
    assignee: "負責人", nobody: "沒人負責", unassign: "（不指派）", other: "其他…", otherTitle: "指派給其他 instance", otherLabel: "instance 名稱",
    change: "改…", project: "專案", priority: "優先度", size: "大小", review: "你確認", reviewBox: "做完要停在待確認，等我確認",
    parent: "主任務", deps: "相依", none: "沒有", edit: "編輯", depsTitle: "{0} 的相依", depsLabel: "要先完成的卡號，用逗號或空白分開（留空＝沒有相依）",
    depWaiting: "還沒完成", depDone: "已完成", opened: "{0} 開的・{1}・最後更新 {2}",
    blockedReason: "卡住原因", goal: "目標", goalHint: "為什麼做、做完是什麼樣子", scope: "範圍", scopeHint: "做：…／不做：…",
    definition: "完成定義", acceptance: "驗收條件", context: "背景", contextHint: "檔案路徑、相關卡號、已經做的決定",
    state: "目前狀態", stateHint: "已完成／下一步／注意（負責人會隨時覆寫）", result: "產出", resultHint: "改了哪些檔案、怎麼驗證",
    empty: "（未填，點一下編輯）", clickToEdit: "點一下編輯", ctrlEnter: "Ctrl+Enter 儲存", save: "儲存", cancel: "取消",
    checklistEmpty: "（還沒有，點一下新增）", editList: "編輯清單", onePerLine: "一行一項；改了文字的項目會變回沒勾", items: "{0}/{1} 項",
    subs: "子任務（{0}）", quickAdd: "新增子任務：輸入標題後按 Enter（小事可以不拆）",
    tabComments: "留言 {0}", tabLog: "進度紀錄 {0}", tabHistory: "變更歷史", noComments: "還沒有留言", noLog: "還沒有進度紀錄",
    rejectTag: "退回", approveTag: "確認", commentTo: "留言給 {0}（Ctrl+Enter 送出）", commentHint: "留言（Ctrl+Enter 送出）", send: "送出",
    evCreated: "開卡", evMoved: "{0}→{1}", evAuto: "（自動）", evAssigned: "負責人 {0}→{1}", evUpdated: "修改{0}", evCommented: "留言", evLogged: "紀錄：{0}",
    fTitle: "標題", fGoal: "目標", fScope: "範圍", fContext: "背景", fState: "目前狀態", fResult: "產出", fBlockedReason: "卡住原因", fSize: "大小",
    fPriority: "優先度", fNeedsReview: "需要確認", fDependsOn: "相依", fAcceptance: "驗收條件", fProjectId: "專案",
    position: "位置", moveUp: "往上移", moveDown: "往下移",
  },
});

const MOVES = ["open", "claimed", "blocked", "review", "done"];
const LIMIT = { title: 100, goal: 300, scope: 600, context: 1000, state: 500, result: 1000, blockedReason: 400, acceptanceItems: 10 };

/** One history line, without who and when. */
export function describeEvent(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "created": return t("taskcard.evCreated");
    case "moved": return `${t("taskcard.evMoved", t(`tasks.${d.from}`), t(`tasks.${d.to}`))}${d.auto ? t("taskcard.evAuto") : ""}${d.reason ? `: ${d.reason}` : ""}`;
    case "assigned": return t("taskcard.evAssigned", d.from || "—", d.to || "—");
    case "updated": return t("taskcard.evUpdated", Object.keys(d.changes || {}).map((k) => fieldName(k)).join(", "));
    case "commented": return t("taskcard.evCommented");
    case "logged": return t("taskcard.evLogged", d.text || "");
    default: return ev.type;
  }
}
const fieldName = (k) => { const key = `taskcard.f${k[0].toUpperCase()}${k.slice(1)}`; const s = t(key); return s === key ? k : s; };

/**
 * `writable`: false over the public link (the card is shown, nothing on it changes). `place`: up and down in its column,
 * for touch and keyboard (null when it cannot move).
 */
export function CardDialog({ id, tick, projects, writable = true, place = null, onClose, onOpen, reloadBoard }) {
  const { instances } = useStore(appStore);
  const [detail, setDetail] = useState(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState("comments");
  const seq = useRef(0);

  async function load() {
    const mine = ++seq.current;
    try {
      const d = await boardApi.card(id);
      if (mine === seq.current) { setDetail(d); setMissing(false); }
    } catch (err) {
      if (mine !== seq.current) return;
      if (err.status === 404 || err.status === 400) setMissing(true);
      else toast(errorText(err), false);
    }
  }
  useEffect(() => { void load(); }, [id, tick]);

  /** A write and what follows: its notes, the card and the board read again. Resolves "ok", "conflict" or "error". */
  async function run(fn) {
    try {
      const r = await fn();
      for (const n of notesForPeople(r && r.notes)) toast(n);
      await load();
      reloadBoard();
      return "ok";
    } catch (err) {
      const conflict = err.status === 409;
      toast(conflict ? t("taskcard.conflict", id) : errorText(err), false);
      if (conflict) await load();
      return conflict ? "conflict" : "error";
    }
  }
  /** A move from this dialog: one at a time (claimed before the first await), then the card and the board read again. */
  const moving = useRef(false);
  const [busy, setBusy] = useState(false);
  async function moved(start) {
    if (moving.current) return;
    moving.current = true;
    setBusy(true);
    try { const r = await start(); if (r) { await load(); reloadBoard(); } }
    finally { moving.current = false; setBusy(false); }
  }

  if (missing || !detail) {
    return html`<${Dialog} title=${id} onClose=${onClose} wide><p class="muted">${missing ? t("taskcard.missing", id) : t("taskcard.loading")}</p></${Dialog}>`;
  }

  const { card, parent, children } = detail;
  const isMain = card.kind === "main";
  const derived = followsSubs(card);
  const finished = card.status === "done" || card.status === "cancelled";
  /** `version` guards against overwriting a newer card; null skips it (text typed after a conflict was shown). */
  const save = (patch, version = card.version) => run(() => boardApi.update(card.id, version === null ? patch : { ...patch, version }));
  const names = [...new Set([...instances.map((i) => i.name), card.assignee].filter(Boolean))].sort();

  async function chooseAssignee(value) {
    if (value === "\u0000other") {
      const name = await askText({ title: t("taskcard.otherTitle"), label: t("taskcard.otherLabel"), required: true });
      if (name) await save({ assignee: name }, null);
      return;
    }
    await save({ assignee: value === "\u0000none" ? null : value });
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

  return html`<${Dialog} title=${`${card.id} · ${t(`tasks.${card.kind}`)}`} onClose=${onClose} wide label=${`${card.id} ${card.title}`}>
    <div class="tc">
      <div class="tc-head">
        ${writable ? html`<${InlineTitle} value=${card.title} version=${card.version} onSave=${(title, base) => save({ title }, base)} />` : html`<h3 class="tc-title">${card.title}</h3>`}
        <span class="muted tc-ver">${t("taskcard.version", card.version)}</span>
        <button type="button" class="icon-btn" title=${t("taskcard.copyLink")} aria-label=${t("taskcard.copyLink")} onClick=${copyLink}><${Icon} name="copy" size=${16} /></button>
      </div>

      <div class="tc-actions">
        <${StatusPill} status=${card.status} />
        ${writable ? html`
        ${card.status === "review" ? html`
          <button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${() => moved(() => moveCard(card, "done"))}><${Icon} name="check" size=${14} />${isMain ? t("taskcard.confirmMain") : t("tasks.confirm")}</button>
          <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => moved(() => moveCard(card, "claimed"))}>${t("tasks.sendBack")}</button>` : null}
        ${card.status === "blocked" ? html`<button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${() => moved(() => answerBlocked(card))}>${t("tasks.answer")}</button>` : null}
        ${!derived && !finished ? html`<select class="tb-select" value="" aria-label=${t("taskcard.moveLabel")} onChange=${(e) => { const to = e.target.value; e.target.value = ""; if (to) void moved(() => moveCard(card, to)); }} disabled=${busy}>
          <option value="">${t("taskcard.moveTo")}</option>
          ${MOVES.filter((s) => s !== card.status).map((s) => html`<option key=${s} value=${s}>${t(`tasks.${s}`)}</option>`)}</select>` : null}
        ${derived && !finished && card.status !== "blocked" ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => moved(() => moveCard(card, "blocked"))}>${t("tasks.block")}</button>` : null}
        ${derived && !finished ? html`<span class="muted tc-hint">${t("taskcard.followsSubs")}</span>` : null}
        <span class="tb-grow"></span>
        ${finished
          ? html`<button type="button" class="btn btn-ghost btn-sm" disabled=${busy} onClick=${() => moved(() => moveCard(card, card.status === "done" ? "claimed" : "open"))}><${Icon} name="restart" size=${14} />${t("taskcard.reopen")}</button>`
          : html`<button type="button" class="btn btn-ghost btn-sm danger" disabled=${busy} onClick=${() => moved(() => moveCard(card, "cancelled"))}>${t("taskcard.cancelCard")}</button>`}` : null}
      </div>

      <dl class="tc-meta">
        <dt>${t("taskcard.assignee")}</dt>
        <dd><span class="tb-who">${card.assignee || t("taskcard.nobody")}</span>
          ${writable ? html`<select class="tb-select" value="\u0000pick" aria-label=${t("taskcard.assignee")} onChange=${(e) => { const v = e.target.value; e.target.value = "\u0000pick"; void chooseAssignee(v); }}>
            <option value="\u0000pick" disabled hidden>${t("taskcard.change")}</option>
            ${card.assignee ? html`<option value="\u0000none">${t("taskcard.unassign")}</option>` : null}
            ${names.filter((n) => n !== card.assignee).map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
            <option value="\u0000other">${t("taskcard.other")}</option>
          </select>` : null}</dd>
        ${isMain ? html`<dt>${t("taskcard.project")}</dt>
          <dd><select class="tb-select" disabled=${!writable} value=${card.projectId === null ? "" : String(card.projectId)} aria-label=${t("taskcard.project")}
            onChange=${(e) => void save({ projectId: e.target.value === "" ? null : Number(e.target.value) })}>
            <option value="">${t("tasks.noProject")}</option>
            ${projects.filter((p) => !p.archived || p.id === card.projectId).map((p) => html`<option key=${p.id} value=${String(p.id)}>${p.name}</option>`)}
          </select></dd>` : null}
        <dt>${t("taskcard.priority")}</dt>
        <dd><select class="tb-select" disabled=${!writable} value=${card.priority} aria-label=${t("taskcard.priority")} onChange=${(e) => void save({ priority: e.target.value })}>
          ${["urgent", "high", "normal", "low"].map((p) => html`<option key=${p} value=${p}>${t(`tasks.${p}`)}</option>`)}</select></dd>
        <dt>${t("taskcard.size")}</dt>
        <dd><select class="tb-select" disabled=${!writable} value=${card.size || ""} aria-label=${t("taskcard.size")} onChange=${(e) => void save({ size: e.target.value || null })}>
          <option value="">${t("tasks.sizeNone")}</option>${["S", "M", "L"].map((s) => html`<option key=${s} value=${s}>${t(`tasks.size${s}`)}</option>`)}</select></dd>
        <dt>${t("taskcard.review")}</dt>
        <dd><label class="tb-check"><input type="checkbox" disabled=${!writable} checked=${card.needsReview} onChange=${(e) => void save({ needsReview: e.target.checked })} />${t("taskcard.reviewBox")}</label></dd>
        ${parent ? html`<dt>${t("taskcard.parent")}</dt><dd><button type="button" class="tb-link" onClick=${() => onOpen(parent.id)}><span class="tb-code">${parent.id}</span> ${parent.title}</button></dd>` : null}
        <dt>${t("taskcard.deps")}</dt>
        <dd>${card.dependsOn.length ? card.dependsOn.map((d) => html`<button key=${d} type="button" class=${`tc-dep${card.unmetDeps.includes(d) ? " waiting" : ""}`}
            title=${card.unmetDeps.includes(d) ? t("taskcard.depWaiting") : t("taskcard.depDone")} onClick=${() => onOpen(d)}>${d}</button>`) : html`<span class="muted">${t("taskcard.none")}</span>`}
          ${writable ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${editDeps}>${t("taskcard.edit")}</button>` : null}</dd>
        ${place && (place.up || place.down) ? html`<dt>${t("taskcard.position")}</dt>
          <dd><button type="button" class="btn btn-ghost btn-sm" disabled=${!place.up} aria-label=${t("taskcard.moveUp")} title=${t("taskcard.moveUp")} onClick=${place.up}><${Icon} name="up" size=${16} /></button>
            <button type="button" class="btn btn-ghost btn-sm" disabled=${!place.down} aria-label=${t("taskcard.moveDown")} title=${t("taskcard.moveDown")} onClick=${place.down}><${Icon} name="down" size=${16} /></button></dd>` : null}
        <dt></dt>
        <dd class="muted">${t("taskcard.opened", card.createdBy, relTime(card.createdAt), relTime(card.updatedAt))}</dd>
      </dl>

      ${card.status === "blocked" ? html`<${Field} title=${t("taskcard.blockedReason")} tone="blocked">
        <${EditableText} readOnly=${!writable} value=${card.blockedReason} limit=${LIMIT.blockedReason} version=${card.version} onSave=${(v, base) => save({ blockedReason: v }, base)} /></${Field}>` : null}
      <${Field} title=${t("taskcard.goal")}><${EditableText} readOnly=${!writable} value=${card.goal} limit=${LIMIT.goal} version=${card.version} placeholder=${t("taskcard.goalHint")} onSave=${(v, base) => save({ goal: v }, base)} /></${Field}>
      ${isMain ? html`<${Field} title=${t("taskcard.scope")}><${EditableText} readOnly=${!writable} value=${card.scope} limit=${LIMIT.scope} version=${card.version} placeholder=${t("taskcard.scopeHint")} onSave=${(v, base) => save({ scope: v }, base)} /></${Field}>` : null}
      <${Field} title=${isMain ? t("taskcard.definition") : t("taskcard.acceptance")}>
        <${Checklist} card=${card} readOnly=${!writable} onToggle=${(n, done) => save(done ? { check: [n] } : { uncheck: [n] })} onReplace=${(items, base) => save({ acceptance: items }, base)} /></${Field}>
      <${Field} title=${t("taskcard.context")}><${EditableText} readOnly=${!writable} value=${card.context} limit=${LIMIT.context} version=${card.version} placeholder=${t("taskcard.contextHint")} onSave=${(v, base) => save({ context: v }, base)} /></${Field}>
      <${Field} title=${t("taskcard.state")}><${EditableText} readOnly=${!writable} value=${card.state} limit=${LIMIT.state} version=${card.version} placeholder=${t("taskcard.stateHint")} onSave=${(v, base) => save({ state: v }, base)} /></${Field}>
      <${Field} title=${t("taskcard.result")}><${EditableText} readOnly=${!writable} value=${card.result} limit=${LIMIT.result} version=${card.version} placeholder=${t("taskcard.resultHint")} onSave=${(v, base) => save({ result: v }, base)} /></${Field}>

      ${isMain ? html`<${Field} title=${t("taskcard.subs", children.length)}>
        ${children.length ? html`<ul class="tc-children">${children.map((c) => html`<li key=${c.id}><button type="button" onClick=${() => onOpen(c.id)}>
          <${StatusPill} status=${c.status} /><span class="tb-code">${c.id}</span><span class="tc-child-title">${c.title}</span><span class="tb-who">${c.assignee || ""}</span></button></li>`)}</ul>` : null}
        ${finished || !writable ? null : html`<${QuickAdd} placeholder=${t("taskcard.quickAdd")} onAdd=${(title) => run(() => boardApi.create({ parent: card.id, title }))} />`}
      </${Field}>` : null}

      <div class="seg tc-tabs" role="tablist">
        ${[["comments", t("taskcard.tabComments", detail.comments.length)], ["log", t("taskcard.tabLog", detail.logs.length)], ["history", t("taskcard.tabHistory")]].map(([k, label]) =>
          html`<button key=${k} type="button" role="tab" aria-selected=${tab === k ? "true" : "false"} class=${`seg-item${tab === k ? " active" : ""}`} onClick=${() => setTab(k)}>${label}</button>`)}
      </div>
      ${tab === "comments" ? html`<${Comments} entries=${detail.comments} card=${card} writable=${writable} onSend=${(text) => run(() => boardApi.update(card.id, { comment: text }))} />` : null}
      ${tab === "log" ? html`<ul class="tc-feed">${detail.logs.length ? detail.logs.map((e) => html`<li key=${e.id}><span class="muted">${relTime(e.at)}</span> <b>${e.author}</b> ${e.text}</li>`)
        : html`<li class="muted">${t("taskcard.noLog")}</li>`}</ul>` : null}
      ${tab === "history" ? html`<ul class="tc-feed">${[...detail.history].reverse().map((ev) => html`<li key=${ev.id}><span class="muted">${relTime(ev.at)}</span> <b>${ev.actor}</b> ${describeEvent(ev)}</li>`)}</ul>` : null}
    </div>
  </${Dialog}>`;
}

function Field({ title, tone, children }) {
  return html`<section class=${`tc-field${tone ? ` tone-${tone}` : ""}`}><h3>${title}</h3>${children}</section>`;
}

/**
 * Which version an edit started from: a save sends it, so an agent's newer write is caught (409). After a conflict
 * the next save of the same draft overwrites on purpose (null: no check).
 */
function useEditBase(version) {
  const [base, setBase] = useState(version);
  return {
    start: () => setBase(version),
    current: () => (base === undefined ? version : base),
    afterSave: (outcome) => { if (outcome === "conflict") setBase(null); },
  };
}

/** Focus moves into an edit box as it opens (before the next key: Esc must reach the box, not the dialog). */
function useAutoFocus(open) {
  const ref = useRef(null);
  useLayoutEffect(() => { if (open && ref.current) ref.current.focus(); }, [open]);
  return ref;
}

/** Esc leaves the edit, not the dialog. */
function escapeEdit(e, cancel) {
  if (e.key !== "Escape") return false;
  e.preventDefault();
  e.stopPropagation();
  cancel();
  return true;
}

function InlineTitle({ value, version, onSave }) {
  const [draft, setDraft] = useState(null);
  const base = useEditBase(version);
  const ref = useAutoFocus(draft !== null);
  if (draft === null) {
    return html`<button type="button" class="tc-title" title=${t("taskcard.clickToEdit")} onClick=${() => { setDraft(value); base.start(); }}>${value}</button>`;
  }
  const commit = async () => {
    const v = draft.trim();
    if (!v || v === value) { setDraft(null); return; }
    const outcome = await onSave(v, base.current());
    base.afterSave(outcome);
    if (outcome === "ok") setDraft(null);
  };
  return html`<input class="tc-title-input" value=${draft} maxlength=${LIMIT.title} ref=${ref}
    onInput=${(e) => setDraft(e.target.value)} onBlur=${() => void commit()}
    onKeyDown=${(e) => { if (escapeEdit(e, () => setDraft(null))) return; if (e.key === "Enter") { e.preventDefault(); void commit(); } }} />`;
}

function EditableText({ value, limit, placeholder, version, readOnly = false, onSave }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const base = useEditBase(version);
  const ref = useAutoFocus(draft !== null);
  if (readOnly) return html`<p class=${`tc-text${value ? "" : " empty"}`}>${value || "—"}</p>`;
  if (draft === null) {
    return html`<button type="button" class=${`tc-text${value ? "" : " empty"}`} title=${t("taskcard.clickToEdit")} onClick=${() => { setDraft(value); base.start(); }}>${value || placeholder || t("taskcard.empty")}</button>`;
  }
  const length = [...draft].length;
  const submit = async () => {
    if (saving) return;
    setSaving(true);
    const outcome = await onSave(draft.trim(), base.current());
    setSaving(false);
    base.afterSave(outcome);
    if (outcome === "ok") setDraft(null);
  };
  return html`<div class="tc-edit">
    <textarea rows=${Math.min(10, Math.max(3, draft.split("\n").length + 1))} value=${draft} ref=${ref}
      onInput=${(e) => setDraft(e.target.value)}
      onKeyDown=${(e) => { if (escapeEdit(e, () => setDraft(null))) return; if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}></textarea>
    <div class="tc-edit-bar">
      <span class=${`tc-counter${length > limit ? " over" : ""}`}>${length}/${limit}</span>
      <span class="muted">${t("taskcard.ctrlEnter")}</span>
      <span class="tb-grow"></span>
      <button type="button" class="btn btn-sm" onClick=${() => setDraft(null)}>${t("taskcard.cancel")}</button>
      <button type="button" class="btn btn-primary btn-sm" disabled=${saving || length > limit} onClick=${submit}>${t("taskcard.save")}</button>
    </div></div>`;
}

function Checklist({ card, readOnly = false, onToggle, onReplace }) {
  const [draft, setDraft] = useState(null);
  // One tick at a time: each sends the version it saw, so a second tick before the first is saved would be refused.
  // The tick being saved shows as asked meanwhile (the box does not flick back until the card is read again).
  const [ticking, setTicking] = useState(null);
  const tick = async (n, done) => { setTicking({ n, done }); try { await onToggle(n, done); } finally { setTicking(null); } };
  const base = useEditBase(card.version);
  const ref = useAutoFocus(draft !== null);
  const start = (text) => { setDraft(text); base.start(); };
  if (draft !== null) {
    const items = draft.split("\n").map((l) => l.trim()).filter(Boolean);
    const save = async () => {
      const outcome = await onReplace(items, base.current());
      base.afterSave(outcome);
      if (outcome === "ok") setDraft(null);
    };
    return html`<div class="tc-edit">
      <textarea rows=${Math.max(3, items.length + 1)} value=${draft} ref=${ref}
        onInput=${(e) => setDraft(e.target.value)}
        onKeyDown=${(e) => { if (escapeEdit(e, () => setDraft(null))) return; if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }}></textarea>
      <div class="tc-edit-bar">
        <span class=${`tc-counter${items.length > LIMIT.acceptanceItems ? " over" : ""}`}>${t("taskcard.items", items.length, LIMIT.acceptanceItems)}</span>
        <span class="muted">${t("taskcard.onePerLine")}</span>
        <span class="tb-grow"></span>
        <button type="button" class="btn btn-sm" onClick=${() => setDraft(null)}>${t("taskcard.cancel")}</button>
        <button type="button" class="btn btn-primary btn-sm" disabled=${items.length > LIMIT.acceptanceItems} onClick=${save}>${t("taskcard.save")}</button>
      </div></div>`;
  }
  if (!card.acceptance.length) return readOnly ? html`<p class="tc-text empty">—</p>` : html`<button type="button" class="tc-text empty" onClick=${() => start("")}>${t("taskcard.checklistEmpty")}</button>`;
  return html`<ul class="tc-checklist">${card.acceptance.map((a, i) => html`<li key=${`${i}-${a.text}`}><label class="tb-check">
      <input type="checkbox" checked=${ticking && ticking.n === i + 1 ? ticking.done : a.done} disabled=${readOnly || !!ticking} onChange=${() => void tick(i + 1, !a.done)} /><span class=${a.done ? "done" : ""}>${a.text}</span></label></li>`)}</ul>
    ${readOnly ? null : html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => start(card.acceptance.map((a) => a.text).join("\n"))}>${t("taskcard.editList")}</button>`}`;
}

function QuickAdd({ placeholder, onAdd }) {
  const [title, setTitle] = useState("");
  const busy = useRef(false);
  return html`<input class="tc-quick-add" value=${title} placeholder=${placeholder} aria-label=${placeholder} maxlength=${LIMIT.title}
    onInput=${(e) => setTitle(e.target.value)}
    onKeyDown=${async (e) => {
      if (e.key !== "Enter" || !title.trim() || busy.current) return;
      e.preventDefault();
      busy.current = true;
      if ((await onAdd(title.trim())) === "ok") setTitle("");
      busy.current = false;
    }} />`;
}

function Comments({ entries, card, writable = true, onSend }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const send = async () => {
    if (!text.trim() || busy.current) return;
    busy.current = true;
    setSending(true);
    if ((await onSend(text.trim())) === "ok") setText("");
    setSending(false);
    busy.current = false;
  };
  return html`<div class="tc-comments">
    ${entries.length ? null : html`<p class="muted">${t("taskcard.noComments")}</p>`}
    ${entries.map((e) => html`<div key=${e.id} class=${`tc-comment${e.authorKind === "person" ? " person" : ""}`}>
      <div class="tc-comment-head"><b>${e.author}</b>
        ${e.kind === "reject" ? html`<span class="tb-tag st-blocked">${t("taskcard.rejectTag")}</span>` : null}
        ${e.kind === "approve" ? html`<span class="tb-tag st-done">${t("taskcard.approveTag")}</span>` : null}
        <span class="muted">${relTime(e.at)}</span></div>
      <div class="tc-comment-body">${e.text}</div></div>`)}
    ${writable ? html`<div class="tc-composer">
      <textarea rows="2" value=${text} placeholder=${card.assignee ? t("taskcard.commentTo", card.assignee) : t("taskcard.commentHint")} aria-label=${t("taskcard.commentHint")}
        onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); return; } if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}></textarea>
      <button type="button" class="btn btn-primary btn-sm" disabled=${sending || !text.trim()} onClick=${send}>${t("taskcard.send")}</button>
    </div>` : null}</div>`;
}
