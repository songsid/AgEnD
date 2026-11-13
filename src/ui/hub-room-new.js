// Hub rooms, the New room dialog (docs/design/hub-rooms-ux.md section 6), opened from the list's 「＋ 新房間」 row (shown
// only to people who may start rooms). Name (required, at most 60 characters), members (people, teams, AD groups; I am
// always in, as the manager), agents (mine join at once; someone else's are invited and join when their owner agrees;
// a team's every member's agents can be invited), and the room assistant when the Hub offers one. 建立 creates the
// room, sends the invitations, and opens the room; the room's first lines (created, invited) are the server's.
// RoomPicker is the search-and-tags field, reused by Room settings (section 7).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Dialog } from "/assets/ui-dialog.js";
import { hubClient } from "./hub-client.js";
import { hroom } from "./hub-room-strings.js";
import { hn, linkRoomsU2Css } from "./hub-room-new-strings.js";

linkRoomsU2Css();

const NAME_MAX = 60;
const SEARCH_DELAY_MS = 200;

/** One picked item's words: a person or agent by name, a team or AD group with its people, a team's agents. */
export function pickLabel(item) {
  if (item.kind === "team-agents") return hn("teamAgents", item.name);
  if ((item.kind === "team" || item.kind === "group") && Number.isFinite(item.people)) return hn("withCount", item.name, item.people);
  return item.name;
}
const keyOf = (item) => `${item.kind}:${item.id}`;

/**
 * A search box over GET /hub/v1/rooms/candidates and the picked items as tags.
 * - kinds: the candidate kinds searched, e.g. ["person", "team", "group"] or ["agent", "team"]. In an agent picker, a team
 *   result stands for "invite every member's agents" (kind "team-agents").
 * - picked, onChange(next), exclude: keys ("kind:id") never offered, e.g. members already in the room.
 * - note: a refusal the owner shows under the field (the 100-person limit, a group the directory could not read).
 * A picked AD group is read first (client.roomGroup): its tag shows its head count, and a group the directory cannot
 * read whole is not added — the other picks stay.
 */
export function RoomPicker({ client, kinds, picked, onChange, placeholder, label, id, exclude = [], fixed = null, note = "" } = {}) {
  const [q, setQ] = useState(""), [results, setResults] = useState(null), [failed, setFailed] = useState(false), [groupNote, setGroupNote] = useState("");
  const asked = useRef(0), timer = useRef(null), latest = useRef(picked), live = useRef(true);
  latest.current = picked;
  const agents = kinds.includes("agent");
  useEffect(() => { live.current = true; return () => { live.current = false; clearTimeout(timer.current); }; }, []);
  const search = (text) => {
    setQ(text); clearTimeout(timer.current);
    const mine = ++asked.current;
    if (!text.trim()) { setResults(null); setFailed(false); return; }
    timer.current = setTimeout(async () => {
      const answers = await Promise.all(kinds.map(kind => client.roomCandidates(text.trim(), kind)));
      if (mine !== asked.current) return;
      if (answers.some(r => !r?.ok)) { setFailed(true); setResults(null); return; }
      setFailed(false);
      setResults(answers.flatMap(r => Array.isArray(r.candidates) ? r.candidates : [])
        .map(c => agents && c.kind === "team" ? { ...c, kind: "team-agents" } : c)
        .filter(c => c && typeof c.id === "string" && typeof c.name === "string"));
    }, SEARCH_DELAY_MS);
  };
  const taken = new Set([...exclude, ...picked.map(keyOf)]);
  const offer = (results ?? []).filter(c => !taken.has(keyOf(c)));
  const pick = async (item) => {
    setQ(""); setResults(null); setGroupNote("");
    if (item.kind !== "group" || typeof client.roomGroup !== "function") { onChange([...latest.current, item]); return; }
    const r = await client.roomGroup(item.id);
    if (!live.current || latest.current.some(x => keyOf(x) === keyOf(item))) return;
    if (!r?.ok) { setGroupNote(hn("groupUnavailable", item.name)); return; }
    onChange([...latest.current, { ...item, ...(typeof r.name === "string" && r.name ? { name: r.name } : {}), ...(Number.isSafeInteger(r.people) ? { people: r.people } : {}) }]);
  };
  return html`<div class="field hub-room-picker">
    <label for=${id}><span>${label}</span></label>
    <ul class="hub-room-tags">
      ${fixed}
      ${picked.map(item => html`<li class="tag" key=${keyOf(item)}>${pickLabel(item)}${agents && item.kind === "agent" && !item.mine || item.kind === "team-agents" ? html` · ${hroom("invitePending")}` : null}
        <button type="button" class="chip-btn" aria-label=${hn("remove", pickLabel(item))} onClick=${() => onChange(picked.filter(x => keyOf(x) !== keyOf(item)))}>×</button></li>`)}
    </ul>
    <input id=${id} type="search" autocomplete="off" placeholder=${placeholder} value=${q} onInput=${(e) => search(e.target.value)} />
    ${failed ? html`<p class="note" role="alert">${hn("searchFailed")}</p>` : null}
    ${groupNote || note ? html`<p class="note hub-room-picker-note" role="alert">${groupNote || note}</p>` : null}
    ${results && !failed ? offer.length ? html`<ul class="hub-room-results" role="listbox" aria-label=${label}>${offer.map(c => html`<li key=${keyOf(c)}>
        <button type="button" role="option" class="hub-room-result" onClick=${() => { void pick(c); }}>${pickLabel(c)}${c.owner?.name && c.kind === "agent" ? html` <small class="note">${c.owner.name}</small>` : null}${c.kind === "agent" && !c.mine ? html` <small class="note">${hroom("invitePending")}</small>` : null}</button></li>`)}</ul>`
      : html`<p class="note">${hn("noMatch")}</p>` : null}
  </div>`;
}

