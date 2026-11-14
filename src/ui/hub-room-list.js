// M-3092 (Hub rooms, track U): the Hub's conversation list, drawn as the Fleet chat draws its roster — the same row
// (`li.v-li > a.inst.v-inst`: avatar with its status dot, the name line and the second line), the same section head
// (`inst-head > side-label`, its count) and the same count badge (`nav-count`). docs/design/hub-rooms-ux.md §2:
// - two groups: 「房間」 (rooms: a square avatar with the name's first character, "3 人 · 12 個 Agent") and 「Agent」
//   (chats with one agent: a round avatar with the agent's presence dot, its owner's name; 「Hub 助理」 last, "Hub 提供");
// - unread first, then by the last message; archived ones last in their group; an unread @ to me is marked;
// - a list from a Hub without rooms yet (`limited`: today's chats) shows no dot and no unread — that Hub has neither;
// - S-145: 「最愛」 first, as the Fleet sidebar's favourites (#1664): starred from the row's menu, in the order starred or
//   moved (Edit), taken out of their own group; the same words, menu and marks (hub-room-favorites.js keeps them).
// Words: hub-room-strings.js (namespace hubRoom; #3850's flat keys).
import { html, useLayoutEffect, useRef } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { firstCharacter, MAX_FAVORITES } from "/assets/instance-nav.js";
import { Menu } from "/assets/ui-menu.js";
import { Icon } from "/assets/ui-icons.js";
import "./hub-room-strings.js";

const tr = (key, ...a) => t(`hubRoom.${key}`, ...a);
/** The Fleet sidebar's own words for favourites (view.*, with named values; agentRow.*): no Hub copy of them. */
const tv = (key, values = {}) => t(`view.${key}`).replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));

/**
 * Today's room (GET /hub/v1/rooms from a Hub without rooms) as a list row — for a client older than this page, whose
 * rooms() answers today's items and has no roomList() (an open tab after an upgrade). The same mapping as
 * hub-client.js legacyRoom() (tests/hub-room-list-3092.test.ts keeps the two equal).
 */
export function listRoomOf(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string") return null;
  return { id: item.id, kind: "direct", name: String(item.exposureName || ""), people: 1, agents: 1, online: null, unread: 0,
    lastAt: Number.isFinite(item.lastAt) ? item.lastAt : 0, lastText: "", lastAuthor: "",
    agent: { exposureId: String(item.exposureId || ""), owner: { name: String(item.ownerName || "") }, presence: null }, limited: true, legacy: item };
}
/** The rooms list from whichever client this page has: roomList() when it can, else rooms() mapped by listRoomOf(). */
export function readRoomList(client) {
  if (typeof client.roomList === "function") return client.roomList();
  return client.rooms().then((r) => (r && r.ok ? { ...r, rooms: (Array.isArray(r.rooms) ? r.rooms : []).map(listRoomOf).filter(Boolean) } : r));
}

/** A member's presence as the Fleet sidebar's dot classes (spec §5's colours): null for none. */
export function presenceDot(presence) {
  return presence === "online" || presence === "idle" ? "ok" : presence === "working" ? "busy" : presence === "paused" ? "warn"
    : presence === "offline" || presence === "later" ? "off" : null;
}

/** A room's counts, "3 人 · 12 個 Agent" / "1 person · 2 agents" — singular when one. */
export function countsLine(people, agents) {
  const p = Math.max(0, Number(people) || 0), a = Math.max(0, Number(agents) || 0);
  return `${p === 1 ? tr("peopleOne") : tr("peopleMany", String(p))} · ${a === 1 ? tr("agentsOne") : tr("agentsMany", String(a))}`;
}

const rank = (r) => (r.archived ? 2 : r.unread > 0 ? 0 : 1);
const order = (a, b) => rank(a) - rank(b) || (b.lastAt || 0) - (a.lastAt || 0) || String(a.name).localeCompare(String(b.name));

/**
 * The list's groups (spec §2): the favourites (S-145: `favs`, ids in their order), rooms, then the chats with one agent
 * (the Hub assistant's last). A favourite is in 「最愛」 only, not also in its own group. `q` filters by the name, an
 * agent's owner and the last line. → [{ key: "favorites" | "rooms" | "agents", items }] (an empty group is left out).
 */
