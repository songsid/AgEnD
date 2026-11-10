// The Session menu (#1018; once in the retired shell.js): who is signed in on this device, its role, and signing out.
// AGEND-138 (#3486): the other signed-in devices are not listed here any more — Settings → Devices has the full list (and
// "Sign out everywhere"), so an admin gets a "Manage devices" link to it. A guest or read-only session has no Settings, so
// its own "Sign out everywhere" (its account's devices) stays here.
// It reads /auth/session when the page starts and each time the menu is opened — a person's action, not a timer.
import { html, useEffect, useRef, useState } from "./app-html.js";
import { Icon } from "./ui-icons.js";
import { t, lang } from "./app-i18n.js";
import { AuthorizeChip, useWebAuthorization } from "./web-authorize.js";
import { roleName } from "./device-roles.js";             // its own file: a retained older web-authorize.js has no roleName (PR #3553 review)

async function getJson(url) {
  try {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const clock = (ms) => new Date(ms).toLocaleTimeString(lang() === "zh-TW" ? "zh-TW" : undefined, { hour: "2-digit", minute: "2-digit" });
const span = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 90 ? `${Math.round(m / 60)} h` : `${m} min`; };

export function SessionMenu() {
  const [me, setMe] = useState(undefined);         // undefined: not read yet; null: signed out
  const [others, setOthers] = useState(0);           // a non-admin session's other devices (its account's): all it can end here
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const auth = useWebAuthorization();                // AGEND-138: the role line below (the chip shares this one read)
  const btn = useRef(null), pop = useRef(null);
  async function refresh() {
    const m = await getJson("/auth/session");
    setMe(m);
    const s = m && m.tier !== "admin" ? await getJson("/auth/sessions") : null;
    setOthers(s && Array.isArray(s.sessions) ? s.sessions.filter((x) => !x.current).length : 0);
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
  return html`<div class="session">
    <button ref=${btn} type="button" class="side-row" aria-haspopup="dialog" aria-expanded=${open ? "true" : "false"}
      onClick=${() => { const next = !open; setOpen(next); if (next) refresh(); }}>
      <span class=${`dot${me ? " ok" : ""}`} aria-hidden="true"></span><span class="grow">${label}</span>${me ? html`<span class="meta">${me.label}</span>` : null}</button>
    ${open ? html`<div data-trust="session" ref=${pop} class="pop" role="dialog" aria-label=${t("app.session")} onKeyDown=${onKey}>
      ${!me ? html`<h3>${t("app.signedOut")}</h3><a class="btn" href=${`/signin?next=${encodeURIComponent(location.pathname)}`}>${t("app.signIn")}</a>` : html`
        <h3>${t("app.signedIn")} · ${me.label}</h3>
        <p class="sub">${t("app.expires", clock(me.expiresAt), span(me.idleMs))}</p>
        ${me.tier === "guest" || me.tier === "read" || (me.tier === "admin" && auth.st) ? html`<p class="role" data-role=${me.tier === "admin" ? (auth.st.state === "verified" ? "owner" : "admin") : me.tier}><span class="sub">${t("webauth.role")}</span> <strong>${roleName(me.tier, !!auth.st && auth.st.state === "verified")}</strong></p>` : null}
        <${AuthorizeChip} />
        <div class="row">
          <button type="button" class="btn" onClick=${() => act("POST", "/auth/logout", () => { location.href = "/signin"; })}><${Icon} name="user" size=${16} />${t("app.signOut")}</button>
          ${me.tier === "admin" ? html`<a class="btn" id="manageDevices" href="/settings/access">${t("app.manageDevices")}</a>`
            : others > 0 ? html`<button type="button" class="btn danger" onClick=${() => act("DELETE", "/auth/sessions", () => { location.href = "/signin"; })}>${t("app.signOutAll")}</button>` : null}
        </div>`}
      ${error ? html`<p class="err" role="alert">${t("app.failed")}</p>` : null}
    </div>` : null}
  </div>`;
}
