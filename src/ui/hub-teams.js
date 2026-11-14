/** Teams share one roster editor between Administration and the lead's My teams page. */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Icon } from "/assets/ui-icons.js";
import { navigate } from "/assets/app-nav.js";
import { ht } from "./hub-teams-strings.js";

const changes = new Set();
const changed = () => { for (const fn of changes) fn(); };
const personId = person => typeof person === "string" ? person : person?.realm && person?.objectId ? `${person.realm}/${person.objectId}` : person?.id || "";
const errorText = (out, writing = false) => out?.status === 429 ? ht("busy") : out?.status === 401 || out?.status === 403 ? ht("denied") : ht(writing ? "saveFailed" : "failed");
const date = value => new Date(value).toLocaleDateString();
const cssLoads = new WeakMap();
/** No new editor controls draw before their fresh feature stylesheet has loaded. */
export function linkHubTeamsCss(doc = typeof document === "undefined" ? null : document) {
  if (!doc?.head) return Promise.resolve(false);
  if (cssLoads.has(doc)) return cssLoads.get(doc);
  const promise = new Promise(resolve => {
    const link = doc.createElement("link"); link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/hub-teams.css");
    link.setAttribute("data-hub-teams-css", "1");
    link.addEventListener("load", () => resolve(true), { once: true });
    link.addEventListener("error", () => { link.remove(); cssLoads.delete(doc); resolve(false); }, { once: true });
    doc.head.appendChild(link);
  });
  cssLoads.set(doc, promise); return promise;
}
function useStyle() {
  const [ready, setReady] = useState(null), [retry, setRetry] = useState(0);
  useEffect(() => { let live = true; linkHubTeamsCss().then(value => { if (live) setReady(value); }); return () => { live = false; }; }, [retry]);
  return [ready, () => { setReady(null); setRetry(n => n + 1); }];
}
function StyleWait({ ready, retry }) {
  return html`<p role="status">${ht(ready === false ? "styleFailed" : "styleLoading")}</p>${ready === false ? html`<button type="button" class="btn" onClick=${retry}>${ht("retry")}</button>` : null}`;
}
function useTeams(client) {
  const [rows, setRows] = useState(null), [error, setError] = useState(null), [revision, setRevision] = useState(0), epoch = useRef(0);
  useEffect(() => {
    let live = true; const mine = ++epoch.current;
    Promise.resolve().then(() => client.teams()).then(out => { if (!live || mine !== epoch.current) return;
      if (out.ok) { setRows(Array.isArray(out.teams) ? out.teams : []); setError(null); } else setError(errorText(out));
    }, () => { if (live && mine === epoch.current) setError(ht("failed")); });
    const end = client.onSignedOut?.(() => { epoch.current++; setRows([]); setError(ht("denied")); });
    const refresh = () => setRevision(n => n + 1); changes.add(refresh);
    return () => { live = false; epoch.current++; changes.delete(refresh); end?.(); };
  }, [client, revision]);
  return { rows, error, refresh: () => setRevision(n => n + 1) };
}
export function HubTeamsEntry() {
  const [ready, retry] = useStyle();
  return html`<section class="card hub-teams"><h3>${ht("title")}</h3><p class="note">${ht("lead")}</p>
    ${ready ? html`<a class="btn hub-team-button" href="/ui/hub/admin?view=teams" onClick=${e => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate("/ui/hub/admin?view=teams"); } }}>${ht("manage")}</a>` : html`<${StyleWait} ready=${ready} retry=${retry} />`}</section>`;
}
export function HubMyTeamsEntry({ client, person, active, onPick }) {
  const { rows } = useTeams(client), me = personId(person);
  if (!me || !rows?.some(row => row.lead === me)) return null;
  const href = "/ui/hub?view=teams";
  return html`<a class=${`side-row${active ? " active" : ""}`} href=${href} aria-current=${active ? "page" : undefined}
    onClick=${e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); onPick?.(); navigate(href); }}><${Icon} name="user" /><span class="grow">${ht("mine")}</span></a>`;
}

