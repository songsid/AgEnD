// #1408 step 1: the Fleet panel (/ui/fleet[/<tab>]) — tasks, schedules, teams and the fleet's config — and the
// "New instance" dialog. Behind the session gate (/ui/js/), loaded the first time it is opened.
//
// Opening a tab reads its list: a person's navigation, so it counts as use, as the old tab click did (#1374 — no timer
// here re-reads anything). Every read is under the navigation's lease: a list that arrives after the person moved on
// is dropped (#1408 §4).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register, lang } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { HeaderTools } from "/assets/header-tools.js";
import { renavigate } from "/assets/app-nav.js";
import { chatPath, fleetPath, FLEET_TABS, rememberFleetTab } from "/assets/app-route.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { confirmedWrite, selfConfirmed } from "./settings-confirm.js";
import { OrgCanvas } from "./fleet-canvas.js";
import { labelOf } from "/assets/instance-nav.js";
import { CacheReport } from "./fleet-cache.js";
import { UsageTab } from "./fleet-usage.js";
import { BackendSelect, ModelSelect } from "./settings-dialogs.js";

/** #2015: one of the largest processes as text: "python3 18.1 GB (dev-a)". */
export function memoryHogText(p) {
  const size = p.rssBytes >= 1024 ** 3 ? `${(p.rssBytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(p.rssBytes / 1024 ** 2)} MB`;
  const owner = p.owner === "instance" && p.instance ? p.instance
    : t(p.owner === "fleet" ? "fleet.hostMemory_ownerFleet" : p.owner === "tmux" ? "fleet.hostMemory_ownerTmux" : "fleet.hostMemory_ownerOther");
  return `${p.name} ${size} (${owner})`;
}

