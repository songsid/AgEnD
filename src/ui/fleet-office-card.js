// #2661: a person's profile card in the Office (fleet-office.js opens it): a popover beside them, not a modal — the Office
// keeps running and is not dimmed; on a phone, a bottom sheet swiped down to close. Fixed 320 px wide.
//
//   [avatar + badge]  Display name
//                     instance-name (one line, cut, full on hover)
//                     Working · Master                       ← the state as the tooltip words it, and the title
//   Lv 50 · 260M work tokens                                 ← two lines over the XP bar, so neither wraps alone
//   10.4M to Lv 51
//   [=========-----]
//   Office  Engineering · Work        Model    claude-opus-5-5
//   Backend Claude Code               Today    12.3K · 45 requests
//   First seen  Day 42
//   Now: Typing away
//                               [Find in office]  [Chat]
//
// What a viewer sees follows the host (GET /ui/office-levels, src/office-levels.ts): the level for anyone who sees the
// Office; work tokens, today and first seen only where the usage report is served (`detail`). A share link's page (no
// `onChat`) shows the name, title, state and office only — never the model, the backend or numbers. A title a skin pack
// pins (`levels.fixed`) shows whatever the level; with hideLevel, no "Lv n" and no XP bar. Levels off: no level rows.
import { html, useEffect, useRef } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { backendLabel, modelText, namesOf } from "/assets/instance-nav.js";
import { badgeText, fixedOf, tierOf, titleOf, tokens, xpOf } from "./fleet-office-levels.js";

register("ocard", {
  en: {
    card: "{0}'s card", level: "Lv {0}", work: "{0} work tokens", estimated: "estimated", toNext: "{0} to Lv {1}", office: "Office", model: "Model", backend: "Backend",
    today: "Today", todayN: "{0} work tokens · {1} requests", firstSeen: "First seen", day: "Day {0}", now: "Now", find: "Find in office", chat: "Chat",
    close: "Close", xp: "Progress to Lv {0}",
  },
  "zh-TW": {
    card: "{0} 的名片", level: "Lv {0}", work: "{0} 工作 token", estimated: "估算", toNext: "再 {0} 到 Lv {1}", office: "辦公室", model: "模型", backend: "後端",
    today: "今天", todayN: "{0} 工作 token · {1} 次請求", firstSeen: "首次出現", day: "第 {0} 天", now: "現在", find: "在辦公室找他", chat: "聊天",
    close: "關閉", xp: "升到 Lv {0} 的進度",
  },
});
const tc = (k, ...v) => t(`ocard.${k}`, ...v);