/** Feedback is cancellable and never applies a result from a previous query or team. */
export function TeamSuggestions({ client, kind = "person", teamId, disabled, onPick }) {
  const [query, setQuery] = useState(""), [answer, setAnswer] = useState(null), [busy, setBusy] = useState(false), epoch = useRef(0), controller = useRef(null);
  useEffect(() => { epoch.current++; controller.current?.abort(); setAnswer(null); setBusy(false);
    return () => { epoch.current++; controller.current?.abort(); }; }, [client, kind, teamId]);
  const search = async () => {
    const q = query.trim(); if (disabled || q.length < 2 || q.length > 64) return;
    const mine = ++epoch.current; controller.current?.abort(); const current = controller.current = new AbortController(); setBusy(true); setAnswer(null);
    let out; try { out = await client.teamSuggestions(kind, q, teamId, current.signal); } catch { out = { ok: false }; }
    if (mine !== epoch.current || current.signal.aborted) return;
    setBusy(false); setAnswer(out);
  };
  const hits = answer?.ok && Array.isArray(answer.candidates) ? answer.candidates.slice(0, 20).filter(row => row.kind === kind) : [];
  return html`<div class="hub-team-search">
    <div class="hub-team-search-line"><label class="field grow"><span>${ht(kind === "group" ? "department" : "members")}</span><input type="search" maxlength="64" autocomplete="off" spellcheck=${false}
      placeholder=${ht(kind === "group" ? "departmentQuery" : "personQuery")} value=${query} disabled=${disabled}
      onInput=${e => { epoch.current++; controller.current?.abort(); setQuery(e.target.value); setAnswer(null); setBusy(false); }}
      onKeyDown=${e => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} /></label>
      <button type="button" class="btn hub-team-button" disabled=${disabled || busy || query.trim().length < 2 || query.trim().length > 64} onClick=${search}>${ht("search")}</button></div>
    <p class="note" role="status">${busy ? ht("searching") : !answer ? ht(kind === "group" ? "groupHint" : "searchHint") : !answer.ok ? answer.status === 429 ? ht("busy") : ht("searchFailed") : hits.length ? "" : ht("noMatches")}</p>
    ${hits.length ? html`<ul class="hub-team-hits">${hits.map(row => html`<li key=${row.id}><span class="grow"><strong>${row.name}</strong>${row.login ? html`<small class="note"> · ${row.login}</small>` : null}</span>
      <button type="button" class="btn hub-team-button" disabled=${disabled} aria-label=${ht("choose", row.name)} onClick=${() => { epoch.current++; controller.current?.abort(); onPick(row); setQuery(""); setAnswer(null); }}>${ht("pick")}</button></li>`)}</ul>` : null}
  </div>`;
}
const draftFrom = team => ({ name: team?.name || "", department: team?.department || "", departmentName: team?.departmentName || "", lead: team?.lead || "",
  members: (team?.memberInfo || (team?.members || []).map(id => ({ id, name: id }))).map(row => ({ ...row })) });
