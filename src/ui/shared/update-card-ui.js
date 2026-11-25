// M-3770 slice 1.4 (design #4480 §3.1, §3.2, §4.1, §6): the one update card on the web — its line on the banner, its
// answers (Update when idle, Pick a time, Not now, Update now, Cancel), the pre-flight result ("Updates on this
// machine"), and Settings → Version and update's controls (when not to update; Advanced: pin, longest wait). A module of
// its own (the module-skew rule): app-update.js and settings-update.js import it; an older cached copy of either simply
// does not show the card (it never meets a missing export). The server's words: GET /ui/update's `card` and `preflight`
// (S-234 / S-235 / S-236), POST /ui/update/answer, PUT /api/settings/fleet/updates.
import { html, useEffect, useState } from "./app-html.js";
import { register, t } from "./app-i18n.js";
import { confirmDialog } from "./ui-confirm.js";
import { Dialog } from "./ui-dialog.js";
import { toast } from "./ui-toast.js";

register("updatecard", {
  en: {
    ready: "AgEnD v{0} is ready (you have v{1}).",
    continues: "Your agents finish what they're doing first, then AgEnD restarts for a few minutes and they carry on.",
    backPhase1: "If the new version doesn't start, AgEnD tries to put v{0} back; if it can't, it tells you how to recover.",
    noWayBack: "There's no automatic way back on this setup: if the new version doesn't start, start AgEnD again (Settings shows how).",
    whenIdle: "Update when idle", pickTime: "Pick a time", notNow: "Not now", updateNow: "Update now", cancel: "Cancel",
    waiting: "Updating to v{0} as soon as your agents are idle.", waitingFor: "Waiting for: {0}", waitingSince: "Waiting since {0}",
    scheduled: "Updating to v{0} at {1}, once your agents are idle then.", notNowUntil: "You chose Not now. The card comes back on {0}.",
    starting: "Starting the update to v{0}…", cantTitle: "AgEnD can't update itself on this machine.", pressOnly: "Update this machine yourself:",
    nowTitle: "Update now?", nowBody: "{0} agents are working. They stop for a few minutes while AgEnD restarts, then pick up where they were.",
    nowBodyIdle: "AgEnD restarts for a few minutes; your agents pick up where they were.", nowGo: "Update now",
    pickTitle: "When should AgEnD update?", pickTonight: "Tonight", pickMorning: "Tomorrow morning", pickThisMorning: "This morning", pickOther: "Another time",
    pickHint: "It still waits until your agents are idle at that time. Within the next 7 days.", pickGo: "Schedule", pickBad: "Pick a time in the next 7 days.",
    changed: "The update changed while you were looking. Here it is again.", running: "An update is already running.",
    failedAnswer: "That didn't work: {0}",
    machine: "Updates on this machine", self: "AgEnD can update itself here.", adminOnly: "Updates here need you: AgEnD can't bring itself back on its own.",
    stop: "AgEnD can't update here until this is fixed.", notChecked: "not checked yet", checking: "Not checked yet: it's checked when AgEnD starts and once a day.",
    pauseTitle: "Don't update during", pauseHint: "Days and hours when AgEnD never updates (a waiting update waits for the window to end).",
    pauseAdd: "Add a time", pauseRemove: "Remove", from: "From", to: "To", save: "Save", saved: "Saved.", saveFailed: "Couldn't save: {0}",
    advanced: "Advanced", pin: "Pin to a version", pinHint: "No update is offered while a version is pinned. Leave empty for none.",
    maxWait: "Longest wait for idle (hours)", maxWaitHint: "After this, the card asks again instead of waiting (1–168, default 24).",
    days: "Sun,Mon,Tue,Wed,Thu,Fri,Sat",
    c_checkout: "AgEnD runs from a source checkout, not from an install npm updates. Update it with git.",
    c_other_copy: "Another copy of AgEnD ({path}) is the one npm would update, not the one running. Run the fleet from the global install.",
    c_path_shadow: "Another agend on the PATH ({path}) would run instead of this one. Remove it or fix the PATH.",
    c_unreadable: "AgEnD can't read where it's installed right now. Try again in a minute.",
    c_shared_home: "Another AgEnD install uses the same home folder. Give each its own home, or remove one.",
    c_unknown_owner: "AgEnD can't prove which install runs this fleet. Restart it as a service and check again.",
    c_other_install: "Another AgEnD install lives under this user. Updating one could affect the other.",
    c_not_service: "AgEnD isn't running as a service, so it can't bring itself back after an update.",
    c_linger_off: "Lingering is off for {user}, so the service stops when they sign out.",
    c_system_unit_not_root: "AgEnD runs as a system service; updating it needs root.",
    c_unit_reload_pending: "The service definition changed and hasn't been reloaded. Run systemctl --user daemon-reload.",
    c_no_write: "Updating needs write access to {path}. Run sudo agend update in a terminal on that computer, or reinstall with the one-line installer.",
    c_linked: "This AgEnD is linked from a development folder ({path}); an update replaces the link.",
    c_vendored: "This AgEnD sits inside another project ({path}).",
    c_low_disk: "Updating needs about {need} free on {path}; there's {have}.",
    c_npm_unreachable: "The update source can't be reached from this machine (network or proxy).",
    c_rehearsal: "A rehearsal or test is running here; updates wait until it ends.",
    c_update_running: "An update is already running.",
    c_container: "AgEnD runs in a container; update the image.",
    c_windows_runtime: "This computer's AgEnD Runtime updates itself.",
    c_node_too_old: "v{0} needs Node {needs}; this machine has {node}.",
    c_other: "A check didn't pass ({0}).",
  },
  "zh-TW": {
    ready: "AgEnD v{0} 已可更新（目前 v{1}）。",
    continues: "Agent 會先把手上的事做完，接著 AgEnD 重新啟動幾分鐘，之後繼續工作。",
    backPhase1: "新版沒有正常啟動的話，AgEnD 會嘗試回到 v{0}；回不去時會告訴你怎麼處理。",
    noWayBack: "這台機器的設定無法自動退回：新版沒有正常啟動的話，請再啟動一次 AgEnD（設定裡有說明）。",
    whenIdle: "閒下來時更新", pickTime: "選個時間", notNow: "先不要", updateNow: "立即更新", cancel: "取消",
    waiting: "Agent 一閒下來就更新到 v{0}。", waitingFor: "正在等：{0}", waitingSince: "從 {0} 開始等",
    scheduled: "{1} 更新到 v{0}（屆時 Agent 閒下來才開始）。", notNowUntil: "你選了「先不要」，{0} 會再提醒。",
    starting: "正在開始更新到 v{0}…", cantTitle: "AgEnD 無法在這台機器上自行更新。", pressOnly: "請自行更新這台機器：",
    nowTitle: "立即更新？", nowBody: "有 {0} 個 Agent 正在工作。AgEnD 重新啟動時會停下幾分鐘，之後從原處繼續。",
    nowBodyIdle: "AgEnD 會重新啟動幾分鐘，Agent 之後從原處繼續。", nowGo: "立即更新",
    pickTitle: "要在什麼時候更新？", pickTonight: "今晚", pickMorning: "明天早上", pickThisMorning: "今天早上", pickOther: "其他時間",
    pickHint: "到了那個時間，仍會等 Agent 閒下來才開始。可選未來 7 天內。", pickGo: "排定", pickBad: "請選未來 7 天內的時間。",
    changed: "這個更新剛剛有變動，以下是最新狀態。", running: "已經有一個更新在進行中。",
    failedAnswer: "沒有成功：{0}",
    machine: "這台機器的更新", self: "AgEnD 可以在這裡自行更新。", adminOnly: "這裡需要你來更新：AgEnD 無法自行退回。",
    stop: "這個問題解決前，AgEnD 無法在這裡更新。", notChecked: "尚未檢查", checking: "尚未檢查：AgEnD 啟動時和每天會檢查一次。",
    pauseTitle: "這些時段不更新", pauseHint: "AgEnD 絕不會在這些日子和時段更新（等待中的更新會等時段結束）。",
    pauseAdd: "新增時段", pauseRemove: "移除", from: "從", to: "到", save: "儲存", saved: "已儲存。", saveFailed: "無法儲存：{0}",
    advanced: "進階", pin: "固定在某個版本", pinHint: "固定版本時不會提供任何更新。留空表示不固定。",
    maxWait: "等 Agent 閒下來的上限（小時）", maxWaitHint: "超過之後，卡片會再問你，而不是繼續等（1–168，預設 24）。",
    days: "日,一,二,三,四,五,六",
    c_checkout: "AgEnD 是從原始碼資料夾執行的，不是 npm 會更新的安裝。請用 git 更新。",
    c_other_copy: "npm 會更新的是另一份 AgEnD（{path}），不是正在執行的這份。請改用全域安裝執行 Fleet。",
    c_path_shadow: "PATH 上的另一個 agend（{path}）會被優先執行。請移除它或修正 PATH。",
    c_unreadable: "AgEnD 目前讀不到自己的安裝位置，請稍後再試。",
    c_shared_home: "另一份 AgEnD 使用同一個 home 資料夾。請讓每份各用自己的 home，或移除其中一份。",
    c_unknown_owner: "AgEnD 無法確認是哪一份安裝在執行這個 Fleet。請以服務方式重新啟動後再檢查。",
    c_other_install: "這個使用者底下還有另一份 AgEnD。更新其中一份可能影響另一份。",
    c_not_service: "AgEnD 不是以服務方式執行，更新後無法自己回來。",
    c_linger_off: "{user} 登出時，AgEnD 的服務會跟著停止（systemd 的 lingering 未開啟）。",
    c_system_unit_not_root: "AgEnD 以系統服務執行，更新需要 root。",
    c_unit_reload_pending: "服務定義已變更但尚未重新載入。請執行 systemctl --user daemon-reload。",
    c_no_write: "更新需要 {path} 的寫入權限。請在那台電腦的終端機執行 sudo agend update，或用單行安裝指令重新安裝。",
    c_linked: "這份 AgEnD 是從開發資料夾連結的（{path}），更新會取代這個連結。",
    c_vendored: "這份 AgEnD 位於另一個專案裡（{path}）。",
    c_low_disk: "更新需要 {path} 約 {need} 的可用空間，目前只有 {have}。",
    c_npm_unreachable: "這台機器連不到更新來源（網路或代理伺服器）。",
    c_rehearsal: "這裡正在進行演練或測試，更新會等它結束。",
    c_update_running: "已經有一個更新在進行中。",
    c_container: "AgEnD 在容器裡執行，請更新映像檔。",
    c_windows_runtime: "這台電腦的 AgEnD Runtime 會自行更新。",
    c_node_too_old: "v{0} 需要 Node {needs}，這台機器是 {node}。",
    c_other: "有一項檢查沒有通過（{0}）。",
  },
});
const tc = (key, ...a) => t(`updatecard.${key}`, ...a);

