// #1629 r4 §4 (r4-5): Settings → Appearance → Mods. A mod is one file that carries a look: an agent's theme with its
// pictures, its card text, widgets, effects, and a person's own CSS. Importing is a person's action in two steps:
// the file is checked whole and its plan shown in full (every part, the custom CSS's whole text) — then only the
// parts the person ticks are applied, all or nothing. Custom CSS from a file is never ticked by default. Installed
// mods can be downloaded again or uninstalled (what they applied stays: Reset and the CSS controls work on it).
// Export builds a file from what is in force now.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { startOwnerCssTrial } from "/assets/owner-css.js";
import { AgentWidget, checkWidget, fleetBinds, instanceBinds } from "/assets/agent-widget.js";
import { CardTitle } from "./settings-learn.js";
import "./settings-strings.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
const kib = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KiB`);

async function call(path, init) {
  let res;
  try { res = await fetch(path, { credentials: "same-origin", ...init }); } catch { return { ok: false, status: 0, body: null }; }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, body, res };
}
const postJson = (path, body) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.className = "offscreen";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
/** Why the host refused, in words (the first problems of a bundle, each with where it is). */
function why(body) {
  if (!body) return tn("modFailed", "?");
  if (Array.isArray(body.problems) && body.problems.length) return body.problems.slice(0, 5).map((p) => `${p.path || "file"}: ${p.problem}`).join("\n");
  return tn("modFailed", body.detail ? `${body.error}: ${body.detail}` : body.error || "?");
}

/** The parts a plan offers, each with its default: everything but custom CSS. */
export function defaultChoice(plan) {
  const c = { theme: false, identity: false, effects: false, ownerCss: false, widgets: {}, replace: false };
  for (const it of plan.items) {
    if (it.part === "theme" || it.part === "identity") c[it.part] = true;
    else if (it.part === "widget") c.widgets[it.slot] = true;
    else if (it.part === "effect") c.effects = true;
    // ownerCss stays false: "read it before turning it on" (r4 §4).
  }
  return c;
}

const COLOR = /^#[0-9a-f]{6}$/;
/** A colour as a swatch (its fill set through the CSSOM — never a style attribute) and its hex code. */
function Swatch({ color }) {
  const ref = useRef(null);
  useLayoutEffect(() => { if (ref.current && ref.current.style && COLOR.test(color)) ref.current.style.setProperty("--sw", color); }, [color]);
  return html`<span class="s-mod-sw"><span class="s-mod-sw-chip" ref=${ref} aria-hidden="true"></span><code>${color}</code></span>`;
}
/** Every field of the checked theme, as it will be applied — nothing left unseen (#1897 review). */
export function ThemeDetail({ theme, pictures, effects }) {
  const th = theme || {};
  const row = (k, v) => html`<div class="s-mod-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const pal = (mode) => {
    const p = th.colors && th.colors[mode];
    return p && Object.keys(p).length ? row(tn(mode === "dark" ? "modColorsDark" : "modColorsLight"), html`<span class="s-mod-sws">${Object.keys(p).map((k) => html`<span key=${k} class="s-mod-sw-item">${k} <${Swatch} color=${p[k]} /></span>`)}</span>`) : null;
  };
  const picOf = (id) => (pictures || []).find((p) => p.id === id);
  const pic = (id, label) => {
    const p = picOf(id);
    return p ? row(label, html`<span class="s-mod-pic"><img src=${`/ui/mods/staged/${p.id}`} alt=${label} loading="lazy" /><span class="muted">${p.path} · ${kib(p.bytes)}</span></span>`) : null;
  };
  return html`<div class="s-mod-theme">
    ${th.accent ? row(tn("modAccent"), html`<${Swatch} color=${th.accent} />`) : null}
    ${pal("light")}${pal("dark")}
    ${th.bubble ? row(tn("modBubble"), `${th.bubble.radius !== undefined ? `${th.bubble.radius}px` : ""}${th.bubble.radius !== undefined && th.bubble.border ? " · " : ""}${th.bubble.border || ""}`) : null}
    ${th.font ? row(tn("modFont"), th.font) : null}
    ${th.workingLabel ? row(tn("modWorkingLabel"), html`<span class="s-mod-text">${th.workingLabel}</span>`) : null}
    ${th.background ? pic(th.background.image, tn("modBackground")) : null}
    ${th.background ? row(tn("modBackgroundFit"), `${th.background.fit} · ${Math.round(th.background.opacity * 100)}%`) : null}
    ${th.avatar ? pic(th.avatar, tn("modAvatar")) : null}
    ${(effects || []).map((e, i) => html`<div key=${i}>${row(tn("modPlacesEffect"), html`<span><code>${e.effect}</code>${e.id ? html` <span class="muted">${e.id.slice(0, 8)}</span>` : null}${Object.keys(e.params || {}).length ? html` · <code>${JSON.stringify(e.params)}</code>` : null}</span>`)}</div>`)}
    <details class="s-mod-raw"><summary>${tn("modAllFields")}</summary><pre class="s-mod-css-text">${JSON.stringify(th, null, 2)}</pre></details>
  </div>`;
}

