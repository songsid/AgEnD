/** Selection only. Each consumer keeps its own current authority, preview and mutation flow. */
import { html, useEffect, useMemo, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { GroupSearch } from "./hub-group-search.js";
register("hubSubjectPicker", {
 en: { kind:"Add a group, team or person", group:"AD group", team:"Team", person:"Person", teamPick:"Choose a team", findPerson:"Find a person", query:"Name or login", hint:"Type 2 to 64 characters.", searching:"Searching…", none:"No matching people. Try more of their name or login.", more:"More people match. Type more of the name.", pick:"Choose {0}", choose:"Choose", failed:"The directory could not be searched just now. Try again.", limited:"Too many searches. Try again shortly.", retry:"Search again", change:"Choose someone else", teamRow:"{0} · Team · {1} members · Lead: {2}", teamHint:"Its leads decide who is on this team.", personRow:"{0} · Person", teamChecked:"Team members checked: {0}" },
 "zh-TW": { kind:"新增群組、團隊或人員", group:"AD 群組", team:"團隊", person:"人員", teamPick:"選擇團隊", findPerson:"尋找同仁", query:"姓名或登入帳號", hint:"請輸入 2 到 64 個字。", searching:"搜尋中…", none:"找不到符合的同仁，請多輸入幾個姓名或帳號的字。", more:"還有更多同仁符合，請多輸入幾個字。", pick:"選擇 {0}", choose:"選擇", failed:"目前無法搜尋目錄，請再試一次。", limited:"搜尋太多次了，請稍後再試。", retry:"重新搜尋", change:"重新選擇對象", teamRow:"{0} · 團隊 · {1} 位成員 · 負責人：{2}", teamHint:"團隊成員由負責人決定。", personRow:"{0} · 人員", teamChecked:"已檢查的團隊成員：{0}" }
});
export const subjectText = (key, ...args) => t(`hubSubjectPicker.${key}`, ...args);
const g = subjectText;
let sequence = 0;
export function PeopleSearch({ search, disabled, onPick, id = "hubGrantPerson" }) {
  const [query, setQuery] = useState(""), [answer, setAnswer] = useState(null), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const mine = ++sequence.current, q = query.trim(); setAnswer(null);
    if (q.length < 2 || q.length > 64) { setBusy(false); return; }
    setBusy(true); const timer = setTimeout(async () => {
      let out; try { out = await search("person", q); } catch { out = { ok: false }; }
      if (mine !== sequence.current) return;
      setBusy(false); setAnswer(out);
    }, 300);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [query, search, retry]);
  const hits = answer?.ok && Array.isArray(answer.people) ? answer.people.slice(0, 20) : [];
  return html`<div class="hub-group-search">
    <label class="field" for=${id}><span>${g("findPerson")}</span><input id=${id} type="search" autocomplete="off" spellcheck=${false}
      disabled=${disabled} value=${query} placeholder=${g("query")} aria-describedby=${`${id}Note`} onInput=${e => setQuery(e.target.value)} /></label>
    <p id=${`${id}Note`} class="note" role="status">${busy ? g("searching") : !answer ? g("hint") : answer.ok ? hits.length ? answer.truncated ? g("more") : "" : g("none") : answer.status === 429 ? g("limited") : g("failed")}</p>
    ${answer && !answer.ok && !busy ? html`<button type="button" class="btn btn-sm" disabled=${disabled} onClick=${() => setRetry(n => n + 1)}>${g("retry")}</button>` : null}
    ${hits.length ? html`<ul class="hub-group-hits" role="list">${hits.map(p => html`<li key=${`${p.person?.realm}/${p.person?.objectId}`} class="s-row"><span class="hub-row-text"><strong>${p.displayName || p.login}</strong><small class="note"><code>${p.login}</code></small></span>
      <button type="button" class="btn btn-sm" disabled=${disabled} aria-label=${g("pick", p.displayName || p.login)} onClick=${() => onPick(p)}>${g("choose")}</button></li>`)}</ul>` : null}
  </div>`;
}
export function TeamPick({ client, disabled, onPick }) {
  const [answer, setAnswer] = useState(null), [retry, setRetry] = useState(0);
  useEffect(() => { let live = true; Promise.resolve().then(() => client.teams()).then(out => { if (live) setAnswer(out); }, () => { if (live) setAnswer({ ok: false }); }); return () => { live = false; }; }, [client, retry]);
  if (!answer) return html`<p class="note" role="status">${g("searching")}</p>`;
  if (!answer.ok) return html`<p class="err" role="status">${g("failed")}</p><button type="button" class="btn btn-sm" disabled=${disabled} onClick=${() => setRetry(n => n + 1)}>${g("retry")}</button>`;
  return html`<label class="field"><span>${g("teamPick")}</span><select data-grant-team value="" disabled=${disabled} onChange=${e => { const row = answer.teams?.find(row => row.id === e.target.value); if (row) onPick(row); }}><option value="">${g("teamPick")}</option>${(answer.teams || []).map(row => html`<option value=${row.id}>${row.name}</option>`)}</select></label>`;
}

export function SubjectPicker({ client, search, kind: controlled, onKind, onPick, selected, onClear, disabled = false, id: inputId, exclude = [], onUnsupported, label, groupId }) {
 const [local, setLocal] = useState("group"), id = useMemo(() => inputId || `hubSubject${++sequence}`, [inputId]);
 const kind = controlled || local;
 const query = useMemo(() => search || ((kind, q) => (kind === "group" ? client.searchGroups?.(q) : client.searchAllowedPeople?.(q)) || { ok: false, reason: "unsupported" }), [client, search]);
 const groups = useMemo(() => ({ searchGroups: q => query("group", q) }), [query]);
 const teamLive = typeof client.teams === "function" && (typeof client.teamsLive !== "function" || client.teamsLive());
 const picked = row => onPick?.(kind, row);
 return html`<div class="hub-subject-picker">
  <label class="field"><span>${label || g("kind")}</span><select data-subject-kind data-grant-kind=${inputId === "hubGrant" ? true : undefined} value=${kind} disabled=${disabled} onChange=${e => { setLocal(e.target.value); onKind?.(e.target.value); }}>
   <option value="group">${g("group")}</option>${teamLive ? html`<option value="team">${g("team")}</option>` : null}<option value="person">${g("person")}</option></select></label>
  ${selected ? html`<div class="s-row"><span class="hub-row-text"><strong>${selected.name || selected.displayName || selected.cn || selected.login}</strong><small class="note"><code>${selected.login || selected.dn || ""}</code></small></span><button type="button" class="btn btn-sm" disabled=${disabled} onClick=${onClear}>${g("change")}</button></div>`
   : kind === "person" ? html`<${PeopleSearch} search=${query} disabled=${disabled} id=${`${id}Person`} onPick=${picked} />`
   : kind === "team" ? html`<${TeamPick} client=${client} disabled=${disabled} onPick=${picked} />`
   : html`<${GroupSearch} client=${groups} id=${groupId || `${id}Group`} disabled=${disabled} exclude=${exclude} unknownHint=${g("failed")} onUnsupported=${onUnsupported} onPick=${picked} />`}
 </div>`;
}
