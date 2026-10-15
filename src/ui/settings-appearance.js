// #1629 r4 §3: Settings → Appearance — the person's own custom CSS (owner CSS): the editor, keep-or-revert, earlier
// versions, the pictures and fonts it may name, and this device's off switch. Settings itself is always drawn stock
// (owner-css.js removes the link here), so a stylesheet that hides things can always be fixed from this page.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { useStore } from "/assets/app-store.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { ownerCssOffHere, ownerCssTrial, safeMode, setOwnerCssActive, setOwnerCssOffHere, startOwnerCssTrial } from "/assets/owner-css.js";
import { setThemesShown, themesStore } from "/assets/app-themes.js";
import "./settings-strings.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
const short = (sha) => (sha ? sha.slice(0, 8) : "");
const kib = (n) => `${Math.max(1, Math.round(n / 1024))} KiB`;

async function call(path, init) {
  let res;
  try { res = await fetch(path, { credentials: "same-origin", ...init }); } catch { return { ok: false, status: 0, body: null }; }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, body };
}
const postJson = (path, body) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Why the host refused a text, in the person's words. */
function refusal(body) {
  const problem = body && body.error, detail = body && body.detail;
  const known = ["at_rule", "url", "unknown_asset", "function", "property", "script_scheme", "too_large", "malformed", "nul", "unserialisable",
    "asset_type", "asset_unreadable", "asset_quota", "asset_in_use", "owner_css_read_only", "owner_css_needs_a_signed_in_person"];
  return known.includes(problem) ? tn(`cssError_${problem}`, detail || "") : tn("cssError_other", problem || "?");
}

export function AppearanceSection() {
  const publicLink = typeof document !== "undefined" && document.body && document.body.dataset.publicLink === "1";
  if (publicLink) return html`<section class="card s-appearance"><h3>${tn("cssTitle")}</h3><p class="sub">${tn("cssPublicLink")}</p></section>`;
  return html`<${ThemesCard} /><${OwnerCssCard} /><${DeviceCard} />`;
}

/** #1629 r2 (d): whether this person's screens show agents' themes (and, as they come, effects) — synced. */
function ThemesCard() {
  const s = useStore(themesStore);
  return html`<section class="card s-appearance s-synced"><h3>${tn("themesTitle")}</h3>
    <label class="check"><input type="checkbox" checked=${s.shown} disabled=${safeMode()} onChange=${(e) => setThemesShown(e.target.checked)} />
      <span>${tn("themesShow")}</span></label>
    <p class="sub">${safeMode() ? tn("themesSafeMode") : tn("themesShowLead")}</p>
  </section>`;
}

