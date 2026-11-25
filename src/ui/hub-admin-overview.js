// M-3162 (Lumen's approved mockup, docs/evidence/hub-admin-dashboard on docs/hub-ux-review-m2902; API M-3161,
// docs/design/hub-admin-dashboard-api.md): Administration → Overview — how the Hub is being used, in counts only.
// People, Questions (per day, answer time, not answered, the most-asked agents), Fleets and Rooms, for Today or 7 days in
// this browser's own time zone, read again every minute. Never what anyone asked or answered, never counted by person;
// the line under the range says so. No token or cost figures. A Hub nobody has joined yet shows one line and "Let
// colleagues join" instead of a page of zeros (the Fleets still show: a Fleet may be paired before anyone uses the Hub).
// A module of its own with its own words (upgrade skew: a tab holding an older dictionary still has every word).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t, lang } from "/assets/app-i18n.js";
import { ErrorState, Skeleton } from "/assets/ui-states.js";
import { timeText } from "/assets/clock-text.js";

register("hubOverview", {
  en: {
    today: "Today", week: "7 days", rangeLabel: "Period",
    updated: "Updated {0} · refreshes every minute",
    privacy: "Counts only. This page never shows what anyone asked or what an agent answered, and never counts by person.",
    hPeople: "People", hAsk: "Questions", hFleet: "Fleets", hRoom: "Rooms",
    pToday: "Active today", pTodaySub: "of {0} people who have joined", pWeek: "Active in 7 days", pWeekSub: "{0} have not signed in this week",
    pWeekAll: "everyone who has joined", pJoin: "Joined this week", pJoinSub: "{0} in total", pNow: "Signed in now", pNowSub: "active in the last 5 minutes",
    qPerDay: "Questions per day", qRange_today: "today", qRange_7d: "7 days", qHint: "Each agent asked counts once.", qToday: "Today",
    aTime: "Answer time", aMed: "Typical (median)", aSlow: "Slowest 1 in 10", aWait: "Waiting now", aWaitOld: "Longest wait now",
    notEnough: "Not enough answers yet", none: "—",
    fTitle: "Not answered", fRate: "{0}% of questions", fOff: "The agent's Fleet was offline", fTime: "No answer in time",
    fPerm: "Permission ended first", fBusy: "Agent stopped or refused", fUnknown: "Other or unknown",
    topTitle: "Most-asked agents", topAgent: "Agent", topAsk: "Questions", topMed: "Typical answer", topFail: "Not answered",
    topNone: "No agent has been asked anything in this period.", topShared: "{0} shared agents in all.",
    flOn: "Connected now", flOnSub: "of {0} Fleets", flBehind: "Need an update", flBehindSub: "below the recommended v{0}",
    flBehindNoRec: "no recommended version set", flOld: "Too old for rooms", flOldSub: "their agents cannot answer in rooms",
    flUnk: "Version unknown", flUnkSub: "too old to report a version", flLink: "See Connected Fleets",
    rmPosts: "Messages", rmP: "People", rmA: "Agents", rmH: "Room assistant", rmActive: "Active rooms", rmActiveSub: "of {0} rooms · {1} created this week",
    rmAsk: "Agent questions in rooms", rmAskSub: "@mentions that asked an agent", rmAuto: "Agent-to-agent chains stopped", rmAutoSub: "hit the depth or rate limit",
    rmNote: "Counts across all rooms. Room names and members are not listed here: an administrator is not a member of every room.",
    emptyLine: "Nobody has joined yet. Let colleagues join to see activity here.", emptyButton: "Let colleagues join",
    sec: "{0} s", min: "{0} min", hour: "{0} h",
  },
  "zh-TW": {
    today: "今天", week: "7 天", rangeLabel: "期間",
    updated: "更新於 {0} · 每分鐘更新一次",
    privacy: "這裡只有數字。不會顯示任何人問了什麼、Agent 答了什麼，也不會按人統計。",
    hPeople: "使用的人", hAsk: "提問", hFleet: "Fleet", hRoom: "房間",
    pToday: "今天使用", pTodaySub: "已加入的 {0} 人當中", pWeek: "7 天內使用", pWeekSub: "有 {0} 人這週沒有登入",
    pWeekAll: "已加入的人都有使用", pJoin: "這週加入", pJoinSub: "總共 {0} 人", pNow: "目前登入中", pNowSub: "最近 5 分鐘內有操作",
    qPerDay: "每天的提問數", qRange_today: "今天", qRange_7d: "7 天", qHint: "每問一個 Agent 算一次。", qToday: "今天",
    aTime: "回答時間", aMed: "一般（中位數）", aSlow: "最慢的十分之一", aWait: "正在等回答", aWaitOld: "目前等最久",
    notEnough: "回答數還不夠", none: "—",
    fTitle: "沒有得到回答", fRate: "佔全部提問的 {0}%", fOff: "Agent 的 Fleet 沒有連接", fTime: "逾時沒有回答",
    fPerm: "權限先到期", fBusy: "Agent 停止或拒絕", fUnknown: "其他或原因不明",
    topTitle: "最常被問的 Agent", topAgent: "Agent", topAsk: "提問數", topMed: "一般回答時間", topFail: "沒有回答",
    topNone: "這段期間還沒有人問過 Agent。", topShared: "總共分享了 {0} 個 Agent。",
    flOn: "目前已連接", flOnSub: "共 {0} 個 Fleet", flBehind: "需要更新", flBehindSub: "低於建議版本 v{0}",
    flBehindNoRec: "還沒有設定建議版本", flOld: "版本太舊，無法使用房間", flOldSub: "它們的 Agent 無法在房間裡回答",
    flUnk: "版本不明", flUnkSub: "版本太舊，無法回報版本", flLink: "查看已連接的 Fleet",
    rmPosts: "訊息數", rmP: "人", rmA: "Agent", rmH: "房間助理", rmActive: "有活動的房間", rmActiveSub: "共 {0} 個房間 · 這週新增 {1} 個",
    rmAsk: "在房間裡問 Agent", rmAskSub: "用 @ 提及來問 Agent 的次數", rmAuto: "Agent 互問被停止", rmAutoSub: "達到層數或頻率上限",
    rmNote: "所有房間的合計。這裡不列出房間名稱與成員：管理員不一定是每個房間的成員。",
    emptyLine: "還沒有人加入。開放同仁加入之後，這裡會顯示使用情形。", emptyButton: "讓同仁加入",
    sec: "{0} 秒", min: "{0} 分鐘", hour: "{0} 小時",
  },
});
export const ho = (key, ...args) => t(`hubOverview.${key}`, ...args);

