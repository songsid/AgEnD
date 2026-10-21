// #2348 (on #1920): Settings → Access & security → Guests. An admin chooses who may sign in as a guest and which
// agents each of them sees — people AgEnD has seen in chat (GET /api/settings/guests/people) — and may send one of them
// a sign-in code by DM. The switches (guest sign-in, guests may chat) and the grants are one draft, staged on every edit
// as PUT /api/settings/fleet/web { guests } (the shell's sticky bar is this section's Save; the server judges what
// waits for a fleet admin: a new person or a new agent does, taking away applies at once). Send sign-in code and Sign
// out are actions: they run at once, outside Save. Before any grant is saved the fleet uses #1920's derived access;
// "Start from today's guests" stages each guest's current reach as a grant.
//
// The shell's contract (agreed with web-claude, #2347): ctx.stage(key, { label, impact, request, count, invalid?,
// onResult }) on every edit, ctx.unstage(key) when the draft is the saved state, ctx.draftEpoch (Discard / after a Save:
// reset from ctx.fleet), ctx.readOnly (the public link: controls disabled, actions hidden), `s-dirty` on edited rows.
import { html, useEffect, useMemo, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { api } from "./settings-confirm.js";
import { DEFAULT_SCHEMA, impactOf } from "./settings-model.js";
import "./settings-strings.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
const PLATFORMS = { discord: "Discord", telegram: "Telegram" };
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const sameList = (a, b) => (a || []).length === (b || []).length && (a || []).every((n) => (b || []).includes(n));
const accountKey = (g) => `${g.adapterId}:${g.userId}`;
const copyGrants = (m) => { const out = {}; for (const [k, v] of Object.entries(m || {})) if (v && Array.isArray(v.instances)) out[k] = { ...(v.name ? { name: v.name } : {}), instances: [...v.instances] }; return out; };
/** The saved state, from the fleet's config: `grants` null while the fleet still uses #1920's derived access. */
export function savedGuests(fleet) {
  const g = (fleet && fleet.web && fleet.web.guests) || {};
  return { enabled: g.enabled === true, chat: g.chat !== false, grants: g.grants ? copyGrants(g.grants) : null };
}
const sameGrant = (a, b) => !!a && !!b && (a.name || "") === (b.name || "") && sameList(a.instances, b.instances);

/**
 * What changed against the saved state, as the PUT /api/settings/fleet/web body's `guests` (null: nothing), and how
 * many things changed (the nav badge). A grant is sent whole; a removed one is null.
 */
export function guestsBody(original, f) {
  const out = {};
  let count = 0;
  if (f.enabled !== original.enabled) { out.enabled = f.enabled ? true : null; count++; }     // off is the default
  if (f.chat !== original.chat) { out.chat = f.chat ? null : false; count++; }                // on is the default
  if (f.grants) {
    const was = original.grants || {}, diff = {};
    for (const k of new Set([...Object.keys(was), ...Object.keys(f.grants)])) {
      const a = own(was, k) ? was[k] : undefined, b = own(f.grants, k) ? f.grants[k] : undefined;
      if (a && b && sameGrant(a, b)) continue;
      diff[k] = b ? { ...(b.name ? { name: b.name } : {}), instances: [...b.instances] } : null;
      count++;
    }
    // #2365 review: turning grants on is a change by itself, even with no one in them yet (default deny): `grants: {}`.
    if (Object.keys(diff).length || !original.grants) out.grants = diff;
    if (!original.grants && !Object.keys(diff).length) count++;
  }
  return Object.keys(out).length ? { body: out, count } : null;
}

function Names({ id, all, value, wrote = [], onChange }) {
  const chosen = new Set(value || []);
  return html`<div class="guest-names" id=${id} role="group">${all.map((n) => html`<label key=${n} class="check guest-name">
    <input type="checkbox" checked=${chosen.has(n)} onChange=${(e) => { const s = new Set(chosen); if (e.target.checked) s.add(n); else s.delete(n); onChange(all.filter((x) => s.has(x))); }} />
    <span>${n}${wrote.includes(n) ? html` <span class="note">${tn("grantsWroteHere")}</span>` : null}</span></label>`)}</div>`;
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const COOLDOWN_MS = 60_000;

/** A draft as staged (#2365 review: carried in the staged change, so leaving the section and coming back keeps it). */
const cloneDraft = (d) => ({ enabled: !!d.enabled, chat: d.chat !== false, grants: d.grants ? copyGrants(d.grants) : null });

export function GuestsSection({ ctx, staged }) {
  const readOnly = !!ctx.readOnly;
  const [original, setOriginal] = useState(() => savedGuests(ctx.fleet));
  // A draft already staged (this section was left with unsaved changes, and is shown again): pick it up, never drop it.
  const prior = (staged && typeof staged.get === "function" && staged.get("guests")) || (ctx.staged && typeof ctx.staged.get === "function" && ctx.staged.get("guests")) || null;
  const [f, setF] = useState(() => (prior && prior.draft ? cloneDraft(prior.draft) : { ...original, grants: original.grants ? copyGrants(original.grants) : null }));
  const [overview, setOverview] = useState(null), [failed, setFailed] = useState(false);
  const [people, setPeople] = useState(null), [query, setQuery] = useState(""), [editing, setEditing] = useState(null);
  const [sendState, setSendState] = useState({}), [now, setNow] = useState(() => Date.now());
  const [status, setStatus] = useState(null);                 // { kind: "waiting" } | { kind: "failed", error }
  const load = async () => {
    let r = null;
    try { r = await api("/api/settings/guests"); } catch { r = null; }
    if (r && r.ok && r.body) { setOverview(r.body); setFailed(false); } else setFailed(true);
  };
  const loadPeople = async () => {
    let r = null;
    try { r = await api("/api/settings/guests/people"); } catch { r = null; }
    setPeople(r && r.ok && r.body && Array.isArray(r.body.people) ? r.body.people : []);
  };
  useEffect(() => { load(); if (!readOnly) loadPeople(); }, []);
  // Discard, or a Save the shell finished: start again from what fleet.yaml says now. Until the new shell's draftEpoch
  // exists, the current page's Discard and Apply both reload ctx.fleet (a new object): that is the epoch then.
  const epoch = ctx.draftEpoch !== undefined ? ctx.draftEpoch : ctx.fleet;
  const first = useMemo(() => ({ seen: false }), []);
  useEffect(() => {
    if (!first.seen) { first.seen = true; return; }
    const o = savedGuests(ctx.fleet);
    setOriginal(o); setF({ ...o, grants: o.grants ? copyGrants(o.grants) : null }); setEditing(null); setStatus(null);
    load();
  }, [epoch]);
  // A cooldown on screen counts down.
  useEffect(() => {
    if (!Object.values(sendState).some((s) => s && s.until > Date.now())) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sendState]);

  const empty = f.grants ? Object.entries(f.grants).find(([, g]) => !g.instances.length) : null;
  // Stage on every edit: the shell's bar is this section's Save.
  useEffect(() => {
    const diff = guestsBody(original, f);
    if (!diff) { ctx.unstage("guests"); return; }
    ctx.stage("guests", {
      label: tn("guestsTitle"), impact: impactOf(ctx.schema || DEFAULT_SCHEMA, "web.guests"), count: diff.count, draft: cloneDraft(f),
      request: { method: "PUT", url: "/api/settings/fleet/web", body: { guests: diff.body } },
      ...(empty ? { invalid: tn("grantsNoAgents") } : {}),
      onResult: (outcome) => {
        if (!outcome || outcome.status === "applied") { setStatus(null); load(); }
        else if (outcome.status === "waiting") setStatus({ kind: "waiting" });
        else setStatus({ kind: "failed", error: outcome.error || "" });
      },
    }, true);
  }, [f, original]);

  const set = (patch) => { setStatus(null); setF((x) => ({ ...x, ...patch })); };
  const setGrant = (k, grant) => { setStatus(null); setF((x) => { const g = { ...(x.grants || {}) }; if (grant) g[k] = grant; else delete g[k]; return { ...x, grants: g }; }); };
  const guests = (overview && overview.guests) || [];
  const instances = (overview && overview.instances) || [];
  const who = (k) => {
    const g = guests.find((x) => accountKey(x) === k), p = (people || []).find((x) => accountKey(x) === k);
    const grant = (f.grants && f.grants[k]) || (original.grants && original.grants[k]);
    const at = k.indexOf(":");
    return { key: k, adapterId: k.slice(0, at), userId: k.slice(at + 1), name: (p && p.name) || (g && g.name) || (grant && grant.name) || k.slice(at + 1),
      platform: (g && g.platform) || (p && p.platform) || "", username: p && p.username, wrote: (p && p.instances) || [], guest: g };
  };
  // "Start from today's guests": each guest's current reach, as a grant (staged like any edit).
  const convert = () => {
    const grants = {};
    for (const g of guests) if (g.scope && g.scope.length) grants[accountKey(g)] = { ...(g.name ? { name: g.name } : {}), instances: [...g.scope] };
    set({ grants });
  };
  const signOut = async (person) => {
    const yes = await confirmDialog({ title: tn("guestSignOutTitle"), message: tn("guestSignOutConfirm", person.name), confirmLabel: tn("guestSignOut"), danger: true });
    if (!yes) return;
    let r = null;
    try { r = await api("/api/settings/guests/revoke", { method: "POST", body: JSON.stringify({ adapterId: person.adapterId, userId: person.userId }) }); } catch { r = null; }
    if (r && r.ok) { toast(tn(r.body && r.body.durable === false ? "guestSignedOutNotDurable" : "guestSignedOut", person.name)); load(); }
    else toast(tn("guestSignOutFailed"), false);
  };
  const sendCode = async (person) => {
    setSendState((s) => ({ ...s, [person.key]: { sending: true } }));
    let r = null;
    try { r = await api("/api/settings/guests/send-code", { method: "POST", body: JSON.stringify({ adapterId: person.adapterId, userId: person.userId }) }); } catch { r = null; }
    const b = (r && r.body) || {};
    const until = b.outcome === "sent" ? Date.now() + COOLDOWN_MS : b.outcome === "wait" ? Date.now() + (b.retryAfterMs || COOLDOWN_MS) : 0;
    setSendState((s) => ({ ...s, [person.key]: { result: { ...b, at: Date.now() }, until } }));
    setNow(Date.now());
    if (b.outcome === "wait") toast(tn("grantsWait"), false);
    else if (b.outcome === "admin_limit") toast(tn("grantsAdminLimit"), false);
    else if (b.outcome !== "sent" && b.outcome !== "dm_failed") toast(tn("grantsCodeFailed", b.error || b.outcome || "?"), false);
    load();
  };
  /** The state pill: what happened last with this person's code, or whether they are signed in. */
  const pill = (person) => {
    const mine = sendState[person.key];
    // #2365 review (P3): the time it was sent, captured once — never "now" on every render.
    const code = (mine && mine.result && mine.result.outcome) ? mine.result : person.guest && person.guest.code;
    if (code && code.outcome === "dm_failed") {
      const text = code.platform === "telegram" && code.startUrl ? tn("grantsDmFailedTg", person.name, code.startUrl)
        : code.platform === "discord" && /cannot send messages/i.test(code.reason || "") ? tn("grantsDmFailedDiscord", person.name)
        : tn("grantsDmFailed", person.name, code.reason || "");
      return html`<span class="g-state warn" role="status">${text}</span>`;
    }
    if (code && code.outcome === "sent" && code.expiresAt && code.expiresAt > now) return html`<span class="g-state sent">${tn("grantsSent", clock(code.at || now), clock(code.expiresAt))}</span>`;
    const g = person.guest;
    return g && (g.sessions || g.devices) ? html`<span class="g-state on">${tn("grantsSignedIn", g.devices || g.sessions)}</span>` : html`<span class="g-state">${tn("grantsNotSignedIn")}</span>`;
  };

  const rows = f.grants ? [...new Set([...Object.keys(f.grants), ...Object.keys(original.grants || {})])] : [];
  const q = query.trim().toLowerCase();
  const candidates = (people || []).filter((p) => !(f.grants && own(f.grants, accountKey(p))))
    .filter((p) => !q || [p.name, p.username, p.userId].some((x) => typeof x === "string" && x.toLowerCase().includes(q))).slice(0, 8);

  return html`<section class="card s-guests" id="guests"><h3>${tn("guestsTitle")}</h3>
    <p class="note">${tn("grantsHint")}</p>
    <fieldset class="s-guest-fields" disabled=${readOnly}>
      <label class=${`check${f.enabled !== original.enabled ? " s-dirty" : ""}`}><input id="guestsEnabled" type="checkbox" checked=${f.enabled} onChange=${(e) => set({ enabled: e.target.checked })} /><span>${tn("guestsEnabled")}</span></label>
      <p class="note">${tn("guestsEnabledHint")}</p>
      <label class=${`check${f.chat !== original.chat ? " s-dirty" : ""}`}><input id="guestsChat" type="checkbox" checked=${f.chat} onChange=${(e) => set({ chat: e.target.checked })} /><span>${tn("guestsChat")}</span></label>
      <p class="note">${tn("guestsChatHint")}</p>
      ${failed ? html`<p class="note" role="status">${tn("guestsLoadFailed")} <button type="button" class="btn btn-sm" onClick=${load}>${t("app.retry")}</button></p>`
        : !overview ? html`<p class="note">${t("app.loading")}</p>` : null}
      ${!f.grants && overview ? html`<div class="g-legacy"><p class="note">${tn("grantsLegacy")}</p>
        ${readOnly ? null : html`<button type="button" class="btn btn-sm" id="grantsConvert" onClick=${convert}>${tn("grantsConvert")}</button>`}</div>` : null}
      <h4>${tn("grantsWithAccess")}</h4>
      ${!rows.length ? html`<p class="note" id="grantsNone">${tn("grantsNoneYet")}</p>` : html`<ul class="guest-list">${rows.map((k) => {
        const person = who(k), draft = f.grants && f.grants[k], saved = original.grants && original.grants[k];
        const removed = !draft, added = !saved, dirty = removed || added || !sameGrant(draft, saved);
        const applied = !!saved && saved.instances.length > 0 && !dirty;
        const ss = sendState[k] || {}, cooling = ss.until && ss.until > now;
        return html`<li key=${k} class=${`guest-row${dirty ? " s-dirty" : ""}${removed ? " g-removed" : ""}`} data-account=${k}>
          <div class="g-head"><span class="g-av" aria-hidden="true">${(person.name || "?").slice(0, 1).toUpperCase()}</span>
            <div class="g-id"><strong>${person.name}</strong> <span class="note">${PLATFORMS[person.platform] || person.platform}${person.username ? ` · @${person.username}` : ""}</span></div>
            ${removed ? html`<span class="g-state">${tn("grantsWillBeRemoved")}</span>` : added ? html`<span class="g-state">${tn("grantsNew")}</span>` : pill(person)}</div>
          <div class="g-chips">${((draft || saved).instances || []).map((n) => html`<span key=${n} class="g-chip">${n}</span>`)}</div>
          ${draft && !draft.instances.length ? html`<p class="note g-error" role="alert">${tn("grantsNoAgents")}</p>` : null}
          ${editing === k && draft ? html`<div class="g-edit"><p class="note">${tn("grantsMaySee", person.name)}</p>
            <${Names} id=${`grant-${k}`} all=${instances} value=${draft.instances} wrote=${person.wrote} onChange=${(list) => setGrant(k, { ...draft, instances: list })} /></div>` : null}
          ${readOnly ? null : html`<div class="guest-actions">
            ${draft ? html`<button type="button" class="btn btn-sm" aria-expanded=${editing === k ? "true" : "false"} onClick=${() => setEditing(editing === k ? null : k)}>${tn("grantsEditAgents")}</button>` : null}
            ${draft ? html`<button type="button" class="btn btn-sm g-send" disabled=${!applied || ss.sending || cooling || !f.enabled || !original.enabled}
              title=${applied ? (person.platform ? tn("grantsPublicLinkNote") : undefined) : tn("grantsSendSaveFirst")} onClick=${() => sendCode(person)}>
              ${ss.sending ? tn("grantsSending") : cooling ? tn("grantsSendAgain", `0:${String(Math.ceil((ss.until - now) / 1000)).padStart(2, "0")}`) : tn("grantsSend")}</button>` : null}
            ${draft ? html`<button type="button" class="btn btn-sm btn-danger" onClick=${() => setGrant(k, null)}>${tn("grantsRemove")}</button>`
              : html`<button type="button" class="btn btn-sm" onClick=${() => setGrant(k, { ...saved })}>${tn("grantsUndoRemove")}</button>`}
            ${person.guest && (person.guest.sessions || person.guest.devices) ? html`<button type="button" class="btn btn-sm" onClick=${() => signOut(person)}>${tn("guestSignOut")}</button>` : null}
          </div>`}
        </li>`;
      })}</ul>`}
      ${readOnly ? null : html`<h4>${tn("grantsAdd")}</h4>
        <input type="search" class="input g-search" id="grantsSearch" value=${query} aria-label=${tn("grantsSearch")} placeholder=${tn("grantsSearch")} onInput=${(e) => setQuery(e.target.value)} />
        ${people === null ? html`<p class="note">${t("app.loading")}</p>` : !candidates.length ? html`<p class="note" id="grantsNoPeople">${tn("grantsNoPeople")}</p>`
          : html`<ul class="g-pick">${candidates.map((p) => html`<li key=${accountKey(p)} class="g-cand" data-account=${accountKey(p)}>
            <span class="g-av" aria-hidden="true">${(p.name || "?").slice(0, 1).toUpperCase()}</span>
            <div class="g-id"><strong>${p.name}</strong> <span class="note">${PLATFORMS[p.platform] || p.platform}${p.username ? ` · @${p.username}` : ""} · ${tn("grantsLastSeen", new Date(p.lastSeen).toLocaleString())}</span>
              ${p.instances && p.instances.length ? html`<div class="note">${tn("grantsWroteTo", p.instances.join(", "))}</div>` : null}</div>
            <button type="button" class="btn btn-sm" onClick=${() => { const k = accountKey(p); setGrant(k, { ...(p.name ? { name: p.name } : {}), instances: instances.filter((n) => (p.instances || []).includes(n)) }); setEditing(k); }}>${tn("grantsChoose")}</button></li>`)}</ul>`}`}
    </fieldset>
    ${status && status.kind === "waiting" ? html`<p class="note" role="status">${tn("grantsWaiting")}</p>` : null}
    ${status && status.kind === "failed" ? html`<p class="note g-error" role="alert">${tn("grantsSaveFailed", status.error)}</p>` : null}
  </section>`;
}

/** The current Settings page's name for it (panel-settings.js), until the new shell mounts GuestsSection directly. */
export const GuestsCard = GuestsSection;

/**
 * #2347 search: this section's entries, in the registry's shape (web-claude's settings-registry.js merges them in when it
 * lands): id, section, card, label, the words a search finds it by, and the config key.
 */
export const GUESTS_SETTINGS = [
  { id: "guests.enabled", section: "access", card: "guests", key: "web.guests.enabled",
    label: { en: "Guest sign-in", "zh-TW": "訪客登入" }, words: { en: ["guest", "sign in", "visitor", "share"], "zh-TW": ["訪客", "登入", "分享"] } },
  { id: "guests.chat", section: "access", card: "guests", key: "web.guests.chat",
    label: { en: "Guests may chat", "zh-TW": "訪客可以聊天" }, words: { en: ["guest", "chat", "read-only"], "zh-TW": ["訪客", "聊天", "唯讀"] } },
  { id: "guests.grants", section: "access", card: "guests", key: "web.guests.grants",
    label: { en: "People with access", "zh-TW": "有存取權的人" }, words: { en: ["guest", "grant", "access", "person", "user", "agents", "who can see"], "zh-TW": ["訪客", "授權", "存取", "使用者", "誰可以看"] } },
  { id: "guests.send-code", section: "access", card: "guests",
    label: { en: "Send sign-in code", "zh-TW": "傳送登入碼" }, words: { en: ["code", "sign-in code", "invite", "token", "DM"], "zh-TW": ["登入碼", "邀請", "私訊"] } },
];
