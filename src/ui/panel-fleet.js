// #1408 step 1: the Fleet panel (/ui/fleet[/<tab>]) — tasks, schedules, teams and the fleet's config — and the
// "New instance" dialog. Behind the session gate (/ui/js/), loaded the first time it is opened.
//
// Opening a tab reads its list: a person's navigation, so it counts as use, as the old tab click did (#1374 — no timer
// here re-reads anything). Every read is under the navigation's lease: a list that arrives after the person moved on
// is dropped (#1408 §4).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { renavigate } from "/assets/app-nav.js";
import { chatPath, fleetPath, FLEET_TABS } from "/assets/app-route.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { confirmedWrite } from "./settings-confirm.js";

register("fleet", {
  en: {
    title: "Fleet", tasks: "Tasks", schedules: "Schedules", teams: "Teams", config: "Config",
    newTask: "New task", newSchedule: "New schedule", newTeam: "New team",
    noTasks: "No tasks yet", noTasksHint: "Create one to coordinate fleet work.", noSchedules: "No schedules yet", noSchedulesHint: "Automate recurring work with cron.",
    noTeams: "No teams yet", noTeamsHint: "Group instances for coordinated work.", countTasks: "{0} tasks", countSchedules: "{0} schedules", countTeams: "{0} teams",
    claim: "Claim", done: "Done", delete: "Delete", on: "on", off: "off", cancel: "Cancel", create: "Create", creating: "Creating…", save: "Save changes",
    taskTitle: "Title", taskDesc: "Description", priority: "Priority", assignee: "Assignee", unassigned: "Unassigned",
    pNormal: "Normal", pLow: "Low", pHigh: "High", pUrgent: "Urgent",
    cron: "Cron expression", message: "Message", target: "Target instance", label: "Label", teamName: "Team name", members: "Members",
    titleRequired: "Title required", scheduleFieldsRequired: "Cron, message, and target required", teamFieldsRequired: "Name and at least one member required",
    deleteSchedule: "Delete this schedule?", deleteTeam: "Delete team “{0}”?", taskCreated: "Task created", scheduleCreated: "Schedule created", scheduleDeleted: "Schedule deleted",
    teamCreated: "Team created", teamDeleted: "Team deleted", taskDone: "Task updated", configSaved: "Config saved", configRestart: " (restart the fleet to apply channel changes)",
    channel: "Channel", type: "Type", tokenEnv: "Bot token env", groupId: "Group ID", show: "Show", hide: "Hide", access: "Access control", mode: "Mode", locked: "Locked", open: "Open",
    allowedUsers: "Allowed users", allowedUsersNote: "Comma-separated user IDs", defaults: "Defaults", backend: "Backend", roots: "Project roots", addRoot: "Add root", removeRoot: "Remove",
    saveNote: "Saving rewrites fleet.yaml (its comments are lost).",
    newInstance: "New instance", directory: "Directory", directoryHint: "Optional — a workspace is created if empty", topic: "Topic name", topicHint: "From the directory name",
    topicRequired: "Topic name is required when Directory is empty", description: "Description", descriptionHint: "What this instance does", model: "Model", modelHint: "e.g. sonnet, opus, gpt-5",
    branch: "Branch (git worktree)", branchHint: "e.g. feature-x", tags: "Tags", tagsHint: "comma-separated, e.g. dev, review", systemPrompt: "System prompt", systemPromptHint: "Custom instructions for this instance",
    fleetDefault: "Use the fleet default", notInstalled: "(not installed)", deprecated: "(deprecated)", instanceCreated: "Instance created",
  },
  "zh-TW": {
    title: "Fleet", tasks: "Tasks", schedules: "排程", teams: "Teams", config: "設定",
    newTask: "新增 task", newSchedule: "新增排程", newTeam: "新增 team",
    noTasks: "還沒有 task", noTasksHint: "建立一個來協調 fleet 的工作。", noSchedules: "還沒有排程", noSchedulesHint: "用 cron 自動執行例行工作。",
    noTeams: "還沒有 team", noTeamsHint: "把 instance 分組一起工作。", countTasks: "{0} 個 task", countSchedules: "{0} 個排程", countTeams: "{0} 個 team",
    claim: "認領", done: "完成", delete: "刪除", on: "開", off: "關", cancel: "取消", create: "建立", creating: "建立中…", save: "儲存變更",
    taskTitle: "標題", taskDesc: "說明", priority: "優先順序", assignee: "負責人", unassigned: "未指派",
    pNormal: "一般", pLow: "低", pHigh: "高", pUrgent: "緊急",
    cron: "Cron 表示式", message: "訊息", target: "目標 instance", label: "標籤", teamName: "Team 名稱", members: "成員",
    titleRequired: "必須填寫標題", scheduleFieldsRequired: "必須填寫 Cron、訊息與目標 instance", teamFieldsRequired: "必須填寫名稱並選擇至少一名成員",
    deleteSchedule: "確定刪除此排程嗎？", deleteTeam: "確定刪除 team「{0}」嗎？", taskCreated: "Task 已建立", scheduleCreated: "排程已建立", scheduleDeleted: "排程已刪除",
    teamCreated: "Team 已建立", teamDeleted: "Team 已刪除", taskDone: "Task 已更新", configSaved: "設定已儲存", configRestart: "（請重新啟動 fleet 以套用頻道變更）",
    channel: "頻道", type: "類型", tokenEnv: "Bot token 環境變數", groupId: "Group ID", show: "顯示", hide: "隱藏", access: "存取控制", mode: "模式", locked: "鎖定", open: "開放",
    allowedUsers: "允許的使用者", allowedUsersNote: "以逗號分隔的使用者 ID", defaults: "預設值", backend: "Backend", roots: "專案根目錄", addRoot: "新增根目錄", removeRoot: "移除",
    saveNote: "儲存會改寫 fleet.yaml（其中的註解會遺失）。",
    newInstance: "新增 instance", directory: "目錄", directoryHint: "可留空——留空會自動建立工作區", topic: "Topic 名稱", topicHint: "預設取自目錄名稱",
    topicRequired: "目錄留空時必須填寫 Topic 名稱", description: "說明", descriptionHint: "這個 instance 做什麼", model: "模型", modelHint: "例如 sonnet、opus、gpt-5",
    branch: "分支（git worktree）", branchHint: "例如 feature-x", tags: "標籤", tagsHint: "以逗號分隔，例如 dev, review", systemPrompt: "System prompt", systemPromptHint: "這個 instance 的自訂指示",
    fleetDefault: "使用 fleet 預設", notInstalled: "（未安裝）", deprecated: "（已淘汰）", instanceCreated: "Instance 已建立",
  },
});

