// Hub rooms, Room settings (docs/design/hub-rooms-ux.md section 7), opened from the room's header menu or the members
// panel's 「房間設定」, for a room manager. Three parts:
// - 基本: the name, 「成員可以 @所有 Agent」, 「新成員看得到」.
// - 成員與 Agent: people and agents, each with a menu (設為房間管理 / 改為成員, 從房間移除); adding people, and adding or
//   inviting agents, with New room's pickers; the room's invitations (pending: 取消邀請; expired after 7 days:
//   重新邀請); the room assistant's switch when the Hub offers one.
// - 其他: 封存房間, after a confirmation.
// Each change is sent at once. The shell holds the room's detail; onChanged() asks it to read the room again
// (member.changed / room.changed do the same for other tabs). leaveRoom() is the header menu's 「離開房間」.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Menu } from "/assets/ui-menu.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { hubClient } from "./hub-client.js";
import { hroom } from "./hub-room-strings.js";
import { hs } from "./hub-room-settings-strings.js";
import { RoomPicker } from "./hub-room-new.js";
import { linkRoomsU2Css } from "./hub-room-new-strings.js";

linkRoomsU2Css();

const NAME_MAX = 60;
const isAgent = (m) => m.kind === "agent" || m.kind === "later";

/** 離開房間 for anyone: → { ok } or { ok: false, text } (the last manager is told to hand the role on first). */
export async function leaveRoom(client, roomId, meId) {
  const r = await client.removeRoomMember(roomId, meId);
  if (r?.ok) return { ok: true };
  return { ok: false, text: r?.status === 409 && r.code === "last-manager" ? hroom("lastManager") : hs("saveFailed") };
}

/** One invitation row's words: the agent, its owner when known, pending or expired. */
export function invitedLabel(row) {
  const owner = typeof row.owner === "string" ? row.owner : row.owner?.name || "";
  if (row.state === "expired") return owner ? hs("expiredRow", row.name, owner) : hs("expiredRowNoOwner", row.name);
  return owner ? hroom("inviteRow", row.name, owner) : hs("pendingRowNoOwner", row.name);
}

