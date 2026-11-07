// #3298 S-89: Administration → Group permissions, on the Hub's own listener, for the Hub's configured directory administrator.
// Experimental and off by default. The page is a presentation of the server's control (S-88): every list is read fresh, the
// group is looked up by the server (its GUID is the server's, never typed here), the effect of a change is the server's own
// preview, and Save applies exactly that preview (its digest) — one click on the preview already on screen, no extra dialog
// (721ca0c3 addendum 2). Nothing here decides who may do what. Shared components: PageHead, card, s-row, field, btn, tag, note,
// Empty/ErrorState/Skeleton.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { PageHead } from "/assets/page-head.js";
import { ErrorState, Skeleton } from "/assets/ui-states.js";
import { navigate } from "/assets/app-nav.js";
import { hubClient } from "./hub-client.js";
import { hg } from "./hub-group-strings.js";

export const CAPS = [["ask_agents", "capAsk"], ["publish_agents", "capPublish"], ["pair_fleet", "capPair"]];
const PREVIEW_DELAY_MS = 400;
const RESOLVE_REASON = { "not-found": "notFound", "not-security-group": "notSecurity", invalid: "invalidDn", unsupported: "unsupported", unknown: "unknownGroup" };

/** The draft as the server receives it: the saved policy with this page's state and groups, its revision as the compare-and-set. */
export function draftPolicy(saved, state, groups) {
  return { ...saved, state, groups: groups.map((g) => ({ group: { realm: g.group.realm, objectId: g.group.objectId }, dn: g.dn, allow: CAPS.map(([c]) => c).filter((c) => g.allow.includes(c)), maxFleets: g.maxFleets })) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** #3298 S-89: the prominent entry to Group permissions at the top of Administration (discovery without docs). */
export function GroupPermissionsCard() {
  const go = (e) => { e.preventDefault(); navigate("/ui/hub/admin?view=groups"); };
  return html`<section class="card hub-groups-entry" data-entry="group-permissions"><h3>${hg("entryTitle")} <span class="tag warn">${hg("experimental")}</span></h3>
    <p class="note">${hg("entryHint")}</p>
    <div class="hub-groups-actions"><a class="btn btn-primary" href="/ui/hub/admin?view=groups" onClick=${go}>${hg("entryOpen")}</a></div></section>`;
}

export function HubGroupPolicyPage() {
  const c = hubClient();
  const [view, setView] = useState(null), [error, setError] = useState(""), [msg, setMsg] = useState(null);
  const [state, setState] = useState("never-enabled"), [groups, setGroups] = useState([]);
  const [dn, setDn] = useState(""), [adding, setAdding] = useState(false), [addError, setAddError] = useState("");
  const [preview, setPreview] = useState(null), [saving, setSaving] = useState(false), [again, setAgain] = useState(0);
  const live = useRef(true), seq = useRef(0);
  useEffect(() => () => { live.current = false; }, []);
  const load = async () => {
    setError("");
    const r = await c.groupPolicy();
    if (!live.current) return;
    if (!r.ok) { setError(r.code === "denied" ? hg("contactAdmin") : hg("failed")); return; }
    setView(r);
    if (r.policy) { setState(r.policy.state); setGroups(r.policy.groups.map((g) => ({ ...g, allow: [...g.allow] }))); }
    setPreview(null);
  };
  useEffect(() => { void load(); }, []);
  const policy = view && view.policy;
  const editable = !!policy && view.supported === true && view.binding === "ready";
  const draft = policy ? draftPolicy(policy, state, groups) : null;
  const changed = !!draft && !same(draft, draftPolicy(policy, policy.state, policy.groups));
  // The server's preview of the draft, refreshed as it changes. A stale answer (an older draft) is dropped.
  useEffect(() => {
    if (!editable || !changed) { setPreview(null); return undefined; }
    const mine = ++seq.current;
    setPreview({ loading: true });
    const timer = setTimeout(async () => {
      const r = await c.previewGroupPolicy(draft);
      if (!live.current || mine !== seq.current) return;
      setPreview(r.ok ? { ok: true, ...r } : { ok: false, code: r.code });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [editable, JSON.stringify(draft), again]);
  const add = async (e) => {
    e.preventDefault();
    const text = dn.trim();
    if (!text || adding) return;
    setAdding(true); setAddError("");
    const r = await c.resolveGroup(text);
    if (!live.current) return;
    setAdding(false);
    if (!r.ok) { setAddError(hg(r.code === "unsupported" ? "unsupported" : "unknownGroup")); return; }
    if (r.ok && r.reason) { setAddError(hg(RESOLVE_REASON[r.reason] || "unknownGroup")); return; }
    const key = { realm: r.realm, objectId: r.objectId };
    if (groups.some((g) => g.group.objectId === key.objectId)) { setAddError(hg("duplicate")); return; }
    // A newly allowed group starts with chat only and one fleet (#3298 decision 2); more is the admin's explicit choice.
    setGroups([...groups, { group: key, dn: r.dn, allow: ["ask_agents"], maxFleets: 1 }]); setDn("");
  };
  const setCap = (i, cap, on) => setGroups(groups.map((g, j) => j !== i ? g : { ...g, allow: on ? [...g.allow, cap] : g.allow.filter((x) => x !== cap),
    // Connecting a fleet needs at least one slot.
    maxFleets: on && cap === "pair_fleet" && g.maxFleets === 0 ? 1 : g.maxFleets }));
  const setFleets = (i, n) => setGroups(groups.map((g, j) => j !== i ? g : { ...g, maxFleets: Math.max(0, Math.min(8, Number(n) || 0)) }));
  const save = async () => {
    if (!preview || !preview.ok || saving) return;
    setSaving(true); setMsg(null);
    const r = await c.saveGroupPolicy(draft, preview.previewDigest);
    if (!live.current) return;
    setSaving(false);
    if (r.ok) { setMsg({ ok: true, text: hg("saved") }); await load(); return; }
    setMsg({ ok: false, text: hg(r.code === "conflict" ? "conflict" : r.code === "stale-preview" ? "previewStale" : r.code === "expired" ? "previewExpired" : "failed") });
    // A preview the server no longer holds is checked again (the person sees the fresh effect before saving).
    if (r.code === "stale-preview" || r.code === "expired") setAgain((n) => n + 1);
  };
  const resume = async (row) => {
    setMsg(null);
    const r = await c.resumeGroupResource(row.resource, policy.revision, row.lifecycleRevision);      // the resource carries its own revision
    if (!live.current) return;
    setMsg(r.ok ? { ok: true, text: hg("resumed") } : { ok: false, text: hg(r.code === "conflict" ? "conflict" : "failed") });
    await load();
  };
  const head = html`<${PageHead} title=${hg("title")} scope=${hg("experimental")} lead=${hg("lead")} />`;
  if (error) return html`<div class="col hub-owner hub-groups">${head}<div class="s-section-layout"><${ErrorState} message=${error} onRetry=${load} /></div></div>`;
  if (!view) return html`<div class="col hub-owner hub-groups">${head}<div class="s-section-layout"><section class="card"><${Skeleton} variant="rows" lines=${4} /></section></div></div>`;
  // The card names the SAVED state; a turn on/off not saved yet is shown as pending, never as already on (Cairn #3372).
  const saved = policy ? policy.state : "never-enabled";
  const stateKey = saved === "enabled" ? "Enabled" : saved === "suspended" ? "Suspended" : "Never";
  const pending = !!policy && state !== saved;
  const paused = Array.isArray(view.paused) ? view.paused : [];
  const pv = preview && preview.ok ? preview.impact || {} : null;
  const list = (rows, label) => rows && rows.length ? html`<div class="hub-groups-impact"><b>${label}</b><ul>${rows.map((r, i) => html`<li key=${i}>${r.name || r.label || r.dn || r.id}${r.login ? html` <small class="note"><code>${r.login}</code></small>` : null}</li>`)}</ul></div>` : null;
  return html`<div class="col hub-owner hub-groups">${head}
    <div class="s-section-layout">
      <p class="note"><a href="/ui/hub/admin" onClick=${(e) => { e.preventDefault(); navigate("/ui/hub/admin"); }}>← ${hg("back")}</a></p>
      ${view.supported !== true ? html`<p class="note" role="status" data-reason="unsupported">${hg("unsupported")}</p>` : null}
      ${view.binding === "repair-required" ? html`<p class="err" role="alert" data-reason="repair">${hg("repair")}</p>` : null}
      ${msg ? html`<p class=${msg.ok ? "note" : "err"} role=${msg.ok ? "status" : "alert"}>${msg.text}</p>` : null}
      ${!policy ? null : html`<section class="card hub-groups-state"><h3>${hg(`state${stateKey}`)}</h3><p class="note">${hg(`state${stateKey}Hint`)}</p>
        ${pending ? html`<p class="note" role="status" data-pending=${state === "enabled" ? "on" : "off"}><span class="tag warn">${hg("notSaved")}</span> ${hg(state === "enabled" ? "pendingOn" : "pendingOff")}</p>` : null}
        ${editable ? html`<div class="hub-groups-actions">${pending
          ? html`<button type="button" class="btn btn-sm" onClick=${() => setState(saved)}>${hg("undo")}</button>`
          : state === "enabled"
          ? html`<button type="button" class="btn btn-sm" onClick=${() => setState("suspended")}>${hg("turnOff")}</button>`
          : html`<button type="button" class="btn btn-sm" onClick=${() => setState("enabled")}>${hg("turnOn")}</button>`}</div>` : null}
      </section>
      <section class="card hub-groups-list"><h3>${hg("groupsTitle")}</h3>
        ${groups.length ? html`<div class="hub-rows">${groups.map((g, i) => html`<div key=${g.group.objectId} class="s-row hub-row hub-group-row" data-group=${g.group.objectId}>
          <span class="hub-row-text"><code class="hub-group-dn">${g.dn}</code></span>
          ${CAPS.map(([cap, word]) => html`<label key=${cap} class="hub-group-cap"><input type="checkbox" checked=${g.allow.includes(cap)} disabled=${!editable} onChange=${(e) => setCap(i, cap, e.target.checked)} /> ${hg(word)}</label>`)}
          <label class="field hub-group-fleets" title=${hg("fleetsHint")}><span>${hg("fleets")}</span><input type="number" min="0" max="8" value=${String(g.maxFleets)} disabled=${!editable || !g.allow.includes("pair_fleet")} onInput=${(e) => setFleets(i, e.target.value)} /></label>
          ${editable ? html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => setGroups(groups.filter((_, j) => j !== i))}>${hg("remove")}</button>` : null}
        </div>`)}</div>` : html`<p class="note">${hg("noGroups")}</p>`}
        ${editable ? html`<form class="hub-step-form" onSubmit=${add}><label class="field"><span class="sr-only">${hg("addLabel")}</span>
          <input placeholder=${hg("addPlaceholder")} aria-label=${hg("addLabel")} autocomplete="off" spellcheck=${false} autocapitalize="none" value=${dn} onInput=${(e) => { setDn(e.target.value); setAddError(""); }} /></label>
          <button type="submit" class="btn btn-sm" disabled=${!dn.trim() || adding}>${adding ? hg("resolving") : hg("add")}</button></form>` : null}
        ${addError ? html`<p class="err" role="alert">${addError}</p>` : null}
      </section>
      ${policy && policy.denies && policy.denies.length ? html`<section class="card"><h3>${hg("deniesTitle")}</h3><p class="note">${hg("deniesHint")}</p>
        <div class="hub-rows">${policy.denies.map((d) => html`<div key=${d.person.objectId} class="s-row hub-row"><span class="hub-row-text">${d.name || d.person.objectId}</span>
          ${d.deny.map((cap) => html`<span key=${cap} class="tag warn">${hg((CAPS.find(([c]) => c === cap) || [0, cap])[1])}</span>`)}</div>`)}</div></section>` : null}
      ${changed ? html`<section class="card hub-groups-preview" aria-live="polite"><h3>${hg("previewTitle")}</h3>
        ${!preview || preview.loading ? html`<p class="note" aria-busy="true"><span class="out-spin" aria-hidden="true"></span> ${hg("previewing")}</p>`
          : !preview.ok ? html`<p class="note" role="status">${preview.code === "unavailable" || preview.code === "not-found" ? hg("enableLater") : preview.code === "conflict" ? hg("conflict") : hg("failed")}</p>`
          : html`${pv.adminLosesChat ? html`<p class="err" role="alert">${hg("adminLosesChat")}</p>` : null}
            ${list(pv.losingActions, hg("losingActions"))}${pv.held && pv.held.length ? html`<div class="hub-groups-impact hub-groups-held" data-held=${pv.held.length}><b>${hg("held", pv.held.length)}</b><p class="note">${hg("heldHint")}</p>
              <ul>${pv.held.map((r, i) => html`<li key=${i}>${r.name || r.personId}${r.login ? html` <small class="note"><code>${r.login}</code></small>` : null}</li>`)}</ul></div>` : null}${list(pv.losingPublication, hg("losingPublication"))}${list(pv.grandfathered, hg("grandfathered"))}${list(pv.suspendedOnSave || pv.suspended, hg("suspended"))}
            ${!(pv.losingActions || []).length && !(pv.losingPublication || []).length && !(pv.suspendedOnSave || pv.suspended || []).length && !pv.adminLosesChat ? html`<p class="note">${hg("noImpact")}</p>` : null}
            <div class="hub-groups-actions"><button type="button" class="btn btn-primary" disabled=${saving} onClick=${save}>${state === "enabled" && policy.state !== "enabled" ? hg("saveOn") : hg("save")}</button></div>`}
      </section>` : null}
      ${paused.length ? html`<section class="card hub-groups-paused"><h3>${hg("pausedTitle")}</h3><p class="note">${hg("pausedHint")}</p>
        <div class="hub-rows">${paused.map((row) => html`<div key=${`${row.resource.kind}:${row.resource.id}`} class="s-row hub-row" data-paused=${row.resource.id}>
          <span class="tag">${hg(row.resource.kind === "fleet" ? "kindFleet" : row.resource.kind === "exposure" ? "kindExposure" : "kindAsker")}</span>
          <span class="hub-row-text"><strong>${row.label || row.resource.id}</strong>${row.owner ? html`<small class="note">${row.owner.name || ""}</small>` : null}</span>
          <button type="button" class="btn btn-sm" onClick=${() => resume(row)}>${hg("resume")}</button></div>`)}</div></section>` : null}`}
    </div></div>`;
}