/** The days from `first` (YYYY-MM-DD, the fleet's zone) to today on this device's clock, counting the first as day 1. */
export function dayOf(first, nowMs = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(first || "");
  if (!m) return null;
  const d = new Date(nowMs), today = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.max(1, Math.floor((today - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86_400_000) + 1);
}

/**
 * What the card says (pure, for the component and the tests): `node` the org chart's node; `lv` levelsOk's answer (or
 * null); `levels` the style's pack `levels` (or null); `share` a share link's page; `state` the state's words; `now`
 * the tooltip's activity line; `where` the office (and area) in words.
 */
export function cardModel({ node, lv, levels, share = false, state, now, where }) {
  const it = node.i || {};
  const names = node.i ? namesOf(node.i) : { primary: node.name, secondary: "" };
  const fx = fixedOf(node.name, levels);
  const on = !!(lv && lv.enabled);
  const e = on ? lv.levels.get(node.name) || null : null;
  const showLevel = !!e && !(fx && fx.hideLevel);
  const title = on && fx ? fx.title : e ? titleOf(e.level, levels && levels.titles) : null;
  const detail = !share && !!e && e.workTokens !== undefined;
  const xp = showLevel && detail ? xpOf(e.level, e.workTokens, lv.unit) : null;
  const rows = [[tc("office"), where]];
  if (!share && it.model) rows.push([tc("model"), modelText(it)]);
  if (!share && it.backend) rows.push([tc("backend"), backendLabel(it.backend)]);
  if (detail) rows.push([tc("today"), tc("todayN", tokens(e.today.workTokens), e.today.requests)]);
  if (detail && e.firstSeen) rows.push([tc("firstSeen"), tc("day", dayOf(e.firstSeen))]);
  return {
    name: names.primary, instance: node.name,
    stateLine: title ? `${state} · ${title}` : state,
    badge: on && fx && fx.hideLevel ? { mark: true, tier: 0 } : e ? { text: badgeText(e.level), tier: tierOf(e.level) } : null,
    level: showLevel ? { line1: detail ? `${tc("level", e.level)} · ${tc("work", tokens(e.workTokens))}` : tc("level", e.level), estimated: detail && e.estimated,
      line2: xp ? tc("toNext", tokens(xp.toNext), xp.next) : null, pct: xp ? xp.pct : null, next: xp ? xp.next : null } : null,
    rows, now,
  };
}

/**
 * The card. `model`: cardModel's; `avatar(canvas)`: draws the person's idle frame on it; `sheet`: a bottom sheet (a
 * phone); `place(el)`: the page positions the popover (beside the person, following them); `onChat` (none on a share
 * link), `onFind`, `onClose`.
 */
export function OfficeCard({ model: m, avatar, sheet, place, onChat, onFind, onClose }) {
  const box = useRef(null), canvas = useRef(null), swipe = useRef(null);
  useEffect(() => { if (canvas.current && avatar) avatar(canvas.current); });
  useEffect(() => { place && place(box.current); });
  // A bottom sheet closes on a swipe down (60 px or more).
  const down = (e) => { if (sheet) swipe.current = e.clientY; };
  const up = (e) => { if (sheet && swipe.current !== null && e.clientY - swipe.current > 60) onClose(); swipe.current = null; };
  return html`<div ref=${box} class=${`oo-card${sheet ? " sheet" : ""}`} role="dialog" aria-modal="false" aria-label=${tc("card", m.name)}
      onPointerDown=${down} onPointerUp=${up} onPointerCancel=${() => { swipe.current = null; }}>
    ${sheet ? html`<div class="oo-card-grip" aria-hidden="true"></div>` : null}
    <div class="oo-card-head">
      <div class="oo-card-avatar"><canvas ref=${canvas} width="56" height="56" aria-hidden="true"></canvas>
        ${m.badge ? html`<span class=${`oo-badge tier-${m.badge.tier}${m.badge.mark ? " mark" : ""}`} aria-hidden="true">${m.badge.mark ? "" : m.badge.text}</span>` : null}</div>
      <div class="oo-card-names">
        <strong class="oo-card-name">${m.name}</strong>
        <div class="oo-card-instance mono" title=${m.instance}>${m.instance}</div>
        <div class="oo-card-state">${m.stateLine}</div>
      </div>
      <button type="button" class="icon-btn oo-card-close" aria-label=${tc("close")} title=${tc("close")} onClick=${onClose}>×</button>
    </div>
    ${m.level ? html`<div class="oo-card-xp">
      <div>${m.level.line1}${m.level.estimated ? html` <span class="muted">(${tc("estimated")})</span>` : null}</div>
      ${m.level.line2 ? html`<div class="muted">${m.level.line2}</div>` : null}
      ${m.level.pct !== null ? html`<progress class="oo-card-bar" max="100" value=${Math.round(m.level.pct * 100)} aria-label=${tc("xp", m.level.next)}></progress>` : null}
    </div>` : null}
    <dl class="oo-card-rows">${m.rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
    ${m.now ? html`<div class="oo-card-now"><span class="muted">${tc("now")}:</span> ${m.now}</div>` : null}
    <div class="oo-card-actions">
      ${onFind ? html`<button type="button" class="btn btn-sm btn-ghost oo-card-find" onClick=${onFind}>${tc("find")}</button>` : null}
      ${onChat ? html`<button type="button" class="btn btn-sm btn-primary oo-card-chat" onClick=${onChat}>${tc("chat")}</button>` : null}
    </div>
  </div>`;
}
