import { AgentIntroSharingPreview } from "./hub-agent-intro.js";
/** Owner-only inventory. Saved requests survive page refresh; Fleet snapshots decide the result. */
import { lang } from "/assets/app-i18n.js";
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { Dialog } from "/assets/ui-dialog.js";
import { ms } from "./hub-my-agents-strings.js";
import { rowAvailability, rowKey, shareRows, reconcileSharing } from "./hub-my-agents-model.js";
import { HubGrantPicker } from "./hub-grant-picker.js";
import { assetUrl } from "/assets/asset-url.js";
import { clockFormat } from "/assets/clock-text.js";
const tone = name => { let h = 0; for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 6; };
const shortSeen = at => Number.isFinite(at) ? clockFormat({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, lang() === "zh-TW" ? "zh-TW" : "en-GB").format(at) : "—";
const Avatar = ({ name }) => html`<span class=${`hub-av sm t${tone(name)}`} aria-hidden="true">${[...name][0] || "?"}</span>`;
const mc = (key, n) => ms(n === 1 ? `${key}One` : key, n);
const STORE = "agend.hub.owner-sharing";
const safeRead = scope => { try { const v = JSON.parse(sessionStorage.getItem(STORE)); return v?.scope === scope && Array.isArray(v.operations) ? v.operations.filter(op => op && typeof op.at === "number" && Array.isArray(op.rows) && op.input && typeof op.input.idempotencyKey === "string" && typeof op.input.fleetId === "string" && Array.isArray(op.input.share) && Array.isArray(op.input.stop)).slice(-32) : []; } catch { return []; } };
function css() {
  if (document.querySelector('link[data-hub-my-agents-css]')) return;
  const link = document.createElement("link"); link.rel = "stylesheet"; link.href = assetUrl("/assets/hub-my-agents.css"); link.setAttribute("data-hub-my-agents-css", "1"); document.head.appendChild(link);
}
const summary = x => !x?.grants?.length ? ms("nobody") : x.grants.some(g => g.subject?.kind !== "person") ? ms("subjects", x.grants.length) : mc("people", x.grants.length);
export function HubMyAgents({ client, scope, shared = [], policy = false, personal = false, apps = false, pausable = false, subjects = false, onChanged, onAllow }) {
  const [data, setData] = useState(null), [mine, setMine] = useState(shared), [publish, setPublish] = useState(policy ? { state: "unknown" } : { state: "allow" });
  const [draft, setDraft] = useState({}), [operations, setOperations] = useState(() => safeRead(scope)), [busy, setBusy] = useState(false), [error, setError] = useState(null), [confirm, setConfirm] = useState(false), [access, setAccess] = useState([]), [help, setHelp] = useState(false);
  const life = useRef(0), writing = useRef(false), currentOps = useRef(operations), changed = useRef(onChanged), welcomed = useRef(null);
  currentOps.current = operations; changed.current = onChanged;
  const live = generation => generation === life.current;
  const load = async generation => {
    const [catalog, accepted, welcome] = await Promise.all([client.ownAgents(scope), client.catalog(), policy ? client.welcome() : Promise.resolve(null)]);
    if (!live(generation)) return;
    if (catalog.ok) setData(catalog); else setError(ms("failed"));
    if (accepted.ok) setMine(accepted.mine || []);
    if (policy) { welcomed.current = welcome?.ok ? welcome : null; setPublish(welcome?.ok ? welcome.publish : { state: "unknown" }); }
    if (catalog.ok) setError(null);
  };
  useEffect(() => {
    css(); const generation = life.current; void load(generation);
    const off = client.onSignedOut?.(() => { life.current++; setOperations([]); setDraft({}); setAccess([]); try { sessionStorage.removeItem(STORE); } catch { /* unavailable storage */ } });
    return () => { life.current++; off?.(); };
  }, [client, scope]);
  useEffect(() => { try { sessionStorage.setItem(STORE, JSON.stringify({ scope, operations })); } catch { /* The in-memory frozen intent remains recoverable until this page closes. */ } }, [scope, operations]);
  const fleets = (data?.fleets || []).map(f => ({ ...f, policyState: welcomed.current?.connect?.fleets?.find(x => x.id === f.id)?.status }));
  const plans = fleets.map(f => ({ fleet: f, rows: shareRows(f, mine) }));
  const pending = operations.flatMap(op => reconcileSharing(op, fleets, mine).rows.map(row => ({ ...row, op })));
  useEffect(() => {
    if (!data) return;
    const done = [], keep = [];
    for (const op of currentOps.current) {
      const outcome = reconcileSharing(op, fleets, mine);
      for (const row of outcome.rows) if (row.state === "done" && row.instance && row.current && !op.offered?.includes(row.current.id)) done.push(row.current);
      const offered = [...new Set([...(op.offered || []), ...done.map(x => x.id)])];
      keep.push({ ...op, offered });
    }
    if (done.length) { setAccess(old => [...new Map([...old, ...done].map(x => [x.id, x])).values()]); setOperations(keep); changed.current?.(); }
  }, [data, mine, operations]);
  useEffect(() => {
    const generation = life.current;
    const unresolved = currentOps.current.filter(op => !reconcileSharing(op, fleets, mine).settled && Date.now() - op.at < 610_000);
    if (!unresolved.length) return;
    const timer = setTimeout(async () => {
      const next = await Promise.all(currentOps.current.map(async op => {
        if (reconcileSharing(op, fleets, mine).settled) return op;
        const r = await client.agentSharingRequest(scope, op.input.idempotencyKey);
        return r.ok ? { ...op, response: r } : op;
      }));
      if (!live(generation)) return; setOperations(next); await load(generation);
    }, 3_000);
    return () => clearTimeout(timer);
  }, [operations, data, mine]);
  const persist = next => { currentOps.current = next; try { sessionStorage.setItem(STORE, JSON.stringify({ scope, operations: next })); } catch { /* preserve in memory */ } setOperations(next); };
  const send = async (op, generation) => {
    const r = await client.requestAgentSharing(scope, op.input);
    if (!live(generation)) return;
    const definite = r.status >= 400 && r.status < 500 && r.status !== 408;
    const response = r.ok ? r : definite ? { state: "complete", result: { results: op.rows.map(row => ({ ...(row.instance ? { instance: row.instance } : { exposureId: row.id }), ok: false, code: r.code === "conflict" ? "stale-list" : r.code === "denied" ? "not-allowed" : "unavailable" })) } } : op.response;
    persist(currentOps.current.map(x => x.input.idempotencyKey === op.input.idempotencyKey ? { ...x, response } : x));
  };
  // M-3543: Share again of a lapsed agent (shared, but its backend/folder changed since): one share request for it, which
  // the Fleet answers with a republish at the next revision; the Hub keeps the people who may ask it.
  const shareAgain = async (row, fleet) => {
    if (writing.current) return; writing.current = true; setBusy(true); const generation = life.current;
    try {
      const op = { input: { idempotencyKey: crypto.randomUUID(), fleetId: fleet.id, catalogRevision: fleet.catalog.revision, share: [row.instance], stop: [] }, at: Date.now(),
        rows: [{ instance: row.instance, name: row.displayName, before: { id: row.current.id, revision: row.current.revision } }], response: null };
      persist([...currentOps.current.slice(-24), op]);
      await send(op, generation);
      await load(generation);
    } finally { if (live(generation)) { writing.current = false; setBusy(false); } }
  };
  const refresh = async () => {
    if (writing.current) return; writing.current = true; setBusy(true); const generation = life.current;
    try {
      for (const op of currentOps.current) if (!reconcileSharing(op, fleets, mine).settled) await send(op, generation);
      await Promise.all(fleets.filter(f => f.connected && f.catalogSupported).map(f => client.refreshOwnAgents(scope, f.id)));
      await load(generation);
      // The request returning is not the report. A bounded follow-up read lets a fresh report land.
      setTimeout(() => { if (live(generation)) void load(generation); }, 1_000);
    } finally { if (live(generation)) { writing.current = false; setBusy(false); } }
  };
  const changes = plans.flatMap(({ fleet, rows }) => rows.filter(row => Object.hasOwn(draft, rowKey(fleet, row)) && draft[rowKey(fleet, row)] !== row.shared).map(row => ({ ...row, fleet })));
  const shares = changes.filter(r => !r.shared), stops = changes.filter(r => r.shared);
  const apply = async () => {
    if (writing.current) return; writing.current = true; setBusy(true); setConfirm(false); const generation = life.current;
    try {
      const next = plans.flatMap(({ fleet }) => {
        const rows = changes.filter(r => r.fleet.id === fleet.id); if (!rows.length) return [];
        return [{ input: { idempotencyKey: crypto.randomUUID(), fleetId: fleet.id, catalogRevision: fleet.catalog.revision, share: rows.filter(r => !r.shared).map(r => r.instance), stop: rows.filter(r => r.shared).map(r => r.current.id) }, at: Date.now(), rows: rows.map(r => ({ ...(r.shared ? { id: r.current.id } : { instance: r.instance }), name: r.displayName, before: r.current ? { id: r.current.id, revision: r.current.revision } : r.exposure || null })), response: null }];
      });
      persist([...currentOps.current.slice(-24), ...next]); setDraft({});
      for (const op of next) { if (!live(generation)) return; await send(op, generation); }
      await load(generation);
    } finally { if (live(generation)) { writing.current = false; setBusy(false); } }
  };
  const pause = async targets => {
    if (writing.current) return; writing.current = true; setBusy(true); setConfirm(false); const generation = life.current;
    try { for (const row of targets) { const x = row.current; if (!live(generation)) return; const r = await client.ownerSharing(scope, x.id, x.revision, x.sharingEpoch || 0, true); if (!r.ok && live(generation)) setError(ms("saveFailed", x.displayName)); }
      if (live(generation)) { setDraft(old => { const next = { ...old }; for (const row of targets) delete next[rowKey(row.fleet, row)]; return next; }); await load(generation); changed.current?.(); }
    } finally { if (live(generation)) { writing.current = false; setBusy(false); } }
  };
  return html`<div class="hub-my-agents" data-my-agents><div class="field-row"><button class="btn btn-sm" disabled=${busy} onClick=${refresh}>${ms(busy ? "refreshing" : "refresh")}</button></div>
    ${fleets.filter(f => f.connected && (!f.catalogSupported || f.catalog?.requests !== true)).length ? html`<p class="note hub-banner warn" role="status">${mc("oldCount", fleets.filter(f => f.connected && (!f.catalogSupported || f.catalog?.requests !== true)).length)}</p>` : null}
    ${error ? html`<p class="err" role="alert">${error}</p>` : null}
    ${publish.state === "deny" ? html`<p class="note" role="status">${ms("denied")}</p>` : null}
    ${plans.map(({ fleet, rows }) => { const count = rows.filter(r => r.shared).length, waiting = pending.filter(r => r.op.input.fleetId === fleet.id && ["pending", "uncertain"].includes(r.state));
      return html`<details class="card hub-agent-fleet" open key=${fleet.id}><summary><strong>${fleet.label || ms("fleet")}</strong><span class="note">${fleet.connected ? ms("connected") : ms("offlineShort", shortSeen(fleet.catalog?.at))} · ${!fleet.catalog || !fleet.catalog.requests || fleet.connected && !fleet.catalogSupported ? ms("knownShared", count) : ms("count", count, rows.length)}</span></summary>
        ${fleet.connected && (!fleet.catalogSupported || !fleet.catalog?.requests) ? html`<p class="note">${ms("old")} <button type="button" class="btn btn-sm" onClick=${() => setHelp(true)}>${ms("update")}</button></p>` : null}
        ${fleet.catalog?.enabled === false ? html`<p class="note">${ms("off")}</p>` : null}
        <div class="field-row"><button type="button" class="btn btn-sm" data-share-all disabled=${busy || !!waiting.length || !rows.some(r => !r.general && !r.shared && !rowAvailability(fleet, r, publish, count))} onClick=${() => setDraft(old => { const next = { ...old }; let n = count; for (const row of rows) if (!row.general && !row.shared && !rowAvailability(fleet, row, publish, n)) { next[rowKey(fleet, row)] = true; n++; } return next; })}>${ms("select")}</button></div>
        <div class="hub-rows">${rows.map(row => { const key = rowKey(fleet, row), status = [...pending].reverse().find(r => r.op.input.fleetId === fleet.id && (row.instance ? r.instance === row.instance : r.id === row.current?.id) && ["pending", "uncertain", "refused"].includes(r.state));
          const reason = rowAvailability(fleet, row, publish, count), tick = ["pending", "uncertain"].includes(status?.state) ? !!status.instance : Object.hasOwn(draft, key) ? draft[key] : row.shared;
          return html`<div class="hub-agent-choice" data-unavailable=${reason ? true : undefined} key=${key}><div class="s-row hub-row"><label class="hub-agent-tick"><input type="checkbox" data-share-agent=${row.instance || row.current?.id} aria-label=${row.displayName} checked=${tick} disabled=${busy || !!reason || !!waiting.length} onChange=${e => { const checked = e.target.checked; setDraft(old => ({ ...old, [key]: checked })); }} /></label><${Avatar} name=${row.displayName} size="sm" />
            <span class="hub-row-text">${row.current ? html`<a class="hub-agent-link" href=${`/ui/hub/exposures?agent=${encodeURIComponent(row.current.id)}`} aria-label=${ms("details", row.displayName)}><strong>${row.displayName}</strong></a>` : html`<strong>${row.displayName}</strong>`}
              ${row.kind === "classic-room" ? html`<small class="tag">${ms("classic")}</small>` : null}<small class="note">${reason && reason !== "offline" ? ms(reason) : row.general ? ms("general") : row.description}</small>
              ${row.current?.intro ? html`<small class="note">${row.current.intro}</small>` : null}
              ${row.shared ? (row.exposure?.lapsed === true && row.instance
                ? html`<small class="note hub-agent-lapsed-status">${ms("needsReshare")} · ${summary(row.current)}${lang() === "zh-TW" ? "" : " "}${ms("kept")}</small>`
                : row.current.state === "published" && !row.current.grants?.length
                  // M-3565 (the user, 11-24): "nobody may ask yet" is where to start — a button straight to the picker.
                  ? html`<small class="note hub-agent-who">${ms("shared")} · <button type="button" class="btn btn-sm hub-agent-set-who" data-set-who=${row.current.id} disabled=${busy}
                      onClick=${() => setAccess([{ ...row.current, direct: true }])}>${ms("setWho")}</button></small>`
                  : html`<small class="note">${ms(row.current.state !== "published" ? "paused" : "shared")} · ${summary(row.current)}</small>`) : null}
              ${row.shared && row.current && fleet.picturesTooLarge?.[row.current.id]?.length
                // M-3533 R2b (Lumen): a picture its Fleet shows but the Hub cannot take says so here, to its owner alone.
                ? fleet.picturesTooLarge[row.current.id].map(slot => html`<small class="note hub-agent-picture-large" data-picture-large=${slot}>${ms(slot === "disc" ? "pictureDiscLarge" : slot === "character" ? "pictureCharacterLarge" : "picturePortraitLarge")}</small>`) : null}
              ${row.shared && row.exposure?.lapsed === true && row.instance ? html`<small class="note hub-agent-lapsed" role="status">${ms("lapsed")}</small>
                <button type="button" class="btn btn-sm hub-agent-share-again" data-share-again=${row.instance} disabled=${busy || !!waiting.length} onClick=${() => shareAgain(row, fleet)}>${ms("shareAgain")}</button>` : null}
              ${status ? html`<small class=${status.state === "refused" ? "err" : "note"} role="status">${status.state === "uncertain" ? ms("uncertain") : status.state === "refused" ? status.code === "stale-list" ? ms("changed") : ms("refused", ms(({ "not-allowed": "denied", "switched-off": "off", "limit": "limit", "not-shareable": "unavailable" })[status.code] || "unavailable")) : ms(status.instance ? "sharing" : "stopping")}</small>` : null}</span>
              ${pausable && row.shared && row.current.state === "published" && typeof client.ownerSharing === "function" ? html`<button type="button" class="btn btn-sm hub-agent-pause" disabled=${busy} onClick=${() => pause([{ ...row, fleet }])}>${ms("pauseOne")}</button>` : null}</div>
            ${row.kind === "classic-room" && tick && !row.shared ? html`<p class="note hub-classic-disclosure">${ms("classicHint")}</p>` : null}</div>`; })}</div></details>`;
    })}
    ${mine.some(x => x.kind === "personal") ? html`<section class="card"><h3>${ms("personal")}</h3>${mine.filter(x => x.kind === "personal").map(x => html`<a class="s-row hub-row" href=${`/ui/hub/exposures?agent=${encodeURIComponent(x.id)}`}><span class="hub-row-text"><strong>${x.displayName}</strong><small class="note">${summary(x)}</small></span></a>`)}</section>` : null}
    ${data && !plans.length && !mine.some(x => x.kind === "personal") ? html`<section class="card"><h3>${ms("empty")}</h3><p>${ms("already")}</p><p>${ms("emptyLead")}</p>${personal ? null : html`<p class="note">${ms("personalOff")}</p>`}<p class="note">${welcomed.current?.connect?.state === "allow" ? ms("fleetLead") : ms("connectDenied")}</p>${apps ? html`<p>${ms("apps")} <a href="/ui/hub/ai-apps">${ms("appsLink")}</a></p>` : null}</section>` : null}
    ${changes.length ? html`<div class="hub-share-bar" role="region" aria-label=${ms("apply")}><strong>${changes.length === 1 ? changes[0].displayName : ms("namesMore", changes[0].displayName, lang() === "zh-TW" ? changes.length : changes.length - 1)}</strong><button class=${`btn ${stops.length ? "btn-danger" : "btn-primary"}`} disabled=${busy || plans.some(p => changes.filter(r => r.fleet.id === p.fleet.id).length > 64)} onClick=${() => stops.length ? setConfirm(true) : apply()}>${shares.length && stops.length ? ms("apply") : mc(shares.length ? "share" : "stop", changes.length)}</button><button class="btn" disabled=${busy} onClick=${() => setDraft({})}>${ms("cancel")}</button></div>` : null}
    ${confirm ? html`<${Dialog} title=${mc("stopTitle", stops.length)} onClose=${() => setConfirm(false)} actions=${html`<button class="btn" onClick=${() => setConfirm(false)}>${ms("cancel")}</button><button class="btn" onClick=${() => pause(stops)}>${ms("pause")}</button><button class="btn btn-danger" onClick=${apply}>${ms("stopGo")}</button>`}><p>${ms("stopBody", stops.map(r => r.displayName).join(", "))}</p><p class="note">${ms("stopHint")}</p></${Dialog}>` : null}
    ${help ? html`<${Dialog} title=${ms("update")} onClose=${() => setHelp(false)}><p>${ms("updateHint")}</p></${Dialog}>` : null}
    ${access.length ? html`<${SharingAccess} targets=${access} client=${client} scope=${scope} subjects=${subjects} onAllow=${onAllow} onClose=${() => { setAccess([]); void load(life.current); changed.current?.(); }} />` : null}
  </div>`;
}
function SharingAccess({ targets, client, scope, subjects, onAllow, onClose }) {
  const [introUpdates,setIntroUpdates]=useState({});
  const introPreview=x=>client.agentIntrosV1?html`<${AgentIntroSharingPreview} key=${x.id} exposure=${{...x,...introUpdates[x.id]}} client=${client} onSaved=${value=>setIntroUpdates(old=>({...old,[x.id]:value}))} />`:null;
  const [mode, setMode] = useState(targets.length === 1 ? "each" : null), [pick, setPick] = useState(null), [previous, setPrevious] = useState({}), [outcomes, setOutcomes] = useState({}), [busy, setBusy] = useState(false);
  const life = useRef(0);
  useEffect(() => { const generation = life.current; void Promise.all(targets.map(async x => [x.id, await client.previousAgentAccess(scope, x.id)])).then(rows => { if (generation === life.current) setPrevious(Object.fromEntries(rows)); }); return () => { life.current++; }; }, [client, scope, targets]);
  useEffect(() => { if (targets.length === 1 && !pick) setPick(targets); }, []);
  const direct = targets.length === 1 && targets[0].direct === true;   // M-3565: opened from a row's 「設定誰可以問」
  const usePrevious = async x => { if (busy) return; const generation = life.current; setBusy(true); const r = await client.usePreviousAgentAccess(scope, x.id, { revision: x.revision, digest: previous[x.id]?.previous?.digest }); if (generation === life.current) { setOutcomes(old => ({ ...old, [x.id]: r.ok ? ms("used") : ms("saveFailed", x.displayName) })); setBusy(false); } };
  if (pick) return html`<${HubGrantPicker} x=${pick[0]} legacy=${!subjects} targets=${pick} client=${client} act=${async fn => fn()} grant=${input => client.ownerGrant(scope, input)} onClose=${() => (direct ? onClose() : setPick(null))} onResults=${results => setOutcomes(old => ({ ...old, ...results }))} extra=${html`${pick.map(x=>html`<div key=${x.id}><strong>${x.displayName}</strong>${introPreview(x)}</div>`)}${pick.length === 1 && previous[pick[0].id]?.previous ? html`<button class="btn" disabled=${busy} onClick=${() => usePrevious(pick[0])}>${ms(previous[pick[0].id].previous.peopleCount === null ? "previousMixed" : "previous", previous[pick[0].id].previous.count)}</button>${outcomes[pick[0].id] ? html`<p role="status">${outcomes[pick[0].id]}</p>` : null}` : null}`} />`;
  return html`<${Dialog} title=${mc("accessTitle", targets.length)} onClose=${onClose} actions=${html`<button class="btn" onClick=${onClose}>${ms("later")}</button>`}><p>${ms("accessLead")}</p><div class="field-row"><button class="btn btn-primary" onClick=${() => { setMode("same"); setPick(targets); }}>${ms("same", targets.length)}</button><button class="btn" onClick=${() => setMode("each")}>${ms("each")}</button></div><ul class="hub-share-access-list">${targets.map(x => html`<li class="hub-share-access-item"><div class="hub-row-text"><strong>${x.displayName}</strong>${introPreview(x)}${outcomes[x.id] ? html`<small role="status">${outcomes[x.id]}</small>` : null}</div>${mode === "each" ? html`<button class="btn btn-sm" onClick=${() => setPick([x])}>${ms("choose")}</button>` : null}${previous[x.id]?.previous ? html`<button class="btn btn-sm" disabled=${busy} onClick=${() => usePrevious(x)}>${ms(previous[x.id].previous.peopleCount === null ? "previousMixed" : "previous", previous[x.id].previous.count)}</button>` : null}</li>`)}</ul></${Dialog}>`;
}
