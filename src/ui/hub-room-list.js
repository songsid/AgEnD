// M-3092 (Hub rooms, track U): the Hub's conversation list, drawn as the Fleet chat draws its roster — the same row
// (`li.v-li > a.inst.v-inst`: avatar with its status dot, the name line and the second line), the same section head
// (`inst-head > side-label`, its count) and the same count badge (`nav-count`). docs/design/hub-rooms-ux.md §2:
// - two groups: 「房間」 (rooms: a square avatar with the name's first character, "3 人 · 12 個 Agent") and 「Agent」
//   (chats with one agent: a round avatar with the agent's presence dot, its owner's name; 「Hub 助理」 last, "Hub 提供");
// - unread first, then by the last message; archived ones last in their group; an unread @ to me is marked;
// - a list from a Hub without rooms yet (`limited`: today's chats) shows no dot and no unread — that Hub has neither.
// Words: hub-room-strings.js (namespace hubRoom; #3850's flat keys).
import { html } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { firstCharacter } from "/assets/instance-nav.js";
import "./hub-room-strings.js";

const tr = (key, ...a) => t(`hubRoom.${key}`, ...a);

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
 * The list's groups (spec §2): rooms, then the chats with one agent (the Hub assistant's last). `q` filters by the name, an
 * agent's owner and the last line. → [{ key: "rooms" | "agents", items }] (an empty group is left out).
 */
export function groupRooms(rooms, q = "") {
  const needle = String(q || "").trim().toLowerCase();
  const hit = (r) => !needle || [r.name, r.agent?.owner?.name, r.lastText].some((v) => String(v || "").toLowerCase().includes(needle));
  const list = (Array.isArray(rooms) ? rooms : []).filter((r) => r && typeof r.id === "string" && hit(r));
  const groups = [
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

/** The groups as the Fleet roster draws them. `current`: the open room's id; `onGo(e, room)`: a row was chosen. */
export function HubRoomRows({ rooms, q = "", current = null, href, onGo }) {
  return html`${groupRooms(rooms, q).map((g) => html`<div key=${g.key} class="hub-room-group" data-group=${g.key}>
    <div class="inst-head"><h2 class="side-label">${tr(g.key === "rooms" ? "roomsGroup" : "agentsGroup")}</h2><span class="count">${g.items.length}</span></div>
    <ul class="hub-rooms" role="list">${g.items.map((r) => {
      const v = rowView(r), on = current === r.id;
      return html`<li key=${r.id} class="v-li two-line" data-room=${r.id}>
        <a class=${`inst v-inst${on ? " active" : ""}${v.archived ? " hub-room-archived" : ""}`} href=${href(r)} aria-current=${on ? "page" : undefined}
          onClick=${(e) => onGo(e, r)}>
          <span class=${`av${v.avatar.square ? " av-square" : ""}`}><span class="av-text" aria-hidden="true">${v.avatar.text}</span>${v.dot
            ? html`<span class=${`av-dot dot ${v.dot}`} aria-hidden="true"></span>` : null}</span>
          <span class="inst-text"><span class="inst-line"><span class="inst-name" title=${v.title}>${v.title}</span><span class="v-meta">${listTime(r.lastAt)}</span></span>
            <span class="inst-line inst-line2"><span class="inst-alt" title=${v.line2 || undefined}>${v.archived ? `${tr("archived")} · ${v.line2}` : v.line2}</span>
              ${v.mentioned ? html`<span class="hub-room-at" title=${tr("mentionedYou")}>@</span>` : null}
              ${v.unread ? html`<span class="nav-count" title=${tr("unreadN", String(v.unread))}>${v.unread > 99 ? "99+" : v.unread}</span>` : null}</span></span>
        </a></li>`;
    })}</ul></div>`)}`;
}