register("fleet", {
  en: {
    hostMemory_elevated: "Host memory pressure: elevated — new agents start one at a time, at least 5 s apart",
    hostMemory_critical: "Host memory pressure: critical — new agents wait for memory to recover",
    hostMemory_top: "Largest: {0}", hostMemory_ownerFleet: "the fleet", hostMemory_ownerTmux: "tmux", hostMemory_ownerOther: "not an instance",
    title: "Fleet", tasks: "Tasks", schedules: "Schedules", teams: "Teams", org: "Org chart", cache: "Cache", usage: "Usage", config: "Config",
    docs: "Docs", docsNewTab: "Docs (opens in a new tab)",
    newTask: "New task", newSchedule: "New schedule", newTeam: "New team",
    noTasks: "No tasks yet", noTasksHint: "Create one to coordinate fleet work.", noSchedules: "No schedules yet", noSchedulesHint: "Automate recurring work with cron.",
    noTeams: "No teams yet", noTeamsHint: "Group instances for coordinated work.", countTasks: "{0} tasks", countSchedules: "{0} schedules", countTeams: "{0} teams", countTask: "1 task", countSchedule: "1 schedule", countTeam: "1 team",
    claim: "Claim", done: "Done", delete: "Delete", on: "on", off: "off", cancel: "Cancel", create: "Create", creating: "Creating…", save: "Save changes",
    taskTitle: "Title", taskDesc: "Description", priority: "Priority", assignee: "Assignee", unassigned: "Unassigned",
    pNormal: "Normal", pLow: "Low", pHigh: "High", pUrgent: "Urgent",
    cron: "Cron expression", message: "Message", target: "Target instance", label: "Label", teamName: "Team name", members: "Members",
    // #1724: schedules in words; Edit; once or repeating
    schedOnce: "Once · {0}", schedNext: "next {0}", schedRetrying: "retrying", schedDisabled: "disabled", schedSilent: "silent", schedTz: "Timezone: {0}",
    editSchedule: "Edit schedule", edit: "Edit", scheduleSaved: "Schedule saved", schedRepeat: "Repeat", schedOnceMode: "Once",
    schedWhen: "Date and time", schedTimezone: "Timezone", schedEnabled: "Enabled", schedWhenIn: "In {0}", schedWhenRequired: "Pick a date and time",
    schedTzBad: "Unknown timezone: {0}",
    cronEveryMinute: "Every minute", cronEveryMinutes: "Every {0} minutes", cronEveryHours: "Every {0} hours", cronDaily: "Daily {0}",
    cronWeekdays: "Weekdays {0}", cronDays: "{0} {1}", cronMonthly: "Day {0} of each month {1}", dayNames: "Sun,Mon,Tue,Wed,Thu,Fri,Sat", dayJoin: ", ",
    titleRequired: "Title required", scheduleFieldsRequired: "Cron, message, and target required", teamFieldsRequired: "Name and at least one member required",
    deleteSchedule: "Delete this schedule?", deleteTeam: "Delete team “{0}”?", taskCreated: "Task created", scheduleCreated: "Schedule created", scheduleDeleted: "Schedule deleted",
    teamCreated: "Team created", teamDeleted: "Team deleted", teamUpdated: "Team updated", edit: "Edit", editTeam: "Edit team",
    teamNoRename: "Renaming isn't supported — create a new team and delete this one.", taskDone: "Task updated", configSaved: "Config saved", configRestart: " (restart the fleet to apply channel changes)",
    channel: "Channel", type: "Type", tokenEnv: "Bot token env", groupId: "Group ID", show: "Show", hide: "Hide", access: "Access control", mode: "Mode", locked: "Locked", open: "Open",
    allowedUsers: "Allowed users", allowedUsersNote: "Comma-separated user IDs", defaults: "Defaults", backend: "Backend", roots: "Project roots", addRoot: "Add root", removeRoot: "Remove",
    saveNote: "Saving rewrites fleet.yaml (its comments are lost).",
    newInstance: "New instance", directory: "Directory", directoryHint: "Optional — a workspace is created if empty", topic: "Name", topicHint: "From the directory name",
    topicRequired: "Name is required when Directory is empty", description: "Description", descriptionHint: "What this instance does", model: "Model", modelHint: "e.g. sonnet, opus, gpt-5",
    branch: "Branch (git worktree)", branchHint: "e.g. feature-x", tags: "Tags", tagsHint: "comma-separated, e.g. dev, review", systemPrompt: "System prompt", systemPromptHint: "Custom instructions for this instance",
    fleetDefault: "Use the fleet default", notInstalled: "(not installed)", notSignedIn: "(not signed in — use /login)", tooOld: "(needs {0} or newer)", unchecked: "(not checked yet)", deprecated: "(deprecated)", instanceCreated: "Instance created",
  },
  "zh-TW": {
    hostMemory_elevated: "主機記憶體壓力偏高：新的 agent 一次啟動一個，至少間隔 5 秒",
    hostMemory_critical: "主機記憶體壓力嚴重：新的 agent 會等記憶體恢復再啟動",
    hostMemory_top: "最大：{0}", hostMemory_ownerFleet: "fleet 本身", hostMemory_ownerTmux: "tmux", hostMemory_ownerOther: "不屬於任何 instance",
    title: "Fleet", tasks: "Tasks", schedules: "排程", teams: "Teams", org: "組織圖", cache: "快取", usage: "用量", config: "設定",
    docs: "文件", docsNewTab: "文件（在新分頁開啟）",
    newTask: "新增 task", newSchedule: "新增排程", newTeam: "新增 team",
    noTasks: "還沒有 task", noTasksHint: "建立一個來協調 fleet 的工作。", noSchedules: "還沒有排程", noSchedulesHint: "用 cron 自動執行例行工作。",
    noTeams: "還沒有 team", noTeamsHint: "把 instance 分組一起工作。", countTasks: "{0} 個 task", countSchedules: "{0} 個排程", countTeams: "{0} 個 team", countTask: "1 個 task", countSchedule: "1 個排程", countTeam: "1 個 team",
    claim: "認領", done: "完成", delete: "刪除", on: "開", off: "關", cancel: "取消", create: "建立", creating: "建立中…", save: "儲存變更",
    taskTitle: "標題", taskDesc: "說明", priority: "優先順序", assignee: "負責人", unassigned: "未指派",
    pNormal: "一般", pLow: "低", pHigh: "高", pUrgent: "緊急",
    cron: "Cron 表示式", message: "訊息", target: "目標 instance", label: "標籤", teamName: "Team 名稱", members: "成員",
    schedOnce: "一次 · {0}", schedNext: "下次 {0}", schedRetrying: "重試中", schedDisabled: "已停用", schedSilent: "靜默", schedTz: "時區：{0}",
    editSchedule: "編輯排程", edit: "編輯", scheduleSaved: "已儲存排程", schedRepeat: "重複", schedOnceMode: "一次",
    schedWhen: "日期與時間", schedTimezone: "時區", schedEnabled: "啟用", schedWhenIn: "以 {0} 時間", schedWhenRequired: "請選擇日期與時間",
    schedTzBad: "不認得的時區：{0}",
    cronEveryMinute: "每分鐘", cronEveryMinutes: "每 {0} 分鐘", cronEveryHours: "每 {0} 小時", cronDaily: "每天 {0}",
    cronWeekdays: "每週一到五 {0}", cronDays: "每週{0} {1}", cronMonthly: "每月 {0} 日 {1}", dayNames: "日,一,二,三,四,五,六", dayJoin: "、",
    titleRequired: "必須填寫標題", scheduleFieldsRequired: "必須填寫 Cron、訊息與目標 instance", teamFieldsRequired: "必須填寫名稱並選擇至少一名成員",
    deleteSchedule: "確定刪除此排程嗎？", deleteTeam: "確定刪除 team「{0}」嗎？", taskCreated: "Task 已建立", scheduleCreated: "排程已建立", scheduleDeleted: "排程已刪除",
    teamCreated: "Team 已建立", teamDeleted: "Team 已刪除", teamUpdated: "Team 已更新", edit: "編輯", editTeam: "編輯 team",
    teamNoRename: "不支援重新命名：請建立新的 team，再刪除這個。", taskDone: "Task 已更新", configSaved: "設定已儲存", configRestart: "（請重新啟動 fleet 以套用頻道變更）",
    channel: "頻道", type: "類型", tokenEnv: "Bot token 環境變數", groupId: "Group ID", show: "顯示", hide: "隱藏", access: "存取控制", mode: "模式", locked: "鎖定", open: "開放",
    allowedUsers: "允許的使用者", allowedUsersNote: "以逗號分隔的使用者 ID", defaults: "預設值", backend: "Backend", roots: "專案根目錄", addRoot: "新增根目錄", removeRoot: "移除",
    saveNote: "儲存會改寫 fleet.yaml（其中的註解會遺失）。",
    newInstance: "新增 instance", directory: "目錄", directoryHint: "可留空——留空會自動建立工作區", topic: "名稱", topicHint: "預設取自目錄名稱",
    topicRequired: "目錄留空時必須填寫名稱", description: "說明", descriptionHint: "這個 instance 做什麼", model: "模型", modelHint: "例如 sonnet、opus、gpt-5",
    branch: "分支（git worktree）", branchHint: "例如 feature-x", tags: "標籤", tagsHint: "以逗號分隔，例如 dev, review", systemPrompt: "System prompt", systemPromptHint: "這個 instance 的自訂指示",
    fleetDefault: "使用 fleet 預設", notInstalled: "（未安裝）", notSignedIn: "（未登入，請用 /login）", tooOld: "（需要 {0} 以上版本）", unchecked: "（尚未檢查）", deprecated: "（已淘汰）", instanceCreated: "Instance 已建立",
  },
});