const RANGE_KEY = "agend_hub_overview_range";
const REFRESH_MS = 60_000;
const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString(lang() === "zh-TW" ? "zh-TW" : "en") : "0");
/** A duration in plain words: seconds under a minute, minutes (one decimal under ten) under an hour, hours beyond. */
export function durationText(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const s = ms / 1000;
  if (s < 60) return ho("sec", String(Math.max(1, Math.round(s))));
  const m = s / 60;
  if (m < 60) return ho("min", m < 10 ? String(Math.round(m * 10) / 10) : String(Math.round(m)));
  return ho("hour", String(Math.round((m / 60) * 10) / 10));
}
/** The day label under a bar: the last bar is Today; the others are their weekday, in this page's language. */
export function dayLabel(date, last) {
  if (last) return ho("qToday");
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat(lang() === "zh-TW" ? "zh-TW" : "en", { weekday: lang() === "zh-TW" ? "narrow" : "short", timeZone: "UTC" }).format(d);
}
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const readRange = () => { try { return sessionStorage.getItem(RANGE_KEY) === "today" ? "today" : "7d"; } catch { return "7d"; } };

function Card({ title, big, sub, cls = "" }) {
  return html`<div class=${`hub-ov-card${cls ? ` ${cls}` : ""}`}><div class="hub-ov-card-title">${title}</div>
    <div class="hub-ov-big">${big}</div>${sub ? html`<div class="hub-ov-sub">${sub}</div>` : null}</div>`;
}
function Rows({ rows }) {
  return html`<dl class="hub-ov-kv">${rows.map(([k, v]) => html`<div key=${k}><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}

/**
 * The Overview. `client.adminDashboard({ range, timeZone })` → the M-3161 response (or { ok: false, status }). `onOpen(view,
 * anchor)` opens another Administration tab (Manage at a card: "join", "fleets"); `onGone()` when the route is not there.
 */