export function groupRooms(rooms, q = "", favs = []) {
  const needle = String(q || "").trim().toLowerCase();
  const hit = (r) => !needle || [r.name, r.agent?.owner?.name, r.lastText].some((v) => String(v || "").toLowerCase().includes(needle));
  const all = (Array.isArray(rooms) ? rooms : []).filter((r) => r && typeof r.id === "string");
  const byId = new Map(all.map((r) => [r.id, r])), starred = new Set(Array.isArray(favs) ? favs : []);
  const list = all.filter((r) => !starred.has(r.id) && hit(r));
  const groups = [
    { key: "favorites", items: [...starred].map((id) => byId.get(id)).filter((r) => r && hit(r)) },
    { key: "rooms", items: list.filter((r) => r.kind === "group").sort(order) },
    { key: "agents", items: list.filter((r) => r.kind !== "group").sort((a, b) => (a.assistant ? 1 : 0) - (b.assistant ? 1 : 0) || order(a, b)) },
  ];
  return groups.filter((g) => g.items.length);
}

/** One row's view: its avatar, two lines, its count and @ mark. */
export function rowView(r) {
  const group = r.kind === "group", limited = r.limited === true;
  // Today's chats keep what their row said: closed, or a question waiting (the Fleet's working dot), else its owner.
  const closed = limited && r.legacy?.state === "closed", waiting = limited && !closed && r.legacy?.waiting === true;
  const line2 = group ? countsLine(r.people, r.agents)
    : closed ? t("hubChat.tagClosed") : waiting ? t("hubChat.waiting")
    : r.assistant ? tr("providedByHub") : String(r.agent?.owner?.name || "");
  return {
    title: r.assistant ? tr("hubAssistant") : String(r.name || ""), line2,
    avatar: { square: group, text: firstCharacter(r.assistant ? tr("hubAssistant") : String(r.name || "?")) || "?" },
    // The Hub assistant's dot is its own state (spec §10: 待命, or 暫時無法回答 when it can't answer): `presence` on its row.
    dot: group ? null : limited ? waiting ? "busy" : null : r.assistant ? presenceDot(r.presence || "idle") : presenceDot(r.agent?.presence),
    closed,
    unread: limited ? 0 : Math.max(0, Number(r.unread) || 0), mentioned: !limited && r.mentioned === true, archived: r.archived === true || closed,
  };
}

const listTime = (ms) => {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
};

/**
 * The groups as the Fleet roster draws them. `current`: the open room's id; `onGo(e, room)`: a row was chosen; `star`
 * (useRoomStar): the favourites — each row's menu stars it, Edit moves the starred ones (none: no menu, no 「最愛」).
 */
