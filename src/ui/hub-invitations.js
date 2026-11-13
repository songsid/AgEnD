// Hub rooms, invitations on the owner's side (docs/design/hub-rooms-ux.md section 8; seam 3 in hub-rooms-split.md).
// A room manager invited one of my shared agents; I agree (it joins the room) or decline. Two places show the same list:
// a row at the top of the Hub's left list (「邀請 · 2」, opening the list) and the top of My shared agents. The list
// follows the rooms stream's invitation.changed, so an answer given in another tab, or an invitation that lapsed after
// 7 days, leaves both places at once.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { hubClient } from "./hub-client.js";
import { hi } from "./hub-invitations-strings.js";

/** The pending invitations to my agents: { list (null while loading), error, reload, answer(id, accept) → Promise<boolean> }. */
export function useInvitations(client = hubClient()) {
  const [list, setList] = useState(null), [error, setError] = useState(false);
  const live = useRef(true), asked = useRef(0);
  const reload = async () => {
    const mine = ++asked.current;
    const r = await client.invitations();
    if (!live.current || mine !== asked.current) return;
    if (r?.ok && Array.isArray(r.invitations)) { setList(r.invitations.filter(valid)); setError(false); }
    else setError(true);
  };
  useEffect(() => {
    live.current = true; void reload();
    const off = client.subscribeRooms?.({ "invitation.changed": () => { void reload(); } }) ?? (() => {});
    return () => { live.current = false; off(); };
  }, [client]);
  const answer = async (invitationId, accept) => {
    const r = await (accept ? client.acceptInvitation(invitationId) : client.declineInvitation(invitationId));
    if (!live.current) return r;
    if (r?.ok) setList(old => old ? old.filter(x => x.id !== invitationId) : old);
    else if (r?.status === 404) { setList(old => old ? old.filter(x => x.id !== invitationId) : old); void reload(); }
    return r;
  };
  return { list, error, reload, answer };
}
const valid = (x) => x && typeof x.id === "string" && x.room && typeof x.room.name === "string" && x.agent && typeof x.agent.name === "string";

/** The left list's 「邀請 · n」 row. The shell passes the list answer's pending count; nothing when it is 0. */
export function InvitationsRow({ count = 0, onOpen } = {}) {
  const n = Number(count) || 0;
  if (n <= 0) return null;
  return html`<button type="button" class="hub-invitations-row" onClick=${() => onOpen?.()}>${hi("row", n)}</button>`;
}

/** The invitations themselves, each with 同意 / 不要. Nothing when there are none (My shared agents shows no empty box). */
export function InvitationsList({ client = hubClient(), heading = true } = {}) {   // onOpenRoom: not used — the owner is not a member of the inviting room
  const { list, error, reload, answer } = useInvitations(client);
  const [busy, setBusy] = useState(null), [note, setNote] = useState(null), inflight = useRef(false);
  if (error && !list) return html`<p class="note hub-invitations-error" role="alert">${hi("loadFailed")} <button type="button" class="btn btn-link" onClick=${() => { void reload(); }}>${hi("retry")}</button></p>`;
  if (!list?.length) return note ? html`<p class="note" role="status">${note.text}</p>` : null;
  const act = async (item, accept) => {
    if (inflight.current) return; // one answer at a time, even before the disabled buttons are drawn
    inflight.current = true; setBusy(item.id); setNote(null);
    const r = await answer(item.id, accept);
    inflight.current = false; setBusy(null);
    if (!r?.ok) setNote({ id: item.id, text: r?.status === 404 ? hi("gone") : hi("failed") });
  };
  return html`<section class="hub-invitations" aria-label=${hi("title")}>
    ${heading ? html`<h3>${hi("title")}</h3>` : null}
    ${list.map(item => html`<article class="hub-invitation" key=${item.id}>
      <p>${hi("item", item.by?.name || "", item.agent.name, item.room.name)}</p>
      <small class="note">${Number(item.room.people) === 1 ? hi("leadOne") : hi("lead", Number(item.room.people) || 0)}</small>
      ${note?.id === item.id ? html`<p class="note" role="alert">${note.text}</p>` : null}
      <div class="field-row">
        <button type="button" class="btn btn-primary" disabled=${busy !== null} onClick=${() => act(item, true)}>${hi("accept")}</button>
        <button type="button" class="btn" disabled=${busy !== null} onClick=${() => act(item, false)}>${hi("decline")}</button>
      </div>
    </article>`)}
    ${note && !list.some(x => x.id === note.id) ? html`<p class="note" role="status">${note.text}</p>` : null}
  </section>`;
}