function PlanItem({ it, choice, setChoice, binds, fleet }) {
  const tick = (label, on, set) => html`<label class="check s-mod-tick"><input type="checkbox" checked=${on} onChange=${(e) => set(e.target.checked)} /><span>${label}</span></label>`;
  if (it.part === "theme") {
    return html`<li class="s-mod-item">${tick(tn("modPartTheme"), choice.theme, (v) => setChoice({ ...choice, theme: v }))}
      <div class="s-mod-detail"><${ThemeDetail} theme=${it.theme} pictures=${it.pictures} effects=${it.effects} /></div></li>`;
  }
  if (it.part === "identity") {
    return html`<li class="s-mod-item">${tick(tn("modPartIdentity"), choice.identity, (v) => setChoice({ ...choice, identity: v }))}
      <div class="s-mod-detail">${it.tagline ? html`<span class="s-mod-text">${it.tagline}</span>` : null}${it.bio ? html`<span class="s-mod-text">${it.bio}</span>` : null}</div></li>`;
  }
  if (it.part === "widget") {
    const w = checkWidget(it.slot, { spec: it.spec, data: it.data });
    return html`<li class="s-mod-item">${tick(tn(`modPartWidget_${it.slot}`), !!choice.widgets[it.slot], (v) => setChoice({ ...choice, widgets: { ...choice.widgets, [it.slot]: v } }))}
      <div class="s-mod-detail s-mod-widget">${w ? html`<${AgentWidget} slot=${it.slot} widget=${w} binds=${it.slot === "sidebar" ? fleet : binds} />` : null}</div></li>`;
  }
  if (it.part === "effect") {
    return html`<li class="s-mod-item">${tick(tn("modPartEffect", it.title), choice.effects, (v) => setChoice({ ...choice, effects: v }))}
      <div class="s-mod-detail"><span>${kib(it.bytes)} · ${tn("modRegions", it.regions.join(", "))}</span>${it.wants.length ? html`<span>${tn("modWants", it.wants.join(", "))}</span>` : null}</div></li>`;
  }
  if (it.part === "ownerCss") {
    return html`<li class="s-mod-item s-mod-css">${tick(tn("modPartCss"), choice.ownerCss, (v) => setChoice({ ...choice, ownerCss: v }))}
      <p class="s-mod-warn">${tn("modCssWarn")}</p>
      <pre class="s-mod-css-text">${it.text}</pre>
      ${it.assets.length ? html`<p class="sub">${tn("modCssAssets", it.assets.length, kib(it.assets.reduce((n, a) => n + a.bytes, 0)))}</p>` : null}</li>`;
  }
  return null;
}

