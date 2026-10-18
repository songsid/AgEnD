// #1920 phase 3 (P3b-2): Settings → Web → Guests — guest sign-in for people who are not admins. The switches (guest
// sign-in, guests may chat), the agents an open connection's guests may reach, and every guest account: who, on which
// platform, what it reaches now, its sessions and devices, with Sign out (at once) and Narrow (staged with the rest).
// Changes go through Review changes → Apply like every Settings edit: one that widens what guests reach waits for a
// fleet admin's confirmation (the server's settings-change.ts), one that narrows it applies at once.
import { html, useEffect, useMemo, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { api } from "./settings-confirm.js";
import "./settings-strings.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
const PLATFORMS = { discord: "Discord", telegram: "Telegram" };
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const copyLists = (m) => { const out = {}; for (const [k, v] of Object.entries(m || {})) if (Array.isArray(v)) out[k] = [...v]; return out; };
const sameList = (a, b) => (a || []).length === (b || []).length && (a || []).every((n) => (b || []).includes(n));
const accountKey = (g) => `${g.adapterId}:${g.userId}`;

/** What changed against the configuration, as the PUT /api/settings/fleet/web body's `guests` (null: nothing). */
export function guestsBody(original, f) {
  const out = {};
  if (f.enabled !== original.enabled) out.enabled = f.enabled ? true : null;          // off is the default
  if (f.chat !== original.chat) out.chat = f.chat ? null : false;                     // on is the default
  for (const key of ["open_instances", "narrow"]) {
    const was = original[key], now = f[key], diff = {};
    for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
      const a = own(was, k) ? was[k] : undefined, b = own(now, k) ? now[k] : undefined;
      if (a === undefined && b === undefined) continue;
      if (a !== undefined && b !== undefined && sameList(a, b)) continue;
      // open_instances: none named = the entry leaves. narrow: undefined = lifted; [] = narrowed to nothing.
      diff[k] = b === undefined || (key === "open_instances" && !b.length) ? null : [...b];
    }
    if (Object.keys(diff).length) out[key] = diff;
  }
  return Object.keys(out).length ? out : null;
}

function Names({ id, all, value, onChange }) {
  const chosen = new Set(value || []);
  return html`<div class="guest-names" id=${id} role="group">${all.map((n) => html`<label key=${n} class="check guest-name">
    <input type="checkbox" checked=${chosen.has(n)} onChange=${(e) => { const s = new Set(chosen); if (e.target.checked) s.add(n); else s.delete(n); onChange(all.filter((x) => s.has(x))); }} />
    <span>${n}</span></label>`)}</div>`;
}

