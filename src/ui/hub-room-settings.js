import {RoomPurposeField,purposeCount} from "./hub-room-purpose.js";
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
import { hroom, styleName } from "./hub-room-strings.js";
import { hs } from "./hub-room-settings-strings.js";
import {ha} from "./hub-ai-apps-strings.js";
import { RoomPicker } from "./hub-room-new.js";
import { OwnerAgentRequestDialog, OwnerAgentRequestRows } from "./hub-room-owner-requests.js";
import { hrq } from "./hub-room-owner-requests-strings.js";
import { hn, linkRoomsU2Css } from "./hub-room-new-strings.js";

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

/**
 * The separator before a style's seats: " · ", but "· " after a full-width bracket or quote (「工作室（大）· 57」), whose
 * glyph already carries its own side spacing, so every row's gap before the dot looks the same (the capture check).
 */
export function dotAfter(name) {
  return /[）」』〕】]$/.test(name) ? "· " : " · ";
}

/**
 * The hint's last words on one line, so a wrap never leaves 「子。」 or "seat." alone: the last four characters (with the
 * full stop) of a Chinese sentence, the last two words of an English one. Short enough never to overflow a phone.
 */
export function keepTail(text) {
  const m = /[\u3000-\u9fff\uff00-\uffef]/.test(text) ? /^([\s\S]*?)(\S{1,4}[。！？]?)$/.exec(text) : /^([\s\S]*?)(\S+ \S+)$/.exec(text);
  return m && m[1] ? html`${m[1]}<span class="hub-nowrap">${m[2]}</span>` : text;
}

/**
 * M-3533 R1b: the room office's styles with their seats, and — when the room's agents (its assistant too) outnumber the
 * picked style's rest seats and a larger style has more — the hint to pick a larger one.
 */
function OfficeStyles({ styles, value, saved, busy, members, onPick, onSave }) {
  const agents = members.filter((m) => m.kind === "agent").length, figures = agents + members.filter((m) => m.kind === "assistant").length;
  const picked = styles.find((x) => x.id === value) || null;
  const larger = picked && styles.some((x) => x.seats.rest > picked.seats.rest);
  return html`<fieldset class="field hub-room-office-styles"><legend>${hroom("officeStyle")}</legend>
    ${styles.map((x) => html`<label class="check" key=${x.id}><input type="radio" name="hubRoomOfficeStyle" value=${x.id} checked=${value === x.id} disabled=${busy}
      onChange=${() => onPick(x.id)} /><span>${styleName(x.id)}${dotAfter(styleName(x.id))}${hroom("seatsN", x.seats.total)}</span></label>`)}
    ${picked && larger && figures > picked.seats.rest ? html`<p class="note hub-room-office-fit">${keepTail(hroom(figures > agents ? "officeFitHintAssistant" : "officeFitHint", agents, styleName(picked.id), picked.seats.rest))}</p>` : null}
    <div class="field-row"><button type="button" class="btn hub-room-office-style-save" disabled=${busy || value === saved} onClick=${onSave}>${hroom("officeStyleSave")}</button></div>
  </fieldset>`;
}

