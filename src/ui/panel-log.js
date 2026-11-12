// #1218 phase 1: one instance's Log (紀錄) — its work step by step: what it was asked, what it answered, each tool call with its
// arguments and result, errors, where each turn ended, and fleet events (a crash, a restart, a prompt waiting). This page never asks
// for thinking (GET /ui/steps without `thinking`); the chat's activity timeline does, for an admin session on the local dashboard
// (AGEND-181, chat-activity.js) — the step row is the one they share (log-row.js), so the row can draw thinking, this page just never
// receives any. Between View and Details (/ui/log/<name>). Behind the session gate (/ui/js/); offered on
// the public link too (the user's decision), read-only, with the same masking.
//
// On demand only (the user's decision on load): off by default (web.log_tab) — the tab says so, and offers to turn it
// on (a Settings write a fleet admin confirms; not over the public link). On, the server reads the agent's transcript
// only when this page asks (GET /ui/steps), and keeps an eye on it only while this page watches (a lease each read
// renews): a steps_tick on the stream says it moved, and the page reads after its cursor. Over the public link (no
// stream) the page asks every POLL_MS while it is shown.
//
// Steps are merged by id: a call shown as running is completed in place when its result arrives; older pages are put
// before. Masking and cutting are the server's (log-steps.ts): the page only shows what it is given.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import * as paneContext from "/assets/app-ctx.js";
import { PanelHeader, setTitle, statusClass, statusLabel, openDrawer } from "/assets/app-shell.js";
import { InstanceSwitch } from "/assets/instance-switch.js";
import { HeaderSlot, HeaderTools } from "/assets/header-tools.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { toast } from "/assets/ui-toast.js";
import { confirmedWrite } from "./settings-confirm.js";
import { LogRow, mergeSteps, timeline, collapse, tl } from "./log-row.js";
// The step helpers live with the row (log-row.js, shared with the chat's timeline); the Log's own tests read them here.
export { mergeSteps, timeline, collapse };