export function GuestsCard({ ctx, staged, disabled = false }) {
  const g = (ctx.fleet.web && ctx.fleet.web.guests) || {};
  const original = useMemo(() => ({ enabled: g.enabled === true, chat: g.chat !== false, open_instances: copyLists(g.open_instances), narrow: copyLists(g.narrow) }), []);
  const [f, setF] = useState(() => ({ ...original, open_instances: copyLists(original.open_instances), narrow: copyLists(original.narrow) }));
  const [overview, setOverview] = useState(null), [failed, setFailed] = useState(false), [narrowing, setNarrowing] = useState(null), [msg, setMsg] = useState(null);
  const load = async () => {
    let r = null;
    try { r = await api("/api/settings/guests"); } catch { r = null; }
    if (r && r.ok && r.body) { setOverview(r.body); setFailed(false); } else setFailed(true);
  };
  useEffect(() => { load(); }, []);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const setList = (key, k, list) => setF((x) => { const m = { ...x[key] }; if (list === undefined) delete m[k]; else m[k] = list; return { ...x, [key]: m }; });
  const review = () => {
    const body = guestsBody(original, f);
    if (body) ctx.stage("guests", { label: tn("guestsTitle"), impact: "now", request: { method: "PUT", url: "/api/settings/fleet/web", body: { guests: body } } });
    else if (staged.has("guests")) ctx.unstage("guests");
    setMsg(tn("readyApply"));
  };
  const signOut = async (guest) => {
    const yes = await confirmDialog({ title: tn("guestSignOutTitle"), message: tn("guestSignOutConfirm", guest.name), confirmLabel: tn("guestSignOut"), danger: true });
    if (!yes) return;
    let r = null;
    try { r = await api("/api/settings/guests/revoke", { method: "POST", body: JSON.stringify({ adapterId: guest.adapterId, userId: guest.userId }) }); } catch { r = null; }
    if (r && r.ok) { toast(tn(r.body && r.body.durable === false ? "guestSignedOutNotDurable" : "guestSignedOut", guest.name)); load(); }
    else toast(tn("guestSignOutFailed"), false);
  };
  const instances = (overview && overview.instances) || [];
  const open = ((overview && overview.connections) || []).filter((c) => c.mode === "open");
  const guests = (overview && overview.guests) || [];
  const when = (ms) => (typeof ms === "number" ? tn("guestLastActive", new Date(ms).toLocaleString()) : tn("guestNotSignedIn"));
  return html`<section class="card s-guests"><h3>${tn("guestsTitle")}</h3>
    <p class="note">${tn("guestsHint")}</p>
    <fieldset class="s-guest-fields" disabled=${disabled}>
      <label class="check"><input id="guestsEnabled" type="checkbox" checked=${f.enabled} onChange=${(e) => set({ enabled: e.target.checked })} /><span>${tn("guestsEnabled")}</span></label>
      <p class="note">${tn("guestsEnabledHint")}</p>
      <label class="check"><input id="guestsChat" type="checkbox" checked=${f.chat} onChange=${(e) => set({ chat: e.target.checked })} /><span>${tn("guestsChat")}</span></label>
      <p class="note">${tn("guestsChatHint")}</p>
      ${open.map((c) => html`<div key=${c.id} class="field guest-open"><span class="label">${tn("guestsOpenFor", c.id, PLATFORMS[c.type] || c.type)}</span>
        <p class="note">${tn("guestsOpenHint")}</p>
        <${Names} id=${`guestsOpen-${c.id}`} all=${instances} value=${own(f.open_instances, c.id) ? f.open_instances[c.id] : []} onChange=${(list) => setList("open_instances", c.id, list)} /></div>`)}
      <h4>${tn("guestsList")}</h4>
      ${failed ? html`<p class="note" role="status">${tn("guestsLoadFailed")} <button type="button" class="btn btn-sm" onClick=${load}>${t("app.retry")}</button></p>`
        : !overview ? html`<p class="note">${t("app.loading")}</p>`
        : !guests.length ? html`<p class="note" id="guestsNone">${tn("guestsNone")}</p>`
        : html`<ul class="guest-list">${guests.map((guest) => {
          const k = accountKey(guest), narrowed = own(f.narrow, k) ? f.narrow[k] : undefined;
          return html`<li key=${k} class="guest-row" data-account=${k}>
            <div class="guest-who"><strong>${guest.name}</strong> <span class="note">${PLATFORMS[guest.platform] || guest.platform} · ${guest.userId}</span></div>
            <div class="note guest-facts">${tn("guestFacts", guest.scope.length, guest.sessions, guest.devices)} · ${when(guest.lastSeen)}</div>
            <div class="note guest-narrow">${narrowed === undefined ? tn("guestNotNarrowed") : tn("guestNarrowedTo", narrowed.length ? narrowed.join(", ") : tn("guestNothing"))}</div>
            <div class="guest-actions">
              <button type="button" class="btn btn-sm" aria-expanded=${narrowing === k ? "true" : "false"} onClick=${() => setNarrowing(narrowing === k ? null : k)}>${tn("guestNarrow")}</button>
              ${narrowed !== undefined ? html`<button type="button" class="btn btn-sm" onClick=${() => setList("narrow", k, undefined)}>${tn("guestNarrowLift")}</button>` : null}
              ${guest.sessions || guest.devices ? html`<button type="button" class="btn btn-sm btn-danger" onClick=${() => signOut(guest)}>${tn("guestSignOut")}</button>` : null}
            </div>
            ${narrowing === k ? html`<div class="guest-narrow-edit"><p class="note">${tn("guestNarrowHint")}</p>
              <${Names} id=${`guestNarrow-${k}`} all=${instances} value=${narrowed === undefined ? guest.scope : narrowed} onChange=${(list) => setList("narrow", k, list)} /></div>` : null}
          </li>`;
        })}</ul>`}
    </fieldset>
    <div class="save-row"><button type="button" class="btn btn-primary" id="guestsReview" disabled=${disabled} onClick=${review}>${tn("guestsReview")}</button>
      ${msg ? html`<span class="note" role="status">${msg}</span>` : null}</div>
  </section>`;
}