function TeamEditor({ client, id, mode, onSaved, onBack }) {
  const [view, setView] = useState(null), [draft, setDraft] = useState(draftFrom(null)), [error, setError] = useState(null), [busy, setBusy] = useState(false), [picker, setPicker] = useState(id ? null : "department"), [deleting, setDeleting] = useState(false), [reload, setReload] = useState(0), [saved, setSaved] = useState(false);
  const epoch = useRef(0), writing = useRef(false), admin = mode === "admin";
  useEffect(() => {
    let live = true; const mine = ++epoch.current;
    if (id) Promise.resolve().then(() => client.team(id)).then(out => {
      if (!live || mine !== epoch.current) return;
      if (out.ok && out.team) { setView(out.team); setDraft(draftFrom(out.team)); setError(null); setPicker(null); }
      else setError(errorText(out));
    }, () => { if (live && mine === epoch.current) setError(ht("failed")); });
    const end = client.onSignedOut?.(() => { epoch.current++; setView(null); setError(ht("denied")); });
    return () => { live = false; epoch.current++; end?.(); };
  }, [client, id, reload]);
  const allowed = !id || view?.canManage === true;
  const save = async e => {
    e?.preventDefault?.(); if (writing.current || !allowed || !draft.lead || !draft.department || !draft.name.trim()) return;
    writing.current = true; setBusy(true); setError(null); setSaved(false); const mine = ++epoch.current;
    const members = [...new Set([...draft.members.map(row => row.id), draft.lead])];
    const value = admin ? { name: draft.name.trim(), department: draft.department, lead: draft.lead, members } : { members };
    let out; try { out = id ? await client.updateTeam(id, { ...value, revision: view.revision }) : await client.createTeam(value); } catch { out = { ok: false }; }
    if (mine !== epoch.current) return;
    writing.current = false; setBusy(false);
    if (out.ok && out.team) { setView(out.team); setDraft(draftFrom(out.team)); setSaved(true); setPicker(null); changed(); onSaved(out.team); }
    else setError(errorText(out, true));
  };
  const remove = async () => {
    if (writing.current || !admin || !id) return;
    writing.current = true; setBusy(true); setError(null); const mine = ++epoch.current;
    let out; try { out = await client.deleteTeam(id); } catch { out = { ok: false }; }
    if (mine !== epoch.current) return; writing.current = false; setBusy(false);
    if (out.ok) { changed(); onBack(); } else setError(errorText(out, true));
  };
  const pick = row => {
    setSaved(false);
    if (picker === "department") setDraft(old => ({ ...old, department: row.id, departmentName: row.name }));
    else setDraft(old => ({ ...old, ...(picker === "lead" ? { lead: row.id } : {}), members: old.members.some(member => member.id === row.id) ? old.members : [...old.members, row] }));
    setPicker(null);
  };
  return html`<section class="card hub-team-editor"><div class="hub-team-head"><h3>${ht(id ? "edit" : "create", view?.name || draft.name)}</h3><button type="button" class="btn hub-team-button" disabled=${busy} onClick=${onBack}>${ht("back")}</button></div>
    ${error ? html`<p class="err" role="alert">${error}</p><button type="button" class="btn hub-team-button" disabled=${busy} onClick=${() => setReload(n => n + 1)}>${ht("refresh")}</button>` : null}
    ${id && !view ? html`<p role="status">${ht("loading")}</p>` : html`<form class="form" onSubmit=${save}>
      ${admin ? html`<label class="field"><span>${ht("name")}</span><input data-team-name maxlength="100" required value=${draft.name} disabled=${busy || !allowed} onInput=${e => { setDraft(old => ({ ...old, name: e.target.value })); setSaved(false); }} /></label>` : null}
      <div class="hub-team-head"><p class="note">${ht("departmentLine", draft.departmentName || ht("chooseDepartment"))}</p>${admin ? html`<button type="button" class="btn hub-team-button" disabled=${busy || !allowed} onClick=${() => setPicker("department")}>${ht("change")}</button>` : null}</div>
      ${view?.leadEligible === false ? html`<p class="warn" role="status">${ht("disabledLead")}</p>` : null}
      ${admin ? html`<div class="hub-team-head"><p>${ht("leadPerson")}: <strong>${draft.members.find(row => row.id === draft.lead)?.name || ht("chooseLead")}</strong></p><button type="button" class="btn hub-team-button" disabled=${busy || !allowed} onClick=${() => setPicker("lead")}>${ht("chooseLead")}</button></div>` : null}
      ${picker ? html`<div class="hub-team-picker"><${TeamSuggestions} key=${picker} client=${client} kind=${picker === "department" ? "group" : "person"} teamId=${id || undefined} disabled=${busy || !allowed} onPick=${pick} /><button type="button" class="btn hub-team-button" onClick=${() => setPicker(null)}>${ht("cancel")}</button></div>` : null}
      <div class="hub-team-head"><h4>${ht("members")} · ${draft.members.length}</h4><button type="button" class="btn hub-team-button" disabled=${busy || !allowed || draft.members.length >= 200} onClick=${() => setPicker("member")}>${ht("add")}</button></div>
      <p class="note">${ht("limit")} ${ht("leadRequired")}</p>
      <div class="hub-team-table-wrap"><table class="hub-team-table"><thead><tr><th>${ht("members")}</th><th>${ht("role")}</th><th>${ht("signedIn")}</th><th>${ht("agents")}</th><th><span class="sr-only">${ht("remove")}</span></th></tr></thead><tbody>
        ${draft.members.map(row => html`<tr key=${row.id}><td><strong>${row.name}</strong>${row.login ? html`<small class="note hub-team-detail">${row.login}</small>` : null}${row.department ? html`<small class="note hub-team-detail">${row.department}</small>` : null}</td><td>${ht(row.id === draft.lead ? "roleLead" : "roleMember")}</td>
          <td>${row.signedIn === true ? ht("yes") : row.signedIn === false ? ht("notYet") : "—"}</td><td>${row.agents?.length ? row.agents.map(agent => agent.name).join(", ") : ht("none")}</td><td><button type="button" class="btn hub-team-button" disabled=${busy || !allowed || row.id === draft.lead || row.id === view?.lead} aria-label=${`${ht("remove")} ${row.name}`} onClick=${() => { setDraft(old => ({ ...old, members: old.members.filter(member => member.id !== row.id) })); setSaved(false); }}>${ht("remove")}</button></td></tr>`)}
      </tbody></table></div>
      <div class="hub-team-actions"><button type="submit" class="btn btn-primary hub-team-button" disabled=${busy || !allowed || !draft.name.trim() || !draft.department || !draft.lead}>${ht(busy ? "saving" : "save")}</button>${saved ? html`<span role="status">${ht("saved")}</span>` : null}
        ${admin && id ? html`<button type="button" class="btn btn-danger hub-team-button" disabled=${busy || !allowed} onClick=${() => setDeleting(true)}>${ht("delete")}</button>` : null}</div>
    </form>`}
    ${deleting ? html`<div class="hub-team-delete" role="region" aria-label=${ht("deleteTitle", view.name)}><h4>${ht("deleteTitle", view.name)}</h4><p>${ht("deleteLead")}</p>
      ${view.impact?.grants?.length || view.impact?.roomCreator ? html`<ul>${view.impact.grants.map(grant => html`<li>${ht("grantExpiry", grant.name, date(grant.expiresAt))}</li>`)}${view.impact.roomCreator ? html`<li>${ht("creators")}</li>` : null}</ul>` : html`<p class="note">${ht("noImpact")}</p>`}
      <div class="hub-team-actions"><button type="button" class="btn hub-team-button" disabled=${busy} onClick=${() => setDeleting(false)}>${ht("cancel")}</button><button type="button" class="btn btn-danger hub-team-button" disabled=${busy} onClick=${remove}>${ht("delete")}</button></div></div>` : null}
  </section>`;
}
export function HubTeamsPage({ client, mode = "lead", person }) {
  const [ready, retry] = useStyle(), { rows, error, refresh } = useTeams(client), [selected, setSelected] = useState(null), me = personId(person);
  const shown = (rows || []).filter(row => mode === "admin" || row.lead === me);
  return html`<div class="hub-teams"><p class="s-page-lead hub-page-lead">${ht(mode === "admin" ? "pageLead" : "myLead")}</p>
    ${!ready ? html`<${StyleWait} ready=${ready} retry=${retry} />` : html`<div class="s-section-layout">
      ${selected !== null ? html`<${TeamEditor} key=${selected} client=${client} id=${selected || null} mode=${mode} onBack=${() => { setSelected(null); refresh(); }} onSaved=${team => { setSelected(team.id); refresh(); }} />`
        : html`<section class="card"><div class="hub-team-head"><h3>${ht(mode === "admin" ? "title" : "mine")}</h3>${mode === "admin" ? html`<button type="button" class="btn btn-primary hub-team-button" onClick=${() => setSelected("")}>${ht("create")}</button>` : null}</div>
          ${error ? html`<p class="err" role="alert">${error}</p><button type="button" class="btn hub-team-button" onClick=${refresh}>${ht("retry")}</button>` : null}
          ${rows === null ? html`<p role="status">${ht("loading")}</p>` : shown.length ? html`<ul class="hub-team-list">${shown.map(row => html`<li key=${row.id}><span class="grow"><strong>${row.name}</strong><small class="note hub-team-detail">${ht("departmentLine", row.departmentName)} · ${ht("count", row.members.length)}</small></span><button type="button" class="btn hub-team-button" aria-label=${ht("edit", row.name)} onClick=${() => setSelected(row.id)}>${ht("manage")}</button></li>`)}</ul>` : html`<p class="note">${ht(mode === "admin" ? "empty" : "noMine")}</p>`}
        </section>`}
    </div>`}</div>`;
}