register("log", {
  en: {
    offTitle: "The Log is off",
    offBody: "Turn it on to see each agent's work step by step: what it was asked, its replies, every tool call with its arguments and result, errors, and fleet events. It reads the agent's own transcript only while this tab is open, and masks secret values.",
    enable: "Turn on the Log", enabling: "Waiting for a fleet admin to confirm it — the confirmation card says where…", enabled: "The Log is on.",
    enableFailed: "The Log was not turned on: {0}", offPublic: "A fleet admin can turn it on in Settings → Web dashboard.",
    unsupported: "{0} has no transcript AgEnD can read, so this Log shows fleet events only. View shows its screen.",
    kiroWhy: "kiro's own steps are shown only when AgEnD can prove which conversation it is in now. {0} Fleet events are shown meanwhile.",
    kiro_not_running: "It is not running.",
    kiro_v3: "Its engine (V3) keeps a history AgEnD does not read.",
    kiro_engine_unknown: "Its engine is not known.",
    kiro_legacy: "It launched without its own agent (legacy mode), so it continues the folder's newest conversation, not one of its own.",
    kiro_fresh: "This launch began a new conversation, which kiro names only later.",
    kiro_v2_root: "Where its engine (TUI) keeps conversations is inherited from tmux, not set by its launch, so it is not proven.",
    kiro_no_profile: "Where its engine (classic) keeps conversations is proven only when it runs with its own credential profile.",
    kiro_session_unobservable: "A /clear or /chat load typed in its terminal can switch conversations without AgEnD seeing it.",
    notRunning: "Its transcript is found while it runs. Start it to see its steps; fleet events are shown meanwhile.",
    noTranscript: "No transcript yet: steps appear once it has worked.",
    empty: "Nothing here yet.", olderLoad: "Load older steps", olderStart: "The start of what can be read.", loading: "Loading…",
    olderTrimmed: "Older steps were let go to keep this page light. Open the Log again to read further back.",
    all: "All", tools: "Tools", errors: "Errors", filter: "Show", live: "Live", reset: "A new conversation began: showing it from its latest steps.",
    ev_crash_respawn: "Crashed and restarted", ev_crash_loop: "Keeps crashing", ev_hang_detected: "Looks stuck", ev_hang_action: "Stuck: acted on",
    ev_instance_paused: "Paused", ev_instance_resumed: "Resumed", ev_interactive_prompt: "Waiting at a prompt", ev_interactive_prompt_assist: "Prompt: asked for help", ev_remote_card: "Asked a question (posted to chat)", ev_remote_card_answer: "Question answered from chat",
    ev_dialog_parked: "A dialog waits", ev_model_failover: "Switched to another model", ev_model_recovered: "Model back",
    ev_mcp_died: "Tool server stopped", ev_mcp_recovered: "Tool server back", ev_mcp_auto_restart: "Tool server restarted",
    ev_message_failed: "A message was not delivered", ev_messages_cancelled: "Messages dropped by a cancel", ev_pty_error: "Terminal error", ev_pty_recovered: "Terminal recovered",
    ev_backend_unreachable: "CLI unreachable", ev_startup_backend_unreachable: "CLI unreachable at start", ev_backend_launch_warning: "Launch warning",
    ev_clear_action: "Conversation cleared", ev_normal_exit_action: "Exited", ev_reply_drop_detected: "A reply went missing",
    ev_reply_drop_recovered: "Missing reply recovered", ev_reply_drop_unrecovered: "Missing reply not recovered",
    ev_supervision_ended: "Supervision ended", ev_tmux_server_crash: "tmux crashed", ev_malformed_tool_call: "Malformed tool call", ev_health_check_error: "Health check error", ev_context_lost: "Started fresh: context lost", ev_working_state: "Working-state journal", ev_kiro_reconcile: "Kiro conversation reconciliation",
  },
  "zh-TW": {
    offTitle: "紀錄未開啟",
    offBody: "開啟後可逐步看到每個 agent 的工作：收到的要求、回覆、每次工具呼叫的參數與結果、錯誤，以及 fleet 事件。只在這個分頁開著時讀取 agent 自己的對話紀錄，機密值會遮蔽。",
    enable: "開啟紀錄", enabling: "等待 fleet admin 確認，確認卡片上有說明確認方式…", enabled: "紀錄已開啟。",
    enableFailed: "紀錄沒有開啟：{0}", offPublic: "fleet admin 可以在「設定 → 網頁儀表板」開啟。",
    unsupported: "{0} 沒有 AgEnD 讀得到的對話紀錄，所以這裡只顯示 fleet 事件。「檢視」可以看它的畫面。",
    kiroWhy: "只有在 AgEnD 能證明 kiro 目前所在的對話時，才會顯示它自己的步驟。{0}目前先顯示 fleet 事件。",
    kiro_not_running: "它沒有在執行。",
    kiro_v3: "它的引擎（V3）的紀錄 AgEnD 不讀取。",
    kiro_engine_unknown: "不知道它用哪個引擎。",
    kiro_legacy: "它啟動時沒有自己的 agent（舊模式），接續的是資料夾裡最新的對話，不是它自己的。",
    kiro_fresh: "這次啟動開了新的對話，kiro 之後才會替它命名。",
    kiro_v2_root: "它的引擎（TUI）存放對話的位置沿用 tmux 的設定，不是由啟動指定，因此無法證明。",
    kiro_no_profile: "它的引擎（classic）存放對話的位置，只有使用自己的憑證設定檔時才能證明。",
    kiro_session_unobservable: "在它的終端機輸入 /clear 或 /chat load 可能切換對話，而 AgEnD 看不到。",
    notRunning: "它執行時才找得到對話紀錄。啟動它就能看到步驟；目前先顯示 fleet 事件。",
    noTranscript: "還沒有對話紀錄：它開始工作後就會出現步驟。",
    empty: "目前還沒有內容。", olderLoad: "載入更早的步驟", olderStart: "已經是能讀到的最早內容。", loading: "載入中…",
    olderTrimmed: "為了讓頁面保持輕快，較早的步驟已移出。重新開啟「紀錄」就能往前讀。",
    all: "全部", tools: "工具", errors: "錯誤", filter: "顯示", live: "即時", reset: "開始了新的對話：從它最新的步驟顯示。",
    ev_crash_respawn: "當機後重新啟動", ev_crash_loop: "反覆當機", ev_hang_detected: "看起來卡住了", ev_hang_action: "卡住：已處理",
    ev_instance_paused: "已暫停", ev_instance_resumed: "已繼續", ev_interactive_prompt: "停在提示上等待", ev_interactive_prompt_assist: "提示：已請求協助", ev_remote_card: "提出問題（已貼到聊天）", ev_remote_card_answer: "問題已從聊天回答",
    ev_dialog_parked: "有對話框在等待", ev_model_failover: "改用另一個模型", ev_model_recovered: "模型恢復",
    ev_mcp_died: "工具伺服器停止", ev_mcp_recovered: "工具伺服器恢復", ev_mcp_auto_restart: "工具伺服器已重新啟動",
    ev_message_failed: "有訊息沒有送達", ev_messages_cancelled: "取消時丟掉的訊息", ev_pty_error: "終端機錯誤", ev_pty_recovered: "終端機恢復",
    ev_backend_unreachable: "連不到 CLI", ev_startup_backend_unreachable: "啟動時連不到 CLI", ev_backend_launch_warning: "啟動警告",
    ev_clear_action: "對話已清除", ev_normal_exit_action: "已結束", ev_reply_drop_detected: "有回覆遺失",
    ev_reply_drop_recovered: "遺失的回覆已補回", ev_reply_drop_unrecovered: "遺失的回覆沒有補回",
    ev_supervision_ended: "監督結束", ev_tmux_server_crash: "tmux 當掉", ev_malformed_tool_call: "格式錯誤的工具呼叫", ev_health_check_error: "健康檢查錯誤", ev_context_lost: "改用全新對話：context 遺失", ev_working_state: "工作狀態紀錄", ev_kiro_reconcile: "Kiro 對話接續處理",
  },
});
/** Why a kiro Log shows fleet events only (kiro-log-gate.ts): each is worded above. */
export const KIRO_REASONS = new Set(["kiro_not_running", "kiro_v3", "kiro_engine_unknown", "kiro_legacy", "kiro_fresh", "kiro_v2_root", "kiro_no_profile", "kiro_session_unobservable"]);

