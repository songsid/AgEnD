/**
 * Hub UX U2 (spec 1.2 / 2.6): the administrator's 「讓同仁加入」 card — three steps, each done from server state.
 * This module so far holds step 3 and the join-code slot that B2 (Ridge) mounts into; steps 1–2 follow in this PR.
 *
 * Slot contract (agreed with Ridge, hub-b2-mount-contract / hub-b2-create-gate):
 *   <div id="hubEnrolmentCodeSlot"> mounts `HubEnrolmentCode` from ./hub-enrolment-code.js, lazily, only when the session
 *   advertises "enrolment-code-v1" (an implementation capability, independent of the on/off switch) and the module exports
 *   `enrolmentCodeV1 === true`. A missing module, a failed import or a missing flag leaves the slot empty (upgrade skew).
 *   Props: { client, enabled, host, onChanged } — `enabled` = step 1 done (code creation needs only company join on; a live
 *   code then satisfies step 2), `host` = the display host of step 3's sentence, `onChanged()` after create/revoke so this
 *   card reads its steps again. Revoking stays the component's own (it lists retained codes even with creation off).
 */
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { GroupSearch } from "./hub-group-search.js";
import { register, t } from "/assets/app-i18n.js";
import { hubClient } from "./hub-client.js";
export const joinStepsV1 = true;
register("hubJoinSteps", {
  en: {
    step3: "Tell colleagues how to join", sentence: "In AgEnD, open Settings → Hub, enter {0}, then sign in with the company account.",
    copy: "Copy these instructions", copied: "Copied", copyFailed: "Copy failed. Select the sentence and copy it.",
    step3Off: "Finish steps 1 and 2 first.",
    title: "Let colleagues join", lead: "Three steps. Each one is checked against what the Hub has saved.", done: "Done",
    step1: "Let colleagues connect Fleets with their company account", step1Switch: "Allow company-account Fleet connections",
    step2: "Who can join", step2Hint: "Add the AD groups whose members may connect a Fleet, then save.",
    step2Code: "A live join code counts too.", byDn: "Add by distinguished name", dnLabel: "Distinguished name", dnAdd: "Add",
    perPerson: "Each person up to", fleetsUnit: "Fleets", capAsk: "Chat with agents", capPublish: "Share agents", remove: "Remove",
    noGroups: "No group yet.", previewing: "Checking what this changes…", noImpact: "Nobody loses anything.",
    losing: "These people lose an action", suspended: "These are paused when you save", adminLosesChat: "You would no longer be able to chat with agents.",
    save: "Save", saving: "Saving…", saved: "Saved.", conflict: "Someone else changed this. The page now shows the saved version.",
    stale: "The check is out of date. It has been run again; look at it and save again.", failed: "Could not save. Try again.",
    unsupported: "This directory cannot list groups for permissions. Ask your Hub administrator.", repair: "The saved permissions need repair on the Group permissions page.",
    duplicate: "That group is already on the list.", notFound: "No such group.", notSecurity: "That is not a security group.", invalidDn: "That is not a distinguished name.", unknownGroup: "The group could not be checked. Try again.",
    groupsPage: "All group permissions", advanced: "Link with key fingerprint (Advanced)", advancedHint: "Only for a colleague who must check the key fingerprint by hand.",
    exceptions: "Individual invitations", otherWays: "Other ways",
  },
  "zh-TW": {
    step3: "告訴同仁怎麼加入", sentence: "在 AgEnD 的「設定 → Hub」輸入 {0}，再用公司帳號登入。",
    copy: "複製這段說明", copied: "已複製", copyFailed: "複製失敗。請選取這段說明再複製。",
    step3Off: "請先完成步驟 1 和 2。",
    title: "讓同仁加入", lead: "三個步驟，每一步都依 Hub 已儲存的設定判斷是否完成。", done: "已完成",
    step1: "允許同仁用公司帳號連接 Fleet", step1Switch: "允許以公司帳號連接 Fleet",
    step2: "誰可以加入", step2Hint: "加入可以連接 Fleet 的 AD 群組，然後儲存。",
    step2Code: "有效的加入碼也算完成。", byDn: "用辨別名稱新增", dnLabel: "辨別名稱", dnAdd: "新增",
    perPerson: "每人最多", fleetsUnit: "台", capAsk: "和 Agent 對話", capPublish: "分享 Agent", remove: "移除",
    noGroups: "還沒有群組。", previewing: "正在檢查這次變更的影響…", noImpact: "沒有人會失去任何權限。",
    losing: "這些人會失去權限", suspended: "儲存後會暫停這些項目", adminLosesChat: "你將無法再和 Agent 對話。",
    save: "儲存", saving: "儲存中…", saved: "已儲存。", conflict: "有人剛改過這裡。頁面已顯示目前儲存的版本。",
    stale: "檢查結果已過期，已重新檢查。請看過後再儲存一次。", failed: "無法儲存，請再試一次。",
    unsupported: "這個目錄無法列出群組來設定權限。請找 Hub 管理員。", repair: "已儲存的權限需要在「群組權限」頁修復。",
    duplicate: "這個群組已經在清單裡。", notFound: "找不到這個群組。", notSecurity: "這不是安全性群組。", invalidDn: "這不是辨別名稱。", unknownGroup: "目前無法確認這個群組，請再試一次。",
    groupsPage: "所有群組權限", advanced: "含金鑰指紋的連結（進階）", advancedHint: "只給需要自己核對金鑰指紋的同仁。",
    exceptions: "個別邀請", otherWays: "其他方式",
  },
});
const sw = (key, ...args) => t(`hubJoinSteps.${key}`, ...args);
/** The web origin as people see it (spec 1.2): no https://, no :443. */
export function displayHost(webOrigin) {
  try { const u = new URL(String(webOrigin || "")); return u.protocol === "https:" ? u.host.replace(/:443$/, "") : ""; } catch { return ""; }
}
/** The one sentence colleagues need (step 3's), for this Hub. */
export const joinSentence = (webOrigin) => { const host = displayHost(webOrigin); return host ? sw("sentence", host) : ""; };
export const otherWaysLabel = () => sw("otherWays");
/** B2's join-code component in its slot, or nothing (see the contract above). */
// B2 ships the module; until then (and on a Hub that does not serve it) the import fails and the slot stays empty.
const CODE_MODULE = "./hub-enrolment-code.js";
const loadCode = () => import(/* @vite-ignore */ CODE_MODULE);
export function EnrolmentCodeSlot({ features = [], client = hubClient(), enabled = false, host = "", onChanged, load = loadCode } = {}) {
  const offered = Array.isArray(features) && features.includes("enrolment-code-v1");
  const [Code, setCode] = useState(null);
  useEffect(() => {
    let live = true;
    if (offered) Promise.resolve().then(load).then(m => { if (live && m && m.enrolmentCodeV1 === true && typeof m.HubEnrolmentCode === "function") setCode(() => m.HubEnrolmentCode); }, () => {});
    return () => { live = false; };
  }, [offered]);
  return html`<div id="hubEnrolmentCodeSlot">${offered && Code ? html`<${Code} client=${client} enabled=${enabled} host=${host} onChanged=${onChanged} />` : null}</div>`;
}
/** Step 3: the one sentence colleagues need, its copy button (only once steps 1 and 2 are done), and the join-code slot. */
export function JoinStep3({ webOrigin, step1 = false, step2 = false, features = [], client = hubClient(), onChanged, load } = {}) {
  const host = displayHost(webOrigin), ready = step1 && step2 && !!host, [copied, setCopied] = useState(null);
  const copy = async () => { try { await navigator.clipboard.writeText(sw("sentence", host)); setCopied("copied"); } catch { setCopied("copyFailed"); } };
  return html`<li class=${ready ? "now" : ""} data-step="3"><div class="hub-step-body"><span><b>${sw("step3")}</b>
      ${ready ? html`<small class="note hub-join-sentence">${sw("sentence", host)}</small>` : html`<small class="note" id="hubJoinStep3Off">${sw("step3Off")}</small>`}</span>
    <button type="button" class="btn btn-sm" disabled=${!ready} aria-describedby=${ready ? undefined : "hubJoinStep3Off"} onClick=${copy}>${copied === "copied" ? sw("copied") : sw("copy")}</button>
    ${copied === "copyFailed" ? html`<p class="note" role="alert">${sw("copyFailed")}</p>` : null}
    <${EnrolmentCodeSlot} features=${features} client=${client} enabled=${step1} host=${host} onChanged=${onChanged} ...${load ? { load } : {}} />
  </div></li>`;
}