function Plan({ staged, onDone }) {
  const app = useStore(appStore);
  const plan = staged.plan;
  const [choice, setChoice] = useState(() => defaultChoice(plan));
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toInstance = choice.theme || choice.identity || !!choice.widgets.chat_header || !!choice.widgets.details;
  const names = (app.instances || []).map((i) => i.name);
  const install = async () => {
    setBusy(true); setError("");
    const r = await postJson("/ui/mods/commit", { stage: staged.stage, plan_hash: staged.plan_hash, include: choice, ...(toInstance ? { target } : {}) });
    setBusy(false);
    // The stage this plan shows is gone or no longer this plan (replaced on another device, expired): read again —
    // the page then shows whatever is staged now, with its own, fresh choices (keyed by stage).
    if (!r.ok) { setError(why(r.body)); if (r.status === 404 || (r.body && r.body.error === "plan_changed")) onDone(); return; }
    if (r.body.css) { startOwnerCssTrial(r.body.css.trial, r.body.css.sha, r.body.css.previous); toast(tn("cssTrying")); }
    toast(tn("modInstalled", plan.mod.title));
    onDone();
  };
  const cancel = async () => {
    const r = await postJson("/ui/mods/abort", { stage: staged.stage });
    // Not this stage any more (another device staged a file meanwhile): say so, then show what is staged now.
    if (!r.ok) toast(r.status === 404 ? tn("modStageGone") : why(r.body), false);
    onDone();
  };
  const inst = (app.instances || []).find((i) => i.name === target) || null;
  const binds = inst ? instanceBinds(inst, app.exec && app.exec[inst.name], app.awaiting && Object.prototype.hasOwnProperty.call(app.awaiting, inst.name) ? app.awaiting[inst.name] : null) : {};
  const m = plan.mod;
  return html`<div class="s-mod-plan" role="group" aria-label=${tn("modPlan")}>
    <h4>${m.title} <span class="muted">${m.name} ${m.version}</span></h4>
    ${m.author ? html`<p class="sub">${tn("modAuthor", m.author)}</p>` : null}
    ${m.description ? html`<p class="sub s-mod-text">${m.description}</p>` : null}
    <p class="sub">${tn("modSizeId", kib(m.bytes), m.id.slice(0, 8))}${m.installed ? ` · ${tn("modAlready")}` : ""}</p>
    ${m.replaces ? html`<label class="check"><input type="checkbox" checked=${choice.replace} onChange=${(e) => setChoice({ ...choice, replace: e.target.checked })} /><span>${tn("modReplace", m.replaces.version)}</span></label>` : null}
    <ul class="s-mod-items">${plan.items.map((it, i) => html`<${PlanItem} key=${i} it=${it} choice=${choice} setChoice=${setChoice} binds=${binds} fleet=${fleetBinds(app.instances, app.exec, app.awaiting)} />`)}</ul>
    ${toInstance ? html`<label class="field"><span>${tn("modTarget")}</span>
      <select value=${target} onChange=${(e) => setTarget(e.target.value)}><option value="">${tn("modTargetPick")}</option>${names.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}</select></label>` : null}
    ${toInstance && !target ? html`<p class="sub">${tn("modTargetNeeded")}</p>` : null}
    ${error ? html`<p class="err s-mod-err" role="alert">${error}</p>` : null}
    <div class="s-widget-actions">
      <button type="button" class="btn btn-primary" disabled=${busy || (toInstance && !target) || (m.replaces && !choice.replace)} onClick=${install}><${Icon} name="check" size=${16} />${tn("modInstall")}</button>
      <button type="button" class="btn" disabled=${busy} onClick=${cancel}>${tn("modCancel")}</button>
    </div>
  </div>`;
}

