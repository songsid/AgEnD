// #1408 step 4 = #1386 part (b): the "Needs you" panel (/ui/needs) — everything waiting on the person, from every
// world, in one list. Behind the session gate (/ui/js/), loaded the first time it is opened.
//
// A renderer only (#1386 §4.2, the user's Discord-first rule): the list is the server's one derivation, the app
// store's `needs`, which arrives over the passive channels (SSE `needs`, the /ui/poll field). This panel reads
// nothing (#1374: no new GET, no timer that asks the server); its writes are a person's actions:
// - a prompt's own buttons, through the page's chat store (appStore.chatOwner — whichever chat import booted, a Retry's
//   included): one claim per prompt with Chat (POST /ui/prompt, first answer wins);
// - Acknowledge on a delivery (POST /ui/needs/ack), which clears it everywhere;
// - Open: that instance's chat.
// Something resolved anywhere (Discord, Telegram, the web) leaves the list by itself.
// alpha.2 (M-2300): an agent's Windows request waiting for a web-only fleet's owner is the app store's `proposals`, read
// by agent-proposals.js (owner only, on the stream's `agent_proposals` ping) — Approve / Reject POST its decision. Only
// on a tab opened before an upgrade (app.js never installed it) does this panel install it, once.
import { html, useEffect, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, createStore, useStore } from "/assets/app-store.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { chatPath } from "/assets/app-route.js";
import { namesOf, namesStore } from "/assets/instance-nav.js";
import { Empty } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { notifyStore, notifySupport, configDetail, reasonText, refreshNotify, setNotify } from "/assets/app-needs.js";
import { openSignIn, signInOffered } from "./backend-signin.js";
import { decideProposal, installProposals } from "./agent-proposals.js";