// The project's docs site (website/, GitHub Pages), in the dashboard's language — its own pages, not the app's.
const DOCS_SITE = "https://songsid.github.io/AgEnD";
export function docsUrl(language = lang()) {
  return `${DOCS_SITE}${language === "zh-TW" ? "/zh-tw" : ""}/docs/web-guide/`;
}
const ICONS = { tasks: "tasks", schedules: "clock", teams: "team", org: "org", cache: "chart", usage: "chart", config: "sliders" };
const BACKENDS = ["claude-code", "codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"];

async function api(method, path, body, lease) {
  const o = { method, headers: { "Content-Type": "application/json" } };
  if (body) o.body = JSON.stringify(body);
  const r = await (lease ? lease.fetch(path, o) : fetch(path, o));
  return r.json();
}

/**
 * Load `path` under the lease: `null` while the first load runs, `{ error }` on failure (no answer, or an HTTP error). A refresh (a new `version`,
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
        // A read the server refused (a 4xx/5xx with an { error } body) is a failure, not an empty list (alpha.2 sweep).
        const r = await lease.fetch(path, { method: "GET", headers: { "Content-Type": "application/json" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
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
  useEffect(() => { rememberFleetTab(tab); }, [tab]);   // #2183: the sidebar's and the phone's Fleet reopen it
  const Body = { tasks: Tasks, schedules: Schedules, teams: Teams, org: Org, cache: Cache, usage: UsageTab, config: Config }[tab] || Tasks;
  // #1685: host memory pressure slowing or holding new agents — shown here, where macOS's routine "elevated" is not a chat notice.
  const { hostMemory, hostMemoryTop } = useStore(appStore);
  // #2015: and which processes hold the most, and whose — text only (never chat, #1712).
  const top = hostMemory && hostMemoryTop?.length ? t("fleet.hostMemory_top", hostMemoryTop.map(memoryHogText).join(" · ")) : "";
  const sub = hostMemory ? html`<span class=${`status host-mem ${hostMemory}`} role="status"><span class=${`dot ${hostMemory === "critical" ? "bad" : "warn"}`} aria-hidden="true"></span>${t(`fleet.hostMemory_${hostMemory}`)}${top ? html`<span class="host-mem-top">${top}</span>` : null}</span>` : null;
  return html`<div data-effect-panel="fleet" class="panel p-fleet">
    <${PanelHeader} title=${t("fleet.title")} sub=${sub}><${DocsLink} /><${HeaderTools} navKey=${navKey} /></${PanelHeader}>
    <nav data-trust="panel-navigation" class="seg" aria-label=${t("fleet.title")}>${FLEET_TABS.map(k => html`<a key=${k} href=${fleetPath(k)} class=${`seg-item${k === tab ? " active" : ""}`}
      aria-current=${k === tab ? "page" : undefined}><${Icon} name=${ICONS[k]} size=${16} /><span>${t(`fleet.${k}`)}</span></a>`)}</nav>
    <div data-trust="panel-content" class="panel-body"><div class=${`col${tab === "org" || tab === "cache" || tab === "usage" ? " col-wide" : ""}`}><${Body} lease=${lease} /></div></div>
  </div>`;
}

/** #1844: the project's docs, from the overview — a link out (a new tab, no opener), not a Fleet tab; in front of the shared controls. */
function DocsLink() {
  return html`<a class="btn btn-ghost btn-sm hd-docs" href=${docsUrl()} target="_blank" rel="noopener noreferrer" aria-label=${t("fleet.docsNewTab")} title=${t("fleet.docsNewTab")}>
    <${Icon} name="book" size=${16} /><span class="hide-narrow" aria-hidden="true">${t("fleet.docs")}</span><${Icon} name="external" size=${12} cls="hd-ext" /></a>`;
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
    return html`<${ListHead} count=${tasks.length === 1 ? t("fleet.countTask") : t("fleet.countTasks", tasks.length)} label=${t("fleet.newTask")} action=${{ onClick: () => setCreating(true) }} />
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

/** #1724: what a row says about when it runs — words for a cron, "Once · <time>" for a one-shot; never empty or "null". */
export function scheduleWhen(x) {
  if (x && x.cron) return cronDesc(x.cron);
  if (x && x.at) return t("fleet.schedOnce", x.at_text || x.at);
  return "—";
}
/** #1724: its next run as the server worked it out (fleet zone), or "retrying"; nothing when there is none (disabled). */
export function scheduleNext(x) {
  if (!x || !x.enabled) return "";
  if (x.retrying) return t("fleet.schedRetrying");
  return x.next_run_text ? t("fleet.schedNext", x.next_run_text) : "";
}
const clip = (s, n = 60) => { const a = Array.from(String(s || "").replace(/\s+/g, " ").trim()); return a.length > n ? `${a.slice(0, n).join("")}…` : a.join(""); };

function Schedules({ lease }) {
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);   // #1724: the schedule being edited
  const { instances } = useStore(appStore);
  const state = useLoad(lease, "/ui/schedules", version);
  const targetName = (name) => { const it = (instances || []).find((i) => i && i.name === name); return it ? labelOf(it) : name; };
  async function del(id) {
    if (!(await confirmDialog({ message: t("fleet.deleteSchedule"), confirmLabel: t("fleet.delete"), danger: true }))) return;
    if (!lease.current()) return;                   // answered after this tab went: the question no longer stands
    const r = await api("DELETE", `/ui/schedules/${encodeURIComponent(id)}`);
    if (r.error) toast(r.error, false); else { toast(t("fleet.scheduleDeleted")); setVersion(v => v + 1); }
  }
  return html`<${Loaded} state=${state}>${(d) => {
    const list = d.schedules || [];
    // #1724: the public link lists schedules and changes none (the server refuses it too).
    const writable = !publicLink();
    return html`<${ListHead} count=${list.length === 1 ? t("fleet.countSchedule") : t("fleet.countSchedules", list.length)} label=${t("fleet.newSchedule")} action=${writable ? { onClick: () => setCreating(true) } : null} />
      ${list.length ? html`<ul class="rows">${list.map(x => {
        const next = scheduleNext(x);
        const tip = [x.cron || x.at, t("fleet.schedTz", x.timezone), x.silent ? t("fleet.schedSilent") : ""].filter(Boolean).join(" · ");
        return html`<li key=${x.id} class=${`row-item sched${x.enabled ? "" : " is-off"}`} title=${tip}>
        <span class=${`pill ${x.enabled ? "open" : "off"}`}>${x.enabled ? t("fleet.on") : t("fleet.schedDisabled")}</span>
        <span class="grow sched-text"><span class="sched-title">${x.label || clip(x.message)}</span>
          <span class="sched-sub muted"><span class="sched-when">${scheduleWhen(x)}</span>${next ? html`${" · "}<span class="sched-next">${next}</span>` : null}${" · "}<a class="link" href=${chatPath(x.target)} title=${x.target}>${targetName(x.target)}</a></span></span>
        ${writable ? html`<span class="sched-actions"><button type="button" class="btn btn-ghost btn-sm sched-edit" onClick=${() => setEditing({ ...x, default_timezone: d.default_timezone })}>${t("fleet.edit")}</button><button type="button" class="btn btn-ghost btn-sm danger" onClick=${() => del(x.id)}>${t("fleet.delete")}</button></span>` : null}</li>`;
      })}</ul>`
        : html`<${Empty} icon="clock" title=${t("fleet.noSchedules")} hint=${t("fleet.noSchedulesHint")} />`}
      ${creating ? html`<${ScheduleForm} defaultTz=${d.default_timezone} onClose=${() => setCreating(false)} onDone=${() => setVersion(v => v + 1)} />` : null}
      ${editing ? html`<${ScheduleForm} schedule=${editing} defaultTz=${d.default_timezone} onClose=${() => setEditing(null)} onDone=${() => setVersion(v => v + 1)} />` : null}`;
  }}</${Loaded}>`;
}

/** #1689: the public link changes no team (the server refuses it): it lists them only. */
const publicLink = () => typeof document !== "undefined" && !!document.body && document.body.dataset.publicLink === "1";

function Teams({ lease }) {
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);   // #1689: { name, members, description } of the team being edited
  const state = useLoad(lease, "/ui/teams", version);
  async function del(name) {
    if (!(await confirmDialog({ message: t("fleet.deleteTeam", name), confirmLabel: t("fleet.delete"), danger: true }))) return;
    if (!lease.current()) return;
    const r = await api("DELETE", `/ui/teams/${encodeURIComponent(name)}`);
    if (r.error) toast(r.error, false); else { toast(t("fleet.teamDeleted")); setVersion(v => v + 1); }
  }
  return html`<${Loaded} state=${state}>${(d) => {
    const entries = Object.entries(d.teams || {});
    const writable = !publicLink();
    return html`<${ListHead} count=${entries.length === 1 ? t("fleet.countTeam") : t("fleet.countTeams", entries.length)} label=${t("fleet.newTeam")} action=${writable ? { onClick: () => setCreating(true) } : null} />
      ${entries.length ? html`<ul class="rows">${entries.map(([name, team]) => html`<li key=${name} class="row-item">
        <span class="grow strong">${name}</span><span class="muted">${(team.members || []).join(", ")}</span>
        ${writable ? html`<button type="button" class="btn btn-ghost btn-sm team-edit" onClick=${() => setEditing({ name, members: [...(team.members || [])], description: team.description || "" })}>${t("fleet.edit")}</button>
        <button type="button" class="btn btn-ghost btn-sm danger" onClick=${() => del(name)}>${t("fleet.delete")}</button>` : null}</li>`)}</ul>`
        : html`<${Empty} icon="team" title=${t("fleet.noTeams")} hint=${t("fleet.noTeamsHint")} />`}
`;
  }}</${Loaded}>
  ${creating ? html`<${CreateTeam} onClose=${() => setCreating(false)} onDone=${() => setVersion(v => v + 1)} />` : null}
  ${editing ? html`<${CreateTeam} team=${editing} onClose=${() => setEditing(null)} onDone=${() => setVersion(v => v + 1)} />` : null}`;
}

/** #1389: the org chart — its structure read once per opening, its live state from the app store. #1918: a canvas, or the list (fleet-canvas.js). */
function Org({ lease }) {
  const state = useLoad(lease, "/ui/org", 0);
  const app = useStore(appStore);
  return html`<${Loaded} state=${state}>${(org) => html`<${OrgCanvas} org=${org} app=${app} lease=${lease} />`}</${Loaded}>`;
}

/** #1468: the prompt-cache analysis — one read per opening and per window chosen; Refresh reads again (fleet-cache.js). */
function Cache({ lease }) {
  const [win, setWin] = useState("7d");
  const [version, setVersion] = useState(0);
  const state = useLoad(lease, `/ui/cache?window=${win}`, version);
  return html`<${Loaded} state=${state}>${(report) => (report && Array.isArray(report.instances)
    ? html`<${CacheReport} report=${report} win=${win} setWin=${setWin} refresh=${() => setVersion((v) => v + 1)} />`
    : html`<${ErrorState} onRetry=${renavigate} />`)}</${Loaded}>`;
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
  // Each save owns the form's busy state only while it is the latest: an older save that is decided later (it waited
  // for an admin's confirmation) never unlocks the form under a newer one still on its way (#1453 review).
  const saves = useRef(0);
  useEffect(() => {
    if (!state || !state.data) return;
    const c = state.data, ch = c.channel || {}, acc = ch.access || {};
    setForm({ type: ch.type || "", tokenEnv: ch.bot_token_env || "AGEND_BOT_TOKEN", groupId: ch.group_id || "", mode: acc.mode || "locked",
      users: (acc.allowed_users || []).join(", "), backend: (c.defaults || {}).backend || "claude-code", roots: [...(c.project_roots || [])] });
  }, [state]);
  async function save() {
    const mine = ++saves.current;
    const done = () => { if (lease.current() && mine === saves.current) setSaving(false); };
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
        onPending: (_id, view) => { toast(t(selfConfirmed(view) ? "app.pendingSelfSent" : "app.pendingSent")); done(); } });
      r = res.ok ? res.body || {} : { error: (res.body && res.body.error) || `HTTP ${res.status}` };
    } catch (err) { r = { error: err.message }; }
    done();
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
      <div class="field"><label for="cfg-be">${t("fleet.backend")}</label><${BackendSelect} id="cfg-be" value=${form.backend} onChange=${(v) => setForm({ ...form, backend: v })} /></div></section>
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
      const res = await confirmedWrite(submit.path, { method: submit.method || "POST", body, label: title,
        onPending: (_id, view) => { handedOver = true; toast(t(selfConfirmed(view) ? "app.pendingSelfSent" : "app.pendingSent")); if (lease.current()) { setBusy(false); onClose(); } } });
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
      <button type="button" class="btn btn-primary" onClick=${go} disabled=${busy || !ready}>${busy ? t("fleet.creating") : submit.label || t("fleet.create")}</button>`}>
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

