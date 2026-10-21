// #2293: global search (Ctrl+K / ⌘K) — chats, messages between agents and Task Board tasks, as the fleet's index has
// them (GET /ui/search; an admin's only). A Spotlight-style dialog: the query on top, results under it grouped by agent,
// ↑↓ and Enter, Esc or a click outside to close; filters folded under one toggle. A chat row still in the agent's
// history opens there, at the message (#m=); anything else — a chat row that has left the history, a message between
// agents, a task — opens here as the index's copy (GET /ui/search/context). Text only: no innerHTML, no style attribute.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { navigate } from "/assets/app-nav.js";
import { chatPath, fleetPath } from "/assets/app-route.js";
import { namesOf, namesStore } from "/assets/instance-nav.js";
import { Icon } from "/assets/ui-icons.js";

register("search", {
  en: {
    label: "Search", placeholder: "Search chats, messages and tasks…", close: "Close", filters: "Filters", filtersOn: "Filters ({0})",
    hint: "Find who you asked about something: a word or two from the chat, a message between agents or a task. Short words (1–2 characters) work too.",
    recent: "Recent searches", clearRecent: "Clear",
    agent: "Agent", anyAgent: "All agents", team: "Team", anyTeam: "All teams", time: "Time", anyTime: "Any time",
    day: "24 hours", week: "7 days", month: "30 days", sources: "In", mine: "Only mine",
    src_chat: "Chats", src_xmsg: "Agent messages", src_task: "Tasks",
    badge_chat: "Chat", badge_xmsg: "Message", badge_task: "Task",
    searching: "Searching…", none: "Nothing found", noneFiltered: "Nothing found with these filters",
    building: "Still indexing — some older results may be missing.",
    limited: "Words of 1–2 characters alone search the newest 5,000 entries only — add a longer word to search everything.",
    unavailable: "Search is off or not available (web.search in fleet.yaml).", busy: "Search is busy — try again in a moment.",
    signedOut: "Signed out — sign in again to search.", failed: "Search failed — try again.",
    keys: "↑↓ move · Enter open · Esc close", results: "Results", back: "Results",
    gone: "This message is no longer in the chat's history — this is the copy kept by search.",
    openChat: "Open chat", openChatOf: "Open {0}'s chat", openTasks: "Open the Task Board", loadingCtx: "Loading…",
    notFound: "No longer found — it may have been removed.", from: "{0} → {1}", groupCount: "{0} results",
  },
  "zh-TW": {
    label: "搜尋", placeholder: "搜尋聊天、訊息與任務…", close: "關閉", filters: "篩選", filtersOn: "篩選（{0}）",
    hint: "找回某件事當初交給誰：輸入聊天、agent 之間訊息或任務裡的一兩個詞。1–2 個字的短詞也可以。",
    recent: "最近的搜尋", clearRecent: "清除",
    agent: "Agent", anyAgent: "所有 agent", team: "團隊", anyTeam: "所有團隊", time: "時間", anyTime: "不限時間",
    day: "24 小時", week: "7 天", month: "30 天", sources: "範圍", mine: "只看我的",
    src_chat: "聊天", src_xmsg: "Agent 訊息", src_task: "任務",
    badge_chat: "聊天", badge_xmsg: "訊息", badge_task: "任務",
    searching: "搜尋中…", none: "找不到結果", noneFiltered: "這些篩選條件下找不到結果",
    building: "索引仍在建立中，較舊的結果可能還沒出現。",
    limited: "只有 1–2 個字的短詞時，只會搜尋最新的 5,000 筆；加上較長的詞即可搜尋全部。",
    unavailable: "搜尋已關閉或無法使用（fleet.yaml 的 web.search）。", busy: "搜尋忙碌中，請稍後再試。",
    signedOut: "已登出，請重新登入後再搜尋。", failed: "搜尋失敗，請再試一次。",
    keys: "↑↓ 移動 · Enter 開啟 · Esc 關閉", results: "結果", back: "結果",
    gone: "這則訊息已不在聊天紀錄中，以下是搜尋保留的副本。",
    openChat: "開啟聊天", openChatOf: "開啟 {0} 的聊天", openTasks: "開啟 Task Board", loadingCtx: "載入中…",
    notFound: "已找不到，可能已被移除。", from: "{0} → {1}", groupCount: "{0} 筆結果",
  },
});