register("needs", {
  en: {
    title: "Needs you", empty: "Nothing needs you right now", emptyHint: "When an agent waits for you, it shows here — and in your chat app's General.", emptyHintWeb: "When an agent waits for you, it shows here.",
    open: "Open chat", openCard: "Open the card", noAssignee: "Task board (nobody assigned)", fleetSignIns: "Fleet sign-ins", signIn: "Sign in",
    gap: "not wrapped up: {0}", gapUnchecked: "{0} checklist item(s) unchecked", gapNoResult: "no result", gapJoin: ", ", acknowledge: "Acknowledge", acknowledging: "Acknowledging…", answering: "Answering…",
    ageNow: "just now", ageMin: "{0} min", ageHour: "{0} h", ageDay: "{0} d",
    notifyTitle: "Notify me on this device", notifyOn: "Notifications are on for this browser while a tab is open.",
    notifyOff: "Get a desktop notification when something new needs you while this tab is in the background.",
    notifyDenied: "This browser blocked notifications for AgEnD. Allow them in the site settings to turn this on.",
    notifyMobile: "On a phone, rely on your chat app's notification: a new item is a new post in General.", notifyMobileWeb: "On a phone, open this page to see what needs you.",
    notifyInsecure: "Notifications need a secure address (localhost or the HTTPS public link), not a plain-HTTP LAN address.",
    notifyUnsupported: "This browser cannot show notifications.", turnOn: "Turn on", turnOff: "Turn off",
    typePrompt: "Fleet prompt", typeAwaiting: "At its terminal", typeInstance: "Instance", typeDelivery: "Delivery",
    proposals: "Agent requests", proposalFrom: "Request from {0}", proposalHint: "Nothing is created or changed until you approve. When you do, AgEnD checks the request, the target machine and your sign-in again, then runs it once.",
    approve: "Approve", reject: "Reject", deciding: "Working…", expiresIn: "expires in {0} min", expiresSoon: "expires in under a minute",
    applying: "Being applied…", openAgent: "Open the new agent's chat", decided: "Decided here", failedReason: "Reason: {0}",
    f_runtime: "Runs on", f_machine: "Machine", f_thisPc: "This PC (Windows)", f_topic_name: "Name", f_backend: "CLI", f_model: "Model", f_directory: "Folder",
    f_sandbox: "Access", f_description: "Description", f_display_name: "Display name", f_tags: "Tags", sb_read_only: "read-only", sb_workspace_write: "can write in its folder",
    createWindows: "Create a Windows agent", changeAgent: "Change {0}",
  },
  "zh-TW": {
    title: "等你處理", empty: "目前沒有需要你處理的事", emptyHint: "agent 在等你時，會出現在這裡——也會出現在聊天 app 的 General。", emptyHintWeb: "agent 在等你時，會出現在這裡。",
    open: "開啟聊天", openCard: "打開卡片", noAssignee: "任務看板（沒有負責人）", fleetSignIns: "Fleet 登入", signIn: "登入",
    gap: "還沒補齊：{0}", gapUnchecked: "還有 {0} 項沒勾", gapNoResult: "沒有產出總結", gapJoin: "、", acknowledge: "確認", acknowledging: "確認中…", answering: "回覆中…",
    ageNow: "剛剛", ageMin: "{0} 分鐘", ageHour: "{0} 小時", ageDay: "{0} 天",
    notifyTitle: "在這台裝置通知我", notifyOn: "這個瀏覽器的通知已開啟（需要開著分頁）。",
    notifyOff: "分頁在背景時，有新的事等你處理就跳出桌面通知。",
    notifyDenied: "這個瀏覽器封鎖了 AgEnD 的通知。請在網站設定中允許後再開啟。",
    notifyMobile: "在手機上請以聊天 app 的通知為主：每個新項目都會在 General 發一則新訊息。", notifyMobileWeb: "在手機上請打開這個頁面查看等你處理的事。",
    notifyInsecure: "通知需要安全的網址（localhost 或 HTTPS 公開連結），區網的一般 HTTP 網址不行。",
    notifyUnsupported: "這個瀏覽器無法顯示通知。", turnOn: "開啟", turnOff: "關閉",
    typePrompt: "Fleet 提示", typeAwaiting: "在終端機上", typeInstance: "Instance", typeDelivery: "傳送",
    proposals: "代理人的請求", proposalFrom: "{0} 的請求", proposalHint: "在你核准之前，不會建立或修改任何東西。核准時，AgEnD 會再次檢查這個請求、目標電腦和你的登入，然後只執行一次。",
    approve: "核准", reject: "拒絕", deciding: "處理中…", expiresIn: "{0} 分鐘後過期", expiresSoon: "不到一分鐘後過期",
    applying: "正在套用…", openAgent: "開啟新 agent 的聊天", decided: "已在這裡決定", failedReason: "原因：{0}",
    f_runtime: "執行於", f_machine: "電腦", f_thisPc: "這台電腦（Windows）", f_topic_name: "名稱", f_backend: "CLI", f_model: "模型", f_directory: "資料夾",
    f_sandbox: "存取權限", f_description: "說明", f_display_name: "顯示名稱", f_tags: "標籤", sb_read_only: "唯讀", sb_workspace_write: "可寫入它的資料夾",
    createWindows: "建立 Windows agent", changeAgent: "修改 {0}",
  },
});
const tn = (k, ...v) => t(`needs.${k}`, ...v);

/**
 * The page's claims on what Needs you writes, kept for the life of the page — not of a panel or a render (#1463
 * review): a second click in the same turn, the panel left and opened again, or a list that has not caught up yet all
 * see the same claim.
 * - `acks[id]`: "busy" while its POST is out, "done" once the server took it, until the server's next list drops the
 *   item (then forgotten); a failure gives it back.
 * - `prompts[nonce]`: the same, for a prompt answered while the page has no chat store yet (before Chat boots). When
 *   it arrives, each such claim is handed to it (holdPrompt) — one claim, never two — and its outcome settles there.
 */
export const claims = createStore({ acks: {}, prompts: {} });
const chatOwner = () => appStore.get().chatOwner || null;
let handedTo = null;
appStore.subscribe((st) => {
  // The chat store arrived (or was replaced by a Retry's): the claims taken without it become its own.
  if (st.chatOwner && st.chatOwner !== handedTo) {
    handedTo = st.chatOwner;
    const items = Array.isArray(st.needs) ? st.needs : [];
    for (const nonce of Object.keys(claims.get().prompts)) {
      handedTo.holdPrompt(items.find((i) => i.nonce === nonce) || { nonce, instance: "" });
    }
  }
  const items = Array.isArray(st.needs) ? st.needs : [];
  const listed = new Set(items.map((i) => i.id)), nonces = new Set(items.map((i) => i.nonce).filter(Boolean));
  const c = claims.get();
  const acks = Object.fromEntries(Object.entries(c.acks).filter(([id, v]) => v === "busy" || listed.has(id)));
  const prompts = Object.fromEntries(Object.entries(c.prompts).filter(([n, v]) => v === "busy" || nonces.has(n)));
  if (Object.keys(acks).length !== Object.keys(c.acks).length || Object.keys(prompts).length !== Object.keys(c.prompts).length) claims.set({ acks, prompts });
});
const setClaim = (kind, key, value) => claims.set((c) => {
  const next = { ...c[kind] };
  if (value) next[key] = value; else delete next[key];
  return { ...c, [kind]: next };
});

