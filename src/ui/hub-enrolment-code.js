/** U2 slot only. Codes stay in this mounted view; every action uses the current same-origin Hub session. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { hubClient } from "./hub-client.js";
import { he } from "./hub-enrolment-code-strings.js";
export const enrolmentCodeV1 = true;
const time = value => new Date(value).toLocaleString();
const supported = client => client?.enrolmentCodeV1 === true && ["enrolmentCodes", "createEnrolmentCode", "revokeEnrolmentCode"].every(key => typeof client[key] === "function");
const integer = (value, max) => Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= max;
const errorText = (result, fallback) => he(result?.code === "backpressure" ? "limited" : result?.status === 403 ? "denied" : fallback);

function CreateCode({ client, busy, enabled, onCreate, onClose }) {
  const [expires, setExpires] = useState("today"), [max, setMax] = useState("30"), [perPerson, setPerPerson] = useState("1");
  const [scope, setScope] = useState("directory"), [group, setGroup] = useState(null), [dn, setDn] = useState("");
  const [picker, setPicker] = useState(null), [resolving, setResolving] = useState(false), [error, setError] = useState(null);
  const live = useRef(true), epoch = useRef(0), reading = useRef(false), allowed = useRef(enabled);
  allowed.current = enabled;
  useEffect(() => {
    live.current = true;
    // An older U2 has no search module. The existing exact-DN resolver remains a safe fallback.
    void import("./hub-group-search.js").then(m => { if (live.current && m.groupSearchV1 === true && m.groupSearchIdV1 === true && typeof m.GroupSearch === "function") setPicker({ component: m.GroupSearch }); }, () => {});
    return () => { live.current = false; epoch.current++; };
  }, []);
  const resolve = async hit => {
    if (reading.current || busy || !allowed.current || typeof client.resolveGroup !== "function") return;
    const name = typeof hit?.dn === "string" ? hit.dn : dn.trim(); if (!name) return;
    reading.current = true; const mine = ++epoch.current; setResolving(true); setError(null); setGroup(null);
    let r; try { r = await client.resolveGroup(name); } catch { r = { ok: false }; }
    if (!live.current || mine !== epoch.current) return;
    reading.current = false; setResolving(false);
    if (!allowed.current || !r.ok || typeof r.realm !== "string" || typeof r.objectId !== "string" || typeof r.dn !== "string"
      || hit?.objectId && hit.objectId.toLowerCase() !== r.objectId.toLowerCase()) { setError(he("scopeFailed")); return; }
    setGroup({ kind: "group", realm: r.realm, objectId: r.objectId, dn: r.dn });
  };
  const chooseScope = value => { epoch.current++; reading.current = false; setResolving(false); setScope(value); setGroup(null); setError(null); };
  const valid = enabled && !busy && !resolving && integer(max, 200) && integer(perPerson, 8) && (scope === "directory" || group);
  const submit = event => { event.preventDefault(); if (!valid) return;
    onCreate({ expires, maxUses: Number(max), perPersonFleets: Number(perPerson), scope: scope === "directory" ? { kind: "directory" } : group });
  };
  return html`<${Dialog} title=${he("create")} onClose=${onClose} busy=${busy} actions=${html`
    <button type="button" class="btn" disabled=${busy} onClick=${onClose}>${he("cancel")}</button>
    <button type="submit" form="hubEnrolmentCreate" class="btn btn-primary" disabled=${!valid}>${he("create")}</button>`}>
    <form id="hubEnrolmentCreate" class="form" onSubmit=${submit}>
      <p class="note">${he("lead")}</p>
      <label class="field" for="hubCodeExpires"><span>${he("expires")}</span><select id="hubCodeExpires" disabled=${busy} value=${expires} onChange=${e => setExpires(e.target.value)}>
        <option value="1h">${he("hour")}</option><option value="today">${he("today")}</option><option value="7d">${he("week")}</option></select></label>
      <label class="field" for="hubCodeMax"><span>${he("max")}</span><input id="hubCodeMax" type="number" inputmode="numeric" min="1" max="200" step="1" required value=${max} disabled=${busy} onInput=${e => setMax(e.target.value)} /></label>
      <label class="field" for="hubCodeScope"><span>${he("scope")}</span><select id="hubCodeScope" value=${scope} disabled=${busy || resolving} onChange=${e => chooseScope(e.target.value)}>
        <option value="directory">${he("directory")}</option><option value="group">${he("group")}</option></select></label>
      ${scope === "group" ? group ? html`<p class="note hub-fp-full">${he("resolved", group.dn)}</p><div class="n-actions"><button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => setGroup(null)}>${he("remove")}</button></div>`
        : html`${picker ? html`<${picker.component} id="hubEnrolmentScopeSearch" client=${client} disabled=${busy || resolving || !enabled} label=${he("groupLabel")} onPick=${resolve} onUnsupported=${() => setPicker(null)} />`
          : html`<label class="field" for="hubCodeGroupDn"><span>${he("dn")}</span><input id="hubCodeGroupDn" maxLength="4096" value=${dn} disabled=${busy || resolving} onInput=${e => setDn(e.target.value)} /></label>
            <div class="n-actions"><button type="button" class="btn btn-sm" disabled=${busy || resolving || !dn.trim() || !enabled} onClick=${() => resolve(null)}>${he("resolve")}</button></div>`}
          <p class="note" role="status">${he("choose")}</p>` : null}
      <details><summary>${he("more")}</summary><label class="field" for="hubCodePerPerson"><span>${he("perPerson")}</span><input id="hubCodePerPerson" type="number" inputmode="numeric" min="1" max="8" step="1" required value=${perPerson} disabled=${busy} onInput=${e => setPerPerson(e.target.value)} /></label></details>
      ${error ? html`<${ErrorState} message=${error} />` : null}
    </form>
  </${Dialog}>`;
}

export function HubEnrolmentCode({ client = hubClient(), enabled = false, host = "", onChanged = () => {} }) {
  const root = useRef(null), live = useRef(false), epoch = useRef(0), writing = useRef(false), reading = useRef(null), refresh = useRef(null), owner = useRef(client);
  owner.current = client;
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [copied, setCopied] = useState(null), [capacity, setCapacity] = useState(null), [notice, setNotice] = useState(null);
  const usable = supported(client), current = mine => live.current && owner.current === client && epoch.current === mine;
  const read = async () => {
    if (!live.current || writing.current || reading.current) return;
    const mine = epoch.current, ticket = {}; reading.current = ticket;
    let r; try { r = await client.enrolmentCodes(); } catch { r = { ok: false }; }
    if (reading.current === ticket) reading.current = null;
    if (!current(mine) || writing.current) return;
    setLoading(false);
    if (r.ok && Array.isArray(r.codes)) { setData({ client, codes: r.codes }); setError(null); return true; }
    else { setData(null); setError(errorText(r, "loadFailed")); }
  };
  refresh.current = read;
  useEffect(() => {
    live.current = usable; epoch.current++; writing.current = false; reading.current = null;
    setData(null); setError(null); setNotice(null); setLoading(true); setOpen(false); setBusy(false); setCapacity(null); setCopied(null);
    if (!usable) return undefined;
    let timer = null, visible = true, polling = false;
    const tick = async () => {
      if (polling) return;
      clearTimeout(timer);
      if (!live.current) return;
      polling = true;
      if (visible && document.visibilityState !== "hidden") await refresh.current();
      polling = false;
      if (live.current) timer = setTimeout(tick, 5000);
    };
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting); if (visible) void tick();
    }) : null;
    if (root.current) observer?.observe(root.current);
    const visibility = () => { if (document.visibilityState !== "hidden") void tick(); };
    document.addEventListener("visibilitychange", visibility);
    const off = client.onSignedOut?.(() => { live.current = false; epoch.current++; clearTimeout(timer); setData(null); setOpen(false); setLoading(false); setBusy(false); setError(he("denied")); });
    void tick();
    return () => { live.current = false; epoch.current++; clearTimeout(timer); observer?.disconnect(); document.removeEventListener("visibilitychange", visibility); off?.(); };
  }, [client, usable]);
  const mutate = async (kind, input) => {
    if (!live.current || writing.current || kind === "create" && !enabled) return;
    writing.current = true; reading.current = null; const mine = ++epoch.current; setBusy(true); setError(null); setCopied(null);
    let r; try { r = await (kind === "create" ? client.createEnrolmentCode(input) : client.revokeEnrolmentCode(input)); } catch { r = { ok: false }; }
    if (!current(mine)) return;
    writing.current = false; setBusy(false); setOpen(false);
    if (r.ok) {
      setOpen(false); if (kind === "create" && Number.isInteger(r.freeFleetRows) && input.maxUses > r.freeFleetRows) setCapacity({ free: r.freeFleetRows, max: input.maxUses });
      try { onChanged(); } catch { /* U2 owns its projection refresh. */ }
    } else setNotice(errorText(r, kind === "create" ? "createFailed" : "endFailed"));
    // Never repeat an uncertain write automatically. Inspect the authoritative list instead.
    await read();
  };
  const copy = async row => {
    const mine = epoch.current;
    try { await navigator.clipboard.writeText(`${he("handoff", host)}\n${row.code}`); if (current(mine)) setCopied(row.id); }
    catch { if (current(mine)) setCopied("failed"); }
  };
  if (!usable) return null;
  const rows = data?.client === client ? data.codes : [];
  return html`<div ref=${root} data-enrolment-codes="v1">
    <div class="n-actions"><button type="button" class="btn btn-primary" disabled=${!enabled || busy || open || loading || !!error || !!notice} onClick=${() => setOpen(true)}>${he("create")}</button></div>
    ${error ? html`<${ErrorState} message=${error} onRetry=${read} />` : null}
    ${notice ? html`<${ErrorState} message=${notice} onRetry=${async () => { if (await read()) setNotice(null); }} />` : null}
    ${capacity ? html`<p class="note" role="status">${he("capacity", capacity.free, capacity.max)}</p>` : null}
    ${loading ? html`<${Skeleton} variant="rows" lines=${2} />` : !rows.length && !error ? html`<${Empty} title=${he("empty")} hint=${he("emptyHint")} />` : null}
    ${rows.map(row => html`<section key=${row.id} data-enrolment-code=${row.id}>
      <p><span class="tag">${he(["live", "expired", "exhausted", "revoked"].includes(row.state) ? row.state : "expired")}</span> <span>${he("used", row.uses, row.maxUses)}</span></p>
      ${row.state === "live" && row.code ? html`<code class="hub-fp-groups">${row.code}</code><p class="note hub-fp-full">${he("handoff", host)}</p>` : null}
      <p class="note hub-fp-full">${he("scope")}: ${row.scope?.kind === "group" ? row.scope.dn : he("directory")} · ${he("perPerson")} ${row.perPersonFleets}</p>
      <p class="note">${he("until", time(row.expiresAt))}${row.inFlight ? html` · ${he("pending", row.inFlight)}` : null}</p>
      <div class="n-actions">${row.state === "live" && row.code ? html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => copy(row)}>${he(copied === row.id ? "copied" : "copy")}</button>
        <button type="button" class="btn btn-sm btn-danger" disabled=${busy} onClick=${() => mutate("revoke", row.id)}>${he("end")}</button>` : null}</div>
      ${row.recent?.length ? html`<details><summary>${he("recent")}</summary><ul>${row.recent.slice(0, 50).map((use, index) => html`<li key=${index}>${use.label} · ${use.owner?.name || use.owner?.login || ""} · ${time(use.at)}</li>`)}</ul></details>` : null}
    </section>`)}
    ${copied === "failed" ? html`<p class="note" role="status">${he("copyFailed")}</p>` : null}
    ${open ? html`<${CreateCode} client=${client} busy=${busy} enabled=${enabled} onCreate=${input => mutate("create", input)} onClose=${() => { if (!writing.current) setOpen(false); }} />` : null}
  </div>`;
}