const ICONS = { tasks: "tasks", schedules: "clock", teams: "team", config: "sliders" };
const BACKENDS = ["claude-code", "codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"];

async function api(method, path, body, lease) {
  const o = { method, headers: { "Content-Type": "application/json" } };
  if (body) o.body = JSON.stringify(body);
  const r = await (lease ? lease.fetch(path, o) : fetch(path, o));
  return r.json();
}

/**
 * Load `path` under the lease: `null` while the first load runs, `{ error }` on failure. A refresh (a new `version`,
 * after Claim or Create) keeps showing what is there until the new list arrives — nothing below it is torn down, so
 * an open dialog and its draft survive (#1425 review). Only the latest request's answer is kept.
 */
function useLoad(lease, path, version) {
  const [state, setState] = useState(null);
  const seq = useRef(0);
  const shownFor = useRef(null);
  useEffect(() => {
    const mine = ++seq.current;
    if (shownFor.current !== lease) { shownFor.current = lease; setState(null); }
    (async () => {
      try {
        const d = await api("GET", path, null, lease);
        if (lease.current() && mine === seq.current) setState({ data: d });
      } catch { if (lease.current() && mine === seq.current) setState({ error: true }); }
    })();
  }, [lease, path, version]);
  return state;
}

export function FleetPanel({ route, navKey }) {
  const lease = useLease(navKey);
  const tab = route.tab;
  useEffect(() => { setTitle(`${t("fleet.title")} · ${t(`fleet.${tab}`)}`); }, [tab, navKey]);
  const Body = { tasks: Tasks, schedules: Schedules, teams: Teams, config: Config }[tab] || Tasks;
  return html`<div class="panel p-fleet">
    <${PanelHeader} title=${t("fleet.title")} />
    <nav class="seg" aria-label=${t("fleet.title")}>${FLEET_TABS.map(k => html`<a key=${k} href=${fleetPath(k)} class=${`seg-item${k === tab ? " active" : ""}`}
      aria-current=${k === tab ? "page" : undefined}><${Icon} name=${ICONS[k]} size=${16} /><span>${t(`fleet.${k}`)}</span></a>`)}</nav>
    <div class="panel-body"><div class="col"><${Body} lease=${lease} /></div></div>
  </div>`;
}