function ExportForm() {
  const app = useStore(appStore);
  const [f, setF] = useState({ instance: "", name: "", version: "1.0.0", title: "", theme: true, identity: true, header: true, details: true, sidebar: false, ownerCss: false });
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const go = async () => {
    setError("");
    const body = { instance: f.instance || undefined, name: f.name, version: f.version, title: f.title,
      include: { theme: f.theme, identity: f.identity, ownerCss: f.ownerCss, widgets: { chat_header: f.header, details: f.details, sidebar: f.sidebar } } };
    let res;
    try { res = await fetch("/ui/mods/export", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
    catch { setError(tn("modFailed", "network")); return; }
    if (!res.ok) { let b = null; try { b = await res.json(); } catch { /* none */ } setError(why(b)); return; }
    download(await res.text(), `${f.name}-${f.version}.agendmod.json`);
    // Effects that aren't this person's to carry stay out of the file (their own claims and shared ones travel).
    const omitted = Number(res.headers && res.headers.get ? res.headers.get("X-AgEnD-Effects-Omitted") : 0);
    if (omitted > 0) toast(tn("modExportOmitted", omitted), false);
  };
  const box = (k, label) => html`<label class="check"><input type="checkbox" checked=${f[k]} onChange=${set(k)} /><span>${label}</span></label>`;
  return html`<details class="s-mod-export"><summary>${tn("modExport")}</summary>
    <p class="sub">${tn("modExportLead")}</p>
    <label class="field"><span>${tn("modExportInstance")}</span><select value=${f.instance} onChange=${set("instance")}><option value="">—</option>${(app.instances || []).map((i) => html`<option key=${i.name} value=${i.name}>${i.name}</option>`)}</select></label>
    <div class="s-mod-boxes">${box("theme", tn("modPartTheme"))}${box("identity", tn("modPartIdentity"))}${box("header", tn("modPartWidget_chat_header"))}${box("details", tn("modPartWidget_details"))}${box("sidebar", tn("modPartWidget_sidebar"))}${box("ownerCss", tn("modPartCss"))}</div>
    <label class="field"><span>${tn("modExportName")}</span><input value=${f.name} placeholder="my-look" onInput=${set("name")} /></label>
    <label class="field"><span>${tn("modExportVersion")}</span><input value=${f.version} onInput=${set("version")} /></label>
    <label class="field"><span>${tn("modExportTitle")}</span><input value=${f.title} onInput=${set("title")} /></label>
    ${error ? html`<p class="err s-mod-err" role="alert">${error}</p>` : null}
    <div class="s-widget-actions"><button type="button" class="btn" disabled=${!f.name || !f.title} onClick=${go}><${Icon} name="download" size=${16} />${tn("modExportGo")}</button></div>
  </details>`;
}

export function ModsCard() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef(null);
  // Only an answer of the expected shape is shown (#1889's lesson): anything else is "couldn't load", never a crash.
  const load = async () => {
    const r = await call("/ui/mods");
    const b = r.ok && r.body && typeof r.body === "object" ? r.body : null;
    const staged = b && b.staged && typeof b.staged === "object" && typeof b.staged.stage === "string" && b.staged.plan && Array.isArray(b.staged.plan.items) ? b.staged : null;
    const proposals = b && Array.isArray(b.proposals) ? b.proposals.filter((p) => p && typeof p.instance === "string" && typeof p.title === "string") : [];
    setState(b && Array.isArray(b.mods) ? { mods: b.mods.filter((m) => m && typeof m.id === "string"), staged, proposals } : { failed: true });
  };
  useEffect(() => { load(); }, []);
  if (!state) return html`<section class="card s-appearance s-mods"><${CardTitle} title=${tn("modsTitle")} topic="mods" /><p class="sub">…</p></section>`;
  if (state.failed) return html`<section class="card s-appearance s-mods"><${CardTitle} title=${tn("modsTitle")} topic="mods" /><p class="err">${tn("modsLoadFailed")}</p></section>`;
  const stage = async () => {
    const f = file.current && file.current.files && file.current.files[0];
    if (!f) return;
    setBusy(true); setError("");
    const r = await call("/ui/mods/stage", { method: "POST", headers: { "Content-Type": "application/json" }, body: f });
    setBusy(false);
    if (file.current) file.current.value = "";
    if (!r.ok) { setError(why(r.body)); return; }
    setState({ ...state, staged: r.body });
  };
  const review = async (p) => {
    const r = await postJson("/ui/mods/proposal/stage", { instance: p.instance });
    if (!r.ok) { setError(why(r.body)); return; }
    setState({ ...state, staged: r.body });
  };
  const dismiss = async (p) => {
    const r = await postJson("/ui/mods/proposal/dismiss", { instance: p.instance });
    if (!r.ok) { toast(why(r.body), false); return; }
    load();
  };
  const uninstall = async (m) => {
    if (!(await confirmDialog({ message: tn("modUninstallConfirm", m.title), confirmLabel: tn("modUninstall"), danger: true }))) return;
    const r = await postJson("/ui/mods/uninstall", { id: m.id });
    if (!r.ok) { toast(why(r.body), false); return; }
    toast(tn("modUninstalled", m.title));
    load();
  };
  const fetchFile = async (m) => {
    const r = await fetch(`/ui/mods/file/${m.id}`, { credentials: "same-origin" }).catch(() => null);
    if (!r || !r.ok) { toast(tn("modFailed", r ? r.status : "network"), false); return; }
    download(await r.text(), `${m.name}-${m.version}.agendmod.json`);
  };
  return html`<section class="card s-appearance s-mods"><${CardTitle} title=${tn("modsTitle")} topic="mods" />
    <p class="sub">${tn("modsLead")}</p>
    ${state.staged ? html`<${Plan} key=${state.staged.stage} staged=${state.staged} onDone=${load} />` : html`<div class="s-mod-import">
      <label class="btn"><${Icon} name="attach" size=${16} /><span>${tn("modChoose")}</span>
        <input ref=${file} type="file" accept=".json,application/json" class="sr-only" disabled=${busy} onChange=${stage} /></label></div>`}
    ${error ? html`<p class="err s-mod-err" role="alert">${error}</p>` : null}
    ${!state.staged && (state.proposals || []).length ? html`<div class="s-mod-proposals"><h4>${tn("modProposals")}</h4><ul class="s-mod-list">${state.proposals.map((p) => html`<li key=${p.instance}>
      <span class="grow">${tn("modProposedBy", p.instance)} <strong>${p.title}</strong> <span class="muted">${p.name} ${p.version}</span></span>
      <button type="button" class="btn btn-sm" onClick=${() => review(p)}>${tn("modReview")}</button>
      <button type="button" class="btn btn-sm" onClick=${() => dismiss(p)}>${tn("modDismiss")}</button></li>`)}</ul></div>` : null}
    ${state.mods.length ? html`<ul class="s-mod-list">${state.mods.map((m) => html`<li key=${m.id}>
      <span class="grow"><strong>${m.title}</strong> <span class="muted">${m.name} ${m.version}${m.target ? ` · ${tn("modAppliedTo", m.target)}` : ""}</span></span>
      <button type="button" class="btn btn-sm" onClick=${() => fetchFile(m)}>${tn("modDownload")}</button>
      <button type="button" class="btn btn-sm danger" onClick=${() => uninstall(m)}>${tn("modUninstall")}</button></li>`)}</ul>` : html`<p class="sub">${tn("modsNone")}</p>`}
    <${ExportForm} />
  </section>`;
}
