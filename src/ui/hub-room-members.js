// Hub rooms, the right-hand members panel (docs/design/hub-rooms-ux.md section 5): the people, the agents in presence
// order, the room assistant, who can see what, and (for a room manager) the way to Room settings. Clicking an agent
// opens a small card: @ it here, chat with it one-to-one (only when I may ask it), and, for a manager, remove it.
// The dots use the Fleet sidebar's colours (.dot ok / busy / warn / off), so a state reads the same in both.
// The shell owns the room's detail (and reads it again on member.changed); this panel applies presence.changed in place.
import { html, useEffect, useState } from "/assets/app-html.js";
import { hubClient } from "./hub-client.js";
import { hm } from "./hub-room-members-strings.js";
import { hroom } from "./hub-room-strings.js";
import { collapse, headerCounts, presenceDot, presenceView, sortAgents } from "./hub-room-presence.js";
import { hn, linkRoomsU2Css } from "./hub-room-new-strings.js";

linkRoomsU2Css();

const AGENTS_SHOWN = 8;

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
  return { dot: presenceDot(v.dot), text: note ? `${word} · ${note}` : word };
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
 * - onSettings().
 */
export function RoomMembersPanel({ client = hubClient(), roomId, detail, onMention, onOpenChat, onSettings } = {}) {
  const [presence, setPresence] = useState({}), [open, setOpen] = useState(null), [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [gone, setGone] = useState({});
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
  // An agent's second line names whose it is beside its state (「處理中 · 林小華的 Agent」), always shown, not only on hover.
  const row = (m, extra = null) => {
    const v = memberStatus(m), owner = (m.kind === "agent" || m.kind === "later") && m.owner?.name ? ownerAgent(m.owner.name) : "";
    return html`<span class="hub-member-name">${m.name}${extra}</span><span class="hub-member-state"><span class=${`dot ${v.dot}`} aria-hidden="true"></span><span>${v.text}</span>${owner ? html`<span class="hub-member-owner">· ${owner}</span>` : null}</span>`;
  };
  return html`<aside class="hub-room-members">
    <section><h4>${heads.member}</h4>
      <ul>${people.map(m => html`<li class="hub-member" key=${m.id}>${row(m, html`${m.id === meId ? html` <span class="tag">${hroom("roleYou")}</span>` : null}${m.role === "manager" ? html` <span class="tag">${hroom("roleManager")}</span>` : null}`)}</li>`)}</ul>
    </section>
    ${agents.length ? null : html`<section class="hub-room-no-agents"><h4>${hm("agents")}</h4><p class="note">${hm("noAgents")}</p></section>`}
    ${agents.length ? html`<section><h4>${heads.agent}</h4>
      <ul>${shown.map(m => html`<li class="hub-member hub-member-agent" key=${m.id}>
        <button type="button" class="hub-member-open" title=${m.owner?.name ? hm("ownerOf", m.owner.name) : ""} aria-expanded=${open === m.id} onClick=${() => { setFailed(false); setOpen(open === m.id ? null : m.id); }}>${row(m)}</button>
        ${open === m.id ? html`<div class="hub-member-card" role="group" aria-label=${m.name}>
          <strong>${m.name}</strong>${m.owner?.name ? html`<small class="note">${hm("ownerOf", m.owner.name)}</small>` : null}
          <small class="note">${memberStatus(m).text}</small>
          <div class="field-row">
            <button type="button" class="btn" onClick=${() => { setOpen(null); onMention?.(m); }}>${hroom("mentionHere")}</button>
            ${m.canAsk === true ? html`<button type="button" class="btn" onClick=${() => { setOpen(null); onOpenChat?.(m); }}>${hroom("chatOneToOne")}</button>` : null}
            ${manager ? html`<button type="button" class="btn btn-danger" disabled=${busy} onClick=${() => remove(m)}>${hroom("removeFromRoom")}</button>` : null}
          </div>
          ${failed ? html`<p class="note" role="alert">${hm("removeFailed")}</p>` : null}
        </div>` : null}
      </li>`)}</ul>
      ${fold.rest ? html`<button type="button" class="btn btn-link hub-members-more" onClick=${() => setExpanded(!expanded)}>${expanded ? hm("fewer") : hroom("moreN", fold.rest)}</button>` : null}
    </section>` : null}
    ${assistant ? html`<section><ul><li class="hub-member hub-member-assistant">${row({ ...assistant, name: hroom("roomAssistant") })}</li></ul></section>` : null}
    <section class="hub-room-who"><h4>${hroom("whoSees")}</h4><p class="note">${hroom("whoSeesRoom")}</p></section>
    ${manager ? html`<button type="button" class="btn btn-link hub-room-settings-link" onClick=${() => onSettings?.()}>${hroom("roomSettings")}</button>` : null}
  </aside>`;
}