function ListHead({ count, label, action }) {
  return html`<div class="list-head"><span>${count}</span>${action ? html`<button type="button" class="btn btn-primary" onClick=${action.onClick}><${Icon} name="plus" size=${16} />${label}</button>` : null}</div>`;
}
function Loaded({ state, children }) {
  if (!state) return html`<${Skeleton} lines=${4} />`;
  if (state.error) return html`<${ErrorState} onRetry=${renavigate} />`;
  return children(state.data);
}

function Tasks({ lease }) {
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const state = useLoad(lease, "/ui/tasks", version);
  async function act(id, action) {
    const r = await api("POST", `/ui/tasks/${encodeURIComponent(id)}`, { action });
    if (r.error) toast(r.error, false); else { toast(t("fleet.taskDone")); setVersion(v => v + 1); }
  }
  return html`<${Loaded} state=${state}>${(d) => {
    const tasks = d.tasks || [];
    return html`<${ListHead} count=${t("fleet.countTasks", tasks.length)} label=${t("fleet.newTask")} action=${{ onClick: () => setCreating(true) }} />
      ${tasks.length ? html`<ul class="rows">${tasks.map(x => html`<li key=${x.id} class="row-item">
        <span class=${`pill ${x.status}`}>${x.status}</span><span class="grow">${x.title}</span>
        ${x.assignee ? html`<a class="link" href=${chatPath(x.assignee)}>${x.assignee}</a>` : null}
        ${x.status === "open" ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => act(x.id, "claim")}>${t("fleet.claim")}</button>` : null}
        ${x.status === "claimed" ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => act(x.id, "complete")}>${t("fleet.done")}</button>` : null}
      </li>`)}</ul>` : html`<${Empty} icon="tasks" title=${t("fleet.noTasks")} hint=${t("fleet.noTasksHint")} />`}
`;
  }}</${Loaded}>
  ${creating ? html`<${CreateTask} onClose=${() => setCreating(false)} onDone=${() => setVersion(v => v + 1)} />` : null}`;
}

function Schedules({ lease }) {
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const state = useLoad(lease, "/ui/schedules", version);
  async function del(id) {
    if (!confirm(t("fleet.deleteSchedule"))) return;
    const r = await api("DELETE", `/ui/schedules/${encodeURIComponent(id)}`);
    if (r.error) toast(r.error, false); else { toast(t("fleet.scheduleDeleted")); setVersion(v => v + 1); }
  }
  return html`<${Loaded} state=${state}>${(d) => {
    const list = d.schedules || [];
    return html`<${ListHead} count=${t("fleet.countSchedules", list.length)} label=${t("fleet.newSchedule")} action=${{ onClick: () => setCreating(true) }} />
      ${list.length ? html`<ul class="rows">${list.map(x => html`<li key=${x.id} class="row-item">
        <span class=${`pill ${x.enabled ? "open" : "done"}`}>${x.enabled ? t("fleet.on") : t("fleet.off")}</span>
        <span class="grow">${x.label || cronDesc(x.cron)}</span><span class="mono muted" title=${cronDesc(x.cron)}>${x.cron}</span>
        <a class="link" href=${chatPath(x.target)}>${x.target}</a>
        <button type="button" class="btn btn-ghost btn-sm danger" onClick=${() => del(x.id)}>${t("fleet.delete")}</button></li>`)}</ul>`
        : html`<${Empty} icon="clock" title=${t("fleet.noSchedules")} hint=${t("fleet.noSchedulesHint")} />`}
`;
  }}</${Loaded}>
  ${creating ? html`<${CreateSchedule} onClose=${() => setCreating(false)} onDone=${() => setVersion(v => v + 1)} />` : null}`;
}

