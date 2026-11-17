// M-3127 C: the Hub's Ctrl K (⌘K) — the Fleet's search dialog (search-dialog.js: one box on top, results under it, ↑↓ Enter,
// Esc or a click outside to close), on the Hub: the rooms and chats whose names match (what Ctrl K did before), then the
// messages with those words in the group rooms I am in (GET /hub/v1/rooms/search), grouped by room, newest first. A hit
// opens its room at the message (`?room=…&m=…`: the room page loads back to it and flashes it). The Fleet dialog's look
// (app.css .search-*), not its module: a Hub page imports no Fleet module. Text only: no innerHTML.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { Icon } from "/assets/ui-icons.js";
import { Skeleton } from "/assets/ui-states.js";
import { hroom } from "./hub-room-strings.js";

export const SEARCH_DEBOUNCE_MS = 250;

/** A snippet as text segments, the matched ranges (from the Hub, clipped to the text) marked. */
export function segments(text, marks) {
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
/** Hits grouped by room in the order each room's newest hit comes; `index` is each hit's place in the flat order. */
export function byRoom(hits, offset = 0) {
  const groups = new Map();
  for (const h of hits || []) { if (!groups.has(h.roomId)) groups.set(h.roomId, { roomId: h.roomId, name: h.roomName, hits: [] }); groups.get(h.roomId).hits.push(h); }
  let i = offset;
  return [...groups.values()].map((g) => ({ ...g, hits: g.hits.map((hit) => ({ hit, index: i++ })) }));
}
/** "14:05" today, "10/19 14:05" this year, "2025/10/19" before (the Fleet search's). */
export function when(ms, now = Date.now()) {
  const d = new Date(ms), n = new Date(now);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === n.toDateString()) return hm;
  return d.getFullYear() === n.getFullYear() ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
/** The address that opens a hit: its room, at its message. */
export const hitPath = (hit) => `/ui/hub?room=${encodeURIComponent(hit.roomId)}&m=${encodeURIComponent(hit.messageId)}`;
const roomLabel = (r) => String(r.assistant ? hroom("hubAssistant") : r.kind === "direct" ? (r.agent?.name || r.exposureName || r.name || "") : (r.name || ""));

/**
 * `client`: the Hub client (searchRoomMessages); `rooms`: the list's rows (name matches); `openRoom(room)`,
 * `openHit(hit)`: where a pick goes; `onClose()`.
 */
export function RoomSearch({ client, rooms = [], openRoom, openHit, onClose }) {
  const ref = useRef(null), input = useRef(null);
  const [q, setQ] = useState("");
  const [res, setRes] = useState({ status: "idle", hits: [] });
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  // The native modal, as the Fleet's: focus trapped, Esc → cancel (closed through the parent), a click on the backdrop.
  useLayoutEffect(() => {
    const d = ref.current, opener = typeof document !== "undefined" ? document.activeElement : null;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
    input.current && input.current.focus();
    return () => { if (d && d.open && typeof d.close === "function") d.close(); if (opener && typeof opener.focus === "function" && document.contains?.(opener)) opener.focus(); };
  }, []);
  useEffect(() => {
    const d = ref.current; if (!d) return undefined;
    const onCancel = (e) => { e.preventDefault(); onClose(); }, onClick = (e) => { if (e.target === d) onClose(); };
    d.addEventListener("cancel", onCancel); d.addEventListener("click", onClick);
    return () => { d.removeEventListener("cancel", onCancel); d.removeEventListener("click", onClick); };
  }, [onClose]);
  const query = q.trim();
  // A room or chat by its name, or an agent chat by its owner's (what the list's filter matched before).
  const names = useMemo(() => (query ? rooms.filter((r) => [roomLabel(r), r.purpose, r.agent?.owner?.name].some((v) => String(v || "").toLowerCase().includes(query.toLowerCase()))).slice(0, 8) : []), [rooms, query]);
  // The messages: debounced; an older answer never replaces a newer query's; "Search older messages" appends.
  const run = async (text, cursor = null) => {
    const mine = ++seq.current;
    if (!text || typeof client?.searchRoomMessages !== "function") { setRes({ status: "idle", hits: [] }); return; }
    setRes((r) => ({ ...r, status: "loading", ...(cursor ? {} : { hits: [], cursor: null }) }));
    const a = await client.searchRoomMessages(text, { limit: 30, ...(cursor ? { cursor } : {}) });
    if (mine !== seq.current) return;
    if (a?.ok) setRes((r) => ({ status: "ok", hits: [...(cursor ? r.hits : []), ...(a.hits || [])], cursor: a.cursor || null }));
    else setRes((r) => ({ status: "error", hits: cursor ? r.hits : [], code: a?.code || "failed" }));
  };
  useEffect(() => { setActive(0); const h = setTimeout(() => void run(query), SEARCH_DEBOUNCE_MS); return () => clearTimeout(h); }, [query]);
  const groups = byRoom(res.hits, names.length);
  const flat = [...names.map((room) => ({ room })), ...groups.flatMap((g) => g.hits.map((x) => ({ hit: x.hit })))];
  const pick = (item) => { if (!item) return; onClose(); if (item.room) openRoom(item.room); else openHit(item.hit); };
  const onKey = (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (flat.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length); }
    else if (e.key === "Enter" && flat.length) { e.preventDefault(); pick(flat[Math.min(active, flat.length - 1)]); }
  };
  useEffect(() => { ref.current?.querySelector?.(`#hub-search-opt-${active}`)?.scrollIntoView?.({ block: "nearest" }); }, [active]);
  const activeId = flat.length ? `hub-search-opt-${Math.min(active, flat.length - 1)}` : undefined;
  const failed = res.status === "error";
  return html`<dialog data-trust="dialog" ref=${ref} class="dlg search-dlg hub-search-dlg" aria-label=${hroom("searchLabel")} onKeyDown=${onKey}>
    <div class="search-box">
      <div class="search-head"><${Icon} name="search" />
        <input ref=${input} class="search-input" type="search" value=${q} placeholder=${hroom("searchPlaceholder")} aria-label=${hroom("searchLabel")}
          role="combobox" aria-expanded=${flat.length ? "true" : "false"} aria-controls="hub-search-results" aria-autocomplete="list" aria-activedescendant=${activeId}
          autocomplete="off" spellcheck=${false} enterkeyhint="search" onInput=${(e) => setQ(e.target.value)} />
        <button type="button" class="icon-btn" aria-label=${hroom("searchClose")} title=${hroom("searchClose")} onClick=${onClose}><${Icon} name="close" /></button>
      </div>
      <div class="search-body">
        ${!query ? html`<div class="search-empty"><p class="search-hint">${hroom("searchHint")}</p></div>` : html`
          ${res.status === "loading" && !res.hits.length && !names.length ? html`<${Skeleton} variant="rows" lines=${4} label=${hroom("searchSearching")} />` : null}
          ${failed ? html`<p class="search-status bad" role="alert">${res.code === "busy" ? hroom("searchBusy") : hroom("searchFailed")}</p>` : null}
          ${res.status === "ok" && !res.hits.length && !names.length ? html`<p class="search-status" role="status">${res.cursor ? hroom("searchNoneYet") : hroom("searchNone")}</p>` : null}
          <div id="hub-search-results" role="listbox" aria-label=${hroom("searchResults")} class=${`search-results${res.status === "loading" ? " stale" : ""}`}>
            ${names.length ? html`<div role="group" class="search-group" aria-label=${hroom("searchRooms")}>
              <div class="search-group-head" aria-hidden="true"><span>${hroom("searchRooms")}</span></div>
              ${names.map((room, i) => html`<div id=${`hub-search-opt-${i}`} role="option" aria-selected=${i === active ? "true" : "false"} class=${`search-row${i === active ? " on" : ""}`}
                onMouseMove=${i === active ? undefined : () => setActive(i)} onClick=${() => pick({ room })}>
                <div class="search-row-top"><span class="search-badge chat">${room.kind === "group" ? hroom("searchBadgeRoom") : hroom("searchBadgeChat")}</span><span class="search-who">${roomLabel(room)}</span></div></div>`)}
            </div>` : null}
            ${groups.map((g) => html`<div role="group" class="search-group" aria-label=${g.name}>
              <div class="search-group-head" aria-hidden="true"><span>${g.name}</span><span class="search-count">${hroom("searchCount", String(g.hits.length))}</span></div>
              ${g.hits.map(({ hit, index }) => html`<div id=${`hub-search-opt-${index}`} role="option" aria-selected=${index === active ? "true" : "false"} class=${`search-row${index === active ? " on" : ""}`}
                onMouseMove=${index === active ? undefined : () => setActive(index)} onClick=${() => pick({ hit })}>
                <div class="search-row-top"><span class="search-who">${hit.author?.name || ""}</span>
                  <time class="search-time" datetime=${Number.isFinite(hit.at) ? new Date(hit.at).toISOString() : undefined}>${when(hit.at)}</time></div>
                <div class="search-snippet">${segments(hit.snippet, hit.marks).map((s) => (s.mark ? html`<mark>${s.text}</mark>` : s.text))}</div></div>`)}
            </div>`)}
          </div>
          ${res.cursor && res.status !== "loading" ? html`<p class="search-hint"><button type="button" class="chip-btn hub-search-more" onClick=${() => void run(query, res.cursor)}>${hroom("searchOlder")}</button></p>` : null}`}
      </div>
      <div class="search-foot" aria-hidden="true">${hroom("searchKeys")}</div>
    </div></dialog>`;
}