export function HubRoomRows({ rooms, q = "", current = null, href, onGo, star = null }) {
  const favs = star ? star.ids : [];
  const filtered = !!String(q || "").trim();
  // #1664's focus rule: after a star or a move the row is drawn elsewhere — its menu button gets the focus back.
  // (The phone's home list and the sidebar can both be in the page: the one on screen.)
  const focusRow = useRef(null);
  useLayoutEffect(() => {
    if (!focusRow.current || typeof document === "undefined") return;
    const id = focusRow.current;
    focusRow.current = null;
    const btn = [...document.querySelectorAll(".hub-rooms > [data-room] > .inst-row-menu > button")]
      .find((el) => el.parentElement.parentElement.getAttribute("data-room") === id && el.offsetParent !== null);
    btn?.focus();
  });
  const styledMenus = typeof getComputedStyle === "function" && typeof document !== "undefined"
    && getComputedStyle(document.documentElement).getPropertyValue?.("--agent-menu-version")?.trim() === "1";
  // The row's ⋯ is the Fleet's 28px row-menu button (`.inst-row-menu > .icon-btn`); `icon-btn-row` names it as its own kind
  // beside the page's 36px icon buttons (the Hub UI gate: one height per button kind).
  const row = (r, fav, i, count) => {
    const v = rowView(r), on = current === r.id, starred = favs.includes(r.id), full = !starred && favs.length >= MAX_FAVORITES;
    const items = star ? [
      { key: "favorite", label: t(`agentRow.${starred ? "remove" : "add"}`), icon: "star", disabled: full, iconClass: starred ? "menu-starred" : undefined,
        title: full ? tv("favFull", { max: MAX_FAVORITES }) : undefined, onSelect: () => { focusRow.current = r.id; star.toggle(r.id); } },
      ...(fav && star.editing ? [
        { key: "up", label: tv("favUp", { name: v.title }), icon: "up", disabled: filtered || i === 0,
          title: filtered ? tv("favFiltered") : tv("favUp", { name: v.title }), onSelect: () => { if (!filtered) { focusRow.current = r.id; star.move(r.id, -1); } } },
        { key: "down", label: tv("favDown", { name: v.title }), icon: "down", disabled: filtered || i === count - 1,
          title: filtered ? tv("favFiltered") : tv("favDown", { name: v.title }), onSelect: () => { if (!filtered) { focusRow.current = r.id; star.move(r.id, 1); } } },
      ] : []),
    ] : [];
    return html`<li key=${r.id} class="v-li two-line" data-room=${r.id}>
        <a class=${`inst v-inst${on ? " active" : ""}${starred ? " inst-favorite" : ""}${v.archived ? " hub-room-archived" : ""}`} href=${href(r)} aria-current=${on ? "page" : undefined}
          onClick=${(e) => onGo(e, r)}>
          <span class=${`av${v.avatar.square ? " av-square" : ""}`}><span class="av-text" aria-hidden="true">${v.avatar.text}</span>${v.dot
            ? html`<span class=${`av-dot dot ${v.dot}`} aria-hidden="true"></span>` : null}</span>
          <span class="inst-text"><span class="inst-line"><span class="inst-name" title=${v.title}>${v.title}</span><span class="v-meta">${listTime(r.lastAt)}</span></span>
            <span class="inst-line inst-line2"><span class="inst-alt" title=${v.line2 || undefined}>${v.archived ? `${tr("archived")} · ${v.line2}` : v.line2}</span>
              ${v.mentioned ? html`<span class="hub-room-at" title=${tr("mentionedYou")}>@</span>` : null}
              ${v.unread ? html`<span class="nav-count" title=${tr("unreadN", String(v.unread))}>${v.unread > 99 ? "99+" : v.unread}</span>` : null}</span></span>
        </a>${items.length ? html`<${Menu} cls=${`inst-workspace inst-row-menu agent-menu${starred ? " is-favorite" : ""}`} fit=${true} topLayer=${true}
          ownerKey=${r.id} label=${t("agentRow.actions", v.title)} items=${items} triggerClass="icon-btn icon-btn-row"
          trigger=${styledMenus ? html`<span class="inst-menu-star" aria-hidden="true">${starred ? html`<${Icon} name="star" size=${14} />` : null}</span><span class="inst-menu-more" aria-hidden="true"><${Icon} name="more" size=${16} /></span>` : undefined} />` : null}</li>`;
  };
  return html`${groupRooms(rooms, q, favs).map((g) => g.key === "favorites"
    // #1664: 最愛 — always open, its rows moved with ↑ ↓ in Edit, named in the page's language.
    // Its head is drawn as its neighbours' (「房間」, 「Agent」), with the Fleet's star before the name and its Edit after the count.
    ? html`<div key=${g.key} class=${`hub-room-group hub-room-favs${star?.editing ? " fav-editing" : ""}`} data-group="favorites" role="group" aria-label=${tv("favorites")}>
      <div class="inst-head fav-head"><h2 class="side-label"><${Icon} name="star" size=${12} cls="fav-mark" />${tv("favorites")}</h2><span class="count">${g.items.length}</span>
        ${g.items.length > 1 ? html`<button type="button" class="chip-btn fav-edit" aria-pressed=${star.editing ? "true" : "false"} onClick=${() => star.setEditing(!star.editing)}>
          ${star.editing ? tv("favDone") : html`<${Icon} name="star" size=${12} />${tv("favEdit")}`}</button>` : null}</div>
      <ul class="hub-rooms" role="list">${g.items.map((r, i) => row(r, true, i, g.items.length))}</ul></div>`
    : html`<div key=${g.key} class="hub-room-group" data-group=${g.key}>
      <div class="inst-head"><h2 class="side-label">${tr(g.key === "rooms" ? "roomsGroup" : "agentsGroup")}</h2><span class="count">${g.items.length}</span></div>
      <ul class="hub-rooms" role="list">${g.items.map((r) => row(r, false, 0, 0))}</ul></div>`)}`;
}