const RESOLVE = { "not-found": "notFound", "not-security-group": "notSecurity", invalid: "invalidDn", unsupported: "unsupported", unknown: "unknownGroup" };
const CAP_ORDER = ["ask_agents", "publish_agents", "pair_fleet"];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** A group lets its members join: connect is allowed with at least one Fleet each. */
export const groupLetsJoin = (g) => !!g && Array.isArray(g.allow) && g.allow.includes("pair_fleet") && g.maxFleets >= 1;
/** Step 2 is done from saved state: the policy is on and a group lets members join — or a join code is live (B2). */
export function step2Done(policy, codes) {
  return !!policy && policy.state === "enabled" && policy.groups.some(groupLetsJoin) || Array.isArray(codes) && codes.some((c) => c && c.state === "live");
}
/** The proposed policy: saved fields, these groups, switched on once it has a group (one 儲存, spec 1.2). */
export function proposedPolicy(saved, groups) {
  return { ...saved, state: groups.length ? "enabled" : saved.state,
    groups: groups.map((g) => ({ group: { realm: g.group.realm, objectId: g.group.objectId }, dn: g.dn, allow: CAP_ORDER.filter((c) => g.allow.includes(c)), maxFleets: g.maxFleets })) };
}

/** Step 2: who can join — search, chips, each person's Fleet limit and the two other permissions; the server's check; one 儲存. */
export function JoinStep2({ client = hubClient(), onSaved } = {}) {
  const [view, setView] = useState(null), [groups, setGroups] = useState([]), [preview, setPreview] = useState(null);
  const [msg, setMsg] = useState(null), [saving, setSaving] = useState(false), [dn, setDn] = useState(""), [dnOpen, setDnOpen] = useState(false), [again, setAgain] = useState(0);
  const live = useRef(true), seq = useRef(0);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const load = async () => {
    if (typeof client.groupPolicy !== "function") { setView({ supported: false, binding: "ready", policy: null }); return; }   // an older client
    let r; try { r = await client.groupPolicy(); } catch { r = { ok: false }; }
    if (!live.current) return;
    if (!r.ok) { setView({ failed: true }); return; }
    setView(r); setGroups(r.policy ? r.policy.groups.map((g) => ({ ...g, allow: [...g.allow] })) : []); setPreview(null);
  };
  useEffect(() => { void load(); }, []);
  const policy = view && view.policy, editable = !!policy && view.supported === true && view.binding === "ready";
  const draft = policy ? proposedPolicy(policy, groups) : null, changed = !!draft && !same(draft, proposedPolicy(policy, policy.groups)) || !!policy && !!groups.length && policy.state !== "enabled";
  useEffect(() => {
    if (!editable || !changed) { setPreview(null); return undefined; }
    const mine = ++seq.current; setPreview({ loading: true });
    const timer = setTimeout(async () => {
      const r = await client.previewGroupPolicy(draft);
      if (live.current && mine === seq.current) setPreview(r.ok ? { ok: true, ...r } : { ok: false, code: r.code });
    }, 400);
    return () => clearTimeout(timer);
  }, [editable, JSON.stringify(draft), changed, again]);
  const addResolved = async (text) => {
    setMsg(null);
    const r = await client.resolveGroup(text);
    if (!live.current) return false;
    if (!r.ok || r.reason) { setMsg({ err: true, text: sw(r.ok ? RESOLVE[r.reason] || "unknownGroup" : r.code === "unsupported" ? "unsupported" : "unknownGroup") }); return false; }
    if (groups.some((g) => g.group.objectId === r.objectId)) { setMsg({ err: true, text: sw("duplicate") }); return false; }
    // In this card a group is added to let its members join: chat and connect, one Fleet each (the admin can change both).
    setGroups((gs) => [...gs, { group: { realm: r.realm, objectId: r.objectId }, dn: r.dn, allow: ["ask_agents", "pair_fleet"], maxFleets: 1 }]);
    return true;
  };
  const setCap = (i, cap, on) => setGroups(groups.map((g, j) => j !== i ? g : { ...g, allow: on ? [...new Set([...g.allow, cap])] : g.allow.filter((x) => x !== cap) }));
  const setFleets = (i, n) => setGroups(groups.map((g, j) => { if (j !== i) return g; const m = Math.max(0, Math.min(8, Math.floor(Number(n)) || 0));
    return { ...g, maxFleets: m, allow: m > 0 ? [...new Set([...g.allow, "pair_fleet"])] : g.allow.filter((x) => x !== "pair_fleet") }; }));
  const save = async () => {
    if (!preview || !preview.ok || saving) return;
    setSaving(true); setMsg(null);
    const r = await client.saveGroupPolicy(draft, preview.previewDigest);
    if (!live.current) return;
    setSaving(false);
    if (r.ok) { setMsg({ text: sw("saved") }); await load(); onSaved?.(); return; }
    setMsg({ err: true, text: sw(r.code === "conflict" ? "conflict" : r.code === "stale-preview" || r.code === "expired" ? "stale" : "failed") });
    if (r.code === "conflict") await load(); else if (r.code === "stale-preview" || r.code === "expired") setAgain((n) => n + 1);
  };
  if (!view) return html`<p class="note" aria-busy="true">${sw("previewing")}</p>`;
  if (view.failed) return html`<p class="note" role="alert">${sw("failed")}</p>`;
  const pv = preview && preview.ok ? preview.impact || {} : null;
  return html`<div class="hub-join-step2">
    ${view.supported !== true ? html`<p class="note" role="status">${sw("unsupported")}</p>` : null}
    ${view.binding === "repair-required" ? html`<p class="err" role="alert">${sw("repair")}</p>` : null}
    ${editable ? html`<${GroupSearch} client=${client} exclude=${groups.map((g) => g.group.objectId)} onPick=${(hit) => addResolved(hit.dn)} onUnsupported=${() => setDnOpen(true)} />` : null}
    ${groups.length ? html`<ul class="hub-join-groups" role="list">${groups.map((g, i) => html`<li key=${g.group.objectId} class="s-row hub-row" data-group=${g.group.objectId}>
      <span class="hub-row-text"><strong>${(/^CN=([^,]+)/i.exec(g.dn) || [0, g.dn])[1]}</strong><small class="note"><code>${g.dn}</code></small></span>
      <label class="field hub-join-fleets"><span>${sw("perPerson")}</span><input type="number" min="0" max="8" value=${String(g.maxFleets)} disabled=${!editable} onInput=${(e) => setFleets(i, e.target.value)} /><span>${sw("fleetsUnit")}</span></label>
      <label class="check"><input type="checkbox" checked=${g.allow.includes("ask_agents")} disabled=${!editable} onChange=${(e) => setCap(i, "ask_agents", e.target.checked)} /> ${sw("capAsk")}</label>
      <label class="check"><input type="checkbox" checked=${g.allow.includes("publish_agents")} disabled=${!editable} onChange=${(e) => setCap(i, "publish_agents", e.target.checked)} /> ${sw("capPublish")}</label>
      ${editable ? html`<button type="button" class="btn btn-sm btn-ghost" onClick=${() => setGroups(groups.filter((_, j) => j !== i))}>${sw("remove")}</button>` : null}</li>`)}</ul>`
      : html`<p class="note">${sw("noGroups")}</p>`}
    ${editable ? html`<details class="s-ui-disclosure hub-join-bydn" open=${dnOpen} onToggle=${(e) => setDnOpen(e.target.open)}><summary>${sw("byDn")}</summary>
      <form class="hub-step-form" onSubmit=${async (e) => { e.preventDefault(); if (dn.trim() && await addResolved(dn.trim())) setDn(""); }}>
        <label class="field"><span>${sw("dnLabel")}</span><input value=${dn} autocomplete="off" spellcheck=${false} onInput=${(e) => setDn(e.target.value)} /></label>
        <button type="submit" class="btn btn-sm" disabled=${!dn.trim()}>${sw("dnAdd")}</button></form></details>` : null}
    ${msg ? html`<p class=${msg.err ? "err" : "note"} role=${msg.err ? "alert" : "status"}>${msg.text}</p>` : null}
    ${changed && editable ? html`<div class="hub-join-preview" aria-live="polite">${!preview || preview.loading ? html`<p class="note" aria-busy="true">${sw("previewing")}</p>`
      : !preview.ok ? html`<p class="note" role="status">${sw(preview.code === "conflict" ? "conflict" : "failed")}</p>`
      : html`${pv.adminLosesChat ? html`<p class="err" role="alert">${sw("adminLosesChat")}</p>` : null}
        ${(pv.losingActions || []).length ? html`<p class="note"><b>${sw("losing")}</b>: ${pv.losingActions.map((r) => r.name || r.login || r.personId).join(", ")}</p>` : null}
        ${(pv.suspendedOnSave || []).length ? html`<p class="note"><b>${sw("suspended")}</b>: ${pv.suspendedOnSave.map((r) => r.label || r.id).join(", ")}</p>` : null}
        ${!(pv.losingActions || []).length && !(pv.suspendedOnSave || []).length && !pv.adminLosesChat ? html`<p class="note">${sw("noImpact")}</p>` : null}
        <div class="field-row"><button type="button" class="btn btn-primary" disabled=${saving} onClick=${save}>${saving ? sw("saving") : sw("save")}</button></div>`}</div>` : null}
  </div>`;
}

