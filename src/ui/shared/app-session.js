// The Session menu (from shell.js, #1018): who is signed in on this device, the other signed-in devices, and signing
// out. Device labels come from other browsers' User-Agents, so they are only ever rendered as text.
// It reads /auth/session when the page starts and each time the menu is opened — a person's action, not a timer.
import { html, useEffect, useRef, useState } from "./app-html.js";
import { Icon } from "./ui-icons.js";
import { t, lang } from "./app-i18n.js";

async function getJson(url) {
  try {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const clock = (ms) => new Date(ms).toLocaleTimeString(lang() === "zh-TW" ? "zh-TW" : undefined, { hour: "2-digit", minute: "2-digit" });
const span = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 90 ? `${Math.round(m / 60)} h` : `${m} min`; };
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? t("app.justNow") : m < 90 ? t("app.minAgo", m) : t("app.hrAgo", Math.round(m / 60)); };

export function SessionMenu() {
  const [me, setMe] = useState(undefined);         // undefined: not read yet; null: signed out
  const [sessions, setSessions] = useState(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const btn = useRef(null), pop = useRef(null);
  async function refresh() {
    const m = await getJson("/auth/session");
    setMe(m);
    const s = m ? await getJson("/auth/sessions") : null;
    setSessions(s && s.sessions ? s.sessions : null);
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => { if (pop.current && !pop.current.contains(e.target) && !btn.current.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  async function act(method, url, after) {
    setError(false);
    try {
      const r = await fetch(url, { method, credentials: "same-origin" });
      if (!r.ok) throw new Error(String(r.status));
      after();
    } catch { setError(true); }
  }
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current && btn.current.focus(); } };
  const label = me ? t("app.session") : t("app.signIn");
  const rows = sessions || [];
  return html`<div class="session">
    <button ref=${btn} type="button" class="side-row" aria-haspopup="dialog" aria-expanded=${open ? "true" : "false"}
      onClick=${() => { const next = !open; setOpen(next); if (next) refresh(); }}>
      <span class=${`dot${me ? " ok" : ""}`} aria-hidden="true"></span><span class="grow">${label}</span>${me ? html`<span class="meta">${me.label}</span>` : null}</button>
    ${open ? html`<div ref=${pop} class="pop" role="dialog" aria-label=${t("app.session")} onKeyDown=${onKey}>
      ${!me ? html`<h3>${t("app.signedOut")}</h3><a class="btn" href=${`/signin?next=${encodeURIComponent(location.pathname)}`}>${t("app.signIn")}</a>` : html`
        <h3>${t("app.signedIn")} · ${me.label}</h3>
        <p class="sub">${t("app.expires", clock(me.expiresAt), span(me.idleMs))}</p>
        ${rows.length > 1 ? html`<h3>${t("app.devices")}</h3><ul class="devices">${rows.map(s => html`<li key=${s.handle}>
          <span class="grow"><span class="name">${s.label}${s.current ? ` · ${t("app.thisDevice")}` : ""}</span><span class="when">${t("app.lastActive", ago(s.lastSeen))}</span></span>
          ${s.current ? null : html`<button type="button" class="btn btn-sm danger" onClick=${() => act("DELETE", `/auth/sessions/${encodeURIComponent(s.handle)}`, refresh)}>${t("app.signOut")}</button>`}</li>`)}</ul>` : null}
        <div class="row">
          <button type="button" class="btn" onClick=${() => act("POST", "/auth/logout", () => { location.href = "/signin"; })}><${Icon} name="user" size=${16} />${t("app.signOut")}</button>
          ${rows.length > 1 ? html`<button type="button" class="btn danger" onClick=${() => act("DELETE", "/auth/sessions", () => { location.href = "/signin"; })}>${t("app.signOutAll")}</button>` : null}
        </div>`}
      ${error ? html`<p class="err" role="alert">${t("app.failed")}</p>` : null}
    </div>` : null}
  </div>`;
}