export const DEBOUNCE_MS = 200;
export const RECENT_KEY = "agend_search_recent";
export const RECENT_MAX = 8;
const SOURCES = ["chat", "xmsg", "task"];
const SINCE = { any: 0, day: 24 * 3600_000, week: 7 * 24 * 3600_000, month: 30 * 24 * 3600_000 };

export function readRecent() {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(v) ? v.filter(x => typeof x === "string" && x.trim()).slice(0, RECENT_MAX) : []; } catch { return []; }
}
export function rememberSearch(q) {
  const s = (q || "").trim();
  if (!s) return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([s, ...readRecent().filter(x => x !== s)].slice(0, RECENT_MAX))); } catch { /* this page only */ }
}
function forgetRecent() { try { localStorage.removeItem(RECENT_KEY); } catch { /* nothing kept */ } }

/** The request's query string for the query and filters (null: nothing to search). */
export function searchUrl(q, f, now = Date.now()) {
  const query = (q || "").trim();
  if (!query) return null;
  const p = new URLSearchParams({ q: query, limit: "60" });
  if (f.instance) p.append("instance", f.instance);
  if (f.team) p.set("team", f.team);
  if (f.sources && f.sources.length && f.sources.length < SOURCES.length) for (const s of f.sources) p.append("source", s);
  if (SINCE[f.since]) p.set("since", String(now - SINCE[f.since]));
  if (f.mine) p.set("mine", "1");
  return `/ui/search?${p.toString()}`;
}
/** Hits grouped by agent, in the order the newest of each appears; `index` is each hit's place in the flat list. */
export function groupHits(hits) {
  const groups = new Map();
  hits.forEach((hit) => {
    if (!groups.has(hit.instance)) groups.set(hit.instance, []);
    groups.get(hit.instance).push(hit);
  });
  let i = 0;
  return [...groups].map(([instance, list]) => ({ instance, hits: list.map(hit => ({ hit, index: i++ })) }));
}
/** The flat order ↑↓ moves through: the groups', top to bottom. */
export const flatHits = (groups) => groups.flatMap(g => g.hits.map(x => x.hit));
/** A snippet as text segments, the matched ones marked (ranges from the server, clipped to the text). */
export function snippetSegments(text, marks) {
  const s = String(text || ""), out = [];
  let at = 0;
  for (const m of Array.isArray(marks) ? marks : []) {
    const a = Math.max(at, Math.min(s.length, Number(m && m[0]) || 0)), b = Math.max(a, Math.min(s.length, Number(m && m[1]) || 0));
    if (a > at) out.push({ text: s.slice(at, a) });
    if (b > a) out.push({ text: s.slice(a, b), mark: true });
    at = b;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}
/** The query's words marked in `text` (case-insensitive, every occurrence; overlapping ones merged) — for the copy view. */
export function markTerms(text, q) {
  const s = String(text || ""), lower = s.toLowerCase();
  const terms = [...new Set(String(q || "").toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
  const ranges = [];
  for (const term of terms) for (let at = lower.indexOf(term); at !== -1 && ranges.length < 500; at = lower.indexOf(term, at + term.length)) ranges.push([at, at + term.length]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
  return snippetSegments(s, merged);
}
/** "14:05" today, "10/19 14:05" this year, "2025/10/19" before. */
export function when(ms, now = Date.now()) {
  const d = new Date(ms), n = new Date(now);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === n.toDateString()) return hm;
  return d.getFullYear() === n.getFullYear() ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
/** A chat hit's message key in its agent's chat (#m=<boot>-<id>), or null. */
export function messageKeyOf(hit) {
  const boot = hit && hit.ref && hit.ref.boot, id = hit && hit.ref && hit.ref.id;
  return typeof boot === "string" && /^[0-9a-f]{1,32}$/.test(boot) && Number.isSafeInteger(id) && id >= 0 ? `${boot}-${id}` : null;
}
/**
 * Open an agent's chat at a message: the route, then the address's #m= — the chat reads it as it mounts, and (already
 * open) on the hashchange this sends.
 */
export function jumpToMessage(instance, key, w = window) {
  const path = chatPath(instance);
  navigate(path);
  if (!key) return;
  w.history.replaceState(null, "", `${path}#m=${key}`);
  w.dispatchEvent(new Event("hashchange"));
}

const errorText = (status) => (status === 404 ? t("search.unavailable") : status === 503 ? t("search.busy") : status === 401 ? t("search.signedOut") : t("search.failed"));

export function SearchDialog({ preset = {}, onClose }) {
  const ref = useRef(null), input = useRef(null), list = useRef(null);
  const app = useStore(appStore);
  const names = useStore(namesStore);
  const [q, setQ] = useState(preset.q || "");
  const [f, setF] = useState({ instance: preset.instance || "", team: "", since: "any", sources: [...SOURCES], mine: false });
  const [showFilters, setShowFilters] = useState(!!preset.instance);
  const [teams, setTeams] = useState(null);
  const [res, setRes] = useState({ status: "idle" });
  const [active, setActive] = useState(0);
  const [detail, setDetail] = useState(null);
  const [recent, setRecent] = useState(readRecent);
  const seq = useRef(0);

  // The native modal: focus trapped, the page inert, Esc → cancel (closed through the parent), a click on the backdrop.
  useLayoutEffect(() => {
    const d = ref.current;
    const opener = typeof document !== "undefined" ? document.activeElement : null;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
    input.current && input.current.focus();
    return () => {
      if (d && d.open && typeof d.close === "function") d.close();
      if (opener && typeof opener.focus === "function" && document.contains?.(opener)) opener.focus();
    };
  }, []);
  useEffect(() => {
    const d = ref.current;
    if (!d) return undefined;
    const onCancel = (e) => { e.preventDefault(); onClose(); };
    const onClick = (e) => { if (e.target === d) onClose(); };
    d.addEventListener("cancel", onCancel);
    d.addEventListener("click", onClick);
    return () => { d.removeEventListener("cancel", onCancel); d.removeEventListener("click", onClick); };
  }, [onClose]);

  // The query, DEBOUNCE_MS after the last change; an answer to an older one is dropped.
  useEffect(() => {
    const url = searchUrl(q, f);
    const mine = ++seq.current;
    if (!url) { setRes({ status: "idle" }); return undefined; }
    setRes(r => ({ ...r, status: "loading" }));
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(url, { headers: { Accept: "application/json" }, ...(ac ? { signal: ac.signal } : {}) });
        if (mine !== seq.current) return;
        if (!r.ok) { setRes({ status: "error", error: errorText(r.status) }); return; }
        const body = await r.json();
        if (mine !== seq.current) return;
        setRes({ status: "ok", hits: Array.isArray(body.hits) ? body.hits : [], limited: !!body.limited, building: !!body.building });
        setActive(0);
      } catch (err) {
        if (mine === seq.current && !(err && err.name === "AbortError")) setRes({ status: "error", error: t("search.failed") });
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); if (ac) ac.abort(); };
  }, [q, f]);

  // Teams, once the filters are first shown.
  useEffect(() => {
    if (!showFilters || teams) return;
    fetch("/ui/teams", { headers: { Accept: "application/json" } }).then(r => (r.ok ? r.json() : { teams: {} })).then(
      (b) => setTeams(Object.keys((b && b.teams) || {}).sort()), () => setTeams([]));
  }, [showFilters, teams]);

  const byName = useMemo(() => new Map((app.instances || []).map(it => [it.name ?? it.instance_name, it])), [app.instances]);
  const label = (name) => (byName.has(name) ? namesOf(byName.get(name), names.primary).primary : name);
  // While a new query runs, the last answer stays (dimmed) rather than flashing empty.
  const groups = useMemo(() => groupHits(res.hits || []), [res]);
  const flat = useMemo(() => flatHits(groups), [groups]);
  const activeFilters = (f.instance ? 1 : 0) + (f.team ? 1 : 0) + (f.since !== "any" ? 1 : 0) + (f.sources.length < SOURCES.length ? 1 : 0) + (f.mine ? 1 : 0);

  // The active row stays in view.
  useEffect(() => {
    const el = list.current && list.current.querySelector(`#search-opt-${active}`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [active, res]);

  const open = (hit) => {
    if (!hit) return;
    rememberSearch(q); setRecent(readRecent());
    const key = hit.source === "chat" ? messageKeyOf(hit) : null;
    if (key && hit.live) { onClose(); jumpToMessage(hit.instance, key); return; }
    setDetail({ hit, status: "loading" });
    // Any failure — the request, or a body that is not JSON — ends as an error, never "Loading…" for good.
    fetch(`/ui/search/context?key=${encodeURIComponent(hit.key)}`, { headers: { Accept: "application/json" } })
      .then(async (r) => {
        if (!r.ok) { setDetail(d => (d && d.hit === hit ? { hit, status: "error", error: r.status === 404 ? t("search.notFound") : errorText(r.status) } : d)); return; }
        const body = await r.json();
        setDetail(d => (d && d.hit === hit ? { hit, status: "ok", ctx: body } : d));
      })
      .catch(() => setDetail(d => (d && d.hit === hit ? { hit, status: "error", error: t("search.failed") } : d)));
  };
  const onKey = (e) => {
    if (e.isComposing) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); input.current && input.current.select(); return; }
    // ↑↓ and Enter are the query box's: in the filters a select or a chip keeps its own keys.
    if (detail || e.target !== input.current) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => (flat.length ? (i + 1) % flat.length : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => (flat.length ? (i - 1 + flat.length) % flat.length : 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (flat.length) open(flat[Math.min(active, flat.length - 1)]); else rememberSearch(q); }
  };
  const setFilter = (patch) => setF(x => ({ ...x, ...patch }));
  const toggleSource = (s) => setF(x => {
    const has = x.sources.includes(s);
    const next = has ? x.sources.filter(y => y !== s) : [...x.sources, s];
    return { ...x, sources: next.length ? SOURCES.filter(y => next.includes(y)) : x.sources };   // never none
  });
  const activeId = flat.length && !detail ? `search-opt-${Math.min(active, flat.length - 1)}` : undefined;

  return html`<dialog data-trust="dialog" ref=${ref} class="dlg search-dlg" aria-label=${t("search.label")} onKeyDown=${onKey}>
    <div class="search-box">
      <div class="search-head">
        <${Icon} name="search" />
        <input ref=${input} class="search-input" type="search" value=${q} placeholder=${t("search.placeholder")} aria-label=${t("search.label")}
          role="combobox" aria-expanded=${flat.length && !detail ? "true" : "false"} aria-controls="search-results" aria-autocomplete="list"
          aria-activedescendant=${activeId} autocomplete="off" spellcheck=${false} enterkeyhint="search"
          onInput=${(e) => { setQ(e.target.value); setDetail(null); }} />
        <button type="button" class=${`chip-btn search-filters-toggle${showFilters ? " on" : ""}`} aria-expanded=${showFilters ? "true" : "false"} aria-controls="search-filters"
          onClick=${() => setShowFilters(v => !v)}><${Icon} name="sliders" size=${14} />${activeFilters ? t("search.filtersOn", activeFilters) : t("search.filters")}</button>
        <button type="button" class="icon-btn" aria-label=${t("search.close")} title=${t("search.close")} onClick=${onClose}><${Icon} name="close" /></button>
      </div>
      ${showFilters ? html`<div id="search-filters" class="search-filters" role="group" aria-label=${t("search.filters")}>
        <label class="search-field"><span>${t("search.agent")}</span>
          <select value=${f.instance} onChange=${(e) => setFilter({ instance: e.target.value })}>
            <option value="">${t("search.anyAgent")}</option>
            ${[...byName.keys()].sort().map(n => html`<option value=${n}>${label(n)}</option>`)}
            ${f.instance && !byName.has(f.instance) ? html`<option value=${f.instance}>${f.instance}</option>` : null}
          </select></label>
        ${teams && teams.length ? html`<label class="search-field"><span>${t("search.team")}</span>
          <select value=${f.team} onChange=${(e) => setFilter({ team: e.target.value })}>
            <option value="">${t("search.anyTeam")}</option>${teams.map(n => html`<option value=${n}>${n}</option>`)}</select></label>` : null}
        <div class="search-chips" role="group" aria-label=${t("search.time")}>
          ${["any", "day", "week", "month"].map(k => html`<button type="button" class=${`chip-btn${f.since === k ? " on" : ""}`} aria-pressed=${f.since === k ? "true" : "false"}
            onClick=${() => setFilter({ since: k })}>${k === "any" ? t("search.anyTime") : t(`search.${k}`)}</button>`)}
        </div>
        <div class="search-chips" role="group" aria-label=${t("search.sources")}>
          ${SOURCES.map(s => html`<button type="button" class=${`chip-btn${f.sources.includes(s) ? " on" : ""}`} aria-pressed=${f.sources.includes(s) ? "true" : "false"}
            onClick=${() => toggleSource(s)}>${t(`search.src_${s}`)}</button>`)}
          <label class="search-mine"><input type="checkbox" checked=${f.mine} onChange=${(e) => setFilter({ mine: e.target.checked })} />${t("search.mine")}</label>
        </div>
      </div>` : null}
      <div class="search-body" ref=${list}>
        ${detail ? html`<${Detail} detail=${detail} q=${q} label=${label} onBack=${() => { setDetail(null); input.current && input.current.focus(); }} onClose=${onClose} />`
          : html`<${Results} q=${q} res=${res} groups=${groups} active=${active} setActive=${setActive} open=${open} label=${label} filtered=${activeFilters > 0}
              recent=${recent} pick=${(s) => { setQ(s); input.current && input.current.focus(); }} clearRecent=${() => { forgetRecent(); setRecent([]); }} />`}
      </div>
      <div class="search-foot" aria-hidden="true">${t("search.keys")}</div>
    </div></dialog>`;
}

function Results({ q, res, groups, active, setActive, open, label, filtered, recent, pick, clearRecent }) {
  if (!q.trim()) {
    return html`<div class="search-empty"><p class="search-hint">${t("search.hint")}</p>
      ${recent.length ? html`<div class="search-recent"><div class="search-recent-head"><span>${t("search.recent")}</span>
        <button type="button" class="chip-btn" onClick=${clearRecent}>${t("search.clearRecent")}</button></div>
        <ul>${recent.map(s => html`<li><button type="button" class="search-recent-item" onClick=${() => pick(s)}><${Icon} name="clock" size=${14} /><span>${s}</span></button></li>`)}</ul></div>` : null}</div>`;
  }
  if (res.status === "error") return html`<p class="search-status bad" role="alert">${res.error}</p>`;
  const hits = res.hits || [];
  return html`
    ${res.building ? html`<p class="search-note" role="status">${t("search.building")}</p>` : null}
    ${res.limited ? html`<p class="search-note" role="status">${t("search.limited")}</p>` : null}
    ${res.status === "loading" && !hits.length ? html`<p class="search-status" role="status">${t("search.searching")}</p>` : null}
    ${res.status === "ok" && !hits.length ? html`<p class="search-status" role="status">${filtered ? t("search.noneFiltered") : t("search.none")}</p>` : null}
    <div id="search-results" role="listbox" aria-label=${t("search.results")} class=${`search-results${res.status === "loading" ? " stale" : ""}`}>
      ${groups.map(g => html`<div role="group" class="search-group" aria-label=${label(g.instance)}>
        <div class="search-group-head" aria-hidden="true"><span>${label(g.instance)}</span><span class="search-count">${t("search.groupCount", g.hits.length)}</span></div>
        ${g.hits.map(({ hit, index }) => html`<${Row} hit=${hit} index=${index} on=${index === active} label=${label} onHover=${() => setActive(index)} onOpen=${() => open(hit)} />`)}
      </div>`)}
    </div>`;
}

function Row({ hit, index, on, label, onHover, onOpen }) {
  const who = hit.source === "xmsg" ? t("search.from", label(hit.instance), label(hit.peer || "")) : hit.source === "task" ? (hit.role || "") : hit.sender || "";
  return html`<div id=${`search-opt-${index}`} role="option" aria-selected=${on ? "true" : "false"} class=${`search-row${on ? " on" : ""}`}
    onMouseMove=${on ? undefined : onHover} onClick=${onOpen}>
    <div class="search-row-top"><span class=${`search-badge ${hit.source}`}>${t(`search.badge_${hit.source}`)}</span>
      <span class="search-who">${who}${hit.source === "xmsg" && hit.role && hit.role !== "message" ? html` <span class="search-kind">${hit.role}</span>` : null}</span>
      <time class="search-time" datetime=${Number.isFinite(hit.ts) ? new Date(hit.ts).toISOString() : undefined}>${when(hit.ts)}</time></div>
    <div class="search-snippet">${snippetSegments(hit.snippet, hit.marks).map(s => (s.mark ? html`<mark>${s.text}</mark>` : s.text))}</div>
  </div>`;
}

function Detail({ detail, q, label, onBack, onClose }) {
  const { hit } = detail;
  const go = (path, key) => { onClose(); if (key !== undefined) jumpToMessage(hit.instance, key); else navigate(path); };
  const head = html`<div class="search-detail-head"><button type="button" class="chip-btn" onClick=${onBack}><${Icon} name="back" size=${14} />${t("search.back")}</button>
    <span class=${`search-badge ${hit.source}`}>${t(`search.badge_${hit.source}`)}</span><span class="search-who">${hit.source === "xmsg" ? t("search.from", label(hit.instance), label(hit.peer || "")) : label(hit.instance)}</span>
    <time class="search-time">${when(hit.ts)}</time></div>`;
  if (detail.status === "loading") return html`<div class="search-detail">${head}<p class="search-status" role="status">${t("search.loadingCtx")}</p></div>`;
  if (detail.status === "error") return html`<div class="search-detail">${head}<p class="search-status bad" role="alert">${detail.error}</p></div>`;
  const ctx = detail.ctx || {};
  const doc = ctx.doc || {};
  const line = (d, here) => html`<li class=${`search-ctx-line${here ? " here" : ""}`}><div class="search-row-top"><span class="search-who">${d.sender || ""}</span><time class="search-time">${when(d.ts)}</time></div>
    <div class="search-ctx-text">${markTerms(d.text, q).map(x => (x.mark ? html`<mark>${x.text}</mark>` : x.text))}</div></li>`;
  let actions;
  if (hit.source === "chat") actions = html`<button type="button" class="btn btn-primary" onClick=${() => go(null, messageKeyOf(hit))}>${t("search.openChat")}</button>`;
  else if (hit.source === "xmsg") actions = html`<button type="button" class="btn" onClick=${() => go(chatPath(hit.instance))}>${t("search.openChatOf", label(hit.instance))}</button>
    ${hit.peer ? html`<button type="button" class="btn" onClick=${() => go(chatPath(hit.peer))}>${t("search.openChatOf", label(hit.peer))}</button>` : null}`;
  else actions = html`<button type="button" class="btn btn-primary" onClick=${() => go(fleetPath("tasks"))}>${t("search.openTasks")}</button>`;
  return html`<div class="search-detail">${head}
    ${hit.source === "chat" ? html`<p class="search-note">${t("search.gone")}</p>` : null}
    <ol class="search-ctx">${(ctx.before || []).map(d => line(d, false))}${line(doc, true)}${(ctx.after || []).map(d => line(d, false))}</ol>
    <div class="search-detail-actions">${actions}</div></div>`;
}