/**
 * #1724: a wall-clock date and time ("YYYY-MM-DDTHH:MM", a datetime-local value) read in `tz`, as the ISO time with
 * offset the scheduler takes (`at`); null when either cannot be read. DST-safe: the offset is sampled at that instant.
 */
export function wallToIso(wall, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(wall || ""));
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let offsetAt;
  try {
    const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    offsetAt = (ms) => Date.parse(fmt.format(new Date(ms)).replace(" ", "T") + "Z") - ms;
  } catch { return null; }
  let off = offsetAt(asUtc);
  off = offsetAt(asUtc - off);
  if (!Number.isFinite(off)) return null;
  const mins = Math.round(off / 60000), a = Math.abs(mins);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${mins < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
/** #1724: an ISO time as the wall clock in `tz` ("YYYY-MM-DDTHH:MM"), to fill the form; "" when it cannot be read. */
export function isoToWall(iso, tz) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ms)).replace(" ", "T");
  } catch { return ""; }
}

/**
 * New schedule, or (#1724) `schedule` given: edit it — the same form, filled in from it: Repeat (cron) or Once (a date
 * and time in its timezone), message, target, label, timezone, enabled. An edit is PATCH /ui/schedules/<id>, which the
 * host validates and applies as the update_schedule tool does (cron and at clear each other there).
 */