export function HubAdminOverview({ client, onOpen = () => {}, onGone = () => {} }) {
  const [range, setRange] = useState(readRange), [data, setData] = useState(null), [error, setError] = useState(false), [at, setAt] = useState(0);
  const live = useRef(true), asked = useRef(0);
  const load = async (r = range) => {
    const mine = ++asked.current;
    const res = await client.adminDashboard({ range: r, timeZone: zone() }).catch(() => null);
    if (!live.current || mine !== asked.current) return;
    if (res && res.ok !== false && res.people) { setData(res); setError(false); setAt(Date.now()); }
    else if (res && res.status === 404) onGone();   // an older Hub after all: the page shows Manage instead
    else setError(true);
  };
  useEffect(() => { live.current = true; void load(range); const id = setInterval(() => { void load(range); }, REFRESH_MS); return () => { live.current = false; clearInterval(id); }; }, [range]);
  const pick = (r) => { if (r === range) return; try { sessionStorage.setItem(RANGE_KEY, r); } catch { /* private mode */ } setRange(r); };
  const head = html`<div class="hub-ov-bar">
      <div class="hub-ov-range" role="group" aria-label=${ho("rangeLabel")}>
        ${["today", "7d"].map((r) => html`<button key=${r} type="button" class=${`hub-ov-range-item${range === r ? " is-current" : ""}`} aria-pressed=${range === r ? "true" : "false"} onClick=${() => pick(r)}>${ho(r === "today" ? "today" : "week")}</button>`)}
      </div>
      ${at ? html`<span class="note hub-ov-updated">${ho("updated", timeText(at, { hour: "2-digit", minute: "2-digit" }, lang() === "zh-TW" ? "zh-TW" : "en"))}</span>` : null}
    </div>
    <p class="note hub-ov-privacy">${ho("privacy")}</p>`;
  if (!data) return html`<div class="hub-ov">${head}${error ? html`<${ErrorState} onRetry=${() => load(range)} />` : html`<${Skeleton} variant="rows" lines=${6} />`}</div>`;
  const { people, questions: q, topAgents = [], fleets: f, rooms: rm } = data;
  const fleetsSection = html`<section class="hub-ov-section"><h3>${ho("hFleet")}</h3>
    <div class="hub-ov-grid4">
      <${Card} title=${ho("flOn")} big=${num(f.connected)} sub=${ho("flOnSub", num(f.total))} />
      <${Card} title=${ho("flBehind")} big=${num(f.needsUpdate)} sub=${f.recommendedVersion ? ho("flBehindSub", f.recommendedVersion) : ho("flBehindNoRec")} cls=${f.needsUpdate ? "warn" : ""} />
      <${Card} title=${ho("flOld")} big=${num(f.tooOldRooms)} sub=${ho("flOldSub")} cls=${f.tooOldRooms ? "warn" : ""} />
      <${Card} title=${ho("flUnk")} big=${num(f.unknownVersion)} sub=${ho("flUnkSub")} cls=${f.unknownVersion ? "warn" : ""} />
    </div>
    <a class="hub-ov-link" href="/ui/hub/admin?view=manage#fleets" onClick=${(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); onOpen("manage", "fleets"); }}>${ho("flLink")} ›</a></section>`;
  // A Hub nobody has joined yet: one line and the way to change that, instead of a page of zeros (Lumen, M-3162).
  if (!people.total) return html`<div class="hub-ov">${head}
    <section class="hub-ov-empty card"><p>${ho("emptyLine")}</p><button type="button" class="btn btn-primary" onClick=${() => onOpen("manage", "join")}>${ho("emptyButton")}</button></section>
    ${fleetsSection}</div>`;
  const perDay = Array.isArray(q.perDay) ? q.perDay : [];
  const peak = Math.max(1, ...perDay.map((d) => d.count || 0));
  const reasons = q.notAnswered?.reasons || {};
  const failRows = [["fOff", reasons.offline], ["fTime", reasons.timedOut], ["fPerm", reasons.permissionEnded], ["fBusy", reasons.stoppedOrRefused],
    ...(reasons.unknown ? [["fUnknown", reasons.unknown]] : [])].map(([k, v]) => [ho(k), num(v || 0)]);
  const topPeak = Math.max(1, ...topAgents.map((a) => a.questions || 0));
  const by = rm.byAuthor || {}, posts = Math.max(1, (by.people || 0) + (by.agents || 0) + (by.assistant || 0));
  const share = (n) => `${Math.round(((n || 0) / posts) * 1000) / 10}%`;
  return html`<div class="hub-ov">${head}
    <section class="hub-ov-section"><h3>${ho("hPeople")}</h3>
      <div class="hub-ov-grid4">
        <${Card} title=${ho("pToday")} big=${num(people.activeToday)} sub=${ho("pTodaySub", num(people.total))} />
        <${Card} title=${ho("pWeek")} big=${num(people.active7d)} sub=${people.total > people.active7d ? ho("pWeekSub", num(people.total - people.active7d)) : ho("pWeekAll")} />
        <${Card} title=${ho("pJoin")} big=${num(people.joined7d)} sub=${ho("pJoinSub", num(people.total))} />
        <${Card} title=${ho("pNow")} big=${num(people.signedInNow)} sub=${ho("pNowSub")} />
      </div></section>
    <section class="hub-ov-section"><h3>${ho("hAsk")}</h3>
      <div class="hub-ov-split">
        <div class="hub-ov-card hub-ov-perday"><div class="hub-ov-card-title">${ho("qPerDay")}</div>
          <div class="hub-ov-big">${num(q.asked)} <small>${ho(`qRange_${data.range === "today" ? "today" : "7d"}`)}</small></div>
          <div class="hub-ov-bars" role="img" aria-label=${perDay.map((d, i) => `${dayLabel(d.date, i === perDay.length - 1)} ${d.count}`).join(", ")}>
            ${perDay.map((d, i) => html`<div key=${d.date} class=${i === perDay.length - 1 ? "today" : ""}><b>${num(d.count)}</b>
              <i ref=${(el) => el?.style?.setProperty("height", `${Math.round(((d.count || 0) / peak) * 100)}%`)}></i><span>${dayLabel(d.date, i === perDay.length - 1)}</span></div>`)}
          </div>
          <p class="note">${ho("qHint")}</p></div>
        <div class="hub-ov-stack">
          <div class="hub-ov-card"><div class="hub-ov-card-title">${ho("aTime")}</div>
            <${Rows} rows=${[[ho("aMed"), durationText(q.answerTime?.medianMs) ?? ho("notEnough")], [ho("aSlow"), durationText(q.answerTime?.p90Ms) ?? ho("notEnough")]]} />
            <${Rows} rows=${[[ho("aWait"), num(q.waiting)], [ho("aWaitOld"), durationText(q.longestWaitMs) ?? ho("none")]]} /></div>
          <div class="hub-ov-card"><div class="hub-ov-card-title">${ho("fTitle")}</div>
            <div class="hub-ov-big">${num(q.notAnswered?.total)}${q.asked ? html` <small>${ho("fRate", String(Math.round(((q.notAnswered?.total || 0) / q.asked) * 1000) / 10))}</small>` : null}</div>
            <${Rows} rows=${failRows} /></div>
        </div>
      </div>
      <div class="hub-ov-card hub-ov-top"><div class="hub-ov-card-title">${ho("topTitle")}</div>
        ${topAgents.length ? html`<table><thead><tr><th class="rank"></th><th>${ho("topAgent")}</th><th class="n">${ho("topAsk")}</th><th class="n">${ho("topMed")}</th><th class="n">${ho("topFail")}</th></tr></thead>
          <tbody>${topAgents.map((a, i) => html`<tr key=${a.id}><td class="rank">${i + 1}</td>
            <td><div class="hub-ov-agent">${a.name}</div>${a.ownerName ? html`<div class="note">${a.ownerName}</div>` : null}<div class="hub-ov-meter"><i ref=${(el) => el?.style?.setProperty("width", `${Math.round(((a.questions || 0) / topPeak) * 100)}%`)}></i></div></td>
            <td class="n">${num(a.questions)}</td><td class="n">${durationText(a.medianMs) ?? html`<span class="note">${ho("notEnough")}</span>`}</td>
            <td class="n">${a.notAnswered ? html`<span class="tag warn">${num(a.notAnswered)}</span>` : "0"}</td></tr>`)}</tbody></table>`
          : html`<p class="note">${ho("topNone")}</p>`}
        <p class="note">${ho("topShared", num(data.sharedAgents))}</p></div>
    </section>
    ${fleetsSection}
    <section class="hub-ov-section"><h3>${ho("hRoom")}</h3>
      <div class="hub-ov-split">
        <div class="hub-ov-card"><div class="hub-ov-card-title">${ho("rmPosts")}</div>
          <div class="hub-ov-big">${num(rm.messages)} <small>${ho(`qRange_${data.range === "today" ? "today" : "7d"}`)}</small></div>
          <div class="hub-ov-split-bar" role="img" aria-label=${`${ho("rmP")} ${by.people || 0}, ${ho("rmA")} ${by.agents || 0}, ${ho("rmH")} ${by.assistant || 0}`}>
            <i class="p" ref=${(el) => el?.style?.setProperty("flex-basis", share(by.people))}></i><i class="a" ref=${(el) => el?.style?.setProperty("flex-basis", share(by.agents))}></i><i class="h" ref=${(el) => el?.style?.setProperty("flex-basis", share(by.assistant))}></i></div>
          <dl class="hub-ov-kv hub-ov-legend"><div><dt><i class="p"></i>${ho("rmP")}</dt><dd>${num(by.people)}</dd></div><div><dt><i class="a"></i>${ho("rmA")}</dt><dd>${num(by.agents)}</dd></div><div><dt><i class="h"></i>${ho("rmH")}</dt><dd>${num(by.assistant)}</dd></div></dl>
          <p class="note">${ho("rmNote")}</p></div>
        <div class="hub-ov-stack">
          <${Card} title=${ho("rmActive")} big=${num(rm.active)} sub=${ho("rmActiveSub", num(rm.total), num(rm.created7d))} />
          <${Card} title=${ho("rmAsk")} big=${num(rm.agentQuestions)} sub=${ho("rmAskSub")} />
          <${Card} title=${ho("rmAuto")} big=${num(rm.chainsStopped)} sub=${ho("rmAutoSub")} />
        </div>
      </div></section>
  </div>`;
}