/**
 * The card (spec 1.2): first on Administration. Step 1 is the existing switch (its state and writes stay the caller's);
 * step 2 is done from the saved policy or a live join code, read here again whenever step 2 or B2's slot changes something;
 * step 3 waits for both. `groups`: the session offers group permissions (else step 2 cannot be edited here).
 */
export function HubJoinCard({ view, busy = false, error = null, onToggle, onRetry, groups = false, features = [], client = hubClient(), webOrigin, children } = {}) {
  const [policy, setPolicy] = useState(null), [codes, setCodes] = useState(null), [tick, setTick] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (groups && typeof client.groupPolicy === "function") client.groupPolicy().then((r) => { if (live.current) setPolicy(r && r.ok ? r.policy : null); }, () => {});
    if (typeof client.enrolmentCodes === "function") Promise.resolve(client.enrolmentCodes()).then((r) => { if (live.current) setCodes(r && r.ok && Array.isArray(r.codes) ? r.codes : null); }, () => {});
  }, [groups, tick]);
  const changed = () => setTick((n) => n + 1);
  const s1 = !!view && view.enabled === true, s2 = step2Done(policy, codes);
  const origin = webOrigin || (typeof location !== "undefined" ? location.origin : "");
  const mark = (done) => done ? html` <span class="tag ok">${sw("done")}</span>` : null;
  return html`<section class="card hub-company-join hub-join-card" data-entry="let-colleagues-join"><h3>${sw("title")}</h3>
    <p class="note">${sw("lead")}</p>
    ${error ? html`<p class="err" role="alert">${error}${onRetry ? html` <button type="button" class="btn btn-sm btn-ghost" onClick=${onRetry}>↻</button>` : null}</p>` : null}
    <ol class="hub-steps hub-join-steps">
      <li class=${s1 ? "done" : "now"} data-step="1"><div class="hub-step-body"><span><b>${sw("step1")}${mark(s1)}</b></span>
        ${view ? html`<label class="check"><input type="checkbox" role="switch" class="s-ui-toggle" checked=${view.enabled} disabled=${busy || !!error} onChange=${(e) => onToggle?.(e.target.checked)} /><span>${sw("step1Switch")}</span></label>` : null}</div></li>
      <li class=${s2 ? "done" : s1 ? "now" : ""} data-step="2"><div class="hub-step-body"><span><b>${sw("step2")}${mark(s2)}</b><small class="note">${sw("step2Hint")} ${features.includes("enrolment-code-v1") ? sw("step2Code") : ""}</small></span>
        ${groups ? html`<${JoinStep2} client=${client} onSaved=${changed} />` : html`<p class="note" role="status">${sw("unsupported")}</p>`}</div></li>
      <${JoinStep3} webOrigin=${origin} step1=${s1} step2=${s2} features=${features} client=${client} onChanged=${changed} />
    </ol>
    ${view && view.enabled && view.companyLink ? html`<details class="s-ui-disclosure hub-join-advanced"><summary>${sw("advanced")}</summary><div class="s-disclosure-body"><p class="note">${sw("advancedHint")}</p>
      <label class="field"><span>${sw("advanced")}</span><textarea rows="4" readonly value=${view.companyLink} /></label></div></details>` : null}
    ${children}
  </section>`;
}