function Teams({ lease }) {
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const state = useLoad(lease, "/ui/teams", version);
  async function del(name) {
    if (!confirm(t("fleet.deleteTeam", name))) return;
    const r = await api("DELETE", `/ui/teams/${encodeURIComponent(name)}`);
    if (r.error) toast(r.error, false); else { toast(t("fleet.teamDeleted")); setVersion(v => v + 1); }
  }
  return html`<${Loaded} state=${state}>${(d) => {
    const entries = Object.entries(d.teams || {});
    return html`<${ListHead} count=${t("fleet.countTeams", entries.length)} label=${t("fleet.newTeam")} action=${{ onClick: () => setCreating(true) }} />
      ${entries.length ? html`<ul class="rows">${entries.map(([name, team]) => html`<li key=${name} class="row-item">
        <span class="grow strong">${name}</span><span class="muted">${(team.members || []).join(", ")}</span>
        <button type="button" class="btn btn-ghost btn-sm danger" onClick=${() => del(name)}>${t("fleet.delete")}</button></li>`)}</ul>`
        : html`<${Empty} icon="team" title=${t("fleet.noTeams")} hint=${t("fleet.noTeamsHint")} />`}
`;
  }}</${Loaded}>
  ${creating ? html`<${CreateTeam} onClose=${() => setCreating(false)} onDone=${() => setVersion(v => v + 1)} />` : null}`;
}

function Secret({ id, value, onInput, label }) {
  const [shown, setShown] = useState(false);
  return html`<div class="field-row"><input id=${id} type=${shown ? "text" : "password"} value=${value} onInput=${onInput} autocomplete="off" />
    <button type="button" class="icon-btn" aria-label=${shown ? t("fleet.hide") : t("fleet.show")} aria-pressed=${shown ? "true" : "false"} title=${`${shown ? t("fleet.hide") : t("fleet.show")} ${label}`}
      onClick=${() => setShown(!shown)}><${Icon} name="eye" size=${16} /></button></div>`;
}

function Config({ lease }) {
  const state = useLoad(lease, "/ui/config", 0);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!state || !state.data) return;
    const c = state.data, ch = c.channel || {}, acc = ch.access || {};
    setForm({ type: ch.type || "", tokenEnv: ch.bot_token_env || "AGEND_BOT_TOKEN", groupId: ch.group_id || "", mode: acc.mode || "locked",
      users: (acc.allowed_users || []).join(", "), backend: (c.defaults || {}).backend || "claude-code", roots: [...(c.project_roots || [])] });
  }, [state]);
  async function save() {
    setSaving(true);
    const body = {
      channel: { group_id: form.groupId.trim(), access: { mode: form.mode, allowed_users: form.users.split(",").map(s => s.trim()).filter(Boolean) } },
      defaults: { backend: form.backend },
      project_roots: form.roots.map(r => r.trim()).filter(Boolean),
    };
    let r;
    // A change to access or the connection may need a fleet admin's confirmation (#1423): the shell follows it.
    try {
      const res = await confirmedWrite("/ui/config", { method: "POST", body, label: t("fleet.config"),
        onPending: () => { toast(t("app.pendingSent")); if (lease.current()) setSaving(false); } });
      r = res.ok ? res.body || {} : { error: (res.body && res.body.error) || `HTTP ${res.status}` };
    } catch (err) { r = { error: err.message }; }
    if (lease.current()) setSaving(false);
    if (r.error) toast(r.error, false); else toast(t("fleet.configSaved") + (r.needs_restart ? t("fleet.configRestart") : ""));
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return html`<${Loaded} state=${state}>${() => !form ? html`<${Skeleton} lines=${4} />` : html`
    <section class="card"><h3>${t("fleet.channel")}</h3>
      <label class="field"><span>${t("fleet.type")}</span><input value=${form.type} disabled /></label>
      <label class="field"><span>${t("fleet.tokenEnv")}</span><input value=${form.tokenEnv} disabled /></label>
      <div class="field"><label for="cfg-gid">${t("fleet.groupId")}</label><${Secret} id="cfg-gid" value=${form.groupId} onInput=${set("groupId")} label=${t("fleet.groupId")} /></div></section>
    <section class="card"><h3>${t("fleet.access")}</h3>
      <label class="field"><span>${t("fleet.mode")}</span><select value=${form.mode} onChange=${set("mode")}><option value="locked">${t("fleet.locked")}</option><option value="open">${t("fleet.open")}</option></select></label>
      <div class="field"><label for="cfg-users">${t("fleet.allowedUsers")}</label><${Secret} id="cfg-users" value=${form.users} onInput=${set("users")} label=${t("fleet.allowedUsers")} />
        <p class="note">${t("fleet.allowedUsersNote")}</p></div></section>
    <section class="card"><h3>${t("fleet.defaults")}</h3>
      <label class="field"><span>${t("fleet.backend")}</span><select value=${form.backend} onChange=${set("backend")}>
        ${[...(BACKENDS.includes(form.backend) ? [] : [form.backend]), ...BACKENDS].map(b => html`<option key=${b} value=${b}>${b}</option>`)}</select></label></section>
    <section class="card"><h3>${t("fleet.roots")}</h3>
      ${form.roots.map((r, i) => html`<div key=${i} class="field-row"><input value=${r} placeholder="/path/to/projects" aria-label=${t("fleet.roots")}
        onInput=${(e) => { const roots = [...form.roots]; roots[i] = e.target.value; setForm({ ...form, roots }); }} />
        <button type="button" class="icon-btn" aria-label=${t("fleet.removeRoot")} title=${t("fleet.removeRoot")} onClick=${() => setForm({ ...form, roots: form.roots.filter((_, j) => j !== i) })}><${Icon} name="close" size=${16} /></button></div>`)}
      <button type="button" class="btn btn-ghost" onClick=${() => setForm({ ...form, roots: [...form.roots, ""] })}><${Icon} name="plus" size=${16} />${t("fleet.addRoot")}</button></section>
    <div class="save-row"><button type="button" class="btn btn-primary" disabled=${saving} onClick=${save}>${t("fleet.save")}</button><span class="note">${t("fleet.saveNote")}</span></div>`}</${Loaded}>`;
}

