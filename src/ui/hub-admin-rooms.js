// Hub rooms, Administration → Rooms (docs/design/hub-rooms-ux.md section 11), for the Hub administrator:
// - 「誰可以開房間」: people and teams who may start rooms besides the administrators (empty: administrators only);
//   saved as soon as it changes; everyone can always start a one-to-one chat.
// - 「所有房間」: every group room's name, people, agents, managers, last activity and status, never its content. Each
//   row's menu: 加入自己成為房間管理 (the room then shows a line saying so) and 封存 (after a confirmation).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Menu } from "/assets/ui-menu.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { chatTime } from "/assets/chat-time.js";
import { hubClient } from "./hub-client.js";
import { hroom } from "./hub-room-strings.js";
import { ha } from "./hub-admin-rooms-strings.js";
import { RoomPicker } from "./hub-room-new.js";
import { linkRoomsU2Css } from "./hub-room-new-strings.js";

linkRoomsU2Css();

export function AdminRooms({ client = hubClient() } = {}) {
  const [creators, setCreators] = useState(null), [rooms, setRooms] = useState(null), [failed, setFailed] = useState(false);
  const [error, setError] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const live = useRef(true);
  const load = async () => {
    const [c, r] = await Promise.all([client.roomCreators(), client.adminRooms()]);
    if (!live.current) return;
    if (!c?.ok || !r?.ok) { setFailed(true); return; }
    setFailed(false);
    setCreators([...(c.people ?? []).map(x => ({ kind: "person", ...named(x) })), ...(c.teams ?? []).map(x => ({ kind: "team", ...named(x) }))]);
    setRooms(Array.isArray(r.rooms) ? r.rooms : []);
  };
  useEffect(() => { live.current = true; void load(); return () => { live.current = false; }; }, [client]);
  if (failed && !rooms) return html`<section class="hub-admin-rooms"><p class="note" role="alert">${ha("loadFailed")} <button type="button" class="btn btn-link" onClick=${() => { void load(); }}>${ha("retry")}</button></p></section>`;
  if (!rooms || !creators) return html`<section class="hub-admin-rooms" aria-busy="true"></section>`;
  const saveCreators = async (next) => {
    const before = creators;
    setCreators(next); setBusy(true); setError(""); setNote("");
    const r = await client.saveRoomCreators({ people: next.filter(x => x.kind === "person").map(x => x.id), teams: next.filter(x => x.kind === "team").map(x => x.id) });
    if (!live.current) return;
    setBusy(false);
    if (!r?.ok) { setCreators(before); setError(ha("saveFailed")); }
  };
  const act = async (send, after) => {
    setBusy(true); setError(""); setNote("");
    const r = await send();
    if (!live.current) return;
    setBusy(false);
    if (!r?.ok) { setError(ha("saveFailed")); return; }
    after?.(); void load();
  };
  const archive = async (room) => {
    if (!await confirmDialog({ title: hroom("archiveRoom"), message: ha("archiveAsk", room.name), confirmLabel: hroom("archive"), danger: true })) return;
    await act(() => client.archiveRoomAsAdmin(room.id, true));
  };
  return html`<section class="hub-admin-rooms">
    ${error ? html`<p class="note" role="alert">${error}</p>` : null}
    ${note ? html`<p class="note" role="status">${note}</p>` : null}
    <section class="form hub-admin-creators"><h3>${hroom("whoCanCreate")}</h3>
      <${RoomPicker} client=${client} id="hubRoomCreators" kinds=${["person", "team"]} label=${hroom("addPeopleOrTeams")} placeholder=${hroom("addPeopleOrTeams")}
        picked=${creators} onChange=${(next) => { if (!busy) void saveCreators(next); }} />
      ${creators.length ? null : html`<p class="note">${ha("adminOnly")}</p>`}
      <p class="note">${hroom("everyoneDirect")}</p>
    </section>
    <section class="hub-admin-all-rooms"><h3>${hroom("allRooms")}</h3>
      <p class="note">${hroom("noContent")}</p>
      ${rooms.length ? html`<table class="hub-admin-rooms-table"><thead><tr><th>${hroom("name")}</th><th>${ha("colPeople")}</th><th>${ha("colAgents")}</th><th>${hroom("roomManager")}</th><th>${ha("colLast")}</th><th>${ha("colState")}</th><th></th></tr></thead>
        <tbody>${rooms.map(room => html`<tr key=${room.id} data-room=${room.id}>
          <td>${room.name}</td><td>${Number(room.people) || 0}</td><td>${Number(room.agents) || 0}</td>
          <td>${Array.isArray(room.managers) ? room.managers.join("、") : ""}</td>
          <td>${room.lastAt ? chatTime(room.lastAt) : ""}</td>
          <td>${room.archived ? hroom("archived") : hroom("active")}</td>
          <td><${Menu} label=${ha("rowMenu", room.name)} disabled=${busy} items=${[
            { key: "join", label: hroom("joinAsManager"), onSelect: () => { void act(() => client.joinRoomAsAdmin(room.id), () => setNote(ha("joined", room.name))); } },
            room.archived ? null : { key: "archive", label: hroom("archive"), danger: true, onSelect: () => { void archive(room); } },
          ]} /></td></tr>`)}</tbody></table>` : html`<p class="note">${ha("none")}</p>`}
    </section>
  </section>`;
}
const named = (x) => typeof x === "string" ? { id: x, name: x } : { id: String(x?.id ?? ""), name: String(x?.name ?? x?.id ?? ""), ...(Number.isFinite(x?.people) ? { people: x.people } : {}) };
