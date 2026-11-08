// AgEnD Hub P1, slice 3 (docs/design/hub-ui-client.md): Settings → Access & security → "Connect to a Hub", on a member
// fleet (the page's mark; never drawn or loaded while hub_member is off). The address and one-time code, then each
// pairing state as it is — waiting (the pairing fingerprint to compare, both confirmations), connected (the approved
// Hub key's fingerprint), the key changed (both keys, labelled; only pair again or disconnect), on hold (why) — then
// this fleet's own agents with a Share switch each, against the revision shown (a stale tab gets a conflict, never a
// silent widening). Everything goes through hubClient(); until slice 1 that is a stub, and the card says so.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Skeleton, ErrorState } from "/assets/ui-states.js";
import { Icon } from "/assets/ui-icons.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { compareGroups, hubClient, safeWebOrigin, ADDRESS_HINT, CODE_HINT } from "./hub-client.js";
import { hw, linkHubCss } from "./hub-strings.js";
import { guidanceFor } from "./hub-provider-guidance.js";
import { AGENT_CHOICE } from "./hub-agent-copy.js";
import { PairingNotices } from "./hub-quick-pairing.js";
import { hq } from "./hub-quick-strings.js";
import { hp } from "./hub-pairing-progress-strings.js";

const CONNECT_ERRORS = { address: "errAddress", code: "errCode", busy: "errBusy", unreachable: "errUnreachable", refused: "errRefused" };
const HOLDS = new Set(["unknown_outcome", "expired", "unsaved", "refused", "revoked", "disconnected"]);
const PUBLISH_ERRORS = { conflict: "errConflict", unsaved: "errUnsaved", not_paired: "errNotPaired", not_enforceable: "agentNotShareable",
  unknown_view: "agentNotShareable", limit: "errLimit", unavailable: "notAvailable" };
// The switcher may have cached hub-strings before this action existed. Its original Allow word is still available.
const allowOnHubLabel = () => { const label = hw("allowOnHub"); return label === "hub.allowOnHub" ? `${hw("allow")}…` : label; };

// A queued local confirmation describes one operation, not every later pairing or link state.
function waitingForPairing(msg, p) {
  const pending = msg?.pending;
  if (!pending) return true;
  if (pending.action === "connect") return p?.state === "unpaired";
  if (pending.action === "confirm") return p?.state === "pending" && p.localConfirmed === false && p.fingerprint?.digest === pending.fingerprint;
  return pending.action === "disconnect" && p?.state === "paired" && p.binding === pending.binding && p.hub?.hubId === pending.hubId;
}

/** A fingerprint: its first 128 bits in groups people compare, the whole digest on request. */
function Fingerprint({ label, fp }) {
  const [full, setFull] = useState(false);
  const digest = fp && fp.digest ? String(fp.digest).toLowerCase() : "";
  return html`<div class="hub-fp">
    <span class="hub-fp-label">${label}</span>
    <code class="hub-fp-groups">${compareGroups(digest)}</code>
    ${digest.length > 32 ? html`<button type="button" class="btn btn-sm btn-link" aria-expanded=${full ? "true" : "false"} onClick=${() => setFull(!full)}>${hw(full ? "hideFull" : "showFull")}</button>` : null}
    ${full ? html`<code class="hub-fp-full">${digest}</code>` : null}
  </div>`;
}