/** A pre-flight check's sentence: its code's words with the detail filled in (never raw error text). */
export function checkSentence(check, version = "") {
  if (!check || !check.code) return "";
  const key = `c_${String(check.code).replace(/-/g, "_")}`;
  let s = t(`updatecard.${key}`, version);
  if (s === `updatecard.${key}`) return tc("c_other", String(check.code));
  const d = check.detail && typeof check.detail === "object" ? check.detail : {};
  return s.replace(/\{(path|user|need|have|node|needs)\}/g, (_, k) => (d[k] !== undefined ? String(d[k]) : "…"));
}
/** The checks that did not pass, in P-order (absent checks are not failures: they were not run). */
export function failedChecks(preflight) {
  const checks = preflight && Array.isArray(preflight.checks) ? preflight.checks : [];
  return checks.filter((c) => c && c.ok === false).sort((a, b) => Number(String(a.id).slice(1)) - Number(String(b.id).slice(1)));
}
/** Whether this machine is a service install (P3 present and passing): the Phase 1 "tries to put it back" sentence is true. */
export function serviceInstall(preflight) {
  const p3 = preflight && Array.isArray(preflight.checks) ? preflight.checks.find((c) => c && c.id === "P3") : null;
  return !!(p3 && p3.ok);
}
/** May the admin press Update here (the server's `pressHere`; no pre-flight yet: as today, yes). */
export function pressHere(info) { return !info || !info.preflight || info.preflight.pressHere !== false; }