const ICON = { prompt: "chat", awaiting_input: "clock", instance: "alert", delivery: "send", task: "tasks" };
const BAD = new Set(["crashed", "delivery_failed", "hang", "exited"]);

/**
 * An item's line. A task board card's is said here, in the page's language (#2246 step 3): its number and title, then
 * its question or what it lacks; anything else is the server's own words.
 */
function detailOf(item) {
  const c = item.type === "task" ? item.card : null;
  if (!c || !c.title) return configDetail(item);
  const lacks = c.gap ? [c.gap.unchecked ? tn("gapUnchecked", c.gap.unchecked) : "", c.gap.noResult ? tn("gapNoResult") : ""].filter(Boolean).join(tn("gapJoin")) : "";
  const tail = c.question || (lacks ? tn("gap", lacks) : "");
  return `${c.code} ${c.title}${tail ? ` — ${tail}` : ""}`;
}

/** "3 min", "2 h": the age shown beside an item (refreshed by a display timer, never by a read). */
export function age(since, nowMs) {
  const minutes = Math.max(0, Math.floor((nowMs - since) / 60_000));
  if (minutes < 1) return tn("ageNow");
  if (minutes < 60) return tn("ageMin", minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? tn("ageHour", hours) : tn("ageDay", Math.floor(hours / 24));
}

/** The store's list, grouped by instance, in its order (instances by their oldest item; items oldest first). */
export function groupNeeds(items) {
  const groups = new Map();
  for (const item of items) {
    // Configuration issues belong to Settings, not the unassigned task/sign-in group.
    const key = JSON.stringify([item.instance, !item.instance && item.type === "config"]);
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { instance: item.instance, items: [item] });
  }
  return [...groups.values()];
}

/**
 * alpha.2 (M-2300): what this page decided, kept for the life of the page — the request's id → "busy" while its POST is
 * out, then the server's answer ({ view, agent, message }): it stays shown after the list drops the request.
 */
export const decisions = createStore({});