function ScheduleForm({ schedule = null, defaultTz, onClose, onDone }) {
  const { instances } = useStore(appStore);
  const tz0 = (schedule && schedule.timezone) || defaultTz || "";
  const [f, setF] = useState(() => ({
    mode: schedule && schedule.at ? "once" : "repeat",
    cron: (schedule && schedule.cron) || "",
    at: schedule && schedule.at ? isoToWall(schedule.at, tz0) : "",
    msg: (schedule && schedule.message) || "",
    target: schedule ? schedule.target : instances[0] ? instances[0].name : "",
    label: (schedule && schedule.label) || "",
    tz: tz0,
    enabled: schedule ? !!schedule.enabled : true,
  }));
  const set = (k) => (e) => { const v = e.target.type === "checkbox" ? e.target.checked : e.target.value; setF((cur) => ({ ...cur, [k]: v })); };
  const submit = {
    path: schedule ? `/ui/schedules/${encodeURIComponent(schedule.id)}` : "/ui/schedules",
    method: schedule ? "PATCH" : "POST",
    label: schedule ? t("fleet.save") : undefined,
    done: schedule ? t("fleet.scheduleSaved") : t("fleet.scheduleCreated"),
    after: onDone,
    collect: () => {
      if (!f.msg.trim() || !f.target || (f.mode === "repeat" && !f.cron.trim())) { toast(t("fleet.scheduleFieldsRequired"), false); return null; }
      const tz = f.tz.trim();
      const body = { message: f.msg.trim(), target: f.target };
      if (f.mode === "repeat") body.cron = f.cron.trim();
      else {
        if (!f.at) { toast(t("fleet.schedWhenRequired"), false); return null; }
        const at = wallToIso(f.at, tz || defaultTz);
        if (!at) { toast(t("fleet.schedTzBad", tz || defaultTz || ""), false); return null; }
        body.at = at;
      }
      if (schedule) { body.label = f.label.trim(); body.enabled = !!f.enabled; if (tz) body.timezone = tz; }
      else { if (f.label.trim()) body.label = f.label.trim(); if (tz) body.timezone = tz; }
      return body;
    },
  };
  const modeBtn = (mode, label) => html`<button type="button" class=${`btn btn-sm${f.mode === mode ? " on" : ""}`} aria-pressed=${f.mode === mode ? "true" : "false"}
    onClick=${() => setF((cur) => ({ ...cur, mode }))}>${label}</button>`;
  return html`<${FormDialog} title=${schedule ? t("fleet.editSchedule") : t("fleet.newSchedule")} onClose=${onClose} submit=${submit}>
    <div class="seg-inline sched-mode" role="group" aria-label=${t("fleet.schedWhen")}>${modeBtn("repeat", t("fleet.schedRepeat"))}${modeBtn("once", t("fleet.schedOnceMode"))}</div>
    ${f.mode === "repeat"
      ? html`${field(`${t("fleet.cron")} *`, html`<input value=${f.cron} onInput=${set("cron")} placeholder="0 9 * * 1-5" class="mono" />`)}
        ${f.cron.trim() ? html`<p class="note sched-preview">${cronDesc(f.cron)}</p>` : null}`
      : html`${field(`${t("fleet.schedWhen")} *`, html`<input type="datetime-local" value=${f.at} onInput=${set("at")} />`)}
        <p class="note">${t("fleet.schedWhenIn", f.tz.trim() || defaultTz || "")}</p>`}
    ${field(`${t("fleet.message")} *`, html`<input value=${f.msg} onInput=${set("msg")} />`)}
    ${field(`${t("fleet.target")} *`, html`<select value=${f.target} onChange=${set("target")}>${instances.map(i => html`<option key=${i.name} value=${i.name}>${labelOf(i)}</option>`)}</select>`)}
    ${field(t("fleet.label"), html`<input value=${f.label} onInput=${set("label")} />`)}
    ${field(t("fleet.schedTimezone"), html`<input value=${f.tz} onInput=${set("tz")} placeholder=${defaultTz || "Asia/Taipei"} />`)}
    ${schedule ? html`<label class="check"><input type="checkbox" checked=${f.enabled} onChange=${set("enabled")} /><span>${t("fleet.schedEnabled")}</span></label>` : null}
  </${FormDialog}>`;
}