export function HubConnectCard() {
  const client = hubClient();
  const [pairing, setPairing] = useState(null);
  const [readError, setReadError] = useState(false);
  const [form, setForm] = useState({ address: "", code: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const live = useRef(true);
  const generation = useRef(0), activePending = useRef(null);
  const pendingMessage = (action, shown, result, token) => {
    const pending = { action, fingerprint: shown?.fingerprint?.digest, binding: shown?.binding, hubId: shown?.hub?.hubId };
    activePending.current = pending;
    setMsg({ error: false, text: hw("waitingConfirm"), pending });
    if (!result.settled?.then) return; // An older client still clears its hint when the projection advances.
    const current = () => live.current && generation.current === token && activePending.current === pending;
    const finish = async outcome => {
      if (!current()) return;
      let next;
      try { next = await client.pairing(); } catch { /* unknown result, never a retry/success claim */ }
      if (!current()) return;
      if (next) setPairing(next);
      activePending.current = null;
      const text = !next || !["applied", "failed", "expired", "rejected", "stale"].includes(outcome?.state) ? hp("unknown")
        : outcome.state === "applied" || !waitingForPairing({ pending }, next) ? null
        : action === "connect" && next.state === "unpaired" && ["failed", "expired"].includes(outcome.state) ? hp("connectFailed") : hp("notApplied");
      setMsg(old => old?.pending === pending ? text ? { error: true, text } : null : old);
    };
    void Promise.resolve(result.settled).then(finish, () => finish(null));
  };
  useEffect(() => {
    if (msg?.pending && !waitingForPairing(msg, pairing)) {
      if (activePending.current === msg.pending) activePending.current = null;
      setMsg(null);
    }
  }, [msg, pairing]);
  const readPairing = () => {
    setReadError(false);
    return client.pairing().then((p) => { if (live.current) setPairing(p); }, () => { if (live.current) setReadError(true); });
  };
  useEffect(() => {
    linkHubCss();
    live.current = true;
    readPairing();
    const off = client.subscribe((p) => { if (live.current) setPairing(p); });
    return () => { live.current = false; generation.current++; activePending.current = null; off(); };
  }, []);
  const act = async (fn) => {
    if (busy) return;
    const token = ++generation.current; activePending.current = null;
    setBusy(true); setMsg(null);
    try { await fn(token); } catch { if (live.current && token === generation.current) setMsg({ error: true, text: hw("errFailed") }); }
    finally { if (live.current) setBusy(false); }
  };
  const connect = () => act(async token => {
    const r = await client.connect({ address: form.address.trim(), code: form.code.trim() });
    if (!live.current) return;
    if (r.ok) { setPairing(r.pairing); setForm({ address: "", code: "" }); if (r.pendingConfirmation) pendingMessage("connect", null, r, token); }
    else setMsg({ error: true, text: hw(CONNECT_ERRORS[r.error] || "errFailed") });
  });
  const disconnect = (name) => act(async token => {
    const shown = pairing;                                  // #3115 r2: the pairing on screen now, before the dialog
    if (!(await confirmDialog({ message: hw("disconnectAsk", name), confirmLabel: hw("disconnect"), danger: true }))) return;
    const r = await client.disconnect(shown);
    if (!live.current) return;
    if (!r.ok) { setMsg({ error: true, text: hw("errUnsaved") }); return; }
    setPairing(await client.pairing());
    if (r.pendingConfirmation) { pendingMessage("disconnect", shown, r, token); return; }
    if (r.remote === "pending") setMsg({ error: false, text: hw("disconnectPending") });
  });
  const cancel = () => act(async () => { const p = await client.cancel(); if (live.current) setPairing(p); });

  const p = pairing;
  let body = null;
  if (!p) body = readError ? html`<${ErrorState} message=${hw("errFailed")} onRetry=${readPairing} />` : html`<${Skeleton} variant="form" lines=${4} />`;
  else if (p.state === "unpaired") {
    const addressOk = ADDRESS_HINT.test(form.address.trim()), codeOk = CODE_HINT.test(form.code.trim());
    body = html`<form class="form hub-connect" onSubmit=${(e) => { e.preventDefault(); connect(); }}>
      <label class="field"><span>${hw("address")}</span><input id="hubAddress" type="url" inputmode="url" autocomplete="off" spellcheck=${false}
        placeholder=${hw("addressPh")} value=${form.address} onInput=${(e) => { const v = e.target.value; setForm((f) => ({ ...f, address: v })); }} /><small class="note">${hw("addressHint")}</small></label>
      <label class="field"><span>${hw("code")}</span><input id="hubCode" autocomplete="one-time-code" spellcheck=${false} autocapitalize="characters"
        value=${form.code} onInput=${(e) => { const v = e.target.value; setForm((f) => ({ ...f, code: v })); }} /></label>
      <div class="field-row"><button type="submit" class="btn btn-primary" disabled=${busy || !addressOk || !codeOk}>${hw("connect")}</button></div>
    </form>`;
  } else if (p.state === "pending") {
    const step = (ok, key) => html`<li class=${ok ? "is-done" : ""}><${Icon} name=${ok ? "check" : "clock"} size=${14} /><span>${hw(key)}</span><small>${hw(ok ? "done" : "waiting")}</small></li>`;
    body = html`<div class="hub-state hub-pending" role="status">
      <h4>${hw("pendingTitle")}</h4>
      <p class="hub-origin"><code>${p.memberOrigin}</code></p>
      <${Fingerprint} label=${hw("pairingFp")} fp=${p.fingerprint} />
      <p class="note">${hw("pendingCompare")}</p>
      ${p.localConfirmed === false && client.confirmFingerprint ? html`<div class="field-row"><button type="button" class="btn btn-primary hub-local-confirm" disabled=${busy}
          onClick=${() => act(async token => { const r = await client.confirmFingerprint(p.fingerprint.digest); if (!live.current) return;
            if (r.ok) { setPairing(r.pairing); if (r.pendingConfirmation) pendingMessage("confirm", p, r, token); }
            else setMsg({ error: true, text: hw(r.error === "expired" ? "hold_expired" : r.error === "conflict" ? "errConflict" : "errUnsaved") }); })}>${hw("localMatch")}</button></div>`
        : p.localConfirmed === true ? html`<p class="note hub-local-confirmed">${hw("localConfirmed")}</p>` : null}
      ${p.ownerConfirmed === null && p.adminApproved === null
        // S3c: the member cannot see the Hub's progress — the two steps as instructions, no marks.
        ? html`<p class="hub-steps-lead">${hq("remoteSteps")}</p>
          <ul class="hub-steps hub-steps-unknown"><li><span>${hq("ownerStep")}</span></li><li><span>${hq("policyStep")}</span></li></ul>
          <p class="note">${hw("hubProgressHidden")}</p>`
        : html`<p class="hub-steps-lead">${hw("pendingSteps")}</p>
          <ul class="hub-steps">${step(p.ownerConfirmed, "ownerStep")}${step(p.adminApproved, "adminStep")}</ul>`}
      ${Number.isFinite(p.expiresAt) ? html`<p class="note">${hw("expires", new Date(p.expiresAt).toLocaleTimeString())}</p>` : null}
      <div class="field-row"><button type="button" class="btn" disabled=${busy} onClick=${cancel}>${hw("cancel")}</button></div>
    </div>`;
  } else if (p.state === "paired") {
    const origin = safeWebOrigin(p), name = p.hub.name || p.hub.memberOrigin;
    body = html`<div class="hub-state hub-paired">
      <h4>${hw("pairedTitle", name)} <span class=${`hub-link ${p.link === "online" ? "is-online" : "is-offline"}`}>${hw(p.link === "online" ? "online" : "offline")}</span></h4>
      <p class="hub-origin"><code>${p.hub.memberOrigin}</code></p>
      <${Fingerprint} label=${hw("hubKeyFp")} fp=${p.hub.fingerprint} />
      <div class="field-row">
        ${origin ? html`<a class="btn" href=${origin} target="_blank" rel="noopener noreferrer">${hw("openHub")}<${Icon} name="external" size=${14} /></a>` : null}
        <button type="button" class="btn btn-danger" disabled=${busy} onClick=${() => disconnect(name)}>${hw("disconnect")}</button>
      </div>
    </div>`;
  } else if (p.state === "key_changed") {
    const name = p.hub.name || p.hub.memberOrigin;
    body = html`<div class="hub-state hub-key-changed" role="alert">
      <h4><${Icon} name="alert" size=${16} /> ${hw("keyTitle")}</h4>
      <p>${hw("keyLead")}</p>
      <${Fingerprint} label=${hw("keyApproved")} fp=${p.hub.fingerprint} />
      <${Fingerprint} label=${hw("keyOffered")} fp=${p.offered} />
      <div class="field-row">
        <button type="button" class="btn" disabled=${busy} onClick=${() => act(async () => { const shown = pairing; await client.disconnect(shown); if (live.current) setPairing(await client.pairing()); })}>${hw("repair")}</button>
        <button type="button" class="btn btn-danger" disabled=${busy} onClick=${() => disconnect(name)}>${hw("disconnect")}</button>
      </div>
    </div>`;
  } else if (p.state === "held" && p.hold === "unavailable") {
    // An older host (404): one line, no form and no fake hold.
    body = html`<p class="note hub-unavailable">${hw("notAvailable")}</p>`;
  } else if (p.state === "held") {
    body = html`<div class="hub-state hub-held" role="alert">
      <h4><${Icon} name="pause" size=${16} /> ${hw("heldTitle")}</h4>
      <p>${hw(HOLDS.has(p.hold) ? `hold_${p.hold}` : "hold_other")}</p>
      ${p.memberOrigin ? html`<p class="hub-origin"><code>${p.memberOrigin}</code></p>` : null}
      <div class="field-row"><button type="button" class="btn" disabled=${busy} onClick=${cancel}>${hw(p.hold === "disconnected" ? "startOver" : "holdClear")}</button></div>
    </div>`;
  }
  return html`<section class="card s-hub-connect" id="hub-connect">
    <h3>${hw("title")}</h3>
    <p class="note">${hw("lead")}</p>
    ${client.stub ? html`<p class="note hub-preview" role="note">${hw("preview")}</p>` : null}
    ${body}
    ${p?.state === "paired" && client.pairingNotices?.().length ? html`<${PairingNotices} memberNotices=${client.pairingNotices()} memberOrigin=${safeWebOrigin(p)} />` : null}
    ${msg && waitingForPairing(msg, p) ? html`<p class=${msg.error ? "err" : "note"} role=${msg.error ? "alert" : "status"}>${msg.text}</p>` : null}
    ${p && p.state === "paired" ? html`<${HubExposures} key=${`${p.binding}|${p.hub.hubId}|${p.hub.fingerprint?.digest}|${safeWebOrigin(p)}`} client=${client} pairing=${p} />` : null}
  </section>`;
}

/**
 * This fleet's own agents, each private unless shared — against the revision the page shows. P1 shares the agent
 * itself (docs/design/hub-representative-agent.md): switching on sends AGENT_CHOICE for the owner's confirmation; a row
 * shared under the older restricted mode says so and offers "Share again" (a new, confirmed revision).
 */
function HubExposures({ client, pairing }) {
  const [rows, setRows] = useState(null);
  const [readError, setReadError] = useState(false);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const live = useRef(true);
  const load = () => { setReadError(false); return client.exposures().then((r) => { if (live.current) setRows(r); }, () => { if (live.current) setReadError(true); }); };
  useEffect(() => { live.current = true; load(); return () => { live.current = false; }; }, []);
  const toggle = async (row, on) => {
    if (busy) return;
    setBusy(row.agent); setMsg(null);
    try {
      const r = await client.setExposed(row.agent, on, row.revision, on ? AGENT_CHOICE : null);
      if (!live.current) return;
      if (!r.ok) { setMsg({ error: true, text: hw(PUBLISH_ERRORS[r.error] || "errUnsaved") }); if (r.error === "conflict") await load(); return; }
      if (!on && r.remote === "pending") setMsg({ error: false, text: hw("withdrawPending") });
      if (r.pending) { setMsg({ error: false, text: hw("pendingSent") }); if (r.settled && r.settled.then) r.settled.then(() => { if (live.current) load(); }, () => { if (live.current) load(); }); }
      await load();
    } catch { if (live.current) setMsg({ error: true, text: hw("errUnsaved") }); }
    finally { if (live.current) setBusy(null); }
  };
  return html`<div class="hub-exposures">
    <h4>${hw("sharedTitle")}</h4>
    <p class="note">${hw("agentLead")}</p>
    ${readError ? html`<${ErrorState} message=${hw("errFailed")} onRetry=${load} />` : !rows ? html`<${Skeleton} variant="rows" lines=${3} />` : null}
    ${rows && !rows.length ? html`<p class="note">${hw("noAgents")}</p>` : null}
    ${rows && rows.length ? html`<ul class="hub-exposure-list">${rows.map((row) => html`<li key=${row.agent} class=${`hub-exposure${row.state === "published" ? " is-shared" : ""}`}>
      <label class="hub-exposure-main">
        <input class="s-ui-toggle" type="checkbox" role="switch" checked=${row.state === "published"} aria-label=${hw("share", row.display)}
          disabled=${busy !== null || !!row.pending || row.state === "frozen" || (row.state !== "published" && !row.enforceable)}
          onChange=${(e) => toggle(row, e.target.checked)} />
        <span class="hub-exposure-name">${row.display}${row.display !== row.agent ? html` <small><code>${row.agent}</code></small>` : null}</span>
      </label>
      ${row.pending ? html`<small class="hub-exposure-why hub-exposure-pending">${hw("waitingConfirm")}</small>`
        : row.state === "frozen" ? html`<small class="hub-exposure-why">${hw("frozen")}</small>`
        : !row.enforceable && row.state !== "published" ? html`<small class="hub-exposure-why">${hw(row.reason === "delivery_unavailable" ? "agentDeliveryUnavailable" : "agentNotShareable")}</small>`
        : row.reason === "republish_required" ? html`<small class="hub-exposure-why hub-exposure-republish">${hw("republishRequired")}
            <button type="button" class="btn btn-sm" disabled=${busy !== null} onClick=${() => toggle(row, true)}>${hw("shareAgain")}</button></small>`
        : row.policy && row.policy.dataView === AGENT_CHOICE.dataViewId ? html`<small class="hub-exposure-why">${hw("agentShared")}</small>`
        : row.policy ? html`<small class="hub-exposure-why">${hw("policy", row.policy.dataView, row.policy.tools.join(", ") || "—")}</small>` : null}
      ${!row.enforceable && row.state !== "frozen" && guidanceFor(row.reason)
        ? html`<small class="hub-exposure-why hub-provider-guidance">${hw(guidanceFor(row.reason))}</small>` : null}
      ${row.state === "published" && !row.pending && /^[a-f0-9-]{36}$/.test(row.exposureId || "") && safeWebOrigin(pairing)
        ? html`<div class="field-row"><a class="btn btn-sm" href=${`${safeWebOrigin(pairing)}/ui/hub/exposures?agent=${encodeURIComponent(row.exposureId)}&grant=1`} target="_blank" rel="noopener noreferrer">${allowOnHubLabel()}</a></div>` : null}
    </li>`)}</ul>` : null}
    ${msg ? html`<p class=${msg.error ? "err" : "note"} role=${msg.error ? "alert" : "status"}>${msg.text}</p>` : null}
  </div>`;
}