function OwnerCssCard() {
  const [state, setState] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trial = useStore(ownerCssTrial);
  const file = useRef(null);
  const load = async (opts = {}) => {
    const r = await call("/ui/owner-css/state");
    if (!r.ok || !r.body) { setState({ failed: true }); return; }
    setState(r.body);
    if (opts.text !== false) setText(r.body.text || "");
  };
  useEffect(() => { load(); }, []);
  // A trial answered (kept or reverted) changes what is in force: read it again, keeping the editor's text.
  useEffect(() => { if (state) load({ text: false }); }, [trial && trial.sha]);
  if (!state) return html`<section class="card s-appearance"><h3>${tn("cssTitle")}</h3><p class="sub">…</p></section>`;
  if (state.failed) return html`<section class="card s-appearance"><h3>${tn("cssTitle")}</h3><p class="err">${tn("cssLoadFailed")}</p></section>`;

  const save = async () => {
    setBusy(true); setError("");
    const r = await postJson("/ui/owner-css", { text });
    setBusy(false);
    if (!r.ok) { setError(refusal(r.body)); return; }
    startOwnerCssTrial(r.body.trial, r.body.sha, r.body.previous);
    toast(tn("cssTrying"));
    load({ text: false });
  };
  const restore = async (sha) => {
    setBusy(true); setError("");
    const r = await postJson("/ui/owner-css/restore", { sha });
    setBusy(false);
    if (!r.ok) { setError(refusal(r.body)); return; }
    setOwnerCssActive(r.body.active);
    load();
  };
  const addAsset = async () => {
    const f = file.current && file.current.files && file.current.files[0];
    if (!f) return;
    setBusy(true); setError("");
    const r = await call("/ui/owner-css/asset", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f });
    setBusy(false);
    if (file.current) file.current.value = "";
    if (!r.ok) { setError(refusal(r.body)); return; }
    load({ text: false });
  };
  const removeAsset = async (id) => {
    setBusy(true); setError("");
    const r = await call(`/ui/owner-css/asset/${id}`, { method: "DELETE" });
    setBusy(false);
    if (!r.ok) { setError(refusal(r.body)); return; }
    load({ text: false });
  };
  const copyRef = (id) => {
    const ref = `url("asset:${id}")`;
    try { navigator.clipboard.writeText(ref).then(() => toast(tn("cssCopied", ref)), () => toast(ref)); } catch { toast(ref); }
  };
  const inForce = state.active
    ? (state.pending ? tn("cssOnTrial", short(state.active)) : tn("cssInForce", short(state.active)))
    : tn("cssNone");
  const assetBytes = state.assets.reduce((n, a) => n + a.bytes, 0);
  return html`<section class="card s-appearance s-owner-css"><h3>${tn("cssTitle")}</h3>
    <p class="sub">${tn("cssLead")}</p>
    <p class="s-css-status" role="status">${inForce}</p>
    <label class="field"><span class="sr-only">${tn("cssTitle")}</span>
      <textarea class="s-css-text" rows="14" spellcheck=${false} autocapitalize="off" autocomplete="off" value=${text} disabled=${busy}
        onInput=${(e) => setText(e.target.value)}></textarea></label>
    ${error ? html`<p class="err" role="alert">${error}</p>` : null}
    <div class="s-css-actions">
      <button type="button" class="btn btn-primary" disabled=${busy || !text.trim()} onClick=${save}><${Icon} name="check" size=${16} />${tn("cssSave")}</button>
      ${state.active ? html`<button type="button" class="btn" disabled=${busy} onClick=${() => restore(null)}>${tn("cssOff")}</button>` : null}
    </div>
    ${state.versions.length ? html`<details class="s-css-versions"><summary>${tn("cssVersions", state.versions.length)}</summary>
      <ul class="s-css-list">${state.versions.map((v) => html`<li key=${v.sha}>
        <code>${short(v.sha)}</code><span class="muted">${new Date(v.at).toLocaleString()} · ${kib(v.bytes)}</span>
        ${v.sha === state.active ? html`<span class="pill">${tn("cssCurrent")}</span>`
          : html`<button type="button" class="btn btn-sm" disabled=${busy} onClick=${() => restore(v.sha)}>${tn("cssRestore")}</button>`}
      </li>`)}</ul></details>` : null}
    <h4>${tn("cssAssets")}</h4>
    <p class="sub">${tn("cssAssetsLead", state.assets.length, state.limits.maxAssets, kib(assetBytes))}</p>
    ${state.assets.length ? html`<ul class="s-css-list">${state.assets.map((a) => html`<li key=${a.id}>
      <code>${a.id}</code><span class="muted">${a.kind} · ${kib(a.bytes)}</span>
      <button type="button" class="btn btn-sm" onClick=${() => copyRef(a.id)}>${tn("cssAssetCopy")}</button>
      <button type="button" class="btn btn-sm btn-ghost" disabled=${busy} onClick=${() => removeAsset(a.id)}>${tn("cssAssetRemove")}</button>
    </li>`)}</ul>` : null}
    <label class="field"><span>${tn("cssAssetAdd")}</span>
      <input ref=${file} type="file" accept="image/png,image/webp,image/jpeg,image/gif,font/woff2,.woff2" disabled=${busy} onChange=${addAsset} /></label>
  </section>`;
}

function DeviceCard() {
  const [off, setOff] = useState(ownerCssOffHere());
  return html`<section class="card s-appearance s-local"><h3>${tn("cssDeviceTitle")}</h3>
    <label class="check"><input type="checkbox" checked=${off} onChange=${(e) => { setOwnerCssOffHere(e.target.checked); setOff(ownerCssOffHere()); }} />
      <span>${tn("cssDeviceOff")}</span></label>
    <p class="sub">${tn("cssDeviceOffLead")}</p>
    <p class="sub">${tn("cssSafe")}</p>
  </section>`;
}