/**
 * New team, or (#1689) `team` given: edit that one — the same form, filled in from it: its members ticked (one no longer
 * in the fleet listed too, so it can be taken out), its description; the name is not editable (a team is not renamed).
 * Saved with PATCH /ui/teams/<name> (the update_team path on the host).
 */
function CreateTeam({ onClose, onDone, team = null }) {
  const { instances } = useStore(appStore);
  const [f, setF] = useState(team ? { name: team.name, desc: team.description || "", members: [...team.members] } : { name: "", desc: "", members: [] });
  // From the state as it is, not this render's copy: two ticks before the next render must both count.
  const toggle = (n) => setF((cur) => ({ ...cur, members: cur.members.includes(n) ? cur.members.filter(x => x !== n) : [...cur.members, n] }));
  const names = [...new Set([...instances.map(i => i.name), ...(team ? team.members : [])])];
  const submit = team
    ? { path: `/ui/teams/${encodeURIComponent(team.name)}`, method: "PATCH", label: t("fleet.save"), done: t("fleet.teamUpdated"), after: onDone, collect: () => {
      if (!f.members.length) { toast(t("fleet.teamFieldsRequired"), false); return null; }
      return { members: f.members, description: f.desc.trim() };
    } }
    : { path: "/ui/teams", done: t("fleet.teamCreated"), after: onDone, collect: () => {
      if (!f.name.trim() || !f.members.length) { toast(t("fleet.teamFieldsRequired"), false); return null; }
      const body = { name: f.name.trim(), members: f.members };
      if (f.desc.trim()) body.description = f.desc.trim();
      return body;
    } };
  return html`<${FormDialog} title=${team ? t("fleet.editTeam") : t("fleet.newTeam")} onClose=${onClose} submit=${submit}>
    ${field(`${t("fleet.teamName")} *`, html`<input value=${f.name} readOnly=${!!team} aria-readonly=${team ? "true" : undefined} onInput=${(e) => { const v = e.target.value; setF((cur) => ({ ...cur, name: v })); }} />`)}
    ${team ? html`<p class="note">${t("fleet.teamNoRename")}</p>` : null}
    ${field(t("fleet.taskDesc"), html`<input value=${f.desc} onInput=${(e) => { const v = e.target.value; setF((cur) => ({ ...cur, desc: v })); }} />`)}
    <fieldset class="field"><legend>${t("fleet.members")} *</legend><div class="checks">${names.map(n => html`<label key=${n} class="check">
      <input type="checkbox" checked=${f.members.includes(n)} onChange=${() => toggle(n)} />${n}</label>`)}</div></fieldset>
  </${FormDialog}>`;
}