/** Props: client, onClose(), onOpenRoom(roomId), assistant (whether the Hub offers the room assistant; read from the list when not given). */
export function NewRoomDialog({ client = hubClient(), onClose, onOpenRoom, assistant } = {}) {
  const [name, setName] = useState(""), [people, setPeople] = useState([]), [agents, setAgents] = useState([]), [withAssistant, setWithAssistant] = useState(false);
  const [offered, setOffered] = useState(assistant === true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [peopleNote, setPeopleNote] = useState("");
  const nameRef = useRef(null), sent = useRef(false);
  useEffect(() => {
    if (typeof assistant === "boolean") { setOffered(assistant); return; }
    let live = true;
    void client.roomList().then(r => { if (live) setOffered(r?.ok === true && r.me?.assistant === true); });
    return () => { live = false; };
  }, [client, assistant]);
  const create = async () => {
    if (sent.current) return;
    const title = name.trim();
    if (!title) { setError(hroom("nameRequired")); nameRef.current?.focus(); return; }
    if ([...title].length > NAME_MAX) { setError(hn("nameTooLong")); nameRef.current?.focus(); return; }
    sent.current = true; setBusy(true); setError(""); setPeopleNote("");
    const ids = (kind, from = people) => from.filter(x => x.kind === kind).map(x => x.id);
    const r = await client.createRoom({ name: title, people: ids("person"), teams: ids("team"), groups: ids("group"),
      agents: agents.filter(x => x.kind === "agent" && x.mine).map(x => x.id), assistant: offered && withAssistant });
    const roomId = r?.ok ? r.room?.id : null;
    if (!roomId) {
      sent.current = false; setBusy(false);
      // Nothing was created. Too many people: say how many, keep every pick. A group the directory could not read:
      // drop that group only.
      const group = r?.status === 503 && r.code === "group-unavailable" ? people.find(x => x.kind === "group" && x.id === r.group) : null;
      if (r?.status === 409 && r.code === "people-limit" && Number.isSafeInteger(r.people)) setPeopleNote(hn("peopleLimit", r.people, r.limit ?? 100));
      else if (group) { setPeople(people.filter(x => x !== group)); setPeopleNote(hn("groupUnavailable", group.name)); }
      else setError(hn("createFailed"));
      return;
    }
    const others = agents.filter(x => x.kind === "agent" && !x.mine).map(x => x.id), teams = agents.filter(x => x.kind === "team-agents").map(x => x.id);
    // The room exists now: invitations are best effort, and the room's own list shows what was sent.
    if (others.length) await client.inviteToRoom(roomId, { agents: others });
    for (const team of teams) await client.inviteToRoom(roomId, { team });
    onOpenRoom?.(roomId); onClose?.();
  };
  const me = html`<li class="tag hub-room-me">${hroom("roleYou")} · ${hroom("roleManager")}</li>`;
  return html`<${Dialog} title=${hroom("newRoomTitle")} onClose=${() => onClose?.()} busy=${busy} cls="hub-room-new"
    actions=${html`<button type="button" class="btn" disabled=${busy} onClick=${() => onClose?.()}>${hroom("cancel")}</button>
      <button type="button" class="btn btn-primary" disabled=${busy} onClick=${() => { void create(); }}>${hroom("create")}</button>`}>
    <form class="form" onSubmit=${(e) => { e.preventDefault(); void create(); }}>
      <label class="field"><span>${hroom("name")}</span>
        <input id="hubRoomName" ref=${nameRef} maxlength=${NAME_MAX} autocomplete="off" placeholder=${hroom("namePlaceholder")} value=${name}
          aria-invalid=${error === hroom("nameRequired") || error === hn("nameTooLong") ? "true" : "false"} onInput=${(e) => { setName(e.target.value); if (error) setError(""); }} /></label>
      ${error ? html`<p class="note hub-room-new-error" role="alert">${error}</p>` : null}
      <${RoomPicker} client=${client} id="hubRoomPeople" kinds=${["person", "team", "group"]} label=${hroom("members")} placeholder=${hroom("addPeople")}
        picked=${people} onChange=${(next) => { setPeople(next); setPeopleNote(""); }} fixed=${me} note=${peopleNote} />
      <${RoomPicker} client=${client} id="hubRoomAgents" kinds=${["agent", "team"]} label=${hn("agents")} placeholder=${hroom("addAgents")}
        picked=${agents} onChange=${setAgents} />
      ${offered ? html`<label class="check"><input id="hubRoomAssistant" class="s-ui-toggle" type="checkbox" role="switch" checked=${withAssistant}
        onChange=${(e) => setWithAssistant(e.target.checked)} /><span>${hroom("addAssistant")}</span></label>` : null}
    </form>
  </${Dialog}>`;
}