export function NeedsPanel({ navKey }) {
  const lease = useLease(navKey);
  const { needs, chatOwner: owner, instances, connections, proposals } = useStore(appStore);
  // A tab opened before an upgrade has this panel but not the app.js that installs the list (it never set `proposals`):
  // install it here then. On a current page app.js already did, and this panel reads nothing itself (#1374).
  useEffect(() => { if (appStore.get().proposals === undefined) installProposals(); }, []);
  const asks = Array.isArray(proposals) ? proposals : [];
  const done = useStore(decisions);
  const decidedHere = Object.entries(done).filter(([id, d]) => d && d !== "busy" && !asks.some((p) => p.id === id));
  // #1854: a fleet with no chat connection (web only, or not known yet) has no General to point at.
  const chatApp = connections > 0;
  const names = useStore(namesStore);
  // #1630/#1722: a group is headed by the instance's leading name (the "Names" preference), as the sidebar shows it.
  const nameFor = (instance) => { const it = (instances || []).find((i) => i && i.name === instance); return it ? namesOf(it, names.primary).primary : instance; };
  const items = Array.isArray(needs) ? needs : [];
  const [, tick] = useState(0);
  useEffect(() => { setTitle(tn("title")); }, [navKey]);
  // Ages move on: a redraw every 30 s while the panel is open (display only — nothing is read).
  useEffect(() => { lease.interval(() => tick((n) => n + 1), 30_000); }, [lease]);
  // The chat store owns a prompt's busy/answered state; redraw when it changes (and when it arrives).
  useEffect(() => { if (owner) return owner.subscribe(() => tick((n) => n + 1)); return undefined; }, [owner, lease]);
  const groups = groupNeeds(items);
  const nowMs = Date.now();
  return html`<div data-effect-panel="needs" class="panel p-needs">
    <${PanelHeader} title=${tn("title")} sub=${items.length + asks.length ? t("app.needsCount", items.length + asks.length) : null} />
    <div data-trust="panel-content" class="panel-body"><div class="col">
      ${asks.length || decidedHere.length ? html`<section class="n-group n-proposals" aria-label=${tn("proposals")}>
        <h2 class="n-group-head">${tn("proposals")}</h2>
        ${asks.map((p) => html`<${ProposalItem} key=${p.id} proposal=${p} nowMs=${nowMs} />`)}
        ${decidedHere.map(([id, d]) => html`<${ProposalResult} key=${id} result=${d} />`)}
      </section>` : null}
      ${!items.length && !asks.length && !decidedHere.length ? html`<${Empty} icon="check" title=${tn("empty")} hint=${tn(chatApp ? "emptyHint" : "emptyHintWeb")} />`
        : groups.map((g) => html`<section key=${JSON.stringify([g.instance, g.items[0]?.type === "config"])} class="n-group" aria-label=${g.instance}>
          <h2 class="n-group-head">${g.instance ? html`<a href=${chatPath(g.instance)} title=${g.instance}>${nameFor(g.instance)}</a>` : g.items[0]?.type === "config" ? t("app.settings") : tn(g.items.some(i => i.type === "backend") ? "fleetSignIns" : "noAssignee")}</h2>
          ${g.items.map((item) => html`<${NeedsItem} key=${item.id} item=${item} nowMs=${nowMs} owner=${owner} />`)}
        </section>`)}
      <${NotifyToggle} />
    </div></div>
  </div>`;
}