/** "New instance": the sidebar's + opens it from anywhere (#1408 step 3 merges it with Settings' create flow). */
export function CreateInstanceDialog({ onClose }) {
  const lease = useLease("create-instance");
  const [backends, setBackends] = useState(null);
  // The backend "fleet default" means (#2098 review P3-3): its models are the ones the model list offers then.
  const [defaultBackend, setDefaultBackend] = useState("claude-code");
  const [f, setF] = useState({ dir: "", topic: "", desc: "", backend: "", model: "", branch: "", tags: "", prompt: "" });
  useEffect(() => {
    (async () => {
      try {
        const bd = await api("GET", "/ui/backends", null, lease);
        if (!lease.current()) return;
        const list = bd.backends || [];
        const first = list.find(b => b.installed && !b.deprecated) || list.find(b => b.installed);
        if (typeof bd.defaultBackend === "string" && bd.defaultBackend) setDefaultBackend(bd.defaultBackend);
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
      ${backends.map(b => html`<option key=${b.name} value=${b.name} disabled=${backendBlocked(b)}>${b.name}${b.deprecated ? ` ${t("fleet.deprecated")}` : ""}${backendNote(b)}</option>`)}</select>` : html`<${Skeleton} lines=${1} />`)}
    ${field(t("fleet.model"), html`<${ModelSelect} value=${f.model} onChange=${(v) => setF(x => ({ ...x, model: v }))} backend=${f.backend || defaultBackend} inherit=${t("fleet.fleetDefault")} />`)}
    ${field(t("fleet.branch"), html`<input value=${f.branch} onInput=${set("branch")} placeholder=${t("fleet.branchHint")} />`)}
    ${field(t("fleet.tags"), html`<input value=${f.tags} onInput=${set("tags")} placeholder=${t("fleet.tagsHint")} />`)}
    ${field(t("fleet.systemPrompt"), html`<textarea rows="3" value=${f.prompt} onInput=${set("prompt")} placeholder=${t("fleet.systemPromptHint")}></textarea>`)}
  </${FormDialog}>`;
}

// #2072: a backend this host cannot run is shown, disabled, with why; one not checked yet stays selectable.
const backendState = (b) => b.state ?? (b.installed ? "usable" : b.unknown ? "unknown" : "not_installed");
function backendBlocked(b) { return ["not_installed", "not_signed_in", "too_old"].includes(backendState(b)); }
function backendNote(b) {
  const s = backendState(b);
  return s === "not_installed" ? ` ${t("fleet.notInstalled")}` : s === "not_signed_in" ? ` ${t("fleet.notSignedIn")}`
    : s === "too_old" ? ` ${t("fleet.tooOld", b.minVersion ?? "?")}` : s === "unknown" ? ` ${t("fleet.unchecked")}` : "";
}

// ── Cron in words (#1724: in the page's language) ──
/**
 * A cron expression as a person says it — "Weekdays 18:00", 「每週一到五 18:00」, "Every 15 minutes" — or the expression
 * itself when it is not one of these shapes. Never "" for an expression; "" only for none.
 */
export function cronDesc(expr) {
  if (!expr || typeof expr !== "string") return "";
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr.trim();
  const [min, hr, dom, mon, dow] = p;
  const num = (s) => /^\d{1,2}$/.test(s);
  const time = num(hr) && num(min) ? `${hr.padStart(2, "0")}:${min.padStart(2, "0")}` : null;
  if (mon !== "*") return expr.trim();
  if (min === "*" && hr === "*" && dom === "*" && dow === "*") return t("fleet.cronEveryMinute");
  if (/^\*\/\d+$/.test(min) && hr === "*" && dom === "*" && dow === "*") return t("fleet.cronEveryMinutes", min.slice(2));
  if (num(min) && /^\*\/\d+$/.test(hr) && dom === "*" && dow === "*") return t("fleet.cronEveryHours", hr.slice(2));
  if (!time) return expr.trim();
  if (dom === "*" && dow === "*") return t("fleet.cronDaily", time);
  if (dom === "*" && dow === "1-5") return t("fleet.cronWeekdays", time);
  if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
    const names = t("fleet.dayNames").split(",");
    return t("fleet.cronDays", dow.split(",").map((d) => names[Number(d) % 7]).join(t("fleet.dayJoin")), time);
  }
  if (num(dom) && dow === "*") return t("fleet.cronMonthly", String(Number(dom)), time);
  return expr.trim();
}
