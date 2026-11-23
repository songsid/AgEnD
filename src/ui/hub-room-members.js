import {rp} from "./hub-room-purpose.js";
import { hi } from "./hub-agent-intro.js";
// Hub rooms, the right-hand members panel (docs/design/hub-rooms-ux.md section 5): the people, the agents in presence
// order, the room assistant, who can see what, and (for a room manager) the way to Room settings. Clicking an agent
// opens a small card: @ it here, chat with it one-to-one (only when I may ask it), and, for a manager, remove it.
// The dots use the Fleet sidebar's colours (.dot ok / busy / warn / off), so a state reads the same in both.
// The shell owns the room's detail (and reads it again on member.changed); this panel applies presence.changed in place.
import { html, useEffect, useState } from "/assets/app-html.js";
import { lang } from "/assets/app-i18n.js";
import { hubClient } from "./hub-client.js";
import { hm } from "./hub-room-members-strings.js";
import { hroom } from "./hub-room-strings.js";
import { collapse, headerCounts, presenceDot, presenceView, sortAgents } from "./hub-room-presence.js";
import { hn, linkRoomsU2Css } from "./hub-room-new-strings.js";
import { roomSource, RoomSourceMark } from "./hub-room-source.js";
import { firstCharacter } from "/assets/instance-nav.js";

linkRoomsU2Css();

const AGENTS_SHOWN = 8;
/**
 * M-3533 M1 (docs/design/hub-office-visit.md §2.6): past this many people and agents together, the list is compact — a
 * summary line, a filter, one line a row, the people not online folded, the agents grouped by owner (folded). A smaller
 * room keeps today's list.
 */
export const COMPACT_OVER = 12;

/** M1: a member matches the filter by its name or (an agent) its owner's, ignoring case. */
export const memberMatches = (m, q) => { const s = String(q || "").trim().toLocaleLowerCase(); return !s || `${m.name || ""} ${m.owner?.name || ""}`.toLocaleLowerCase().includes(s); };

/**
 * M1: the agents by owner — keyed by the owner's id (two owners of one name are two groups), named by their name; my own
 * group first, then the owners by name in the viewer's language (a group does not move as its agents start and stop).
 * Within a group, the list's own order (presence).
 */
