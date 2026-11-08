import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { ErrorState, Skeleton } from "/assets/ui-states.js";
import { compareGroups, hubClient, safeWebOrigin } from "./hub-client.js";
import { hq } from "./hub-quick-strings.js";
import { hr } from "./hub-read-strings.js";
import { linkHubOwnerCss } from "./hub-owner-strings.js";

const reason = (r) => hq(r.code === "expired" ? "expired" : r.code === "conflict" ? "conflict" : r.code === "backpressure" ? "limit"
  : r.code === "denied" || r.code === "revoked" ? "denied" : r.code === "unavailable" || r.code === "unreachable" ? "unavailable" : "failed");
const time = (at) => new Date(at).toLocaleString();

/** The page controls its own attempt only. The separate fleet-local proof is never performed by this component. */
export function QuickPairingGuide({ allowed = false, publishAllowed = false, onConnected = () => {} }) {
  const c = hubClient(), live = useRef(true), generation = useRef(0), reported = useRef(null);
  const [attempt, setAttempt] = useState(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [label, setLabel] = useState(""), [error, setError] = useState(null), [mismatch, setMismatch] = useState(false), [stopped, setStopped] = useState(false);
  const [copied, setCopied] = useState(null), [full, setFull] = useState(false);
  const load = async (id = null) => {
    const captured = generation.current, r = await c.quickPairing(id);
    if (!live.current || captured !== generation.current) return;
    setLoading(false);
    if (!r.ok) { if (r.code === "expired") { generation.current++; setAttempt(null); } setError(reason(r)); return; }
    setError(null); setAttempt(old => r.attempt ? { ...(old?.id === r.attempt.id ? old : {}), ...r.attempt, memberOrigin: r.memberOrigin } : null);
  };
  useEffect(() => { linkHubOwnerCss(); live.current = true; void load(); return () => { live.current = false; generation.current++; }; }, []);
  useEffect(() => { if (attempt?.connected && reported.current !== attempt.id) { reported.current = attempt.id; onConnected(); } }, [attempt?.connected, attempt?.id]);
  useEffect(() => {
    if (!attempt?.id || attempt.connected || mismatch || stopped) return;
    let pending = false;
    const timer = setInterval(() => { if (!document.hidden && !pending) { pending = true; void load(attempt.id).finally(() => { pending = false; }); } }, 2000);
    return () => clearInterval(timer);
  }, [attempt?.id, attempt?.connected, mismatch, stopped]);
  const create = async (event) => {
    event.preventDefault(); if (busy || !allowed || !label.trim()) return;
    const captured = ++generation.current; setBusy(true); setError(null); setMismatch(false); setStopped(false);
    const r = await c.createQuickPairing(label.trim());
    if (!live.current || captured !== generation.current) return;
    setBusy(false);
    if (!r.ok) { setError(reason(r)); return; }
    setAttempt({ id: r.pairingId, code: r.code, expiresAt: r.expiresAt, memberOrigin: r.memberOrigin, state: "offered", connected: false });
  };
  const stop = async (different = false) => {
    if (busy || !attempt?.id) return;
    if (different) setMismatch(true);
    const id = attempt.id, captured = ++generation.current; setBusy(true); setError(null);
    const r = await c.stopQuickPairing(id);
    if (!live.current || captured !== generation.current) return;
    setBusy(false);
    if (!r.ok) { setError(reason(r)); return; }
    setStopped(true); setAttempt(null);
  };
  const match = async () => {
    if (busy || mismatch || !attempt?.fingerprint) return;
    const id = attempt.id, fp = attempt.fingerprint, captured = generation.current; setBusy(true); setError(null);
    const r = await c.confirmPairing(id, fp);
    if (!live.current || captured !== generation.current) return;
    setBusy(false); if (!r.ok) { setError(reason(r)); return; }
    await load(id);
  };
  const copy = async (key, value) => { try { await navigator.clipboard.writeText(value); if (live.current) setCopied(key); } catch { /* text remains selectable */ } };
  // The Hub cannot observe the fleet-local button. Only its later claim proves that step completed; accepting
  // the code or confirming on the Hub alone does not. Connected still requires the pinned ready link below.
  if (loading) return html`<${Skeleton} variant="rows" lines=${2} />`;
  if (!allowed && !attempt && !error) return null;
  return html`<div data-quick-pairing="guide">
    ${error ? html`<${ErrorState} message=${error} onRetry=${() => load(attempt?.id)} />` : null}
    ${mismatch ? html`<p class="err" role="alert">${stopped ? hq("mismatchStop") : hq("compare")}</p>` : null}
    ${stopped ? html`<p class="note" role="status">${hq("stopped")}</p>` : null}
    ${!attempt ? allowed ? html`<form onSubmit=${create}><label for="quickFleetLabel">${hq("label")}</label>
      <input id="quickFleetLabel" value=${label} maxLength="120" required placeholder=${hq("labelExample")} onInput=${e => setLabel(e.target.value)} />
      <p class="note">${hq("labelHint")} ${hq("privacy")}</p><div class="field-row"><button type="submit" class="btn btn-primary" disabled=${busy || !label.trim()}>${hq(stopped ? "again" : "start")}</button></div></form>` : null
      : attempt.connected ? html`<p class="note" role="status"><b>${hq("connected")}</b></p><h4>${hq("publish")}</h4><p class="note">${hq(publishAllowed ? "publishHint" : "publishNo")}</p>
        ${allowed ? html`<div class="field-row"><button type="button" class="btn" onClick=${() => { generation.current++; setAttempt(null); }}>${hq("another")}</button></div>` : null}`
      : html`<ol class="hub-steps"><li class=${attempt.state === "claimed" ? "done" : "now"}><div class="hub-step-body"><h4>${hq("localTitle")}</h4><p class="note">${hq("local")}</p>
        <span class="note">${hq("address")}</span><code class="hub-fp-full">${attempt.memberOrigin}</code>
        ${attempt.code ? html`<span class="note">${hq("code")}</span><code class="hub-fp-groups">${attempt.code}</code><button type="button" class="btn btn-sm" onClick=${() => copy("code", attempt.code)}>${hq(copied === "code" ? "copied" : "copy")}</button>` : html`<p class="note">${hq(attempt.state === "claimed" ? "claim" : "waiting")}</p>`}
        <p class="note">${hq("expires", time(attempt.expiresAt))}</p></div></li>
        <li class=${attempt.fingerprint ? "now" : ""}><div class="hub-step-body"><h4>${hq("compareTitle")}</h4><p class="note">${hq("compare")}</p>
          ${attempt.fingerprint ? html`<code class="hub-fp-groups">${compareGroups(attempt.fingerprint)}</code>
            <button type="button" class="btn btn-sm btn-link" aria-expanded=${full} onClick=${() => setFull(!full)}>${full ? "SHA-256 −" : "SHA-256 +"}</button>
            ${full ? html`<code class="hub-fp-full">${attempt.fingerprint}</code>` : null}
            ${attempt.ownerConfirmed ? html`<p class="note" role="status">${hq("claim")}</p>` : html`<div class="field-row"><button type="button" class="btn btn-primary" disabled=${busy || mismatch} onClick=${match}>${hq("match")}</button>
              <button type="button" class="btn" disabled=${busy} onClick=${() => stop(true)}>${hq("mismatch")}</button></div>`}` : null}
        </div></li></ol>`}
    ${attempt && !attempt.connected ? html`<div class="field-row"><button type="button" class="btn" disabled=${busy} onClick=${() => stop(false)}>${hq("stop")}</button></div>` : null}
  </div>`;
}

function Notice({ notice, admin = false, memberOrigin = null, after = () => {} }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const live = useRef(true); useEffect(() => () => { live.current = false; }, []);
  const revoke = async () => {
    if (busy || notice.revoked) return;
    setBusy(true); setError(false); const c = hubClient();
    const r = await (admin ? c.revokeFleet(notice.fleetId) : c.revokeOwnFleet(notice.fleetId, notice.generation));
    if (!live.current) return;
    setBusy(false); if (!r.ok) setError(true); else after();
  };
  let href = null;
  if (memberOrigin) { try { const origin = new URL(memberOrigin); if (origin.protocol === "https:") href = `${origin.origin}/ui/hub?securityNotice=${encodeURIComponent(notice.id)}`; } catch { /* no link */ } }
  return html`<div data-pairing-notice=${notice.id}><p><b>${hq("notice", notice.label)}</b></p><p class="note">${hq("approved")} ${time(notice.at)}</p>
    <p class="note">${hq("fleetId")} <code class="hub-fp-full">${notice.fleetId}</code></p>
    <p class="note">${hq("revokeHint")}</p>
    ${notice.revoked ? html`<span class="tag">${hq("revoked")}</span>` : href ? html`<a class="btn" target="_blank" rel="noopener noreferrer" href=${href}>${hq("review")}</a>`
      : html`<div class="field-row"><button type="button" class="btn btn-danger" disabled=${busy} onClick=${revoke}>${hq("revoke")}</button></div>`}
    ${error ? html`<p class="err" role="alert">${hq("revokeFailed")}</p>` : null}</div>`;
}

/** Narrowing remains available when current connect permission is denied or unknown. */
export function OwnedFleetRevoke({ fleet, onRevoked }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const live = useRef(true); useEffect(() => () => { live.current = false; }, []);
  if (!Number.isSafeInteger(fleet.generation) || fleet.status === "revoked") return null;
  const revoke = async () => {
    if (busy) return; setBusy(true); setError(false);
    const r = await hubClient().revokeOwnFleet(fleet.id, fleet.generation);
    if (!live.current) return;
    setBusy(false); if (r.ok) onRevoked(); else setError(true);
  };
  return html`<button type="button" class="btn btn-sm btn-danger" disabled=${busy} onClick=${revoke}>${hq("revoke")}</button>
    ${error ? html`<small class="err" role="alert">${hq("revokeFailed")}</small>` : null}`;
}
export function PairingNotices({ admin = false, memberNotices = null, memberOrigin = null }) {
  const c = hubClient(), live = useRef(true), epoch = useRef(0), acked = useRef(new Set());
  const [noticeError, setNoticeError] = useState(null);
  const [notices, setNotices] = useState(memberNotices || []);
  const [historyOpen, setHistoryOpen] = useState(false), [historyCount, setHistoryCount] = useState(99);
  const load = async () => {
    const mine = epoch.current;
    let r; try { r = await c.pairingNotices(); } catch { r = { ok: false, code: "unreachable" }; }
    if (live.current && mine === epoch.current) {
      if (r.ok) { setNotices(r.notices || []); setNoticeError(null); }
      else { setNotices([]); setNoticeError(r.code === "backpressure" ? "busy" : "noticesUnavailable"); }
    }
    return r;
  };
  useEffect(() => {
    live.current = true; const mine = ++epoch.current;
    const current = () => live.current && mine === epoch.current;
    if (memberNotices) { setNotices(memberNotices); setNoticeError(null); return () => { live.current = false; epoch.current++; }; }
    let off = () => {}, timer = null, reading = false;
    const later = (fn, r = {}) => {
      const seconds = Number(r.retryAfter); clearTimeout(timer);
      timer = setTimeout(() => { if (current()) void fn(); },
        (Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.min(300, seconds)) : 10) * 1000);
    };
    const recover = async () => {
      if (!current() || reading) return;
      off(); reading = true;
      const r = await load(); reading = false;
      if (!current()) return;
      if (r.ok) { setNoticeError("noticesRetry"); later(subscribe); }
      else later(recover, r);
    };
    const subscribe = () => {
      if (!current()) return;
      off(); off = c.subscribePairingNotices(rows => { if (current()) { setNotices(rows); setNoticeError(null); } },
        () => { if (current()) { setNoticeError("noticesRetry"); void recover(); } });
    };
    if (c.pairingNoticeSnapshotV1 === true) subscribe();
    else void load().then(r => { if (current()) { if (r.ok) subscribe(); else later(recover, r); } });
    return () => { live.current = false; epoch.current++; clearTimeout(timer); off(); };
  }, [memberNotices]);
  const requested = new URLSearchParams(location.search).get("securityNotice"), target = notices.find(n => n.id === requested) || notices[0];
  const older = notices.filter(n => n !== target);
  useEffect(() => {
    if (memberNotices || !target) return;
    let cancelled = false;
    // A collapsed history is not shown. Bound rendering and ACK fan-out even at the 1024-record retention cap.
    void (async () => { for (const n of [target, ...(historyOpen ? older.slice(0, historyCount) : [])]) {
      if (cancelled || !live.current) return;
      if (acked.current.has(n.id)) continue;
      acked.current.add(n.id);
      try { if (!(await c.acknowledgePairingNotice(n.id)).ok) acked.current.delete(n.id); }
      catch { acked.current.delete(n.id); }
    } })();
    return () => { cancelled = true; };
  }, [notices, memberNotices, historyOpen, historyCount]);
  if (!target && !noticeError) return null;
  const status = noticeError ? html`<p class="note" role="status" data-notices="retrying">${hr(noticeError)}</p>` : null;
  if (!target) return html`<aside class="card hub-security-notices" aria-label=${hq("notices")}><h3>${hq("notices")}</h3>${status}</aside>`;
  return html`<aside class="card hub-security-notices" aria-label=${hq("notices")}><h3>${hq("notices")}</h3>${status}
    <${Notice} key=${target.id} notice=${target} admin=${admin} memberOrigin=${memberOrigin} after=${load} />
    ${older.length ? html`<details onToggle=${e => setHistoryOpen(e.currentTarget.open)}><summary>${hq("previous")} (${older.length})</summary>
      ${older.slice(0, historyCount).map(n => html`<${Notice} key=${n.id} notice=${n} admin=${admin} memberOrigin=${memberOrigin} after=${load} />`)}
      ${historyCount < older.length ? html`<button type="button" class="btn btn-sm" onClick=${() => setHistoryCount(n => n + 100)}>${hq("more")}</button>` : null}</details>` : null}
  </aside>`;
}

/** Same private, visible-only member poll as the switcher; no notice payload enters the fleet-wide SSE/guest stream. */
export function MemberPairingNotices() {
  const c = hubClient(), [pairing, setPairing] = useState(null), [rows, setRows] = useState([]);
  useEffect(() => {
    if (!c.member || typeof c.pairingNotices !== "function") return;
    let live = true;
    const update = p => { if (live) { setPairing(p); setRows(c.pairingNotices()); } };
    void c.pairing().then(update, () => {});
    const off = c.subscribe(update); return () => { live = false; off(); };
  }, []);
  const origin = safeWebOrigin(pairing);
  return origin && rows.length ? html`<${PairingNotices} memberNotices=${rows} memberOrigin=${origin} />` : null;
}