/** The public link has no stream: the page asks this often while it is shown. */
export const POLL_MS = 4000;
/** A watching page renews its lease at least this often (the server's lease is 45 s). */
export const RENEW_MS = 30_000;
/** Steps kept in the page; older ones beyond it are dropped from the top (the server still has them). */
export const PAGE_MAX = 1000;

const isError = (x) => x.kind === "error" || (x.kind === "event" && x.type !== "working_state") || x.status === "failed" || x.status === "interrupted";

export function LogPanel({ route, navKey }) {
  const pane = paneContext.usePane?.();
  const app = useStore(appStore);
  const name = route.instance;
  const inst = app.instances.find((i) => i.name === name) || null;
  useEffect(() => { if (pane?.focused !== false) setTitle(`${name} · ${t("app.log")}`); }, [name, navKey, pane?.focused]);
  if (!app.ready) return html`<div data-effect-panel="log" class="panel p-log"><${PanelHeader} title=${name} /><div data-trust="panel-content" class="panel-body"><${Skeleton} lines=${6} /></div></div>`;
  if (!inst) {
    return html`<div data-effect-panel="log" class="panel p-log"><${PanelHeader} title=${name} />
      <div data-trust="panel-content" class="panel-body center"><${Empty} icon="alert" title=${t("chat.notFound", name)} hint=${t("chat.notFoundHint")}
        action=${html`<button type="button" class="btn only-narrow" onClick=${openDrawer}>${t("chat.backToList")}</button>`} /></div></div>`;
  }
  return html`<${LogView} key=${name} name=${name} inst=${inst} navKey=${navKey} exec=${app.exec[name]}
    awaiting=${Object.prototype.hasOwnProperty.call(app.awaiting, name) ? app.awaiting[name] : null} />`;
}