// ── Create dialogs ──

/**
 * One form dialog: fields, Cancel / Create, the request, a toast. Its own lease ends when the dialog goes: a request
 * that finishes after that still reports its toast (it may have created something), but never closes or refreshes
 * whatever is on screen now (#1425 review). `ready` false keeps Create off until the form has what it needs.
 */
export function FormDialog({ title, onClose, submit, children, ready = true }) {
  const lease = useLease("form-dialog");
  const [busy, setBusy] = useState(false);
  async function go() {
    if (busy || !ready) return;
    const body = submit.collect();
    if (!body) return;
    setBusy(true);
    let r, handedOver = false;
    // A write that needs a fleet admin's confirmation (#1423; e.g. a new instance with control-bearing settings):
    // the dialog goes at once and the shell follows the request. From then on the dialog is done: the decision is
    // said in a toast, and nothing here closes, refreshes or acts again.
    try {
      const res = await confirmedWrite(submit.path, { method: "POST", body, label: title,
        onPending: () => { handedOver = true; toast(t("app.pendingSent")); if (lease.current()) { setBusy(false); onClose(); } } });
      r = res.ok ? res.body || {} : { error: (res.body && res.body.error) || `HTTP ${res.status}` };
    } catch (err) { r = { error: err.message }; }
    if (r.error) { toast(r.error, false); if (!handedOver && lease.current()) setBusy(false); return; }
    toast(submit.done);
    if (handedOver || !lease.current()) return;
    setBusy(false);
    onClose();
    if (submit.after) submit.after();
  }
  return html`<${Dialog} title=${title} onClose=${onClose} busy=${busy}
    actions=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${t("fleet.cancel")}</button>
      <button type="button" class="btn btn-primary" onClick=${go} disabled=${busy || !ready}>${busy ? t("fleet.creating") : t("fleet.create")}</button>`}>
    <form class="form" onSubmit=${(e) => { e.preventDefault(); go(); }}><fieldset class="form" disabled=${busy}>${children}</fieldset></form></${Dialog}>`;
}
const field = (label, input) => html`<label class="field"><span>${label}</span>${input}</label>`;

function CreateTask({ onClose, onDone }) {
  const { instances } = useStore(appStore);
  const [f, setF] = useState({ title: "", desc: "", priority: "normal", assignee: "" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = { path: "/ui/tasks", done: t("fleet.taskCreated"), after: onDone, collect: () => {
    if (!f.title.trim()) { toast(t("fleet.titleRequired"), false); return null; }
    const body = { title: f.title.trim(), priority: f.priority };
    if (f.desc.trim()) body.description = f.desc.trim();
    if (f.assignee) body.assignee = f.assignee;
    return body;
  } };
  return html`<${FormDialog} title=${t("fleet.newTask")} onClose=${onClose} submit=${submit}>
    ${field(`${t("fleet.taskTitle")} *`, html`<input value=${f.title} onInput=${set("title")} required />`)}
    ${field(t("fleet.taskDesc"), html`<input value=${f.desc} onInput=${set("desc")} />`)}
    ${field(t("fleet.priority"), html`<select value=${f.priority} onChange=${set("priority")}><option value="normal">${t("fleet.pNormal")}</option><option value="low">${t("fleet.pLow")}</option><option value="high">${t("fleet.pHigh")}</option><option value="urgent">${t("fleet.pUrgent")}</option></select>`)}
    ${field(t("fleet.assignee"), html`<select value=${f.assignee} onChange=${set("assignee")}><option value="">${t("fleet.unassigned")}</option>${instances.map(i => html`<option key=${i.name} value=${i.name}>${i.name}</option>`)}</select>`)}
  </${FormDialog}>`;
}

function CreateSchedule({ onClose, onDone }) {
  const { instances } = useStore(appStore);
  const [f, setF] = useState({ cron: "", msg: "", target: instances[0] ? instances[0].name : "", label: "" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = { path: "/ui/schedules", done: t("fleet.scheduleCreated"), after: onDone, collect: () => {
    if (!f.cron.trim() || !f.msg.trim() || !f.target) { toast(t("fleet.scheduleFieldsRequired"), false); return null; }
    const body = { cron: f.cron.trim(), message: f.msg.trim(), target: f.target, source: "web-user", reply_chat_id: "", reply_thread_id: "" };
    if (f.label.trim()) body.label = f.label.trim();
    return body;
  } };
  return html`<${FormDialog} title=${t("fleet.newSchedule")} onClose=${onClose} submit=${submit}>
    ${field(`${t("fleet.cron")} *`, html`<input value=${f.cron} onInput=${set("cron")} placeholder="0 9 * * 1-5" class="mono" />`)}
    ${f.cron.trim() ? html`<p class="note">${cronDesc(f.cron)}</p>` : null}
    ${field(`${t("fleet.message")} *`, html`<input value=${f.msg} onInput=${set("msg")} />`)}
    ${field(`${t("fleet.target")} *`, html`<select value=${f.target} onChange=${set("target")}>${instances.map(i => html`<option key=${i.name} value=${i.name}>${i.name}</option>`)}</select>`)}
    ${field(t("fleet.label"), html`<input value=${f.label} onInput=${set("label")} />`)}
  </${FormDialog}>`;
}

function CreateTeam({ onClose, onDone }) {
  const { instances } = useStore(appStore);
  const [f, setF] = useState({ name: "", desc: "", members: [] });
  const toggle = (n) => setF({ ...f, members: f.members.includes(n) ? f.members.filter(x => x !== n) : [...f.members, n] });
  const submit = { path: "/ui/teams", done: t("fleet.teamCreated"), after: onDone, collect: () => {
    if (!f.name.trim() || !f.members.length) { toast(t("fleet.teamFieldsRequired"), false); return null; }
    const body = { name: f.name.trim(), members: f.members };
    if (f.desc.trim()) body.description = f.desc.trim();
    return body;
  } };
  return html`<${FormDialog} title=${t("fleet.newTeam")} onClose=${onClose} submit=${submit}>
    ${field(`${t("fleet.teamName")} *`, html`<input value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} />`)}
    ${field(t("fleet.taskDesc"), html`<input value=${f.desc} onInput=${(e) => setF({ ...f, desc: e.target.value })} />`)}
    <fieldset class="field"><legend>${t("fleet.members")} *</legend><div class="checks">${instances.map(i => html`<label key=${i.name} class="check">
      <input type="checkbox" checked=${f.members.includes(i.name)} onChange=${() => toggle(i.name)} />${i.name}</label>`)}</div></fieldset>
  </${FormDialog}>`;
}

/** "New instance": the sidebar's ✎ opens it from anywhere (#1408 step 3 merges it with Settings' create flow). */
export function CreateInstanceDialog({ onClose }) {
  const lease = useLease("create-instance");
  const [backends, setBackends] = useState(null);
  const [f, setF] = useState({ dir: "", topic: "", desc: "", backend: "", model: "", branch: "", tags: "", prompt: "" });
  useEffect(() => {
    (async () => {
      try {
        const bd = await api("GET", "/ui/backends", null, lease);
        if (!lease.current()) return;
        const list = bd.backends || [];
        const first = list.find(b => b.installed && !b.deprecated) || list.find(b => b.installed);
        setBackends(list);
        setF(x => ({ ...x, backend: first ? first.name : "" }));
      } catch {
        // The list could not be read: offer the known backends, and keep the explicit choice "fleet default" selected.
        if (lease.current()) { setBackends(BACKENDS.map(name => ({ name, installed: true }))); setF(x => ({ ...x, backend: "" })); }
      }
    })();
  }, [lease]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = { path: "/ui/instances", done: t("fleet.instanceCreated"), collect: () => {
    if (!f.dir.trim() && !f.topic.trim()) { toast(t("fleet.topicRequired"), false); return null; }
    const body = {};
    if (f.dir.trim()) body.directory = f.dir.trim();
    if (f.topic.trim()) body.topic_name = f.topic.trim();
    if (f.desc.trim()) body.description = f.desc.trim();
    if (f.backend) body.backend = f.backend;
    if (f.model.trim()) body.model = f.model.trim();
    if (f.branch.trim()) body.branch = f.branch.trim();
    const tags = f.tags.split(",").map(x => x.trim()).filter(Boolean); if (tags.length) body.tags = tags;
    if (f.prompt.trim()) body.systemPrompt = f.prompt.trim();
    return body;
  } };
  // Create waits for the backend list: a submission before it would go without a backend, and the list arriving
  // afterwards would change the shown choice under a request already sent (#1425 review).
  return html`<${FormDialog} title=${t("fleet.newInstance")} onClose=${onClose} submit=${submit} ready=${backends !== null}>
    ${field(t("fleet.directory"), html`<input value=${f.dir} onInput=${set("dir")} placeholder=${t("fleet.directoryHint")} />`)}
    ${field(`${t("fleet.topic")}${f.dir.trim() ? "" : " *"}`, html`<input value=${f.topic} onInput=${set("topic")} placeholder=${t("fleet.topicHint")} />`)}
    ${field(t("fleet.description"), html`<input value=${f.desc} onInput=${set("desc")} placeholder=${t("fleet.descriptionHint")} />`)}
    ${field(t("fleet.backend"), backends ? html`<select value=${f.backend} onChange=${set("backend")}><option value="">${t("fleet.fleetDefault")}</option>
      ${backends.map(b => html`<option key=${b.name} value=${b.name} disabled=${!b.installed}>${b.name}${b.deprecated ? ` ${t("fleet.deprecated")}` : ""}${b.installed ? "" : ` ${t("fleet.notInstalled")}`}</option>`)}</select>` : html`<${Skeleton} lines=${1} />`)}
    ${field(t("fleet.model"), html`<input value=${f.model} onInput=${set("model")} placeholder=${t("fleet.modelHint")} />`)}
    ${field(t("fleet.branch"), html`<input value=${f.branch} onInput=${set("branch")} placeholder=${t("fleet.branchHint")} />`)}
    ${field(t("fleet.tags"), html`<input value=${f.tags} onInput=${set("tags")} placeholder=${t("fleet.tagsHint")} />`)}
    ${field(t("fleet.systemPrompt"), html`<textarea rows="3" value=${f.prompt} onInput=${set("prompt")} placeholder=${t("fleet.systemPromptHint")}></textarea>`)}
  </${FormDialog}>`;
}

// ── Cron in words ──
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function cronDesc(expr) {
  if (!expr) return "";
  const p = expr.trim().split(/\s+/);
  if (p.length < 5) return expr;
  const [min, hr, dom, mon, dow] = p;
  const time = hr !== "*" && min !== "*" ? `at ${hr.padStart(2, "0")}:${min.padStart(2, "0")}` : "";
  if (min === "*" && hr === "*") return "Every minute";
  if (min.startsWith("*/")) return `Every ${min.slice(2)} minutes`;
  if (hr.startsWith("*/")) return `Every ${hr.slice(2)} hours`;
  if (dom === "*" && mon === "*" && dow === "*") return `Daily ${time}`;
  if (dom === "*" && mon === "*" && dow === "1-5") return `Weekdays ${time}`;
  if (dom === "*" && mon === "*" && dow !== "*") return `${dow.split(",").map(d => { const n = parseInt(d, 10); return Number.isNaN(n) ? d : (DAYS[n] || d); }).join(", ")} ${time}`;
  if (dom !== "*" && mon === "*") return `${dom}${dom === "1" ? "st" : dom === "2" ? "nd" : dom === "3" ? "rd" : "th"} of month ${time}`;
  return expr;
}