function NeedsItem({ item, nowMs, owner }) {
  const c = useStore(claims);
  // A prompt: the page's chat store holds the one claim (Chat and Needs you, any panel, any render).
  const p = item.type === "prompt" && item.nonce && owner ? owner.state.prompts[item.nonce] : null;
  const fallback = item.nonce ? c.prompts[item.nonce] : undefined;
  const promptBusy = p ? p.busy || p.resolved : !!fallback;
  const answer = async (action) => {
    const store = chatOwner();
    if (store) { store.answerByNonce(item, action); return; }
    // Only before Chat has booted: the page's own claim on this nonce, taken now (synchronously), kept until the
    // server's list drops the prompt (or the answer fails).
    if (claims.get().prompts[item.nonce]) return;
    setClaim("prompts", item.nonce, "busy");
    let r = null;
    try {
      const res = await fetch("/ui/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance: item.instance, nonce: item.nonce, action }) });
      r = await res.json().catch(() => ({}));
    } catch (err) { r = { error: err && err.message ? err.message : t("app.failed") }; }
    // The chat store may have arrived meanwhile and taken this claim over: its outcome is settled there.
    const now = chatOwner();
    if (r && r.answered) { if (now) setClaim("prompts", item.nonce, null); else setClaim("prompts", item.nonce, "done"); return; }
    setClaim("prompts", item.nonce, null);
    if (now) now.releasePrompt(item.nonce);
    toast((r && r.error) || t("app.failed"), false);
  };
  const ack = c.acks[item.id];
  const acknowledge = async () => {
    if (claims.get().acks[item.id]) return;                       // the page's claim, taken synchronously
    setClaim("acks", item.id, "busy");
    let res = null, body = null;
    try {
      res = await fetch("/ui/needs/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id }) });
      body = await res.json().catch(() => ({}));
    } catch { body = { error: t("app.failed") }; }
    // Taken: it stays claimed until the server's next `needs` drops it — here, everywhere at once. Refused: free again.
    setClaim("acks", item.id, res && res.ok ? "done" : null);
    toast((body && (body.message || body.error)) || t("app.failed"), !!(res && res.ok));
  };
  return html`<article data-trust="permission" class=${`n-item${BAD.has(item.reason) ? " bad" : ""}`}>
    <span class="n-icon"><${Icon} name=${ICON[item.type] || "alert"} size=${18} /></span>
    <div class="n-body">
      <div class="n-title"><strong>${reasonText(item)}</strong><span class="n-age">${age(item.since, nowMs)}</span></div>
      ${detailOf(item) ? html`<p class="n-detail">${detailOf(item)}</p>` : null}
      <div class="n-actions">
        ${item.type === "prompt" && Array.isArray(item.actions) ? item.actions.filter((a) => !a.input).map((a) => html`<button key=${a.id} type="button" class="btn btn-sm"
            disabled=${promptBusy} onClick=${() => answer(a.id)}>${(p ? p.busy : fallback === "busy") ? tn("answering") : a.label}</button>`) : null}
        ${item.type === "delivery" ? html`<button type="button" class="btn btn-sm" disabled=${!!ack} onClick=${acknowledge}>
            <${Icon} name="check" size=${14} />${ack === "busy" ? tn("acknowledging") : tn("acknowledge")}</button>` : null}
        ${(item.reason === "auth_paused" || item.reason === "backend_signin") && item.signIn && signInOffered() ? html`<button type="button" class="btn btn-sm btn-primary" onClick=${() => openSignIn(item.signIn)}>${tn("signIn")}</button>` : null}
        ${item.type === "task" && item.card ? html`<a class="btn btn-sm" href=${`/ui/fleet?card=${encodeURIComponent(item.card.code)}`}>${tn("openCard")}</a>` : null}
        ${item.instance ? html`<a class="btn btn-sm btn-ghost" href=${chatPath(item.instance)}>${tn("open")}</a>` : null}
      </div>
    </div>
  </article>`;
}

/**
 * alpha.2 (M-2300): the request's summary as the owner reads it (junsion's §6: the machine, the CLI, the model, the
 * folder, the access). The server's lines are the settings diff, escaped for a chat's markdown ("new\_instance.directory:
 * absent → C:\\work"): here, unescaped and named — a create's fields as "Folder: C:\work", "Machine: This PC" when it
 * names none; a change's as "Model: a → b"; any other line as it is. Text only (rendered as text, never markup).
 */
export function proposalLines(summary) {
  const unescape = (s) => String(s).replace(/\\([\\`*_~[\]()<>|])/g, "$1").replace(/\[at\]/g, "@");
  const lines = (Array.isArray(summary) ? summary : []).map(unescape);
  const create = lines.some((l) => /^POST \/ui\/instances$/.test(l));
  const out = [], label = (k) => { const key = `f_${k}`, s = tn(key); return s === `needs.${key}` ? k : s; };
  // The access field's values, in words (matched by value: the two the request's schema allows).
  const ACCESS = { "read-only": "sb_read_only", "workspace-write": "sb_workspace_write" };
  const value = (_k, v) => (Object.hasOwn(ACCESS, v) ? tn(ACCESS[v]) : v);
  let machine = false;
  for (const l of lines) {
    if (/^POST \/ui\/instances$/.test(l)) continue;
    const m = /^new_instance\.([A-Za-z_]+): absent → (.*)$/.exec(l);
    if (m) { if (m[1] === "machineId") machine = true; out.push(`${label(m[1] === "machineId" ? "machine" : m[1])}: ${value(m[1], m[2])}`); continue; }
    const ch = /^(\S+) ([A-Za-z_]+): (.*) → (.*)$/.exec(l);
    if (ch) { out.push(`${tn("changeAgent", ch[1])} · ${label(ch[2])}: ${ch[3]} → ${ch[4]}`); continue; }
    out.push(l);
  }
  if (create && !machine) out.splice(1, 0, `${label("machine")}: ${tn("f_thisPc")}`);
  return create ? [tn("createWindows"), ...out] : out;
}

/**
 * alpha.2 (M-2300): one agent's request waiting for this web-only fleet's owner — what it would do (the server's own
 * summary: the machine, the CLI, the model, the folder, the access), when it runs out, and Approve / Reject. One click
 * per request on this page (claimed before the POST); the answer is the server's: applied, rejected, run out, already
 * decided elsewhere, or failed with its reason.
 */
function ProposalItem({ proposal: p, nowMs }) {
  const d = useStore(decisions)[p.id];
  const busy = d === "busy" || p.state === "applying";
  const [failed, setFailed] = useState(null);
  const decide = async (decision) => {
    if (decisions.get()[p.id]) return;                                 // one POST in flight per request on this page
    setFailed(null);
    decisions.set((s) => ({ ...s, [p.id]: "busy" }));
    const r = await decideProposal(p.id, decision);
    // #2997 review (Prism P2): nothing decided (the network failed, the owner was refused, a bad answer) and the request
    // still waits — the claim is released and why is said here, so the next click is taken; a decided one is kept.
    const decided = r.view && r.view.state !== "pending";
    if (!decided) {
      decisions.set((s) => { const next = { ...s }; delete next[p.id]; return next; });
      setFailed(r.message || t("app.failed"));
      return;
    }
    decisions.set((s) => ({ ...s, [p.id]: { ...r, decision } }));
    toast(r.view.outcome ? r.view.outcome.message : (r.message || t("app.failed")), r.view.state === "applied");
  };
  const minutes = Math.floor((p.remaining_ms || 0) / 60_000);
  return html`<article data-trust="permission" class="n-item">
    <span class="n-icon"><${Icon} name="alert" size=${18} /></span>
    <div class="n-body">
      <div class="n-title"><strong>${tn("proposalFrom", p.requested_by)}</strong><span class="n-age">${age(p.requested_at, nowMs)} · ${minutes >= 1 ? tn("expiresIn", minutes) : tn("expiresSoon")}</span></div>
      <ul class="n-detail">${proposalLines(p.summary).map((line, i) => html`<li key=${i}>${line}</li>`)}</ul>
      <p class="note">${tn("proposalHint")}</p>
      ${failed ? html`<p class="note n-proposal-error" role="alert">${failed}</p>` : null}
      <div class="n-actions">
        <button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${() => decide("confirm")}>${busy ? (p.state === "applying" ? tn("applying") : tn("deciding")) : tn("approve")}</button>
        <button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => decide("reject")}>${tn("reject")}</button>
      </div>
    </div>
  </article>`;
}

/** A request decided on this page: the server's outcome (and its reason), and the new agent's chat when one was created. */
function ProposalResult({ result: r }) {
  const v = r.view, outcome = v && v.outcome;
  const ok = !!(v && v.state === "applied");
  return html`<article data-trust="permission" class=${`n-item${ok || (v && v.state === "rejected") ? "" : " bad"}`}>
    <span class="n-icon"><${Icon} name=${ok ? "check" : "alert"} size=${18} /></span>
    <div class="n-body">
      <div class="n-title"><strong>${outcome ? outcome.message : (r.message || t("app.failed"))}</strong><span class="n-age">${tn("decided")}</span></div>
      ${v ? html`<ul class="n-detail">${proposalLines(v.summary).map((line, i) => html`<li key=${i}>${line}</li>`)}</ul>` : null}
      ${outcome && outcome.detail ? html`<p class="note">${tn("failedReason", outcome.detail)}</p>` : null}
      ${ok && r.agent ? html`<div class="n-actions"><a class="btn btn-sm btn-primary" href=${chatPath(r.agent)} title=${r.agent}>${tn("openAgent")}</a></div>` : null}
    </div>
  </article>`;
}

/** The device's choice, as the page knows it (app-needs.js notifyStore): every mounted toggle shows the same. */
function NotifyToggle() {
  const support = notifySupport();
  const { state, asking } = useStore(notifyStore);
  useEffect(() => { refreshNotify(); }, []);
  const on = state === "on";
  const toggle = () => { setNotify(!on); };
  const { connections } = useStore(appStore);
  const note = support === "mobile" ? tn(connections > 0 ? "notifyMobile" : "notifyMobileWeb") : support === "insecure" ? tn("notifyInsecure")
    : support !== "ok" ? tn("notifyUnsupported") : state === "denied" ? tn("notifyDenied") : on ? tn("notifyOn") : tn("notifyOff");
  return html`<section class="card n-notify"><h3>${tn("notifyTitle")}</h3>
    <p class="note">${note}</p>
    ${support === "ok" ? html`<div><button type="button" class=${`btn btn-sm${on ? "" : " btn-primary"}`} aria-pressed=${on ? "true" : "false"} disabled=${asking} onClick=${toggle}>
      <${Icon} name="bell" size=${14} />${on ? tn("turnOff") : tn("turnOn")}</button></div>` : null}
  </section>`;
}
