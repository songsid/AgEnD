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
import { dateTimeText } from "./clock-text.js";

register("updatecard", {
  en: {
    ready: "AgEnD {0} is ready.",
    continues: "Your work continues.",
    backPhase1: "Your work continues; if the new version won't start, AgEnD tries to roll back to {0}.",
    noWayBack: "Your work continues; this setup can't restart AgEnD by itself, so check on it afterwards.",
    howTo: "How to update", pressOnlyLine: "AgEnD can't update itself on this machine; update it by hand.", sep: ", ", more: " and {0} more",
    whenIdle: "Update when idle", pickTime: "Pick a time", notNow: "Not now", updateNow: "Update now", cancel: "Cancel",
    waiting: "Updating to {0} as soon as your agents are idle.", waitingFor: "Waiting for: {0}", waitingSince: "Waiting since {0}",
    scheduled: "Updating to {0} at {1}, when your agents are idle.", notNowUntil: "You chose Not now. The card comes back on {0}.",
    starting: "Starting the update to {0}…", cantTitle: "AgEnD can't update itself on this machine.",
    nowTitle: "Update now?", nowBody: "{0} agents are working. They stop for a few minutes while AgEnD restarts, then pick up where they were.",
    nowBodyIdle: "AgEnD restarts for a few minutes; your agents pick up where they were.", nowGo: "Update now",
    pickTitle: "When should AgEnD update?", pickTonight: "Tonight", pickMorning: "Tomorrow morning", pickOther: "Another time", pickDay: "Day", pickAt: "Time",
    pickHint: "It still waits until your agents are idle at that time. Within the next 7 days.", pickGo: "Schedule", pickBad: "Pick a time in the next 7 days.",
    changed: "The update changed while you were looking. Here it is again.", running: "An update is already running.",
    failedAnswer: "That didn't work: {0}",
    machine: "Updates on this machine", self: "AgEnD can update itself here.", adminOnly: "Updates here need you:",
    stop: "AgEnD can't update here until this is fixed.", notChecked: "not checked yet", checking: "Not checked yet: it's checked when AgEnD starts and once a day.",
    pauseTitle: "Don't update during", pauseHint: "Days and hours when AgEnD never updates (a waiting update waits for the window to end).",
    pauseAdd: "Add a time", pauseRemove: "Remove", from: "From", to: "To", save: "Save", saved: "Saved.", saveFailed: "Couldn't save: {0}",
    settingsLabel: "When AgEnD updates", pending: "Waiting for confirmation: this lets updates go ahead sooner.", applied: "Confirmed and saved.",
    advanced: "Advanced", pin: "Pin to a version", pinHint: "No update is offered while a version is pinned. Leave empty for none.",
    maxWait: "Longest wait for idle (hours)", maxWaitHint: "After this, AgEnD asks again instead of waiting (1–168, default 24).",
    days: "Sun,Mon,Tue,Wed,Thu,Fri,Sat",
    c_checkout: "AgEnD runs from a source checkout, not from an install npm updates. Update it with git.",
    c_other_copy: "Another copy of AgEnD ({path}) is the one npm would update, not the one running. Run the fleet from the global install.",
    c_path_shadow: "Another agend on the PATH ({path}) would run instead of this one. Remove it or fix the PATH.",
    c_unreadable: "AgEnD can't read where it's installed right now. Try again in a minute.",
    c_shared_home: "Another AgEnD install uses the same home folder. Give each its own home, or remove one.",
    c_unknown_owner: "AgEnD can't prove which install runs this fleet. Restart it as a service and check again.",
    c_other_install: "Another AgEnD install lives under this user. Updating one could affect the other.",
    c_not_service: "AgEnD isn't running as a service, so it can't bring itself back after an update.",
    c_service_unknown: "AgEnD can't confirm that its service will bring it back after an update.",
    notAllChecked: "Some checks haven't run yet; they run when AgEnD starts and once a day.",
    c_linger_off: "AgEnD stops when the {user} account signs out, so it can't restart itself. To fix it, run `sudo loginctl enable-linger {user}`.",
    c_system_unit_not_root: "AgEnD runs as a system service; updating it needs root.",
    c_unit_reload_pending: "The service definition changed and hasn't been reloaded. Run `systemctl --user daemon-reload`.",
    c_no_write: "Updating needs write access to {path}. Run `sudo agend update` in a terminal on the computer AgEnD runs on, or reinstall with the one-line installer.",
    c_linked: "This AgEnD is linked from a development folder ({path}); an update replaces the link.",
    c_vendored: "This AgEnD sits inside another project ({path}).",
    c_low_disk: "Updating needs about {need} free on {path}; there's {have}.",
    c_npm_unreachable: "The update source can't be reached from this machine (network or proxy).",
    c_rehearsal: "A rehearsal or test is running here; updates wait until it ends.",
    c_update_running: "An update is already running.",
    c_container: "AgEnD runs in a container; update the image.",
    c_windows_runtime: "This computer's AgEnD Runtime updates itself.",
    c_node_too_old: "AgEnD {0} needs Node {needs}; this machine has {node}.",
    c_other: "A check didn't pass ({0}).",
    fixIt: "Keep AgEnD running after sign-out", fixing: "Turning it on…", fixedLinger: "Done: AgEnD keeps running after the {0} account signs out.",
    fixHint: "AgEnD turns it on for you; nothing restarts and your agents keep working. If this computer doesn't allow it, run the command yourself.",
    fixFailed: "AgEnD couldn't turn it on by itself. Run the command above in a terminal on the computer AgEnD runs on.", fixNotNeeded: "That's already fixed.",
    howToFix: "How to fix", serviceHow: "In a terminal on the computer AgEnD runs on, run `agend install` as the same user (no sudo). AgEnD restarts as a service: every agent stops briefly and comes back on its own.",
    serviceIt: "Install as a service", serviceBusy: "Installing…", serviceTitle: "Install AgEnD as a service?",
    serviceAsk: "AgEnD restarts as a service: every agent stops briefly and comes back on its own.\n\nAfter that, AgEnD can bring itself back after an update. To go back, run agend uninstall.",
    serviceGo: "Install and restart", serviceRestarting: "AgEnD is installing the service and restarting. This page reconnects when it's back.",
    serviceBack: "AgEnD is back, running as a service.",
    "serviceFailed_user-manager": "AgEnD couldn't install the service: this computer's user service manager can't be reached. AgEnD keeps running as before.",
    serviceFailed_other: "AgEnD couldn't install the service. AgEnD keeps running as before.",
    serviceDetails: "Details: `{0}`",
    "serviceNext_user-manager": "On WSL this is a known issue before version 2.6.0: run `wsl --update` in Windows, then reopen WSL. Then press Check for updates; the button comes back once the check finds the service manager.",
    serviceNext_other: "What happened is in service-install.log in the AgEnD folder. Press Check for updates to try again.",
    servicePending: "AgEnD is still setting up the service. Check again in a minute: once it has gone through, this line turns ✓.",
    serviceStill: "AgEnD isn't running as a service yet. What happened is in service-install.log in the AgEnD folder.",
  },
  "zh-TW": {
    ready: "AgEnD {0} 可以更新了。",
    continues: "工作不會中斷。",
    backPhase1: "工作不會中斷；新版起不來時，AgEnD 會嘗試退回 {0}。",
    noWayBack: "工作不會中斷；這台機器無法自行重新啟動 AgEnD，更新後請確認一下。",
    howTo: "如何更新", pressOnlyLine: "這台機器上 AgEnD 無法自行更新，請手動更新。", sep: "、", more: "，另有 {0} 個",
    whenIdle: "閒置時更新", pickTime: "選個時間", notNow: "先不要", updateNow: "立即更新", cancel: "取消",
    waiting: "Agent 一閒置就更新到 {0}。", waitingFor: "正在等：{0}", waitingSince: "從 {0} 開始等",
    scheduled: "排定在 {1}，等 Agent 閒置後更新到 {0}。", notNowUntil: "你選了「先不要」，{0} 會再提醒。",
    starting: "正在開始更新到 {0}…", cantTitle: "AgEnD 無法在這台機器上自行更新。",
    nowTitle: "立即更新？", nowBody: "有 {0} 個 Agent 正在工作。AgEnD 重新啟動時會停下幾分鐘，之後從原處繼續。",
    nowBodyIdle: "AgEnD 會重新啟動幾分鐘，Agent 之後從原處繼續。", nowGo: "立即更新",
    pickTitle: "要在什麼時候更新？", pickTonight: "今晚", pickMorning: "明天早上", pickOther: "其他時間", pickDay: "日期", pickAt: "時間",
    pickHint: "到了那個時間，仍會等 Agent 閒置才開始。可排定在未來 7 天內。", pickGo: "排定", pickBad: "請選擇未來 7 天內的時間。",
    changed: "這個更新剛剛有變動，以下是最新狀態。", running: "已經有一個更新在進行中。",
    failedAnswer: "沒有成功：{0}",
    machine: "這台機器的更新", self: "AgEnD 可以在這裡自行更新。", adminOnly: "這裡的更新需要你來進行：",
    stop: "這個問題解決前，AgEnD 無法在這裡更新。", notChecked: "尚未檢查", checking: "尚未檢查：AgEnD 啟動時和每天會檢查一次。",
    pauseTitle: "這些時段不更新", pauseHint: "AgEnD 絕不會在這些日子和時段更新（等待中的更新會等時段結束）。",
    pauseAdd: "新增時段", pauseRemove: "移除", from: "從", to: "到", save: "儲存", saved: "已儲存。", saveFailed: "無法儲存：{0}",
    settingsLabel: "AgEnD 何時更新", pending: "等待確認中：這項變更會讓更新提早進行。", applied: "已確認並儲存。",
    advanced: "進階", pin: "固定在某個版本", pinHint: "固定版本時不會提供任何更新。留空表示不固定。",
    maxWait: "等 Agent 閒下來的上限（小時）", maxWaitHint: "超過之後，AgEnD 會再問你，而不是繼續等（1–168，預設 24）。",
    days: "日,一,二,三,四,五,六",
    c_checkout: "AgEnD 是從原始碼資料夾執行的，不是 npm 會更新的安裝。請用 git 更新。",
    c_other_copy: "npm 會更新的是另一份 AgEnD（{path}），不是正在執行的這份。請改用全域安裝執行 Fleet。",
    c_path_shadow: "PATH 上的另一個 agend（{path}）會被優先執行。請移除它或修正 PATH。",
    c_unreadable: "AgEnD 目前讀不到自己的安裝位置，請稍後再試。",
    c_shared_home: "另一份 AgEnD 使用同一個 home 資料夾。請讓每份各用自己的 home，或移除其中一份。",
    c_unknown_owner: "AgEnD 無法確認是哪一份安裝在執行這個 Fleet。請以服務方式重新啟動後再檢查。",
    c_other_install: "這個使用者底下還有另一份 AgEnD。更新其中一份可能影響另一份。",
    c_not_service: "AgEnD 不是以服務方式執行，更新後無法自己回來。",
    c_service_unknown: "AgEnD 無法確認它的服務在更新後會讓它重新啟動。",
    notAllChecked: "有些檢查還沒跑完；AgEnD 啟動時和每天會檢查一次。",
    c_linger_off: "{user} 這個帳號登出後 AgEnD 會停止，所以無法自行重新啟動。修正方式：執行 `sudo loginctl enable-linger {user}`。",
    c_system_unit_not_root: "AgEnD 以系統服務執行，更新需要 root。",
    c_unit_reload_pending: "服務定義已變更但尚未重新載入。請執行 `systemctl --user daemon-reload`。",
    c_no_write: "更新需要 {path} 的寫入權限。請在執行 AgEnD 的那台電腦上，用終端機執行 `sudo agend update`，或用單行安裝指令重新安裝。",
    c_linked: "這份 AgEnD 是從開發資料夾連結的（{path}），更新會取代這個連結。",
    c_vendored: "這份 AgEnD 位於另一個專案裡（{path}）。",
    c_low_disk: "更新需要 {path} 約 {need} 的可用空間，目前只有 {have}。",
    c_npm_unreachable: "這台機器連不到更新來源（網路或 Proxy 設定）。",
    c_rehearsal: "這裡正在進行演練或測試，更新會等它結束。",
    c_update_running: "已經有一個更新在進行中。",
    c_container: "AgEnD 在容器裡執行，請更新映像檔。",
    c_windows_runtime: "這台電腦的 AgEnD Runtime 會自行更新。",
    c_node_too_old: "AgEnD {0} 需要 Node {needs}，這台機器是 {node}。",
    c_other: "有一項檢查沒有通過（{0}）。",
    fixIt: "登出後讓 AgEnD 繼續執行", fixing: "開啟中…", fixedLinger: "完成：{0} 這個帳號登出後，AgEnD 仍會繼續執行。",
    fixHint: "AgEnD 會替你開啟；不會重新啟動，Agent 照常工作。若這台電腦不允許，請自己執行上面的指令。",
    fixFailed: "AgEnD 無法自行開啟。請在執行 AgEnD 的那台電腦上，用終端機執行上面的指令。", fixNotNeeded: "這項已經修正了。",
    howToFix: "修正方式", serviceHow: "在執行 AgEnD 的那台電腦上，用同一個使用者在終端機執行 `agend install`（不需要 sudo）。AgEnD 會改以服務方式重新啟動：每個 Agent 會短暫停止，之後自動回來。",
    serviceIt: "安裝成服務", serviceBusy: "安裝中…", serviceTitle: "要把 AgEnD 安裝成服務嗎？",
    serviceAsk: "AgEnD 會改以服務方式重新啟動：每個 Agent 會短暫停止，之後自動回來。\n\n之後每次更新完，AgEnD 都能自己重新啟動。要改回來，執行 agend uninstall。",
    serviceGo: "安裝並重新啟動", serviceRestarting: "AgEnD 正在安裝服務並重新啟動，回來後這個頁面會自動重新連線。",
    serviceBack: "AgEnD 回來了，現在以服務方式執行。",
    "serviceFailed_user-manager": "AgEnD 無法安裝服務：這台電腦的使用者服務管理員無法連線。AgEnD 仍照原本的方式執行。",
    serviceFailed_other: "AgEnD 無法安裝服務。AgEnD 仍照原本的方式執行。",
    serviceDetails: "詳細訊息：`{0}`",
    "serviceNext_user-manager": "在 WSL 上，這是 2.6.0 以前版本的已知問題：在 Windows 執行 `wsl --update`，再重新開啟 WSL。之後按「檢查更新」，檢查找到服務管理員後，按鈕就會回來。",
    serviceNext_other: "詳細情形記錄在 AgEnD 資料夾的 service-install.log。按「檢查更新」可以再試一次。",
    servicePending: "AgEnD 還在設定服務。過一分鐘再檢查一次：完成後，這一行會變成 ✓。",
    serviceStill: "AgEnD 還不是以服務方式執行。詳細情形記錄在 AgEnD 資料夾的 service-install.log。",
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
  return s.replace(/\{(path|user|need|have|node|needs)\}/g, (_, k) => (d[k] !== undefined ? String(d[k]).replace(/`/g, "'") : "…"));
}
/** A check's sentence as plain text (a toast): the command marks dropped. */
export function checkText(check, version = "") { return checkSentence(check, version).replace(/`/g, ""); }
/** A check's sentence for the page: a `command` in it is shown as copyable code (#4487 UX look). */
export function checkRich(check, version = "") { return richText(checkSentence(check, version)); }
const richText = (text) => String(text).split("`").map((part, i) => (i % 2 ? html`<code class="uc-cmd">${part}</code>` : part));

/**
 * M-3770 1.6: the fix a failing check offers here (the server's update-fix.ts `fixFor`): lingering off → "linger";
 * not a service → "service" (S-246: AgEnD restarts as a service, after the admin confirms).
 */
export function fixFor(check) {
  if (!check || check.ok !== false || check.id !== "P3") return null;
  return check.code === "linger-off" ? "linger" : check.code === "not-service" ? "service" : null;
}
/** The body's `confirm` for "service" (update-fix.ts SERVICE_FIX_CONFIRM). */
const SERVICE_CONFIRM = "restart-as-service";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stillNotService = (info) => failedChecks(info && info.preflight).some((c) => c.code === "not-service");
/**
 * S-246: the hand-over has begun. Wait for AgEnD to answer again after it was gone (every 3 s, up to 6 minutes), then
 * have it look again and say whether it is a service now. A fleet that never went away is judged at the end.
 */
export async function waitForService(deps, { sleep = pause, tries = 120 } = {}) {
  let gone = false;
  for (let i = 0; i < tries; i++) {
    await sleep(3000);
    let r = null;
    try { r = await fetch("/ui/update", { cache: "no-store" }); } catch { r = null; }
    if (!r || !r.ok) { gone = true; continue; }
    if (gone) break;
  }
  try { await fetch("/ui/update/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch { /* judged on what it has */ }
  const info = (await deps.refresh()) || deps.getInfo();
  const still = !info || stillNotService(info);
  // Back as a service: the check's line is gone, so a toast says so. Still not one: the check's own block says where to look.
  if (!still) toast(tc("serviceBack"), true, { detail: true });
  return { service: !still };
}
/**
 * POST /ui/update/fixes: the server runs its pre-flight again, makes the fix if it is still asked for, and answers with the
 * fresh pre-flight (which replaces the store's, so the line and its button go once the check passes).
 */
export async function fixCheck(fix, check, deps, opts = {}) {
  const { refresh, setInfo, getInfo } = deps;
  const key = `fix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let res = null, out = null;
  try {
    const body = fix === "service" ? { fix, confirm: SERVICE_CONFIRM } : { fix };
    res = await fetch("/ui/update/fixes", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
    try { out = await res.json(); } catch { out = null; }
  } catch { res = null; }
  const info = getInfo();
  if (out && out.preflight && info) setInfo({ ...info, preflight: out.preflight });
  if (fix === "service") {
    // 202: the hand-over began. No answer at all: AgEnD stopped before it could answer — the same.
    // Said in the check's own block, never a toast over the page (#4557 look): restarting, refused, or still not a service.
    const say = typeof opts.onStatus === "function" ? opts.onStatus : () => {};
    // Still running after the server's wait: nothing may have stopped yet, and it can still refuse (#4564 review).
    if (res && res.status === 202 && out && out.pending) { say(tc("servicePending")); return { ok: false, refused: true }; }
    if (!res || res.status === 202) {
      say(tc("serviceRestarting"));
      // The card's other buttons are off while AgEnD goes away and comes back (#4564 look); an older app-update.js has no setter.
      const starting = typeof deps.setStarting === "function" ? deps.setStarting : () => {};
      starting(true);
      let service = false;
      try { ({ service } = await waitForService(deps, opts)); } finally { starting(false); }
      if (!service) say(tc("serviceStill"));
      return { ok: service, refused: !service };
    }
    if (res.status === 422) {
      // The cause in the product's words, the command's own words after it as a detail, then the next step (#4564 look).
      const cause = out && out.cause === "user-manager" ? "user-manager" : "other";
      const raw = String((out && out.reason) || "").replace(/`/g, "").trim();
      const failed = tc(`serviceFailed_${cause}`), sep = /[。！？]$/.test(failed) ? "" : " ";   // no space after a zh full stop
      say([`${failed}${raw ? `${sep}${tc("serviceDetails", raw)}` : ""}`, tc(`serviceNext_${cause}`)]);
      return { ok: false, refused: true };
    }
    if (res.ok) { const { service } = await waitForService(deps, { ...opts, tries: 0 }); if (!service) say(tc("serviceStill")); return { ok: service, refused: !service }; }
  }
  const user = check && check.detail && check.detail.user ? String(check.detail.user) : "";
  // Shown in full (a phone's toast is otherwise one line, cut): it names the user, and the failure says what to do.
  if (res && res.ok) toast(tc("fixedLinger", user), true, { detail: true });
  else if (res && res.status === 409 && out && out.error === "not_needed") toast(tc("fixNotNeeded"));
  else if (res && res.status === 422) { /* no toast: the check's own block says so and drops the button (#4557 UX look) */ }
  else { toast(tc("failedAnswer", (out && out.error) || (res ? String(res.status) : "network")), false); await refresh(); }
  return { ok: !!(res && res.ok), refused: !!(res && res.status === 422) };
}
/**
 * One check that did not pass: its sentence, and its fix — a button where AgEnD can make it (lingering: with a line saying
 * what it does; once the host refused it, the button goes and one line says to run the command), and for not a service
 * also how by hand.
 */
function CheckItem({ check, version, deps, checkedAt = null }) {
  const [busy, setBusy] = useState(false);
  // What a press left behind (refused / still working), kept for the check it answered: a later check (Check for updates)
  // has a newer `checkedAt`, so the button comes back then (#4564 look).
  const [mark, setMark] = useState(null);
  const [note, setNote] = useState([]);
  const fix = deps ? fixFor(check) : null;
  const press = async () => {
    // S-246: every agent stops briefly — asked first; Cancel sends nothing.
    if (fix === "service" && !(await confirmDialog({ title: tc("serviceTitle"), message: tc("serviceAsk"), confirmLabel: tc("serviceGo") }))) return;
    setBusy(true); setNote([]); setMark(null);
    try {
      const r = await fixCheck(fix, check, deps, { onStatus: (t) => setNote(Array.isArray(t) ? t : [t]) });
      const info = deps.getInfo && deps.getInfo();
      if (r.refused) setMark({ at: info && info.preflight ? info.preflight.checkedAt : checkedAt });
    } finally { setBusy(false); }
  };
  const refused = !!mark && mark.at === checkedAt;
  const lines = busy ? note : refused ? (note.length ? note : fix === "linger" ? [tc("fixFailed")] : []) : [];
  const label = fix === "service" ? tc(busy ? "serviceBusy" : "serviceIt") : tc(busy ? "fixing" : "fixIt");
  return html`<li>${checkRich(check, version)}
    ${fix && lines.length ? lines.map((l, i) => html`<p class=${i ? "uc-fix-next" : "uc-fix-refused"} role=${i ? undefined : "status"}>${richText(l)}</p>`) : null}
    ${fix && !refused ? html`<div class="uc-fix"><button type="button" class="btn btn-sm" disabled=${busy} onClick=${press}>${label}</button>
      ${fix === "linger" ? html`<span class="uc-fix-hint muted">${tc("fixHint")}</span>` : null}</div>` : null}
    ${check.code === "not-service" && !(fix === "service" && refused) ? html`<details class="uc-how"><summary>${tc("howToFix")}</summary><p>${richText(tc("serviceHow"))}</p></details>` : null}
  </li>`;
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
  if (!pf || !Array.isArray(pf.checks) || !pf.checks.some((c) => c && c.id === "P3")) return tc("continues");
  return serviceInstall(pf) ? tc("backPhase1", info.current) : tc("noWayBack");
}
/** The busy agents, capped (the leader's copy pass): "A, B and 3 more" / 「A、B，另有 3 個」 (#4487 UX look). */
export function namesShown(names, max = 2) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  return list.length <= max ? list.join(tc("sep")) : `${list.slice(0, max).join(tc("sep"))}${tc("more", list.length - max)}`;
}

// M-3730: through the shared clock helper (24-hour in zh-TW); English is 24-hour here too, as the leader asked for this card.
const fmtTime = (ms) => dateTimeText(ms, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtDay = (ms) => dateTimeText(ms, { weekday: "short", month: "short", day: "numeric" }).replace(/\s*\d{1,2}:\d{2}(:\d{2})?$/, "");
/** "HH:MM" every `step` minutes of a day: the 24-hour choices (never the browser's own time input, which shows AM/PM). */
export function dayTimes(step = 15) { const out = []; for (let m = 0; m < 24 * 60; m += step) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`); return out; }

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
    toast(first ? checkText(first, info && info.card ? info.card.version : "") : tc("stop"), false);
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
/** hh:00 tomorrow (never a morning that has already begun or passed). */
export function tomorrowAt(hour, now = new Date()) { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(hour, 0, 0, 0); return d.getTime(); }
const WEEK = 7 * 24 * 60 * 60_000;
/** Pick a time: tonight, tomorrow morning, or another time in the next 7 days. Resolves to ms epoch or null. */
let pickResolve = null;
export function pickTimeDialog() { return new Promise((resolve) => { pickResolve = resolve; pickSignal.forEach((f) => f()); }); }
const pickSignal = new Set();
export function PickTimeHost() {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("tonight");
  const [day, setDay] = useState(0);
  const [time, setTime] = useState("20:00");
  useEffect(() => { const f = () => { setChoice("tonight"); setDay(0); setTime("20:00"); setOpen(true); }; pickSignal.add(f); return () => pickSignal.delete(f); }, []);
  if (!open) return null;
  const close = (v) => { setOpen(false); const r = pickResolve; pickResolve = null; if (r) r(v); };
  const otherAt = () => { const d = new Date(); d.setDate(d.getDate() + day); const [h, m] = time.split(":").map(Number); d.setHours(h, m, 0, 0); return d.getTime(); };
  const at = () => choice === "tonight" ? nextAt(22) : choice === "morning" ? tomorrowAt(8) : otherAt();
  const go = () => { const v = at(); if (!Number.isFinite(v) || v <= Date.now() || v > Date.now() + WEEK) { toast(tc("pickBad"), false); return; } close(v); };
  const radio = (id, label) => html`<label class="check uc-pick-row"><input type="radio" name="uc-pick" checked=${choice === id} onChange=${() => setChoice(id)} /><span>${label}</span></label>`;
  const days = Array.from({ length: 8 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return { i, label: fmtDay(d.getTime()) }; });
  return html`<${Dialog} title=${tc("pickTitle")} onClose=${() => close(null)}
    actions=${html`<button type="button" class="btn" onClick=${() => close(null)}>${tc("cancel")}</button><button type="button" class="btn btn-primary" onClick=${go}>${tc("pickGo")}</button>`}>
    <div class="uc-pick">
      ${radio("tonight", `${tc("pickTonight")} · ${fmtTime(nextAt(22))}`)}
      ${radio("morning", `${tc("pickMorning")} · ${fmtTime(tomorrowAt(8))}`)}
      ${radio("other", tc("pickOther"))}
      ${choice === "other" ? html`<div class="uc-pick-frame">
        <label class="uc-pick-field"><span>${tc("pickDay")}</span><select class="input uc-pick-day" value=${String(day)} onChange=${(e) => setDay(Number(e.currentTarget.value))}>
          ${days.map((d) => html`<option value=${String(d.i)}>${d.label}</option>`)}</select></label>
        <label class="uc-pick-field"><span>${tc("pickAt")}</span><select class="input uc-pick-time" value=${time} onChange=${(e) => setTime(e.currentTarget.value)}>
          ${dayTimes(15).map((x) => html`<option value=${x}>${x}</option>`)}</select></label>
      </div>` : null}
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
/** Whether Pick a time is offered: the server takes a schedule only on a machine whose pre-flight says it can update itself
 *  (class self; no result yet: as today, yes) — an admin-only machine updates on a press only (#4487 review P2). */
export function canSchedule(info) {
  const pf = info && info.preflight;
  return pressHere(info) && (!pf || pf.class === "self");
}
/** One action policy for the banner and Settings (#4487 review P2): what an admin can do with the card in its state, on
 *  this machine. Update now is never the filled button once the admin has chosen to wait (#4487 UX look). */
export function cardActions(info, deps) {
  const c = info && info.card;
  if (!c || !info.admin) return [];
  const press = pressHere(info), sched = canSchedule(info);
  const act = (key, label, run, primary = false) => ({ key, label, primary, run });
  const whenIdle = act("when-idle", tc("whenIdle"), () => answerCard({ action: "when-idle" }, deps), true);
  const pick = act("pick-time", tc("pickTime"), () => pickTime(deps));
  const later = act("not-now", tc("notNow"), () => answerCard({ action: "not-now" }, deps));
  const cancel = act("cancel", tc("cancel"), () => answerCard({ action: "cancel" }, deps));
  const now = act("now", tc("updateNow"), () => updateNow(info, deps));
  if (c.state === "offered") return [press && whenIdle, sched && pick, later].filter(Boolean);
  if (c.state === "not-now") return [press && whenIdle, sched && pick].filter(Boolean);
  if (c.state === "waiting-idle") return [press && now, sched && pick, cancel].filter(Boolean);
  if (c.state === "scheduled") return [press && now, cancel].filter(Boolean);
  return [];
}
export function cardLine(info, { Line, busy, deps }) {
  const c = info && info.card;
  if (!c || !info.admin) return null;
  const press = pressHere(info), fails = failedChecks(info.preflight);
  // "Can't update here" (class stop): one line, in one place — Needs you (the leader's copy pass), not the banner too.
  if (info.preflight && info.preflight.class === "stop" && (c.state === "offered" || c.state === "cant")) return null;
  const buttons = cardActions(info, deps).map((a) => html`<button type="button" key=${a.key} class=${`btn btn-sm${a.primary ? " btn-primary" : ""}`} disabled=${busy} onClick=${() => { void a.run(); }}>${a.label}</button>`);
  const how = fails.length ? html`<details class="uc-how"><summary>${tc("howTo")}</summary>${fails.map((f) => html`<p>${checkRich(f, c.version)}</p>`)}</details>` : null;
  if (c.state === "offered") {
    const sub = press ? [backSentence(info)] : [tc("pressOnlyLine"), how];
    return html`<${Line} title=${tc("ready", c.version)} sub=${sub}>${buttons}</${Line}>`;
  }
  if (c.state === "waiting-idle") {
    const names = Array.isArray(c.waitingFor) && c.waitingFor.length ? tc("waitingFor", namesShown(c.waitingFor)) : null;
    return html`<${Line} spinner title=${tc("waiting", c.version)} sub=${[names]}>${buttons}</${Line}>`;
  }
  if (c.state === "scheduled") return html`<${Line} icon="clock" title=${tc("scheduled", c.version, fmtTime(c.scheduledAt))}>${buttons}</${Line}>`;
  if (c.state === "updating" && !(info.progress && info.progress.stage)) return html`<${Line} spinner title=${tc("starting", c.version)} />`;
  return null;
}

/** Settings → Version and update: the card's state, the pre-flight result, and the controls (two + Advanced). */
export function UpdateCardSettings({ info, deps }) {
  noteCurrentVersion(info && info.current);
  return html`<div class="uc-settings">
    <${CardStatus} info=${info} deps=${deps} />
    <${MachineLine} info=${info} deps=${deps} />
    <${UpdatesControls} />
  </div>`;
}
function CardStatus({ info }) {
  const c = info && info.card;
  if (!c) return null;
  const line = c.state === "not-now" && c.notNowUntil ? tc("notNowUntil", fmtTime(c.notNowUntil))
    : c.state === "scheduled" && c.scheduledAt ? tc("scheduled", c.version, fmtTime(c.scheduledAt))
    : c.state === "waiting-idle" ? [tc("waiting", c.version), Array.isArray(c.waitingFor) && c.waitingFor.length ? tc("waitingFor", namesShown(c.waitingFor)) : ""].filter(Boolean).join(" ")
    : null;
  return line ? html`<p class="uc-status" role="status">${line}</p>` : null;
}
/** "Updates on this machine": ✓ / ◐ / ✗, then each check that did not pass, worded, and the ones not run yet. */
export function MachineLine({ info, deps }) {
  const pf = info && info.preflight;
  if (!pf) return html`<div class="uc-machine"><strong>${tc("machine")}</strong> <span class="muted">${tc("checking")}</span></div>`;
  const cls = pf.class === "self" ? "self" : pf.class === "admin-only" ? "admin-only" : "stop";
  const mark = cls === "self" ? "✓" : cls === "admin-only" ? "◐" : "✗";
  const fails = failedChecks(pf);
  return html`<div class=${`uc-machine uc-${cls}`}>
    <div><strong>${tc("machine")}</strong> <span class="uc-mark" aria-hidden="true">${mark}</span> <span>${tc(cls === "self" ? "self" : cls === "admin-only" ? "adminOnly" : "stop")}</span></div>
    ${fails.length ? html`<ul class="uc-checks">${fails.map((f) => html`<${CheckItem} key=${f.id} check=${f} version=${info.card ? info.card.version : ""} deps=${deps} checkedAt=${pf.checkedAt} />`)}</ul>`
      : cls !== "self" ? html`<p class="muted uc-checks">${tc("notAllChecked")}</p>` : null}
  </div>`;
}

/** The running version (the placeholder of the pin): read from GET /ui/update's answer, kept by app-update.js's store. */
let currentVersion = "";
export function noteCurrentVersion(v) { if (typeof v === "string") currentVersion = v; }
const updateCurrentVersion = () => currentVersion;

/** Half-hour choices, plus a saved value that isn't on the half hour (written by hand in fleet.yaml) so it is kept. */
const timeChoices = (current) => { const all = dayTimes(30); return current && !all.includes(current) ? [...all, current].sort() : all; };

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
  // #4487 review P1: a held settings change. What only holds updates back applies at once ("Saved."); what lets an update go
  // ahead sooner waits for a confirmation (the pending card), and says so — never "Saved." before it is applied.
  const save = async (patch) => {
    setBusy(true);
    let r = null, waiting = false;
    try {
      // Settings' own module, loaded here only (the banner, on every page, never needs it).
      const { confirmedWrite } = await import("/ui/js/settings-confirm.js");
      r = await confirmedWrite("/api/settings/fleet/updates", { method: "PUT", body: patch, label: tc("settingsLabel"), resendable: true,
        onPending: () => { waiting = true; setBusy(false); toast(tc("pending")); } });
    } catch { r = null; }
    setBusy(false);
    if (r && r.ok) { toast(tc(waiting ? "applied" : "saved")); return true; }
    const out = r && r.body;
    const why = out && Array.isArray(out.problems) && out.problems[0] ? `${out.problems[0].path}: ${out.problems[0].message}` : (out && out.error) || (r ? String(r.status) : "network");
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
        <label class="uc-time">${tc("from")} <select class="input" value=${w.from} onChange=${(e) => setRow(i, { from: e.currentTarget.value })}>${timeChoices(w.from).map((x) => html`<option value=${x}>${x}</option>`)}</select></label>
        <label class="uc-time">${tc("to")} <select class="input" value=${w.to} onChange=${(e) => setRow(i, { to: e.currentTarget.value })}>${timeChoices(w.to).map((x) => html`<option value=${x}>${x}</option>`)}</select></label>
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
/** #4487 review P2: the one update item Needs you shows, counts and weighs for its empty state — "failed", "cant" (can't
 *  update here: the card says so, or the pre-flight is class stop; never while Not now), or null. */
export function updateAttention(info) {
  const c = info && info.admin ? info.card : null;
  if (!c) return null;
  if (c.state === "failed") return "failed";
  if ((c.state === "cant" || (info.preflight && info.preflight.class === "stop")) && c.state !== "not-now") return "cant";
  return null;
}
export function UpdateNeedsItem({ info, settingsHref }) {
  const kind = updateAttention(info);
  if (!kind) return null;
  const c = info.card, fails = failedChecks(info.preflight);
  if (kind === "failed") return html`<section class="n-group uc-needs"><div class="n-item"><strong>${t("update.failed_" + ((c.failed && c.failed.cause) || "other"))}</strong>
    <p class="muted">${c.failed && c.failed.rolledBack ? t("update.unchanged", info.current) : t("update.afterInstall")}</p>
    <a class="btn btn-sm" href=${settingsHref}>${t("app.settings")}</a></div></section>`;
  // Can't update here: the reason itself is the one line (the leader's copy pass), with the way to Settings.
  const first = fails[0];
  return html`<section class="n-group uc-needs"><div class="n-item"><strong>${first ? checkRich(first, c.version) : tc("cantTitle")}</strong>
    <a class="btn btn-sm" href=${settingsHref}>${t("app.settings")}</a></div></section>`;
}
