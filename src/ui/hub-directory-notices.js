/** Recipient-only history, fetched on this page only. No stream, polling, implicit ACK or global notice feed. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { dn } from "./hub-directory-notice-strings.js";

export const DIRECTORY_NOTICE_FEATURE = "directory-security-notices-v1";
export function directoryNoticesOffered(session, client) {
  return !!session?.features?.includes(DIRECTORY_NOTICE_FEATURE) && client?.directorySecurityNoticesV1 === true
    && typeof client.directorySecurityNotices === "function" && typeof client.acknowledgeDirectorySecurityNotice === "function";
}
const unavailable = result => result.status === 401 ? "auth" : result.status === 403 ? "denied" : result.status === 404 ? "unsupported" : "unavailable";
export function DirectoryNotices({ client, host = false }) {
  const [rows, setRows] = useState([]), [next, setNext] = useState(null), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [errorKey, setErrorKey] = useState(null), [acking, setAcking] = useState(null);
  const generation = useRef(0), pending = useRef(false), retry = useRef(null);
  const load = async (before, mine = generation.current) => {
    if (mine !== generation.current || pending.current) return;
    clearTimeout(retry.current); pending.current = true; setBusy(true); setErrorKey(null);
    let result; try { result = await client.directorySecurityNotices(before ? { before, limit: 25 } : { limit: 25 }); }
    catch { result = { ok: false }; }
    if (mine !== generation.current) return;
    pending.current = false; setBusy(false); setLoaded(true);
    if (result.ok && Array.isArray(result.items)) {
      setRows(prior => before ? [...prior, ...result.items.filter(row => !prior.some(old => old.id === row.id))] : result.items);
      setNext(result.nextBefore || null);
    } else {
      if (result.status === 401 || result.status === 403) { setRows([]); setNext(null); }
      if (result.code === "backpressure") {
        setErrorKey("busy"); const seconds = Number(result.retryAfter);
        retry.current = setTimeout(() => { if (mine === generation.current) void load(before, mine); },
          (Number.isFinite(seconds) && seconds > 0 ? Math.min(300, Math.max(1, seconds)) : 10) * 1000);
      } else setErrorKey(unavailable(result));
    }
  };
  useEffect(() => {
    const mine = ++generation.current; pending.current = false; setRows([]); setNext(null); setLoaded(false); setAcking(null);
    void load(null, mine);
    return () => { generation.current++; pending.current = false; clearTimeout(retry.current); };
  }, [client]);
  const acknowledge = async id => {
    if (pending.current) return;
    clearTimeout(retry.current); pending.current = true; setAcking(id); setBusy(true); setErrorKey(null);
    const mine = generation.current;
    let result; try { result = await client.acknowledgeDirectorySecurityNotice(id); } catch { result = { ok: false }; }
    if (mine !== generation.current) return;
    pending.current = false; setBusy(false); setAcking(null);
    if (result.ok) setRows(prior => prior.map(row => row.id === id ? { ...row, acknowledged: true } : row));
    else {
      if (result.status === 401 || result.status === 403) { setRows([]); setNext(null); }
      setErrorKey(result.code === "backpressure" ? "busyAck" : result.status === 401 || result.status === 403 ? unavailable(result) : "uncertain");
    }
  };
  return html`<div class="s-section-layout hub-directory-notices"><section class="card" aria-label=${dn("title")}>
    <h2>${dn("title")}</h2><p class="muted">${dn(host ? "hostLead" : "lead")}</p><p class="muted">${dn("readOnly")}</p>
    ${!loaded ? html`<p role="status">${dn("loading")}</p>` : null}
    ${errorKey ? html`<p role="status">${dn(errorKey)}</p>` : null}
    ${loaded && !errorKey && !rows.length ? html`<p class="muted">${dn("empty")}</p>` : null}
    ${rows.map(row => html`<article class="directory-notice" key=${row.id} data-directory-notice=${row.id}>
      <h3>${dn(row.kind === "directory-compensation" ? "restored" : "changed")}</h3>
      <p class="muted">${dn(row.actor?.kind === "host-owner" ? "host" : "admin")} · <time datetime=${new Date(row.at).toISOString()}>${new Date(row.at).toLocaleString()}</time></p>
      <p>${(row.changes || []).map(key => dn(key)).join(" · ")}</p>
      ${row.acknowledged ? html`<span class="muted">${dn("acknowledged")}</span>` : html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => acknowledge(row.id)}>${dn(acking === row.id ? "acknowledging" : "acknowledge")}</button>`}
    </article>`)}
    <div class="s-actions"><button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => load(null)}>${dn(errorKey ? "retry" : "refresh")}</button>
      ${next ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => load(next)}>${dn("older")}</button>` : null}</div>
  </section></div>`;
}