/** The card's second sentence (§3.1, Phase 1): only what is true on this machine; none before pre-flight has run. */
export function backSentence(info) {
  const pf = info && info.preflight;
  if (!pf || !Array.isArray(pf.checks) || !pf.checks.some((c) => c && c.id === "P3")) return null;
  return serviceInstall(pf) ? tc("backPhase1", info.current) : tc("noWayBack");
}

const fmtTime = (ms) => { try { return new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return String(ms); } };

/**
 * POST /ui/update/answer. The answer's card replaces the store's; 412 carries a fresh pre-flight; 409 card_changed reads
 * again. `refresh` is app-update.js's, `setInfo` writes the store (passed in: this module never imports app-update.js).
 */
export async function answerCard(body, { refresh, setInfo, getInfo }) {
  const key = `answer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let res = null, out = null;
  try {
    res = await fetch("/ui/update/answer", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
    try { out = await res.json(); } catch { out = null; }
  } catch { res = null; }
  const info = getInfo();
  if (res && res.ok && out && "card" in out) { if (info) setInfo({ ...info, card: out.card }); return { ok: true, card: out.card }; }
  if (res && res.status === 412 && out && out.preflight) {
    if (info) setInfo({ ...info, preflight: out.preflight });
    const first = failedChecks(out.preflight)[0];
    toast(first ? checkSentence(first, info && info.card ? info.card.version : "") : tc("stop"), false);
    return { ok: false, preflight: out.preflight };
  }
  if (res && res.status === 409) toast(out && out.key === "update_running" ? tc("running") : tc("changed"), false);
  else toast(tc("failedAnswer", (out && (out.key || out.error)) || (res ? String(res.status) : "network")), false);
  await refresh();
  return { ok: false };
}

/** Update now: one question naming how many agents work now (the card's waitingFor), then the answer. */
export async function updateNow(info, deps) {
  const busy = info && info.card && Array.isArray(info.card.waitingFor) ? info.card.waitingFor.length : 0;
  const yes = await confirmDialog({ title: tc("nowTitle"), confirmLabel: tc("nowGo"), message: busy ? tc("nowBody", busy) : tc("nowBodyIdle") });
  if (!yes) return { ok: false };
  return answerCard({ action: "now", confirm: "update-agend" }, deps);
}

/** The next whole time at hh:00 local, today if it is still ahead (by 30 min), else tomorrow. */
export function nextAt(hour, now = new Date()) {
  const d = new Date(now); d.setHours(hour, 0, 0, 0);
  if (d.getTime() - now.getTime() < 30 * 60_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}
const WEEK = 7 * 24 * 60 * 60_000;
/** Pick a time: tonight, tomorrow morning, or another time in the next 7 days. Resolves to ms epoch or null. */
let pickResolve = null;
export function pickTimeDialog() { return new Promise((resolve) => { pickResolve = resolve; pickSignal.forEach((f) => f()); }); }
const pickSignal = new Set();
export function PickTimeHost() {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("tonight");
  const [other, setOther] = useState("");
  useEffect(() => { const f = () => { setChoice("tonight"); setOther(""); setOpen(true); }; pickSignal.add(f); return () => pickSignal.delete(f); }, []);
  if (!open) return null;
  const close = (v) => { setOpen(false); const r = pickResolve; pickResolve = null; if (r) r(v); };
  const at = () => choice === "tonight" ? nextAt(22) : choice === "morning" ? nextAt(8) : (other ? new Date(other).getTime() : NaN);
  const go = () => { const v = at(); if (!Number.isFinite(v) || v <= Date.now() || v > Date.now() + WEEK) { toast(tc("pickBad"), false); return; } close(v); };
  const radio = (id, label) => html`<label class="check uc-pick-row"><input type="radio" name="uc-pick" checked=${choice === id} onChange=${() => setChoice(id)} /><span>${label}</span></label>`;
  const min = new Date(Date.now() + 5 * 60_000), max = new Date(Date.now() + WEEK);
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  return html`<${Dialog} title=${tc("pickTitle")} onClose=${() => close(null)}
    actions=${html`<button type="button" class="btn" onClick=${() => close(null)}>${tc("cancel")}</button><button type="button" class="btn btn-primary" onClick=${go}>${tc("pickGo")}</button>`}>
    <div class="uc-pick">
      ${radio("tonight", `${tc("pickTonight")} · ${fmtTime(nextAt(22))}`)}
      ${radio("morning", `${new Date(nextAt(8)).toDateString() === new Date().toDateString() ? tc("pickThisMorning") : tc("pickMorning")} · ${fmtTime(nextAt(8))}`)}
      ${radio("other", tc("pickOther"))}
      ${choice === "other" ? html`<input type="datetime-local" class="input uc-pick-other" min=${local(min)} max=${local(max)} value=${other} onInput=${(e) => setOther(e.currentTarget.value)} />` : null}
      <p class="muted uc-pick-hint">${tc("pickHint")}</p>
    </div>
  </${Dialog}>`;
}
export async function pickTime(deps) {
  const at = await pickTimeDialog();
  if (!at) return { ok: false };
  return answerCard({ action: "pick-time", at }, deps);
}

/**
 * The banner's line for the card (null: nothing to show — not-now, done, no card). `Line` is app-update.js's line
 * component and `busy` its starting flag (passed in). The progress and the failure lines stay app-update.js's own.
 */
export function cardLine(info, { Line, busy, deps }) {
  const c = info && info.card;
  if (!c || !info.admin) return null;
  const press = pressHere(info), fails = failedChecks(info.preflight);
  const btn = (label, onClick, primary = false) => html`<button type="button" class=${`btn btn-sm${primary ? " btn-primary" : ""}`} disabled=${busy} onClick=${onClick}>${label}</button>`;
  const whenIdle = () => { void answerCard({ action: "when-idle" }, deps); };
  const later = () => { void answerCard({ action: "not-now" }, deps); };
  const cancel = () => { void answerCard({ action: "cancel" }, deps); };
  const now = () => { void updateNow(info, deps); };
  const pick = () => { void pickTime(deps); };
  const blocked = !press ? [tc(info.preflight && info.preflight.class === "stop" ? "stop" : "pressOnly"), ...fails.slice(0, 2).map((f) => checkSentence(f, c.version))] : null;
  if (c.state === "offered") {
    const sub = [c.notes || null, tc("continues"), backSentence(info)];
    return html`<${Line} title=${tc("ready", c.version, info.current)} sub=${blocked ? [c.notes || null, ...blocked] : sub}>
      ${press ? html`${btn(tc("whenIdle"), whenIdle, true)}${btn(tc("pickTime"), pick)}` : null}${btn(tc("notNow"), later)}</${Line}>`;
  }
  if (c.state === "waiting-idle") {
    const names = Array.isArray(c.waitingFor) && c.waitingFor.length ? tc("waitingFor", c.waitingFor.join(", ")) : null;
    return html`<${Line} spinner title=${tc("waiting", c.version)} sub=${[names, blocked ? blocked[1] : null]}>
      ${press ? html`${btn(tc("updateNow"), now, true)}${btn(tc("pickTime"), pick)}` : null}${btn(tc("cancel"), cancel)}</${Line}>`;
  }
  if (c.state === "scheduled") {
    return html`<${Line} icon="clock" title=${tc("scheduled", c.version, fmtTime(c.scheduledAt))} sub=${[tc("continues")]}>
      ${press ? btn(tc("updateNow"), now) : null}${btn(tc("cancel"), cancel)}</${Line}>`;
  }
  if (c.state === "updating" && !(info.progress && info.progress.stage)) return html`<${Line} spinner title=${tc("starting", c.version)} />`;
  if (c.state === "cant") return html`<${Line} tone="bad" icon="alert" title=${tc("cantTitle")} sub=${fails.slice(0, 2).map((f) => checkSentence(f, c.version))} />`;
  return null;
}

/** Settings → Version and update: the card's state, the pre-flight result, and the controls (two + Advanced). */
export function UpdateCardSettings({ info, deps }) {
  noteCurrentVersion(info && info.current);
  return html`<div class="uc-settings">
    <${CardStatus} info=${info} deps=${deps} />
    <${MachineLine} info=${info} />
    <${UpdatesControls} />
  </div>`;
}
function CardStatus({ info }) {
  const c = info && info.card;
  if (!c) return null;
  const line = c.state === "not-now" && c.notNowUntil ? tc("notNowUntil", fmtTime(c.notNowUntil))
    : c.state === "scheduled" && c.scheduledAt ? tc("scheduled", c.version, fmtTime(c.scheduledAt))
    : c.state === "waiting-idle" ? [tc("waiting", c.version), Array.isArray(c.waitingFor) && c.waitingFor.length ? tc("waitingFor", c.waitingFor.join(", ")) : ""].filter(Boolean).join(" ")
    : null;
  return line ? html`<p class="uc-status" role="status">${line}</p>` : null;
}
/** "Updates on this machine": ✓ / ◐ / ✗, then each check that did not pass, worded, and the ones not run yet. */
export function MachineLine({ info }) {
  const pf = info && info.preflight;
  if (!pf) return html`<div class="uc-machine"><strong>${tc("machine")}</strong> <span class="muted">${tc("checking")}</span></div>`;
  const cls = pf.class === "self" ? "self" : pf.class === "admin-only" ? "admin-only" : "stop";
  const mark = cls === "self" ? "✓" : cls === "admin-only" ? "◐" : "✗";
  const fails = failedChecks(pf);
  return html`<div class=${`uc-machine uc-${cls}`}>
    <div><strong>${tc("machine")}</strong> <span class="uc-mark" aria-hidden="true">${mark}</span> <span>${tc(cls === "self" ? "self" : cls === "admin-only" ? "adminOnly" : "stop")}</span></div>
    ${fails.length ? html`<ul class="uc-checks">${fails.map((f) => html`<li key=${f.id}>${checkSentence(f, info.card ? info.card.version : "")}</li>`)}</ul>` : null}
  </div>`;
}

/** The running version (the placeholder of the pin): read from GET /ui/update's answer, kept by app-update.js's store. */
let currentVersion = "";
export function noteCurrentVersion(v) { if (typeof v === "string") currentVersion = v; }
const updateCurrentVersion = () => currentVersion;

/** The controls: when not to update (pause windows) and, under Advanced, the pin and the longest wait. PUT /api/settings/fleet/updates. */
export function UpdatesControls() {
  const [cfg, setCfg] = useState(null);
  const [pause, setPause] = useState([]);
  const [pin, setPin] = useState("");
  const [wait, setWait] = useState("24");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/settings/fleet", { cache: "no-store" });
        const body = r.ok ? await r.json() : null;
        const u = body && body.updates && typeof body.updates === "object" ? body.updates : {};
        if (!alive) return;
        setCfg(u); setPause(Array.isArray(u.pause) ? u.pause.map((w) => ({ days: [...(w.days || [])], from: w.from || "09:00", to: w.to || "18:00" })) : []);
        setPin(typeof u.pin === "string" ? u.pin : ""); setWait(String(Number.isInteger(u.maxIdleWait) ? u.maxIdleWait : 24));
      } catch { if (alive) setCfg({}); }
    })();
    return () => { alive = false; };
  }, []);
  if (!cfg) return null;
  const dayNames = tc("days").split(",");
  const save = async (patch) => {
    setBusy(true);
    let res = null, out = null;
    try { res = await fetch("/api/settings/fleet/updates", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }); try { out = await res.json(); } catch { out = null; } } catch { res = null; }
    setBusy(false);
    if (res && res.ok) { toast(tc("saved")); return true; }
    const why = out && Array.isArray(out.problems) && out.problems[0] ? `${out.problems[0].path}: ${out.problems[0].message}` : (out && out.error) || (res ? String(res.status) : "network");
    toast(tc("saveFailed", why), false);
    return false;
  };
  const setRow = (i, next) => setPause((rows) => rows.map((r, j) => (j === i ? { ...r, ...next } : r)));
  const toggleDay = (i, d) => setRow(i, { days: pause[i].days.includes(d) ? pause[i].days.filter((x) => x !== d) : [...pause[i].days, d].sort() });
  return html`<div class="uc-controls">
    <fieldset class="uc-pause"><legend>${tc("pauseTitle")}</legend>
      <p class="muted uc-hint">${tc("pauseHint")}</p>
      ${pause.map((w, i) => html`<div class="uc-pause-row" key=${i}>
        <div class="uc-days" role="group" aria-label=${tc("pauseTitle")}>${dayNames.map((n, d) => html`<label class="check uc-day"><input type="checkbox" checked=${w.days.includes(d)} onChange=${() => toggleDay(i, d)} /><span>${n}</span></label>`)}</div>
        <label class="uc-time">${tc("from")} <input type="time" class="input" value=${w.from} onInput=${(e) => setRow(i, { from: e.currentTarget.value })} /></label>
        <label class="uc-time">${tc("to")} <input type="time" class="input" value=${w.to} onInput=${(e) => setRow(i, { to: e.currentTarget.value })} /></label>
        <button type="button" class="btn btn-sm" onClick=${() => setPause((rows) => rows.filter((_, j) => j !== i))}>${tc("pauseRemove")}</button>
      </div>`)}
      <div class="uc-row-actions">
        <button type="button" class="btn btn-sm" onClick=${() => setPause((rows) => [...rows, { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }])}>${tc("pauseAdd")}</button>
        <button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${() => { void save({ pause }); }}>${tc("save")}</button>
      </div>
    </fieldset>
    <details class="s-ui-disclosure uc-advanced"><summary>${tc("advanced")}</summary><div class="s-disclosure-body">
      <label class="field"><span>${tc("pin")}</span><input class="input" value=${pin} placeholder=${updateCurrentVersion() || ""} onInput=${(e) => setPin(e.currentTarget.value)} /><span class="muted uc-hint">${tc("pinHint")}</span></label>
      <label class="field"><span>${tc("maxWait")}</span><input class="input" type="number" min="1" max="168" step="1" value=${wait} onInput=${(e) => setWait(e.currentTarget.value)} /><span class="muted uc-hint">${tc("maxWaitHint")}</span></label>
      <div class="uc-row-actions"><button type="button" class="btn btn-sm btn-primary" disabled=${busy}
        onClick=${() => { void save({ pin: pin.trim() ? pin.trim() : null, maxIdleWait: Number(wait) }); }}>${tc("save")}</button></div>
    </div></details>
  </div>`;
}

/** Needs you (§3.1: only a failure or "can't update here"): one item from the store, not counted in the server's badge. */
export function UpdateNeedsItem({ info, settingsHref }) {
  const c = info && info.admin ? info.card : null;
  if (!c) return null;
  const fails = failedChecks(info.preflight);
  if (c.state === "failed") return html`<section class="n-group uc-needs"><div class="n-item"><strong>${t("update.failed_" + ((c.failed && c.failed.cause) || "other"))}</strong>
    <p class="muted">${c.failed && c.failed.rolledBack ? t("update.unchanged", info.current) : t("update.afterInstall")}</p>
    <a class="btn btn-sm" href=${settingsHref}>${t("app.settings")}</a></div></section>`;
  if ((c.state === "cant" || (info.preflight && info.preflight.class === "stop")) && c.state !== "not-now") return html`<section class="n-group uc-needs"><div class="n-item"><strong>${tc("cantTitle")}</strong>
    ${fails.slice(0, 3).map((f) => html`<p class="muted">${checkSentence(f, c.version)}</p>`)}
    <a class="btn btn-sm" href=${settingsHref}>${t("app.settings")}</a></div></section>`;
  return null;
}