/** Props: client, roomId, detail (the shell's GET /hub/v1/rooms/:id answer), onClose(), onChanged(), assistant (the Hub offers the room assistant; read from the list when not given). */
export function RoomSettings({ client = hubClient(), roomId, detail, onClose, onChanged, assistant } = {}) {
  const room = detail?.room ?? {}, settings = detail?.settings ?? {}, members = Array.isArray(detail?.members) ? detail.members : [];
  const invited = Array.isArray(detail?.invited) ? detail.invited : [];
  const [askOwner, setAskOwner] = useState(false);
  const ownerRequestsLive = settings.ownerAgentRequests === true && typeof client.requestRoomAgent === "function";
  const [purpose,setPurpose]=useState(room.purpose??"");
  useEffect(()=>setPurpose(room.purpose??""),[roomId,room.purpose]);
  const purposeSupported=client.roomPurposeV1===true&&typeof room.purpose==="string"&&detail?.me?.role==="manager";
  const [name, setName] = useState(room.name ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [allMention, setAllMention] = useState(settings.allMention !== false), [history, setHistory] = useState(settings.historyForNew === "all" ? "all" : "since-join");
  const [memberAgents, setMemberAgents] = useState(settings.membersCanAddOwnAgents === true);
  useEffect(() => setMemberAgents(settings.membersCanAddOwnAgents === true), [detail]);
  const [aiApps,setAiApps]=useState(settings.aiApps!==false);
  const [aiAppsScope]=useState(()=>client.aiAppsScope?.());
  const [offered, setOffered] = useState(assistant === true), [addPeople, setAddPeople] = useState([]), [addAgents, setAddAgents] = useState([]), [peopleNote, setPeopleNote] = useState("");
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  // M-3533 R1 (design §2.1b): Room office, on or off — managers only (this dialog is theirs), when the Hub serves it.
  const officeShown = typeof settings.office?.enabled === "boolean" && client.roomOfficeV1 === true;
  const [office, setOffice] = useState(settings.office?.enabled === true);
  useEffect(() => { setName(room.name ?? ""); setAllMention(settings.allMention !== false); setHistory(settings.historyForNew === "all" ? "all" : "since-join"); setOffice(settings.office?.enabled === true); }, [detail]);
  useEffect(()=>setAiApps(settings.aiApps!==false),[detail]);
  // M-3533 R1b (§2.1b): the office's style — the room styles, each with its seats from its own layout (the drawing's
  // fleet-office-skin.js, loaded with import() as the office tab does); picked here, saved once with Save style.
  const savedStyle = typeof settings.office?.style === "string" ? settings.office.style : "studio";
  const [style, setStyle] = useState(savedStyle), [styles, setStyles] = useState(null);
  useEffect(() => { setStyle(savedStyle); }, [detail]);
  useEffect(() => {
    if (!officeShown) return;
    import("./fleet-office-skin.js").then((m) => { if (live.current) setStyles(m.ROOM_STYLES.map((id) => ({ id, seats: m.styleSeats(id) })).filter((x) => x.seats)); }, () => {});
  }, [officeShown]);
  useEffect(() => {
    if (typeof assistant === "boolean") { setOffered(assistant); return; }
    void client.roomList().then(r => { if (live.current) setOffered(r?.ok === true && r.me?.assistant === true); });
  }, [client, assistant]);
  const hasAssistant = members.some(m => m.kind === "assistant");
  /** One change: send it, then let the shell read the room again; a refusal names what to do. */
  /** refused(r): a refusal the caller shows itself (true = handled), e.g. under the add-people field. */
  const act = async (send, undo, refused) => {
    setBusy(true); setError(""); setPeopleNote("");
    const r = await send();
    if (!live.current) return r;
    setBusy(false);
    if (r?.ok) onChanged?.();
    else { undo?.(); if (!refused?.(r)) setError(r?.status === 409 && r.code === "last-manager" ? hroom("lastManager") : hs("saveFailed")); }
    return r;
  };
  const savePurpose=()=>{
    if(!purposeSupported||purposeCount(purpose)>200||purpose===(room.purpose??""))return;
    void act(()=>client.updateRoom(roomId,{purpose}));
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
      // Too many people, or a group the directory could not read: said under the add field; nothing was added.
      const r = await act(send, undefined, (no) => {
        if (no?.status === 409 && no.code === "people-limit" && Number.isSafeInteger(no.people)) { setPeopleNote(hn("peopleLimit", no.people, no.limit ?? 100)); return true; }
        if (no?.status === 503 && no.code === "group-unavailable" && item.kind === "group") { setPeopleNote(hn("groupUnavailable", item.name)); return true; }
        return false;
      });
      if (!r?.ok) break;
    }
  };
  const rowMenu = (m) => html`<${Menu} label=${hs("rowMenu", m.name)} items=${[
    m.kind === "person" ? { key: "role", label: m.role === "manager" ? hroom("makeMember") : hroom("makeManager"),
      onSelect: () => { void act(() => client.setRoomMemberRole(roomId, m.id, m.role === "manager" ? "member" : "manager")); } } : null,
    { key: "remove", label: hroom("removeFromRoom"), danger: true, onSelect: () => { void act(() => client.removeRoomMember(roomId, m.id)); } },
  ]} />`;
  const memberRow = (m) => html`<li class="hub-settings-row" key=${m.id} data-member=${m.id}><span>${m.name}${m.id === detail?.me?.id ? html` <span class="tag">${hroom("roleYou")}</span>` : null}${m.role === "manager" ? html` <span class="tag">${hroom("roleManager")}</span>` : null}${isAgent(m) && m.owner?.name ? html` <small class="note">${m.owner.name}</small>` : null}${m.kind === "person" && m.signedIn === false ? html` <small class="note">${hn("neverSignedIn")}</small>` : null}</span>${rowMenu(m)}</li>`;
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
      <form class="field hub-room-name-row" onSubmit=${(e) => { e.preventDefault(); saveName(); }}>
        <label for="hubRoomSettingsName">${hroom("name")}</label>
        <div class="field-row"><input id="hubRoomSettingsName" maxlength=${NAME_MAX} autocomplete="off" value=${name} onInput=${(e) => setName(e.target.value)} />
          <button type="button" class="btn" disabled=${busy || name.trim() === (room.name ?? "")} onClick=${saveName}>${hs("save")}</button></div>
      </form>
      ${purposeSupported?html`<form class="form hub-room-purpose-form" onSubmit=${e=>{e.preventDefault();savePurpose();}}><${RoomPurposeField} id="hubRoomSettingsPurpose" value=${purpose} onValue=${setPurpose} disabled=${busy} /><div class="field-row"><button type="submit" class="btn" disabled=${busy||purposeCount(purpose)>200||purpose===(room.purpose??"")}>${hs("save")}</button></div></form>`:null}
      <label class="check"><input id="hubRoomAllMention" class="s-ui-toggle" type="checkbox" role="switch" checked=${allMention} disabled=${busy}
        onChange=${(e) => { const v = e.target.checked; setAllMention(v); void act(() => client.updateRoom(roomId, { allMention: v }), () => setAllMention(!v)); }} /><span>${hroom("membersCanAll")}</span></label>
      ${typeof settings.membersCanAddOwnAgents === "boolean" ? html`<div class="field"><label class="check"><input id="hubRoomMemberAgents" class="s-ui-toggle" type="checkbox" role="switch" checked=${memberAgents} disabled=${busy}
        onChange=${e => { const v = e.target.checked; setMemberAgents(v); void act(() => client.updateRoom(roomId, { membersCanAddOwnAgents: v }), () => setMemberAgents(!v)); }} /><span>${hs("membersOwnAgents")}</span></label><p class="note">${hs("membersOwnAgentsHint")}</p></div>` : null}
      ${typeof settings.aiApps==="boolean"&&typeof client.setRoomAiApps==="function"?html`<label class="check"><input id="hubRoomAiApps" class="s-ui-toggle" type="checkbox" role="switch" checked=${aiApps} disabled=${busy}
        onChange=${e=>{const value=e.target.checked;setAiApps(value);void act(()=>client.setRoomAiApps(aiAppsScope,roomId,value),()=>setAiApps(!value));}}/><span>${ha("roomSwitch")}</span></label>`:null}
      <fieldset class="field"><legend>${hroom("newMembersSee")}</legend>
        ${[["since-join", hroom("historyAfter")], ["all", hroom("historyAll")]].map(([value, label]) => html`<label class="check" key=${value}><input type="radio" name="hubRoomHistory" value=${value} checked=${history === value} disabled=${busy}
          onChange=${() => { const old = history; setHistory(value); void act(() => client.updateRoom(roomId, { historyForNew: value }), () => setHistory(old)); }} /><span>${label}</span></label>`)}
      </fieldset>
    </section>
    <section class="form"><h4>${hroom("membersAndAgents")}</h4>
      <ul class="hub-settings-people">${members.filter(m => m.kind === "person").map(memberRow)}</ul>
      <${RoomPicker} client=${client} id="hubRoomAddPeople" kinds=${["person", "team", "group"]} label=${hroom("addMembers")} placeholder=${hroom("addPeople")}
        picked=${addPeople} exclude=${taken} note=${peopleNote} onChange=${(next) => { void add(next, setAddPeople); }} />
      <ul class="hub-settings-agents">${members.filter(isAgent).map(memberRow)}</ul>
      ${invited.length ? html`<ul class="hub-settings-invited">${invited.map(row => html`<li class="hub-settings-row" key=${row.id} data-invitation=${row.id}><span>${invitedLabel(row)}</span>
        ${row.state === "expired"
          ? html`<button type="button" class="btn btn-link" disabled=${busy} onClick=${() => { void act(async () => { const r = await client.inviteToRoom(roomId, { agents: [row.exposureId] }); if (r?.ok) await client.cancelRoomInvitation(roomId, row.id); return r; }); }}>${hs("inviteAgain")}</button>`
          : html`<button type="button" class="btn btn-link" disabled=${busy} onClick=${() => { void act(() => client.cancelRoomInvitation(roomId, row.id)); }}>${hroom("cancelInvite")}</button>`}</li>`)}</ul>` : null}
      <${RoomPicker} client=${client} id="hubRoomAddAgents" kinds=${["agent", "team"]} label=${hroom("addOrInviteAgents")} placeholder=${hroom("addAgents")}
        picked=${addAgents} exclude=${taken} onChange=${(next) => { void add(next, setAddAgents); }}
        searchHelp=${ownerRequestsLive ? html`<p class="note hub-owner-request-entry">${hrq("missing")}
          <button type="button" class="btn btn-link" disabled=${busy} onClick=${() => setAskOwner(true)}>${hrq("ask")}</button></p>` : null} />
      ${ownerRequestsLive ? html`<${OwnerAgentRequestRows} client=${client} roomId=${roomId} page=${detail.agentRequests} onChanged=${onChanged} busy=${busy} />` : null}
      ${offered || hasAssistant ? html`<label class="check"><input id="hubRoomSettingsAssistant" class="s-ui-toggle" type="checkbox" role="switch" checked=${hasAssistant} disabled=${busy}
        onChange=${(e) => { const v = e.target.checked, id = members.find(m => m.kind === "assistant")?.id; void act(() => v ? client.addRoomMember(roomId, { kind: "assistant" }) : client.removeRoomMember(roomId, id)); }} /><span>${hs("assistantSwitch")}</span></label>` : null}
    </section>
    ${officeShown ? html`<section class="form hub-room-office-settings"><h4>${hroom("officeSection")}</h4>
      <label class="check"><input id="hubRoomOffice" class="s-ui-toggle" type="checkbox" role="switch" checked=${office} disabled=${busy}
        onChange=${(e) => { const v = e.target.checked; setOffice(v); void act(() => client.updateRoom(roomId, { office: { enabled: v } }), () => setOffice(!v)); }} /><span>${hroom("officeSetting")}</span></label>
      ${office && styles ? html`<${OfficeStyles} styles=${styles} value=${style} saved=${savedStyle} busy=${busy} members=${members} onPick=${setStyle}
        onSave=${() => { void act(() => client.updateRoom(roomId, { office: { style } })); }} />` : null}
    </section>` : null}
    <section class="form"><h4>${hroom("other")}</h4>
      <button type="button" class="btn btn-danger" disabled=${busy || room.archived === true} onClick=${() => { void archive(); }}>${hroom("archiveRoom")}</button>
    </section>
  </${Dialog}>
  ${askOwner && ownerRequestsLive ? html`<${OwnerAgentRequestDialog} key=${roomId} client=${client} roomId=${roomId} roomName=${room.name}
    onClose=${() => setAskOwner(false)} onSent=${() => onChanged?.()} />` : null}`;
}

/** Members never enter the manager settings dialog; their picker is scoped to this room and their own exposures. */
export function OwnRoomAgents({ client, roomId, detail, onClose, onChanged }) {
  const [picked, setPicked] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true), inFlight = useRef(false);
  useEffect(() => () => { live.current = false; }, []);
  const allowed = detail?.settings?.membersCanAddOwnAgents === true && detail?.room?.archived !== true;
  const scoped = { roomCandidates: (q) => client.roomOwnAgentCandidates(roomId, q) };
  const add = async next => {
    setPicked([]);
    if (!allowed || inFlight.current) return;
    const item = next[0];
    if (!item || item.kind !== "agent" || item.mine !== true) return;
    inFlight.current = true; setBusy(true); setError("");
    let result;
    try { result = await client.addRoomMember(roomId, { kind: "agent", id: item.id }); } catch { result = null; }
    if (!live.current) return;
    inFlight.current = false; setBusy(false);
    if (result?.ok) { onChanged?.(); onClose?.(); }
    else setError(hs("saveFailed"));
  };
  return html`<${Dialog} title=${hs("addOwnAgents")} onClose=${onClose}>
    <p class="note">${hs("ownAgentsHint")}</p>
    ${error ? html`<p role="alert">${error}</p>` : null}
    ${allowed && !busy ? html`<${RoomPicker} id="hubRoomOwnAgents" client=${scoped} kinds=${["agent"]} label=${hs("addOwnAgents")} placeholder=${hroom("addAgents")} picked=${picked} onChange=${add}
      exclude=${(detail?.members ?? []).filter(m => m.kind === "agent").map(m => `agent:${m.id}`)} />` : null}
  </${Dialog}>`;
}
