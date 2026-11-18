import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { Dialog } from "/assets/ui-dialog.js";
import { RoomPicker } from "./hub-room-new.js";
import { hrq } from "./hub-room-owner-requests-strings.js";
import { hn } from "./hub-room-new-strings.js";

export function ownerRequestError(result, owner) {
  if (result?.code === "owner-not-taking-requests") return hrq("ownerOff", owner);
  if (result?.code === "request-open") return hrq("already", owner);
  if (result?.code === "request-limit" && Number.isSafeInteger(result.resetsAt) && result.resetsAt > 0 && result.resetsAt <= 8.64e15) {
    const time = new Date(result.resetsAt).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return hrq("limit", time);
  }
  return hrq("failed");
}

/** The selection is a person, never evidence that the person owns any agent. */
export function OwnerAgentRequestDialog({ client, roomId, roomName, onClose, onSent } = {}) {
  const [picked, setPicked] = useState([]), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [scope] = useState(() => client.roomAgentRequestScope?.());
  const live = useRef(true), sending = useRef(false), attempt = useRef(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const owner = picked[0] ?? null;
  const send = async event => {
    event?.preventDefault?.();
    if (sending.current || !owner || note.length > 100) return;
    const frozen = { owner: owner.id, note: note.trim() };
    if (!attempt.current || attempt.current.owner !== frozen.owner || attempt.current.note !== frozen.note)
      attempt.current = { ...frozen, idempotencyKey: crypto.randomUUID() };
    sending.current = true; setBusy(true); setError("");
    let result;
    try { result = await client.requestRoomAgent(scope, roomId, { ...attempt.current }); }
    catch { result = null; }
    if (!live.current) return;
    sending.current = false; setBusy(false);
    if (result?.ok) { onSent?.(result.request); onClose?.(); }
    else setError(ownerRequestError(result, owner.name));
  };
  const actions = html`
    <button type="button" class="btn btn-ghost" disabled=${busy} onClick=${onClose}>${hrq("cancel")}</button>
    ${owner ? html`<button type="submit" form="hubOwnerAgentRequestForm" class="btn btn-primary" disabled=${busy}>${hrq("send")}</button>` : null}`;
  return html`<${Dialog} cls="hub-owner-request" title=${owner ? hrq("title", owner.name, roomName) : hrq("chooseTitle")}
      onClose=${onClose} busy=${busy} actions=${actions}>
    <form id="hubOwnerAgentRequestForm" class="form" onSubmit=${send}>
      <fieldset disabled=${busy}>
        ${owner ? html`<div class="field"><span id="hubRequestOwnerLabel">${hrq("owner")}</span>
          <ul class="hub-room-tags" aria-labelledby="hubRequestOwnerLabel"><li class="tag">${owner.name}
            <button type="button" class="chip-btn" aria-label=${hn("remove", owner.name)} onClick=${() => { setPicked([]); setError(""); }}>×</button>
          </li></ul></div>`
          : html`<${RoomPicker} client=${client} id="hubRequestOwner" kinds=${["person"]} label=${hrq("choose")} placeholder=${hrq("search")}
            picked=${picked} onChange=${next => { setPicked(next.slice(-1)); setError(""); }} />`}
        ${owner ? html`<p class="note">${hrq("lead", owner.name)}</p>
          <label class="field" for="hubOwnerAgentNote"><span>${hrq("note")}</span>
            <input id="hubOwnerAgentNote" type="text" maxlength="100" value=${note} onInput=${event => setNote(event.target.value.slice(0, 100))} />
            <small class="note">${note.length} / 100</small>
          </label>` : null}
      </fieldset>
      ${error ? html`<p class="note" role="alert">${error}</p>` : null}
    </form>
  </${Dialog}>`;
}

const valid = row => row && typeof row.id === "string" && typeof row.owner?.name === "string"
  && ["pending", "declined", "expired", "accepted"].includes(row.state);
export function OwnerAgentRequestRows({ client, roomId, page, onChanged, busy = false } = {}) {
  const [scope] = useState(() => client.roomAgentRequestScope?.());
  const [extra, setExtra] = useState([]), [next, setNext] = useState(page?.next ?? null), [error, setError] = useState(""), [working, setWorking] = useState(false);
  const live = useRef(true), pending = useRef(false);
  const view = useRef({ page, roomId });
  // Retire old responses at render, before the reset effect or a later operation can run.
  if (view.current.page !== page || view.current.roomId !== roomId) view.current = { page, roomId };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useLayoutEffect(() => {
    setExtra([]); setNext(page?.next ?? null); setError(""); setWorking(false); pending.current = false;
  }, [page, roomId]);
  useEffect(() => client.subscribeRooms?.({ "invitation.changed": () => onChanged?.() }) ?? (() => {}), [client, roomId, onChanged]);
  const rows = [...(Array.isArray(page?.requests) ? page.requests : []), ...extra].filter(valid);
  const act = async (id, more = false) => {
    if (pending.current) return;
    const mine = view.current;
    pending.current = true; setWorking(true); setError("");
    let result;
    try { result = await (more ? client.roomAgentRequests(scope, roomId, next) : client.cancelRoomAgentRequest(scope, roomId, id)); }
    catch { result = null; }
    if (!live.current || mine !== view.current) return;
    pending.current = false; setWorking(false);
    if (result?.ok) {
      if (more) { setExtra(old => [...old, ...(Array.isArray(result.requests) ? result.requests : [])]); setNext(result.next ?? null); }
      else onChanged?.();
    } else setError(hrq("failed"));
  };
  return html`<div class="hub-room-owner-requests">
    ${rows.length ? html`<ul class="hub-settings-invited">${rows.map(row => html`<li class="hub-settings-row" key=${row.id} data-owner-request=${row.id}>
      <span>${hrq(row.state === "pending" ? "waiting" : row.state, row.owner.name)}</span>
      ${row.state === "pending" ? html`<button type="button" class="btn btn-link" disabled=${busy || working} onClick=${() => { void act(row.id); }}>${hrq("cancelRequest")}</button>` : null}
    </li>`)}</ul>` : null}
    ${next ? html`<button type="button" class="btn btn-ghost" disabled=${busy || working} onClick=${() => { void act(null, true); }}>${hrq("more")}</button>` : null}
    ${error ? html`<p class="note" role="alert">${error}</p>` : null}
  </div>`;
}