/** Props: client, roomId, detail (the shell's GET /hub/v1/rooms/:id answer), onClose(), onChanged(), assistant (the Hub offers the room assistant; read from the list when not given). */
export function RoomSettings({ client = hubClient(), roomId, detail, onClose, onChanged, assistant } = {}) {
  const room = detail?.room ?? {}, settings = detail?.settings ?? {}, members = Array.isArray(detail?.members) ? detail.members : [];
  const invited = Array.isArray(detail?.invited) ? detail.invited : [];
  const [name, setName] = useState(room.name ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [allMention, setAllMention] = useState(settings.allMention !== false), [history, setHistory] = useState(settings.historyForNew === "all" ? "all" : "since-join");
  const [offered, setOffered] = useState(assistant === true), [addPeople, setAddPeople] = useState([]), [addAgents, setAddAgents] = useState([]);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => { setName(room.name ?? ""); setAllMention(settings.allMention !== false); setHistory(settings.historyForNew === "all" ? "all" : "since-join"); }, [detail]);
  useEffect(() => {
    if (typeof assistant === "boolean") { setOffered(assistant); return; }
    void client.roomList().then(r => { if (live.current) setOffered(r?.ok === true && r.me?.assistant === true); });
  }, [client, assistant]);
  const hasAssistant = members.some(m => m.kind === "assistant");
  /** One change: send it, then let the shell read the room again; a refusal names what to do. */
  const act = async (send, undo) => {
    setBusy(true); setError("");
    const r = await send();
    if (!live.current) return r;
    setBusy(false);
    if (r?.ok) onChanged?.();
    else { undo?.(); setError(r?.status === 409 && r.code === "last-manager" ? hroom("lastManager") : hs("saveFailed")); }
    return r;
  };
  const saveName = () => {
    const title = name.trim();
    if (!title) { setError(hroom("nameRequired")); return; }
    if (title === room.name || [...title].length > NAME_MAX) return;
    void act(() => client.updateRoom(roomId, { name: title }), () => setName(room.name ?? ""));
  };
  /** A picked item is sent at once (the picker then starts empty again): a person, team or group joins; my agent joins; someone else's agent, or a team's agents, are invited. */
  const add = async (next, setter) => {
    setter([]);
    for (const item of next) {
      const send = item.kind === "agent" && item.mine ? () => client.addRoomMember(roomId, { kind: "agent", id: item.id })
        : item.kind === "agent" ? () => client.inviteToRoom(roomId, { agents: [item.id] })
        : item.kind === "team-agents" ? () => client.inviteToRoom(roomId, { team: item.id })
        : () => client.addRoomMember(roomId, { kind: item.kind, id: item.id });
      const r = await act(send);
      if (!r?.ok) break;
    }
  };
  const rowMenu = (m) => html`<${Menu} label=${hs("rowMenu", m.name)} items=${[
    m.kind === "person" ? { key: "role", label: m.role === "manager" ? hroom("makeMember") : hroom("makeManager"),
      onSelect: () => { void act(() => client.setRoomMemberRole(roomId, m.id, m.role === "manager" ? "member" : "manager")); } } : null,
    { key: "remove", label: hroom("removeFromRoom"), danger: true, onSelect: () => { void act(() => client.removeRoomMember(roomId, m.id)); } },
  ]} />`;
  const memberRow = (m) => html`<li class="hub-settings-row" key=${m.id} data-member=${m.id}><span>${m.name}${m.id === detail?.me?.id ? html` <span class="tag">${hroom("roleYou")}</span>` : null}${m.role === "manager" ? html` <span class="tag">${hroom("roleManager")}</span>` : null}${isAgent(m) && m.owner?.name ? html` <small class="note">${m.owner.name}</small>` : null}</span>${rowMenu(m)}</li>`;
  const archive = async () => {
    const yes = await confirmDialog({ title: hroom("archiveRoom"), message: hroom("archiveAsk", room.name ?? ""), confirmLabel: hroom("archive"), danger: true });
    if (!yes) return;
    const r = await act(() => client.updateRoom(roomId, { archived: true }));
    if (r?.ok) onClose?.();
  };
  const taken = members.map(m => `${m.kind === "later" ? "agent" : m.kind}:${m.id}`).concat(invited.filter(x => x.state !== "expired").map(x => `agent:${x.exposureId}`));
  return html`<${Dialog} title=${hroom("roomSettings")} onClose=${() => onClose?.()} cls="hub-room-settings" wide=${true}>
    ${error ? html`<p class="note hub-room-settings-error" role="alert">${error}</p>` : null}
    <section class="form"><h4>${hroom("basics")}</h4>
      <form class="field-row" onSubmit=${(e) => { e.preventDefault(); saveName(); }}>
        <label class="field"><span>${hroom("name")}</span><input id="hubRoomSettingsName" maxlength=${NAME_MAX} autocomplete="off" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        <button type="button" class="btn" disabled=${busy || name.trim() === (room.name ?? "")} onClick=${saveName}>${hs("save")}</button>
      </form>
      <label class="check"><input id="hubRoomAllMention" class="s-ui-toggle" type="checkbox" role="switch" checked=${allMention} disabled=${busy}
        onChange=${(e) => { const v = e.target.checked; setAllMention(v); void act(() => client.updateRoom(roomId, { allMention: v }), () => setAllMention(!v)); }} /><span>${hroom("membersCanAll")}</span></label>
      <fieldset class="field"><legend>${hroom("newMembersSee")}</legend>
        ${[["since-join", hroom("historyAfter")], ["all", hroom("historyAll")]].map(([value, label]) => html`<label class="check" key=${value}><input type="radio" name="hubRoomHistory" value=${value} checked=${history === value} disabled=${busy}
          onChange=${() => { const old = history; setHistory(value); void act(() => client.updateRoom(roomId, { historyForNew: value }), () => setHistory(old)); }} /><span>${label}</span></label>`)}
      </fieldset>
    </section>
    <section class="form"><h4>${hroom("membersAndAgents")}</h4>
      <ul class="hub-settings-people">${members.filter(m => m.kind === "person").map(memberRow)}</ul>
      <${RoomPicker} client=${client} id="hubRoomAddPeople" kinds=${["person", "team", "group"]} label=${hroom("addMembers")} placeholder=${hroom("addPeople")}
        picked=${addPeople} exclude=${taken} onChange=${(next) => { void add(next, setAddPeople); }} />
      <ul class="hub-settings-agents">${members.filter(isAgent).map(memberRow)}</ul>
      ${invited.length ? html`<ul class="hub-settings-invited">${invited.map(row => html`<li class="hub-settings-row" key=${row.id} data-invitation=${row.id}><span>${invitedLabel(row)}</span>
        ${row.state === "expired"
          ? html`<button type="button" class="btn btn-link" disabled=${busy} onClick=${() => { void act(async () => { const r = await client.inviteToRoom(roomId, { agents: [row.exposureId] }); if (r?.ok) await client.cancelRoomInvitation(roomId, row.id); return r; }); }}>${hs("inviteAgain")}</button>`
          : html`<button type="button" class="btn btn-link" disabled=${busy} onClick=${() => { void act(() => client.cancelRoomInvitation(roomId, row.id)); }}>${hroom("cancelInvite")}</button>`}</li>`)}</ul>` : null}
      <${RoomPicker} client=${client} id="hubRoomAddAgents" kinds=${["agent", "team"]} label=${hroom("addOrInviteAgents")} placeholder=${hroom("addAgents")}
        picked=${addAgents} exclude=${taken} onChange=${(next) => { void add(next, setAddAgents); }} />
      ${offered || hasAssistant ? html`<label class="check"><input id="hubRoomSettingsAssistant" class="s-ui-toggle" type="checkbox" role="switch" checked=${hasAssistant} disabled=${busy}
        onChange=${(e) => { const v = e.target.checked, id = members.find(m => m.kind === "assistant")?.id; void act(() => v ? client.addRoomMember(roomId, { kind: "assistant" }) : client.removeRoomMember(roomId, id)); }} /><span>${hs("assistantSwitch")}</span></label>` : null}
    </section>
    <section class="form"><h4>${hroom("other")}</h4>
      <button type="button" class="btn btn-danger" disabled=${busy || room.archived === true} onClick=${() => { void archive(); }}>${hroom("archiveRoom")}</button>
    </section>
  </${Dialog}>`;
}