function LogView({ name, inst, navKey, exec, awaiting }) {
  const lease = useLease(`log:${name}`);
  const [state, setState] = useState({ phase: "loading" });   // loading | off | on | failed
  const [steps, setSteps] = useState([]);
  const [events, setEvents] = useState([]);
  const [info, setInfo] = useState(null);                       // { backend, supported, reason }
  const [filter, setFilter] = useState("all");
  const [older, setOlder] = useState({ busy: false });
  const [notice, setNotice] = useState("");
  const [enabling, setEnabling] = useState(false);
  // `epoch` moves whenever `before` stops being valid (a trim, a new conversation): an older page asked for before that
  // is dropped when it comes back, so it never restores a cursor across steps that were let go.
  const cursor = useRef({ key: null, after: null, skip: false, before: null, ev: 0, trimmed: false, epoch: 0 });
  const reading = useRef(false), again = useRef(false);
  const scroller = useRef(null), pinned = useRef(true);
  const overPublicLink = globalThis.document?.body?.dataset?.publicLink === "1";
  const polling = globalThis.document?.body?.dataset?.webTransport === "poll";

  const q = (params) => `/ui/steps?${new URLSearchParams({ instance: name, ...params })}`;
  const read = async (url) => {
    const r = await lease.fetch(url, { cache: "no-store" });
    if (!lease.current()) return null;
    const j = await r.json().catch(() => null);
    if (!lease.current()) return null;
    if (!r.ok || !j) throw new Error((j && j.error) || String(r.status));
    return j;
  };
  /**
   * At most PAGE_MAX steps, the newest kept (#1790 review; #1791 review: older pages too). The oldest are let go to keep
   * the page light; older pages would resume at a cursor past them and leave them out, so older pages are no longer
   * offered — the page says so (reopening reads from the newest).
   */
  const capPage = (merged) => {
    if (merged.length <= PAGE_MAX) return merged;
    const c = cursor.current;
    c.before = null; c.trimmed = true; c.epoch++;
    return merged.slice(merged.length - PAGE_MAX);
  };
  const take = (j, { replace = false } = {}) => {
    if (!j.enabled) { setState({ phase: "off" }); return; }
    setInfo({ backend: j.backend, supported: j.supported, reason: j.reason || null });
    const c = cursor.current;
    if (j.key) c.key = j.key;
    if (j.after !== null && j.after !== undefined) { c.after = j.after; c.skip = !!j.skip; }
    if (replace) { c.before = j.before ?? null; c.trimmed = false; c.epoch++; }
    if (typeof j.ev === "number") c.ev = Math.max(c.ev, j.ev);
    setSteps((list) => capPage(replace ? j.steps || [] : mergeSteps(list, j.steps || [])));
    if (j.events && j.events.length) setEvents((list) => (replace ? j.events : [...list, ...j.events.filter((e) => !list.some((x) => x.id === e.id))]));
    else if (replace) setEvents([]);
    if (j.reset) setNotice(tl("reset"));
    setState({ phase: "on" });
  };

  // The newest window (and the watch), once per page and on Retry.
  const open = async () => {
    reading.current = true;
    try {
      const j = await read(q({ watch: "1" }));
      if (j) take(j, { replace: true });
    } catch { if (lease.current()) setState({ phase: "failed" }); }
    finally { reading.current = false; }
  };
  // What came after the cursor: one read at a time, and once more if asked meanwhile.
  const pull = async () => {
    if (state.phase !== "on" && state.phase !== "loading") return;
    if (reading.current) { again.current = true; return; }
    const c = cursor.current;
    if (c.after === null && c.key === null) return void open();
    reading.current = true;
    try {
      const params = { watch: "1", ev: String(c.ev) };
      if (c.after !== null) params.after = String(c.after);
      if (c.key) params.key = c.key;
      if (c.skip) params.skip = "1";
      const j = await read(q(params));
      if (j) take(j, { replace: !!j.reset });
    } catch { /* the next tick or poll tries again */ }
    finally {
      reading.current = false;
      if (again.current && lease.current()) { again.current = false; void pull(); }
    }
  };
  const loadOlder = async () => {
    const c = cursor.current;
    if (c.before === null || older.busy) return;
    const epoch = c.epoch;
    setOlder({ busy: true });
    try {
      const j = await read(q({ before: String(c.before), ...(c.key ? { key: c.key } : {}) }));
      if (j && j.enabled) {
        // A trim or a new conversation meanwhile: this answer is stale — even one that says a new conversation began,
        // which would replace what is shown now with an older snapshot and its cursor.
        if (c.epoch !== epoch) return;
        if (j.reset) { take(j, { replace: true }); return; }
        c.before = j.before ?? null;
        const el = scroller.current, from = el ? el.scrollHeight - el.scrollTop : 0;
        setSteps((list) => capPage(mergeSteps(list, j.steps || [], true)));
        // Keep the reader where they were: what was at the top stays in view.
        requestAnimationFrame(() => { if (el && lease.current()) el.scrollTop = el.scrollHeight - from; });
      }
    } catch { toast(t("chat.loadFailed"), false); }
    finally { if (lease.current()) setOlder({ busy: false }); }
  };

  useEffect(() => { void open(); }, [lease]);
  // Live: the stream's tick for this instance; over the public link, a poll while shown. A renewal keeps the lease.
  useEffect(() => {
    if (state.phase !== "on") return;
    const on = appStore.get().streamOn;
    if (on && !polling) lease.hold(on("steps_tick", (d) => { if (d && d.instance === name) void pull(); }));
    const shown = () => !globalThis.document?.hidden;
    if (polling) lease.interval(() => { if (shown()) void pull(); }, POLL_MS);
    lease.interval(() => { if (shown()) void pull(); }, RENEW_MS);
    // Coming back to a hidden tab: catch up at once.
    lease.on(globalThis.document, "visibilitychange", () => { if (shown()) void pull(); });
  }, [lease, state.phase]);

  // Pinned to the newest step, like the chat: a reader who scrolled up is never moved.
  const onScroll = () => { const el = scroller.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
  useLayoutEffect(() => { const el = scroller.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [steps, events, filter]);

  const enable = async () => {
    if (enabling) return;
    setEnabling(true);
    try {
      const res = await confirmedWrite("/api/settings/fleet/web", { method: "PUT", body: { log_tab: true }, label: tl("enable") });
      if (!lease.current()) return;
      if (res.ok) { toast(tl("enabled")); setState({ phase: "loading" }); void open(); }
      else toast(tl("enableFailed", (res.body && res.body.error) || String(res.status)), false);
    } catch (err) { toast(tl("enableFailed", err && err.message ? err.message : "?"), false); }
    finally { if (lease.current()) setEnabling(false); }
  };

  const cls = statusClass(inst, exec, awaiting);
  const sub = html`<span class="status"><span class=${`dot ${cls}`} aria-hidden="true"></span>${statusLabel(inst, exec, awaiting)}</span>`;
  const items = useMemo(() => {
    const all = timeline(steps, events);
    const shown = filter === "tools" ? all.filter((x) => x.kind === "tool") : filter === "errors" ? all.filter(isError) : all;
    return collapse(shown);
  }, [steps, events, filter]);

  let content;
  if (state.phase === "failed") content = html`<${ErrorState} message=${t("chat.loadFailed")} onRetry=${() => { setState({ phase: "loading" }); void open(); }} />`;
  else if (state.phase === "loading") content = html`<${Skeleton} lines=${6} />`;
  else if (state.phase === "off") {
    content = html`<div class="log-off center"><${Empty} icon="tasks" title=${tl("offTitle")} hint=${tl("offBody")}
      action=${overPublicLink ? html`<p class="note">${tl("offPublic")}</p>`
        : html`<button type="button" class="btn btn-primary log-enable" disabled=${enabling} onClick=${enable}>${enabling ? tl("enabling") : tl("enable")}</button>`} /></div>`;
  } else {
    const why = info && info.reason ? (info.reason === "unsupported" ? tl("unsupported", info.backend)
      : KIRO_REASONS.has(info.reason) ? tl("kiroWhy", tl(info.reason))
      : info.reason === "not_running" ? tl("notRunning") : info.reason === "no_transcript" ? tl("noTranscript") : "") : "";
    content = html`
      ${why ? html`<p class="note log-why" role="status">${why}</p>` : null}
      ${notice ? html`<p class="note log-notice" role="status">${notice}</p>` : null}
      ${cursor.current.before !== null
        ? html`<div class="log-older"><button type="button" class="btn btn-sm" disabled=${older.busy} onClick=${loadOlder}>${older.busy ? tl("loading") : tl("olderLoad")}</button></div>`
        : cursor.current.trimmed ? html`<p class="note log-start">${tl("olderTrimmed")}</p>`
        : steps.length ? html`<p class="note log-start">${tl("olderStart")}</p>` : null}
      ${items.length ? html`<ol class="log-list" role="log" aria-label=${t("app.log")}>${items.map((x, i) => html`<${LogRow} key=${`${x.kind}:${x.id}`} x=${x} prev=${items[i - 1]} />`)}</ol>`
        : html`<p class="note log-empty">${tl("empty")}</p>`}`;
  }
  const tools = state.phase === "on" ? html`<div data-trust="panel-controls" class="log-bar" role="group" aria-label=${tl("filter")}>
      ${["all", "tools", "errors"].map((k) => html`<button key=${k} type="button" class=${`chip-btn${filter === k ? " on" : ""}`} aria-pressed=${filter === k ? "true" : "false"} onClick=${() => setFilter(k)}>${tl(k)}</button>`)}
      <span class="grow"></span><span class="log-live" title=${tl("live")}><span class="dot running" aria-hidden="true"></span>${tl("live")}</span></div>` : null;
  return html`<div data-effect-panel="log" class="panel p-log">
    <${PanelHeader} title=${name} sub=${sub} pageControls=${{ navKey }} nav=${html`<${InstanceSwitch} name=${name} current="log" />`}><${HeaderTools} navKey=${navKey} /><${HeaderSlot} /></${PanelHeader}>
    ${tools}
    <div data-trust="panel-content" class="panel-body log-body" ref=${scroller} onScroll=${onScroll}><div class="col log-col">${content}</div></div>
  </div>`;
}
LogPanel.workspaceVersion = 1;
