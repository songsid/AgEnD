import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { Dialog } from "/assets/ui-dialog.js";
import { RoomPicker } from "./hub-room-new.js";
import { hrq } from "./hub-room-owner-requests-strings.js";
import { hn } from "./hub-room-new-strings.js";
import { dateTimeText } from "/assets/clock-text.js";

export function ownerRequestError(result, owner) {
  if (result?.code === "owner-not-taking-requests") return hrq("ownerOff", owner);
  if (result?.code === "request-open") return hrq("already", owner);
  if (result?.code === "request-limit" && Number.isSafeInteger(result.resetsAt) && result.resetsAt > 0 && result.resetsAt <= 8.64e15) {
    const time = dateTimeText(result.resetsAt, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
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

const validOwnerRequest = row => row && row.kind === "owner-request" && typeof row.id === "string"
  && typeof row.room?.name === "string" && typeof row.by?.name === "string";
const choiceReason = row => hrq(({ "not-shared": "notShared", paused: "paused", "already-in-room": "inRoom" })[row.reason] || "unavailable");
function myAgentsHint(text) {
  const label = hrq("myAgents"), at = text.indexOf(label);
  return at < 0 ? text : html`${text.slice(0, at)}<a href="/ui/hub/exposures">${label}</a>${text.slice(at + label.length)}`;
}

/** Feature-gated separately from legacy invitations, so cached readers keep their original API shape. */
export function OwnerAgentRequestsList({ client, heading = true } = {}) {
  if (client.ownerRequestsLive?.() !== true) return null;
  return html`<${OwnerRequestList} key=${client.roomAgentRequestScope?.()} client=${client} heading=${heading} />`;
}
function OwnerRequestList({ client, heading }) {
  const [scope] = useState(() => client.roomAgentRequestScope());
  const [page, setPage] = useState(null), [error, setError] = useState(false), [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const live = useRef(true), generation = useRef(0), readingMore = useRef(false), writing = useRef(false);
  const reload = async () => {
    const mine = ++generation.current; readingMore.current = false; setLoading(false);
    let result; try { result = await client.ownerAgentRequests(scope); } catch { result = null; }
    if (!live.current || mine !== generation.current) return;
    if (result?.ok && Array.isArray(result.requests)) { setPage({ requests: result.requests.filter(validOwnerRequest), next: result.next || null }); setError(false); }
    else setError(true);
  };
  useEffect(() => {
    live.current = true; void reload();
    const off = client.subscribeRooms?.({ "invitation.changed": () => { void reload(); } }) ?? (() => {});
    return () => { live.current = false; generation.current++; off(); };
  }, [client, scope]);
  const more = async () => {
    if (readingMore.current || !page?.next) return;
    const mine = generation.current; readingMore.current = true; setLoading(true); setError(false);
    let result; try { result = await client.ownerAgentRequests(scope, page.next); } catch { result = null; }
    if (!live.current || mine !== generation.current) return;
    readingMore.current = false; setLoading(false);
    if (result?.ok && Array.isArray(result.requests)) setPage(old => ({ requests: [...new Map([...old.requests, ...result.requests.filter(validOwnerRequest)].map(row => [row.id, row])).values()], next: result.next || null }));
    else setError(true);
  };
  const answer = async (item, choice) => {
    if (writing.current) return { ok: false, ignored: true };
    writing.current = true; setBusy(true); setNotice("");
    let result;
    try { result = await (choice ? client.acceptOwnerAgentRequest(scope, item.id, { exposureId: choice.exposureId, revision: choice.revision })
      : client.declineOwnerAgentRequest(scope, item.id)); } catch { result = null; }
    if (!live.current) return result;
    writing.current = false; setBusy(false);
    if (result?.ok || result?.status === 404) {
      generation.current++; readingMore.current = false; setLoading(false);
      setPage(old => old ? { ...old, requests: old.requests.filter(row => row.id !== item.id) } : old);
      setNotice(result?.ok ? hrq(choice ? "added" : "declinedNotice", item.room.name) : hrq("gone"));
      void reload();
    }
    return result;
  };
  return html`<section class="hub-owner-agent-requests" aria-label=${hrq("requestsTitle")}>
    ${page?.requests.length && heading ? html`<h3>${hrq("requestsTitle")}</h3>` : null}
    ${page?.requests.map(item => html`<${OwnerRequestCard} key=${item.id} client=${client} scope=${scope} item=${item} busy=${busy} onAnswer=${answer} />`)}
    ${page?.next ? html`<button class="btn btn-ghost" disabled=${loading || busy} onClick=${() => { void more(); }}>${hrq("more")}</button>` : null}
    ${error ? html`<p class="note" role="alert">${hrq("loadFailed")} <button class="btn btn-link" onClick=${() => { void reload(); }}>${hrq("retry")}</button></p>` : null}
    ${notice ? html`<p class="note" role="status">${notice}</p>` : null}
  </section>`;
}
function OwnerRequestCard({ client, scope, item, busy, onAnswer }) {
  const [view, setView] = useState(null), [selected, setSelected] = useState(null), [error, setError] = useState("");
  const live = useRef(true), generation = useRef(0);
  const load = async () => {
    const mine = ++generation.current;
    let result; try { result = await client.ownerAgentRequest(scope, item.id); } catch { result = null; }
    if (!live.current || mine !== generation.current) return;
    if (result?.ok && Array.isArray(result.choices)) {
      const choices = result.choices.filter(row => row && typeof row.key === "string" && typeof row.name === "string")
        .sort((a, b) => Number(b.canAdd === true) - Number(a.canAdd === true));
      setView({ request: result.request, choices });
      const available = choices.filter(row => row.canAdd === true && typeof row.exposureId === "string" && Number.isSafeInteger(row.revision));
      setSelected(old => available.some(row => row.key === old) ? old : available.length === 1 ? available[0].key : null);
    } else setError(hrq(result?.status === 404 ? "gone" : "loadFailed"));
  };
  useEffect(() => { live.current = true; void load(); return () => { live.current = false; generation.current++; }; }, [client, scope, item.id]);
  const chosen = view?.choices.find(row => row.key === selected && row.canAdd === true);
  const available = view?.choices.filter(row => row.canAdd === true) || [];
  const act = async choice => {
    setError(""); const result = await onAnswer(item, choice);
    if (!live.current || result?.ignored || result?.ok || result?.status === 404) return;
    setError(hrq("actionFailed")); if (result?.status === 409) void load();
  };
  const request = view?.request || item;
  return html`<article class="hub-invitation" data-owner-request-card=${item.id}>
    <p class="hub-owner-request-title">${hrq("requestLead", request.by?.name || "", request.room.name)}</p>
    ${request.note ? html`<blockquote>${hrq("quotedNote", request.note)}</blockquote>` : null}
    <p class="note">${hrq(request.room.people === 1 ? "requestBodyOne" : "requestBody", Number(request.room.people) || 0)}</p>
    ${view && !available.length ? html`<p class="note">${myAgentsHint(hrq("noAgents"))}</p>` : null}
    ${view ? html`<fieldset class="hub-owner-agent-choices" disabled=${busy}><legend>${hrq(available.length > 1 && !chosen ? "chooseAgent" : "which")}</legend>
      ${view.choices.length ? view.choices.map(row => html`<label class="check" key=${row.key}>
        <input type="radio" name=${"owner-request-" + item.id} value=${row.key} disabled=${!row.canAdd} checked=${selected === row.key} onChange=${() => setSelected(row.key)} />
        <span><strong>${row.name}</strong>${row.kind === "classic-room" ? html` <small class="tag">${hrq("classic")}</small>` : null}
          ${row.intro ? html`<small class="note">${row.intro}</small>` : null}
          ${!row.canAdd ? html`<small class="note">${myAgentsHint(choiceReason(row))}</small>` : null}</span>
      </label>`) : null}
    </fieldset>` : null}
    ${error ? html`<p class="note" role="alert">${error} <button class="btn btn-link" onClick=${() => { void load(); }}>${hrq("retry")}</button></p>` : null}
    <div class="field-row">${available.length ? html`<button type="button" class="btn btn-primary" disabled=${busy || !chosen} onClick=${() => { void act(chosen); }}>${hrq("add")}</button>` : null}
      <button type="button" class="btn" disabled=${busy} onClick=${() => { void act(null); }}>${hrq("decline")}</button></div>
  </article>`;
}

export function OwnerAgentRequestSetting({ client, scope } = {}) {
  if (typeof client?.agentRequestSettings !== "function" || !scope) return null;
  return html`<${OwnerRequestSetting} key=${scope} client=${client} scope=${scope} />`;
}
function OwnerRequestSetting({ client, scope }) {
  const [accepting, setAccepting] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const live = useRef(true), writing = useRef(false);
  useEffect(() => {
    live.current = true;
    void client.agentRequestSettings(scope).then(result => { if (live.current) { if (result?.ok && typeof result.accepting === "boolean") setAccepting(result.accepting); else setMessage(hrq("loadFailed")); } }, () => { if (live.current) setMessage(hrq("loadFailed")); });
    return () => { live.current = false; };
  }, [client, scope]);
  const change = async event => {
    if (writing.current || typeof accepting !== "boolean") return;
    const value = !event.target.checked; writing.current = true; setBusy(true); setMessage("");
    let result; try { result = await client.agentRequestSettings(scope, { accepting: value }); } catch { result = null; }
    if (!live.current) return;
    writing.current = false; setBusy(false);
    if (result?.ok) { setAccepting(result.accepting); setMessage(hrq("saved")); } else setMessage(hrq("actionFailed"));
  };
  return html`<section class="card hub-owner-request-setting"><label class="check">
    <input type="checkbox" checked=${accepting === false} disabled=${busy || accepting === null} onChange=${change} />
    <span>${hrq("stopRequests")}</span></label><p class="note">${hrq("stopHint")}</p>
    ${message ? html`<p class="note" role="status">${message}</p>` : null}</section>`;
}

export function OwnerAgentDiscoverySetting({ client, scope, exposure } = {}) {
  if (!scope || !exposure?.id || typeof client?.agentRoomDiscovery !== "function") return null;
  return html`<${AgentDiscoverySetting} key=${scope + ":" + exposure.id + ":" + exposure.revision + ":" + (exposure.sharingEpoch || 0)} client=${client} scope=${scope} exposure=${exposure} />`;
}
function AgentDiscoverySetting({ client, scope, exposure }) {
  const [view, setView] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true), writing = useRef(false), generation = useRef(0);
  const load = async () => {
    if (writing.current) return;
    const mine = ++generation.current;
    let r; try { r = await client.agentRoomDiscovery(scope, exposure.id); } catch { r = null; }
    if (!live.current || mine !== generation.current) return;
    if (r?.ok && typeof r.findable === "boolean" && typeof r.available === "boolean") { setView(r); setError(""); }
    else setError(hrq("loadFailed"));
  };
  useEffect(() => { live.current = true; writing.current = false; setBusy(false); setView(null); void load(); return () => { live.current = false; generation.current++; }; }, [client, scope, exposure.id]);
  const change = async event => {
    if (writing.current || !view?.available) return;
    const findable = event.target.checked; writing.current = true; setBusy(true); setError("");
    const mine = ++generation.current;
    let r; try { r = await client.agentRoomDiscovery(scope, exposure.id, { findable, ifRevision: view.revision, exposureRevision: view.exposureRevision }); } catch { r = null; }
    if (!live.current || mine !== generation.current) return;
    writing.current = false; setBusy(false);
    if (r?.ok) setView(r); else { setError(hrq("actionFailed")); if (r?.status === 403 || r?.status === 409) void load(); }
  };
  return html`<section class="card hub-room-discovery-setting"><label class="check"><input type="checkbox" checked=${view?.findable === true} disabled=${busy || !view?.available} onChange=${change} /><span>${hrq("discoveryLabel")}</span></label>
    <p class="note">${hrq("discoveryHint")}</p>
    ${view?.reason ? html`<p class="note">${hrq(view.reason === "owner-disabled" ? "discoveryOptOut" : view.reason === "paused" ? "discoveryPaused" : "discoveryUnshared")}</p>` : null}
    ${error ? html`<p class="note" role="alert">${error} <button class="btn btn-link" onClick=${() => { void load(); }}>${hrq("retry")}</button></p>` : null}
  </section>`;
}
