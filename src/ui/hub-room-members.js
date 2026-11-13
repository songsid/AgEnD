// Hub rooms, the right-hand members panel (docs/design/hub-rooms-ux.md section 5): the people, the agents in presence
// order, the room assistant, who can see what, and (for a room manager) the way to Room settings. Clicking an agent
// opens a small card: @ it here, chat with it one-to-one (only when I may ask it), and, for a manager, remove it.
// The dots use the Fleet sidebar's colours (.dot ok / busy / warn / off), so a state reads the same in both.
// The shell owns the room's detail (and reads it again on member.changed); this panel applies presence.changed in place.
import { html, useEffect, useState } from "/assets/app-html.js";
import { hubClient } from "./hub-client.js";
import { hm } from "./hub-room-members-strings.js";
import { hroom } from "./hub-room-strings.js";
import { hn, linkRoomsU2Css } from "./hub-room-new-strings.js";

linkRoomsU2Css();

const AGENT_ORDER = { working: 0, idle: 1, paused: 2, offline: 3, later: 4 };
const AGENTS_SHOWN = 8;
const isAgent = (m) => m.kind === "agent" || m.kind === "later";
const agentOnline = (m) => m.presence === "idle" || m.presence === "working" || m.presence === "paused";

/** The dot class and words for one member's presence. */
export function presenceView(m) {
  // Added from a group or team before their first Hub sign-in: they see the room when they first sign in.
  if (m.kind === "person" && m.signedIn === false) return { dot: "off", text: hn("neverSignedIn") };
  if (m.kind === "person") return m.presence === "online" ? { dot: "ok", text: hroom("stOnline") } : { dot: "off", text: hroom("stOffline") };
  if (m.kind === "assistant") return m.presence === "working" ? { dot: "busy", text: hroom("stWorking") }
    : m.presence === "paused" ? { dot: "warn", text: hroom("stAssistantDown") } : { dot: "ok", text: hroom("assistantIdleHub") };
  if (m.kind === "later") return m.presence === "online" || m.presence === "idle" ? { dot: "ok", text: hroom("stOnline") } : { dot: "off", text: hroom("stLater") };
  switch (m.presence) {
    case "working": return { dot: "busy", text: hroom("stWorking") };
    case "idle": return { dot: "ok", text: hroom("stIdle") };
    case "paused": return { dot: "warn", text: m.presenceNote ? `${hroom("stPaused")} · ${m.presenceNote}` : hroom("stPaused") };
    case "later": return { dot: "off", text: hroom("stLater") };
    default: return { dot: "off", text: m.presenceNote || hroom("stOffline") };   // 「需要更新 AgEnD」 comes as the note
  }
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
 * - onSettings().
 */
export function RoomMembersPanel({ client = hubClient(), roomId, detail, onMention, onOpenChat, onSettings } = {}) {
  const [presence, setPresence] = useState({}), [open, setOpen] = useState(null), [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [gone, setGone] = useState({});
  useEffect(() => { setPresence({}); setGone({}); }, [detail]);
  useEffect(() => client.subscribeRooms?.({
    "presence.changed": (e) => { if (e?.roomId === roomId && typeof e.memberId === "string") setPresence(old => ({ ...old, [e.memberId]: { presence: e.presence, presenceNote: e.presenceNote } })); },
  }) ?? (() => {}), [client, roomId]);
  if (!detail || !Array.isArray(detail.members)) return html`<aside class="hub-room-members" aria-busy="true"></aside>`;
  const data = { role: detail.me?.role === "manager" ? "manager" : "member",
    members: detail.members.filter(m => m && !gone[m.id]).map(m => presence[m.id] ? { ...m, ...presence[m.id] } : m) };
  const meId = detail.me?.id;
  const manager = data.role === "manager";
  // Me first, then who is online, then the offline and those who have never signed in (spec 8224c4675).
  const personRank = (m) => m.id === meId ? 0 : m.presence === "online" ? 1 : 2;
  const people = data.members.filter(m => m.kind === "person").sort((a, b) => personRank(a) - personRank(b));
  const agents = data.members.filter(isAgent).sort((a, b) => (AGENT_ORDER[a.presence] ?? 3) - (AGENT_ORDER[b.presence] ?? 3));
  const assistant = data.members.find(m => m.kind === "assistant");
  const shown = expanded || agents.length <= AGENTS_SHOWN ? agents : agents.slice(0, AGENTS_SHOWN);
  const remove = async (m) => {
    setBusy(true); setFailed(false);
    const r = await client.removeRoomMember(roomId, m.id);
    setBusy(false);
    if (r?.ok) { setOpen(null); setGone(old => ({ ...old, [m.id]: true })); }   // the shell reads the room again on member.changed
    else setFailed(true);
  };
  const row = (m, extra = null) => {
    const v = presenceView(m);
    return html`<span class="hub-member-name">${m.name}${extra}</span><span class="hub-member-state"><span class=${`dot ${v.dot}`} aria-hidden="true"></span>${v.text}</span>`;
  };
  return html`<aside class="hub-room-members">
    <section><h4>${hroom("membersHead", people.length, people.filter(m => m.presence === "online").length)}</h4>
      <ul>${people.map(m => html`<li class="hub-member" key=${m.id}>${row(m, html`${m.id === meId ? html` <span class="tag">${hroom("roleYou")}</span>` : null}${m.role === "manager" ? html` <span class="tag">${hroom("roleManager")}</span>` : null}`)}</li>`)}</ul>
    </section>
    ${agents.length ? null : html`<section class="hub-room-no-agents"><h4>${hm("agents")}</h4><p class="note">${hm("noAgents")}</p></section>`}
    ${agents.length ? html`<section><h4>${hroom("agentsHead", agents.length, agents.filter(agentOnline).length)}</h4>
      <ul>${shown.map(m => html`<li class="hub-member hub-member-agent" key=${m.id}>
        <button type="button" class="hub-member-open" title=${m.owner?.name ? hm("ownerOf", m.owner.name) : ""} aria-expanded=${open === m.id} onClick=${() => { setFailed(false); setOpen(open === m.id ? null : m.id); }}>${row(m)}</button>
        ${open === m.id ? html`<div class="hub-member-card" role="group" aria-label=${m.name}>
          <strong>${m.name}</strong>${m.owner?.name ? html`<small class="note">${hm("ownerOf", m.owner.name)}</small>` : null}
          <small class="note">${presenceView(m).text}</small>
          <div class="field-row">
            <button type="button" class="btn" onClick=${() => { setOpen(null); onMention?.(m); }}>${hroom("mentionHere")}</button>
            ${m.canAsk === true ? html`<button type="button" class="btn" onClick=${() => { setOpen(null); onOpenChat?.(m); }}>${hroom("chatOneToOne")}</button>` : null}
            ${manager ? html`<button type="button" class="btn btn-danger" disabled=${busy} onClick=${() => remove(m)}>${hroom("removeFromRoom")}</button>` : null}
          </div>
          ${failed ? html`<p class="note" role="alert">${hm("removeFailed")}</p>` : null}
        </div>` : null}
      </li>`)}</ul>
      ${agents.length > AGENTS_SHOWN ? html`<button type="button" class="btn btn-link hub-members-more" onClick=${() => setExpanded(!expanded)}>${expanded ? hm("fewer") : hroom("moreN", agents.length - AGENTS_SHOWN)}</button>` : null}
    </section>` : null}
    ${assistant ? html`<section><ul><li class="hub-member hub-member-assistant">${row({ ...assistant, name: hroom("roomAssistant") })}</li></ul></section>` : null}
    <section class="hub-room-who"><h4>${hroom("whoSees")}</h4><p class="note">${hroom("whoSeesRoom")}</p></section>
    ${manager ? html`<button type="button" class="btn btn-link hub-room-settings-link" onClick=${() => onSettings?.()}>${hroom("roomSettings")}</button>` : null}
  </aside>`;
}