export function byOwner(agents, locale = undefined) {
  const groups = new Map();
  for (const m of agents) {
    const key = String(m.owner?.id || `name:${m.owner?.name || ""}`);
    if (!groups.has(key)) groups.set(key, { key, owner: String(m.owner?.name || ""), mine: m.owner?.mine === true, agents: [] });
    groups.get(key).agents.push(m);
  }
  return [...groups.values()].sort((a, b) => (Number(b.mine) - Number(a.mine)) || a.owner.localeCompare(b.owner, locale) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** M1: people in a stable order — me first, then by name in the viewer's language, the member id breaking a tie. */
export function peopleOrder(people, meId, locale = undefined) {
  return [...people].sort((a, b) => (Number(b.id === meId) - Number(a.id === meId)) || String(a.name || "").localeCompare(String(b.name || ""), locale)
    || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

/**
 * The dot class and words for one member, from the shared rooms presence mapping (hub-room-presence.js: reason codes,
 * known notes in the viewer's language, the same online count as the list). Only two things are this panel's own: a
 * person added before their first Hub sign-in (they see the room when they first sign in), and the assistant's idle
 * row reading 「待命 · Hub 提供」.
 */
export function memberStatus(m) {
  if (m.kind === "person" && m.signedIn === false) return { dot: "off", text: hn("neverSignedIn") };
  const v = presenceView(m);
  const word = m.kind === "assistant" && v.word === "stIdle" ? hroom("assistantIdleHub") : hroom(v.word);
  const note = v.noteKey ? hroom(v.noteKey) : v.noteText;
  // M-3137 (versions spec §2.4): an agent whose Fleet needs an AgEnD update says whom to ask, not only whose it is.
  return { dot: presenceDot(v.dot), text: note ? `${word} · ${note}` : word, ...(v.word === "needsUpdate" ? { update: true } : {}) };
}

/**
 * M-3533 R2a: an agent's avatar as its owner's Fleet shows it — its persona emoji, else its initial — on its identity
 * colour (the room detail's `look`, from the owner's catalog), else on the default tint. Text on the colour is whichever
 * of near-black and white reads better on it.
 */
export function agentAvatar(m) {
  const color = typeof m?.look?.color === "string" && /^#[0-9a-f]{6}$/i.test(m.look.color) ? m.look.color.toLowerCase() : null;
  const emoji = typeof m?.look?.emoji === "string" && m.look.emoji.trim() ? m.look.emoji.trim() : "";
  const rgb = color ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) : null;
  const lum = rgb ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] : null;
  return { color, text: emoji || firstCharacter(m?.name || "") || "?", emoji: !!emoji, ink: lum === null ? null : (1.05 / (lum + 0.05) >= (lum + 0.05) / 0.05 ? "#ffffff" : "#111111") };
}
/**
 * The avatar in the row (the emoji or initial drawn from `data-av`, so the row's text is still the name alone), and
 * M-3256's source badge on its bottom-right corner, ringed in the row's colour: one slot, the row stays one line.
 */
function AgentAvatar({ m }) {
  const a = agentAvatar(m), source = roomSource(m);
  return html`<span class="hub-agent-av-wrap" aria-hidden="true"><span class=${`hub-agent-av${a.emoji ? " emoji" : ""}`} data-av=${a.text}
    style=${a.color ? `--av:${a.color};--av-ink:${a.ink}` : undefined}></span>${source ? html`<span class="hub-agent-av-src"><${RoomSourceMark} source=${source} decorative=${true} /></span>` : null}</span>`;
}

/** 「林小華的 Agent」, but 「Alex 的 Agent」: a name ending in a Latin letter or digit takes a space before 的 (Lumen). */
export function ownerAgent(name) {
  return hm(/[A-Za-z0-9]$/.test(name) ? "ownerAgentLatin" : "ownerAgent", name);
}

/**
 * The panel, in the right rail of a group room. Props (one mount line in the shell):
 * - client;
 * - roomId;
 * - detail: the shell's own GET /hub/v1/rooms/:id answer { room, me: { id?, role }, members, settings, invited }. The
 *   shell reads it again on member.changed, so it is not read here. Only presence.changed is applied here, in place,
 *   until the next detail;
 * - onMention(member): puts 「@name 」 in the composer;
 * - onOpenChat(member): opens the one-to-one, offered only for an agent whose member row says `canAsk`;
 * - onSettings();
 * - compact (M1): true / false for that list whatever the size; absent, a room over COMPACT_OVER gets the compact one.
 */
export function RoomMembersPanel({ client = hubClient(), roomId, detail, onMention, onOpenChat, onSettings, compact: force = undefined } = {}) {
  const [presence, setPresence] = useState({}), [open, setOpen] = useState(null), [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [gone, setGone] = useState({}), [q, setQ] = useState("");
  useEffect(() => { setPresence({}); setGone({}); }, [detail]);
  useEffect(() => client.subscribeRooms?.({
    // The whole state each time: presence, its reason code and note. One the event omits is cleared (undefined), so a
    // stale reason or note never outlives the presence it came with.
    "presence.changed": (e) => { if (e?.roomId === roomId && typeof e.memberId === "string") setPresence(old => ({ ...old, [e.memberId]: { presence: e.presence, presenceReason: e.presenceReason, presenceNote: e.presenceNote } })); },
  }) ?? (() => {}), [client, roomId]);
  if (!detail || !Array.isArray(detail.members)) return html`<aside class="hub-room-members" aria-busy="true"></aside>`;
  const data = { role: detail.me?.role === "manager" ? "manager" : "member",
    members: detail.members.filter(m => m && !gone[m.id]).map(m => presence[m.id] ? { ...m, ...presence[m.id] } : m) };
  const meId = detail.me?.id;
  const manager = data.role === "manager";
  // Me first, then who is online, then the offline and those who have never signed in (spec 8224c4675).
  const personRank = (m) => m.id === meId ? 0 : m.presence === "online" ? 1 : 2;
  const people = data.members.filter(m => m.kind === "person").sort((a, b) => personRank(a) - personRank(b));
  const agents = sortAgents(data.members), heads = headerCounts(data.members);
  const assistant = data.members.find(m => m.kind === "assistant");
  const fold = collapse(agents, AGENTS_SHOWN), shown = expanded ? agents : fold.shown;
  const remove = async (m) => {
    setBusy(true); setFailed(false);
    const r = await client.removeRoomMember(roomId, m.id);
    setBusy(false);
    if (r?.ok) { setOpen(null); setGone(old => ({ ...old, [m.id]: true })); }   // the shell reads the room again on member.changed
    else setFailed(true);
  };
  // `compact` true / false: that list whatever the room's size (the classic list's own tests); by default, by size.
  const compact = typeof force === "boolean" ? force : people.length + agents.length > COMPACT_OVER;
  // An agent's second line names whose it is beside its state (「處理中 · 林小華的 Agent」), always shown, not only on hover.
  // M1: in a compact list a row is one line — the name, its state — and the owner and introduction move into its card.
  const row = (m, extra = null) => {
    const v = memberStatus(m), owner = !compact && (m.kind === "agent" || m.kind === "later") && m.owner?.name ? (v.update ? hm("askOwner", m.owner.name) : ownerAgent(m.owner.name)) : "";
    // R2a: an agent's avatar takes the source mark's slot, the mark on its corner (the source also in the title and card).
    const agentRow = m.kind === "agent" || m.kind === "later";
    return html`<span class="hub-member-name">${agentRow ? html`<${AgentAvatar} m=${m} />` : html`<${RoomSourceMark} source=${roomSource(m)} decorative=${true} />`}${m.name}${extra}</span><span class="hub-member-state"><span class=${`dot ${v.dot}`} aria-hidden="true"></span><span>${v.text}</span>${owner ? html`<span class="hub-member-owner">· ${owner}</span>` : null}</span>${!compact&&(m.intro||m.kind==="assistant")?html`<small class="note">${m.kind==="assistant"?hi("assistant"):m.intro}</small>`:null}`;
  };
  const person = (m) => html`<li class="hub-member" key=${m.id}>${row(m, html`${m.id === meId ? html` <span class="tag">${hroom("roleYou")}</span>` : null}${m.role === "manager" ? html` <span class="tag">${hroom("roleManager")}</span>` : null}`)}</li>`;
  const agentItem = (m) => html`<li class="hub-member hub-member-agent" key=${m.id}>
        <button type="button" class="hub-member-open" title=${roomSource(m)?.label || ""} aria-label=${`${m.name}. ${memberStatus(m).text}. ${roomSource(m)?.label || ""}`} aria-expanded=${open === m.id} onClick=${() => { setFailed(false); setOpen(open === m.id ? null : m.id); }}>${row(m)}</button>
        ${open === m.id ? html`<div class="hub-member-card" role="group" aria-label=${m.name}>
          <strong>${m.name}</strong>${m.intro?html`<p class="note">${m.intro}</p>`:null}${m.owner?.name ? html`<small class="note">${hm("ownerOf", m.owner.name)}</small>` : null}
          <small class="note hub-source-explanation">${roomSource(m)?.label}</small>
          <small class="note">${memberStatus(m).text}</small>
          <div class="field-row">
            <button type="button" class="btn" onClick=${() => { setOpen(null); onMention?.(m); }}>${hroom("mentionHere")}</button>
            ${m.canAsk === true ? html`<button type="button" class="btn" onClick=${() => { setOpen(null); onOpenChat?.(m); }}>${hroom("chatOneToOne")}</button>` : null}
            ${manager ? html`<button type="button" class="btn btn-danger" disabled=${busy} onClick=${() => remove(m)}>${hroom("removeFromRoom")}</button>` : null}
          </div>
          ${failed ? html`<p class="note" role="alert">${hm("removeFailed")}</p>` : null}
        </div>` : null}
      </li>`;
  // M1: the compact list (§2.6) — the summary, the filter, who is online, the rest folded; the agents by owner, folded.
  // A filter opens every group with a match and shows only the matches; the summary keeps the room's counts, and the two
  // headings say how many match of how many (the leader, #4366: clear that the list is filtered).
  const compactList = () => {
    const locale = lang(), ordered = peopleOrder(people, meId, locale);
    const online = ordered.filter((m) => m.id === meId || m.presence === "online"), owners = byOwner(agents, locale);
    const on = online.filter((m) => memberMatches(m, q)), off = ordered.filter((m) => !online.includes(m) && memberMatches(m, q));
    const groups = owners.map((g) => ({ ...g, shown: g.agents.filter((m) => memberMatches(m, q)) })).filter((g) => g.shown.length);
    const filtering = !!q.trim();
    return html`<p class="note hub-members-sum">${hm("summary", people.length, online.length, agents.length, owners.length)}</p>
    <input class="hub-members-filter" type="search" value=${q} placeholder=${hm("filter")} aria-label=${hm("filterLabel")} onInput=${(e) => setQ(e.target.value)} />
    ${filtering && !on.length && !off.length && !groups.length ? html`<p class="note hub-members-none" role="status">${hm("noMatch")}</p>` : null}
    <section class="hub-members-people"><h4>${filtering ? hm("membersMatch", on.length + off.length, people.length) : heads.member}</h4>
      ${on.length ? html`<ul>${on.map(person)}</ul>` : null}
      ${off.length ? html`<details class="hub-member-group hub-members-offline" open=${filtering}><summary>${hm("notOnline", off.length)}</summary><ul>${off.map(person)}</ul></details>` : null}
    </section>
    ${agents.length ? html`<section><h4>${filtering ? hm("agentsMatch", groups.reduce((n, g) => n + g.shown.length, 0), agents.length) : heads.agent}</h4>
      ${groups.map((g) => html`<details class="hub-member-group hub-members-owner" key=${g.key} open=${filtering}><summary>${hm("ownerGroup", g.owner || hm("noOwner"), filtering ? g.shown.length : g.agents.length)}</summary><ul>${g.shown.map(agentItem)}</ul></details>`)}
    </section>` : null}`;
  };
  return html`<aside class=${`hub-room-members${compact ? " compact" : ""}`}>
    ${detail.room?.purpose?html`<section class="hub-room-purpose-panel"><h4>${rp("title")}</h4><p>${detail.room.purpose}</p></section>`:manager&&client.roomPurposeV1===true&&typeof detail.room?.purpose==="string"?html`<button type="button" class="btn btn-link" onClick=${()=>onSettings?.()}>${rp("add")}</button>`:null}
    ${compact ? compactList() : html`<section><h4>${heads.member}</h4>
      <ul>${people.map(person)}</ul>
    </section>
    ${agents.length ? null : html`<section class="hub-room-no-agents"><h4>${hm("agents")}</h4><p class="note">${hm("noAgents")}</p></section>`}
    ${agents.length ? html`<section><h4>${heads.agent}</h4>
      <ul>${shown.map(agentItem)}</ul>
      ${fold.rest ? html`<button type="button" class="btn btn-link hub-members-more" onClick=${() => setExpanded(!expanded)}>${expanded ? hm("fewer") : hroom("moreN", fold.rest)}</button>` : null}
    </section>` : null}`}
    ${assistant ? html`<section><ul><li class="hub-member hub-member-assistant">${row({ ...assistant, name: hroom("roomAssistant") })}</li></ul></section>` : null}
    <section class="hub-room-who"><h4>${hroom("whoSees")}</h4><p class="note">${hroom("whoSeesRoom")}</p></section>
    ${manager ? html`<button type="button" class="btn btn-link hub-room-settings-link" onClick=${() => onSettings?.()}>${hroom("roomSettings")}</button>` : null}
  </aside>`;
}
