// #1629 r4 §3: Settings → Appearance — the person's own custom CSS (owner CSS): the editor, keep-or-revert, earlier
// versions, the pictures and fonts it may name, and this device's off switch. Settings itself is always drawn stock
// (owner-css.js removes the link here), so a stylesheet that hides things can always be fixed from this page.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { recordEdit } from "/assets/text-undo.js";
import { appStore, useStore } from "/assets/app-store.js";
import { ModsCard } from "./settings-mods.js";
import { experimentalComponent, useCanvasWorker } from "/assets/feature-flags.js";
const EffectsCard = experimentalComponent(() => import("./settings-effects.js"), m => m.EffectsCard);
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { ownerCssOffHere, ownerCssTrial, safeMode, setOwnerCssActive, setOwnerCssOffHere, startOwnerCssTrial } from "/assets/owner-css.js";
import { setThemesShown, themesStore } from "/assets/app-themes.js";
import { followsReducedMotion, onMotionChange, setFollowsReducedMotion } from "/assets/fx-motion.js";
import { CARD_SIZES, cardSizeDefault, cardSizeStore, setCardSizeDefault } from "/assets/identity-card.js";
import { AgentWidget, checkWidget, fleetBinds, setSidebarWidget, sidebarWidgetRaw, sidebarWidgetStore, widgetProblem } from "/assets/agent-widget.js";
import { confirmedWrite } from "./settings-confirm.js";
import { savePref, withoutHold } from "/assets/app-prefs.js";
import { DEFAULT_SCHEMA, impactOf, ownChoiceImpact } from "./settings-model.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { colorsOff, defaultPlaces, identityClasses, identityOf, PLACEMENTS, paintIdentity, setColorsOff, setDefaultPlaces, useIdentityColors } from "/assets/identity-color.js";
import { CardTitle } from "./settings-learn.js";
import "./settings-strings.js";

const tn = (k, ...v) => t(`settings.${k}`, ...v);
/** #2390: a refusal's detail in the page's language when the host named it (detail_key), else its English as sent. */
export function appIconDetail(body) {
  const key = body && typeof body.detail_key === "string" ? `appIconDetail_${body.detail_key}` : null;
  const english = (body && body.detail) || "";
  if (!key) return english;
  const args = Array.isArray(body.detail_args) ? body.detail_args : [];
  const said = tn(key, ...(body.detail_key === "corrupt" ? [english] : args));
  return said === `settings.${key}` ? english : said;
}
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

/**
 * #2347: in Settings, a change here is saved by the bar's Save like every Settings change. The synced preferences are
 * held by app-prefs while Settings is open (the panel stages them); `stage`/`unstage`/`staged` (the panel's) carry the
 * rest: this device's own switches and the fleet's Canvas Worker switch. Without them (shown on its own) each control
 * saves at once, as before.
 */
export function AppearanceSection(props = {}) {
  const part = props.part || "look";
  const publicLink = typeof document !== "undefined" && document.body && document.body.dataset.publicLink === "1";
  // #2347 regrouping: Look (the person's own), this device's switches (in Preferences) and the host-wide cards (in Web
  // dashboard) are drawn where each belongs. None of it is offered over the public link (Look says so).
  if (publicLink) return part === "look" ? html`<section class="card s-appearance"><h3>${tn("cssTitle")}</h3><p class="sub">${tn("cssPublicLink")}</p></section>` : null;
  if (part === "device") return html`<${MotionCard} ...${props} /><${DeviceCard} ...${props} />`;
  if (part === "dashboard") return html`<${AppIconCard} /><${CardLimitsCard} /><${ExperimentalEffectsCard} ...${props} />`;
  const group = (key) => html`<h2 class="s-ap-group">${tn(key)}</h2>`;
  return html`${group("groupLook")}<${ThemesCard} ...${props} /><${IdentityColorCard} /><${CardSizeCard} />
    ${group("groupLayout")}<${SidebarWidgetCard} />
    ${group("groupCss")}<${OwnerCssCard} />
    ${group("groupMods")}<${ModsCard} /><${EffectsCard} />
    <${RestoreDefaultsCard} ...${props} />`;
}

/** #2347: the staged keys of this device's own switches (Restore defaults sets them, so their staged change goes). */
const DEVICE_CHOICES = ["device:fx-follow-motion", "device:owner-css-off"];
/**
 * #2347: a switch kept on this device only — shown at once; in Settings staged under `key` with what it was before, so
 * Discard (or leaving Settings) puts that back. Back to that value: no change.
 */
function deviceChoice(props, key, label, read, write) {
  return (value) => {
    const prev = props.staged && props.staged.get(key);
    const from = prev ? prev.from : read();
    write(value);
    if (!props.stage) return;
    if (value === from) props.unstage(key);
    else props.stage(key, { label: tn("youDeviceChoice", label), impact: ownChoiceImpact(props.schema), from, local: { commit: () => {}, revert: () => write(from) } }, true);
  };
}

register("experimentalEffects", {
  en: { title: "Experimental: Canvas Worker effects", help: "Enable uploaded Canvas Worker effects. Ambient effects are always available. Saved effects stay intact when this is off.", failed: "Could not change this setting. Try again." },
  "zh-TW": { title: "實驗功能：Canvas Worker 特效", help: "啟用上傳的 Canvas Worker 特效。氛圍特效不受影響；關閉時保留已儲存的特效。", failed: "無法變更此設定，請重試。" },
});
const CANVAS_WORKER = "fleet:experimental.canvas_worker";
function ExperimentalEffectsCard(props = {}) {
  const enabled = useCanvasWorker(), [writable, setWritable] = useState(false), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => { let live = true; Promise.resolve(globalThis.AgendAuth?.trialSession?.()).then(value => { if (live) setWritable(value?.localAdmin === true); }, () => {}); return () => { live = false; }; }, []);
  if (!writable) return null;
  // #2347: in Settings it is a fleet change like any other — staged here, written by the bar's Save (this page's switch
  // follows once it applied).
  const pending = props.staged && props.staged.get(CANVAS_WORKER);
  const shown = pending ? pending.draft : enabled;
  const stageIt = (value) => {
    setFailed(false);
    if (value === enabled) { props.unstage(CANVAS_WORKER); return; }
    props.stage(CANVAS_WORKER, { label: t("experimentalEffects.title"), impact: impactOf(props.schema || DEFAULT_SCHEMA, "web.experimental.canvas_worker"), draft: value,
      request: { method: "PUT", url: "/api/settings/fleet/web", body: { experimental: { canvas_worker: value } } },
      onResult: (outcome) => { if (outcome && outcome.status === "applied") appStore.set({ canvasWorker: value }); else if (outcome && outcome.status === "failed") setFailed(true); } }, true);
  };
  const change = async value => {
    if (props.stage) { stageIt(value); return; }
    setBusy(true); setFailed(false);
    try {
      const result = await confirmedWrite("/api/settings/fleet/web", { method: "PUT", body: { experimental: { canvas_worker: value } }, label: t("experimentalEffects.title") });
      if (result.ok) appStore.set({ canvasWorker: value }); else setFailed(true);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return html`<section class="card s-appearance s-experimental-effects"><label class="check"><input type="checkbox" checked=${shown} disabled=${busy} onChange=${event => change(event.target.checked)} /><span>${t("experimentalEffects.title")}</span></label><p class="sub">${t("experimentalEffects.help")}</p>${failed ? html`<p role="alert">${t("experimentalEffects.failed")}</p>` : null}</section>`;
}

/** #2056 B: a sample sidebar row in the host's default colour places, so the choice is seen rather than described. */
const SAMPLE = { color: { person: "preset:teal" } };
function ColorSample({ places, off }) {
  const id = identityOf(SAMPLE, { hostDefault: places, off });
  return html`<div class="idc-preview s-colors-sample" aria-hidden="true"><span class=${`inst v-inst ${identityClasses(id)}`} ref=${(el) => paintIdentity(el, id)}>
    <span class="av"><span class="av-text">A</span></span><span class="inst-text"><span class="inst-name">${tn("colorSample")}</span></span></span></div>`;
}

/**
 * #1958: identity colours on this host — where they show for an instance nobody chose for (#2056: name, bar and
 * ring unless changed), and a switch that turns them off everywhere while every pick is kept.
 */
function IdentityColorCard() {
  useIdentityColors();
  const places = defaultPlaces(), off = colorsOff();
  const toggle = (p) => setDefaultPlaces(places.includes(p) ? places.filter((x) => x !== p) : [...places, p]);
  return html`<section class="card s-appearance s-synced s-colors"><${CardTitle} title=${tn("colorTitle")} topic="colors" />
    <p class="sub">${tn("colorLead")}</p>
    <div class="s-colors-row">
      <fieldset class="idc-places" disabled=${off}><legend>${tn("colorPlaces")}</legend>
        ${PLACEMENTS.map((p) => html`<label key=${p} class="check"><input type="checkbox" checked=${places.includes(p)} onChange=${() => toggle(p)} /> ${t(`color.place_${p}`)}</label>`)}
      </fieldset>
      <${ColorSample} places=${places} off=${off} />
    </div>
    <label class="check"><input type="checkbox" class="s-colors-off" checked=${off} onChange=${(e) => setColorsOff(e.target.checked)} /> <span>${tn("colorOff")}</span></label>
    <p class="sub">${tn("colorOffLead")}</p>
  </section>`;
}

/**
 * #1958 decision 5: Restore defaults — the host's appearance settings back to their defaults after a confirm that says
 * what it resets; this person's custom CSS turned off (its versions stay). Not settings, so never touched: the colours
 * people picked per instance (and where each agent's colours go, #2196), installed mods, uploaded effects and the
 * fleet's card limits.
 */
export async function restoreAppearanceDefaults() {
  // #2347: a confirmed action — it saves at once, Settings open or not (nothing it sets stays held).
  withoutHold(() => {
    setThemesShown(true);
    setFollowsReducedMotion(false);
    setCardSizeDefault("m");
    savePref("card.sizeByInstance", null);
    setSidebarWidget(null);
    setDefaultPlaces(null);
    setColorsOff(false);
    setOwnerCssOffHere(false);
  });
  const r = await postJson("/ui/owner-css/restore", { sha: null });
  return r && r.error ? { ok: false, error: r.error } : { ok: true };
}
function RestoreDefaultsCard(props = {}) {
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!(await confirmDialog({ title: tn("restoreTitle"), message: tn("restoreConfirm"), confirmLabel: tn("restoreGo"), danger: true }))) return;
    setBusy(true);
    const r = await restoreAppearanceDefaults();
    if (props.unstage) for (const key of DEVICE_CHOICES) props.unstage(key);      // saved by the restore itself
    setBusy(false);
    if (r.ok) toast(tn("restoreDone")); else toast(tn("restoreCssFailed", r.error), false);
  }
  return html`<section class="card s-appearance s-restore"><${CardTitle} title=${tn("restoreTitle")} topic="restore" />
    <p class="sub">${tn("restoreLead")}</p>
    <button type="button" class="btn" disabled=${busy} onClick=${go}>${tn("restoreTitle")}</button>
  </section>`;
}

/** #1629 r4.1 Q3 (a): every identity card's size on this person's screens (a card's own control sets it apart). */
function CardSizeCard() {
  useStore(cardSizeStore);
  const size = cardSizeDefault();
  return html`<section class="card s-appearance s-synced s-card-size"><${CardTitle} title=${tn("cardSizeTitle")} topic="cards" />
    <div class="card-size" role="group" aria-label=${tn("cardSizeTitle")}>
      ${CARD_SIZES.map((s) => html`<button key=${s} type="button" class=${`seg-item${s === size ? " active" : ""}`} aria-pressed=${s === size ? "true" : "false"}
        onClick=${() => setCardSizeDefault(s)}>${t(`card.size${s.toUpperCase()}Name`)}</button>`)}
    </div>
    <p class="sub">${tn("cardSizeLead")}</p>
  </section>`;
}

/**
 * #2308: the image as one square PNG the host makes the icon sizes from — centre-cropped, drawn at 512 px if smaller
 * (marked low-resolution), as it is up to 1024 px, else 1024. The browser decodes whatever it can show (PNG, JPG, WebP);
 * the host takes only that PNG.
 */
export async function appIconPng(file) {
  const bmp = await createImageBitmap(file);
  try {
    const side = Math.min(bmp.width, bmp.height);
    const out = Math.min(1024, Math.max(512, side));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = out;
    const g = canvas.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("no PNG");
    return { blob, low: side < 512 };
  } finally {
    if (bmp.close) bmp.close();
  }
}

/** #2308: this page's icon links follow a change at once (the next pages carry the version from the host). */
export function refreshAppIconLinks(version, custom) {
  if (typeof document === "undefined") return;
  const v = encodeURIComponent(version);
  const head = document.head;
  const links = [...head.querySelectorAll("link")];
  const byPath = (path) => links.find((l) => (l.getAttribute("href") || "").split("?")[0] === path);
  for (const [path, rel] of [["/favicon.ico", "icon"], ["/apple-touch-icon.png", "apple-touch-icon"], ["/manifest.webmanifest", "manifest"]]) {
    const el = byPath(path);
    if (el && el.getAttribute("rel") === rel) el.setAttribute("href", `${path}?v=${v}`);
  }
  const svg = byPath("/favicon.svg");
  if (custom && svg) svg.remove();
  else if (!custom && !svg) {
    const link = document.createElement("link");
    for (const [k, val] of [["rel", "icon"], ["href", `/favicon.svg?v=${v}`], ["type", "image/svg+xml"], ["sizes", "any"]]) link.setAttribute(k, val);
    head.appendChild(link);
  }
}

/**
 * #2308: the app icon — what a browser tab and a home screen show. One picture for every page (sign-in and the public
 * link too); an admin changes it, everyone else sees it.
 */
function AppIconCard() {
  const [state, setState] = useState(null);
  const [canWrite, setCanWrite] = useState(false);
  const [picked, setPicked] = useState(null);           // { blob, url, low }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef(null);
  const load = async () => {
    const r = await call("/ui/app-icon");
    setState(r.ok && r.body && typeof r.body.version === "string" ? r.body : { failed: true });
  };
  useEffect(() => {
    load();
    const auth = typeof window !== "undefined" ? window.AgendAuth : null;
    if (auth && auth.canWrite) Promise.resolve(auth.canWrite()).then((v) => setCanWrite(v === true), () => {});
  }, []);
  useEffect(() => () => { if (picked) URL.revokeObjectURL(picked.url); }, [picked]);
  const title = html`<${CardTitle} title=${tn("appIconTitle")} topic="app-icon" />`;
  if (!state) return html`<section class="card s-appearance s-app-icon">${title}<p class="sub">…</p></section>`;
  if (state.failed) return html`<section class="card s-appearance s-app-icon">${title}<p class="err">${tn("appIconLoadFailed")}</p></section>`;

  const choose = async () => {
    const f = file.current && file.current.files && file.current.files[0];
    if (file.current) file.current.value = "";
    if (!f) return;
    setError("");
    try {
      const made = await appIconPng(f);
      setPicked({ ...made, url: URL.createObjectURL(made.blob) });
    } catch {
      setError(tn("appIconNotAnImage"));
    }
  };
  const answered = (r, done) => {
    setBusy(false);
    if (!r.ok) {
      const known = ["app_icon_too_large", "app_icon_not_png", "app_icon_unreadable", "app_icon_admin_only", "app_icon_needs_a_signed_in_person", "app_icon_busy", "app_icon_superseded", "app_icon_not_reset", "app_icon_not_kept", "app_icon_failed"];
      setError(known.includes(r.body && r.body.error) ? tn(`appIconError_${r.body.error}`, appIconDetail(r.body)) : tn("appIconError_other", (r.body && r.body.error) || String(r.status)));
      return;
    }
    setState(r.body);
    setPicked(null);
    refreshAppIconLinks(r.body.version, r.body.custom);
    toast(done);
  };
  const use = async () => {
    setBusy(true); setError("");
    answered(await call("/ui/app-icon", { method: "PUT", headers: { "Content-Type": "image/png" }, body: picked.blob }), tn("appIconSaved"));
  };
  const reset = async () => {
    setBusy(true); setError("");
    answered(await call("/ui/app-icon", { method: "DELETE" }), tn("appIconResetDone"));
  };
  const v = encodeURIComponent(state.version);
  return html`<section class="card s-appearance s-app-icon">${title}
    <p class="sub">${tn("appIconLead")}</p>
    <div class="s-app-icon-row">
      <figure class="s-app-icon-now"><img class="s-app-icon-big" src=${`/apple-touch-icon.png?v=${v}`} width="96" height="96" alt=${tn("appIconCurrent")} />
        <img class="s-app-icon-small" src=${`/icon-192.png?v=${v}`} width="32" height="32" alt="" />
        <figcaption>${state.custom ? tn("appIconCustom") : tn("appIconDefault")}</figcaption></figure>
      ${picked ? html`<figure class="s-app-icon-new"><img class="s-app-icon-big" src=${picked.url} width="96" height="96" alt=${tn("appIconPreview")} />
        <figcaption>${tn("appIconPreview")}</figcaption></figure>` : null}
    </div>
    ${picked && picked.low ? html`<p class="sub s-app-icon-low">${tn("appIconLow")}</p>` : null}
    ${error ? html`<p class="err" role="alert">${error}</p>` : null}
    ${canWrite ? html`<div class="s-css-actions">
      <input ref=${file} type="file" class="sr-only" id="s-app-icon-file" accept="image/png,image/jpeg,image/webp" onChange=${choose} />
      ${picked ? html`
        <button type="button" class="btn btn-primary" disabled=${busy} onClick=${use}><${Icon} name="check" size=${16} />${tn("appIconUse")}</button>
        <button type="button" class="btn" disabled=${busy} onClick=${() => setPicked(null)}>${tn("appIconCancel")}</button>`
      : html`<button type="button" class="btn" disabled=${busy} onClick=${() => file.current && file.current.click()}>${tn("appIconChoose")}</button>`}
      ${state.custom && !picked ? html`<button type="button" class="btn" disabled=${busy} onClick=${reset}>${tn("appIconReset")}</button>` : null}
    </div>` : html`<p class="sub">${tn("appIconReadOnly")}</p>`}
    <p class="sub">${tn("appIconWho")}</p>
    <p class="sub">${tn("appIconIos")}</p>
  </section>`;
}

const LIMIT_FIELDS = [["portrait", "max_width"], ["portrait", "max_height"], ["portrait", "max_kib"], ["banner", "max_width"], ["banner", "max_height"], ["banner", "max_kib"],
  ["instance_quota", "files"], ["instance_quota", "mib"]];
/**
 * #1629 r4.1 Q3 (b): the identity card's upload limits (fleet.yaml web.appearance). Each field shows what is in force
 * when it differs from what is written (a value beyond its bound is clamped). A lower limit applies at once; a higher
 * one waits for a fleet admin's confirmation (the server decides). Stored pictures are never touched.
 */
function CardLimitsCard() {
  const [view, setView] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = async () => {
    const r = await call("/api/settings/fleet/appearance");
    // Only an answer of the expected shape is drawn: every group's in-force values, defaults and bounds.
    const ok = r.ok && r.body && ["portrait", "banner", "instance_quota"].every((g) => r.body.effective && r.body.effective[g] && r.body.defaults && r.body.defaults[g] && r.body.bounds && r.body.bounds[g]);
    if (!ok) { setView({ error: true }); return; }
    setView(r.body);
    const d = {};
    for (const [g, k] of LIMIT_FIELDS) { const v = r.body.configured && r.body.configured[g] && r.body.configured[g][k]; d[`${g}.${k}`] = typeof v === "number" ? String(v) : ""; }
    setDraft(d);
  };
  useEffect(() => { load(); }, []);
  if (!view) return null;
  if (view.error) return html`<section class="card s-appearance s-card-limits"><${CardTitle} title=${tn("cardLimitsTitle")} topic="limits" /><p class="sub">${tn("cardLimitsUnavailable")}</p></section>`;
  const configured = (g, k) => (view.configured && view.configured[g] && typeof view.configured[g][k] === "number" ? view.configured[g][k] : null);
  const save = async () => {
    const body = {};
    for (const [g, k] of LIMIT_FIELDS) {
      const raw = (draft[`${g}.${k}`] || "").trim();
      const next = raw === "" ? null : Number(raw);
      if (next !== null && !(Number.isInteger(next) && next > 0)) { setMsg(tn("cardLimitsWhole")); return; }
      if (next !== configured(g, k)) (body[g] ??= {})[k] = next;
    }
    if (!Object.keys(body).length) { setMsg(tn("cardLimitsNoChange")); return; }
    setBusy(true); setMsg(null);
    const r = await confirmedWrite("/api/settings/fleet/appearance", { method: "PUT", body, label: tn("cardLimitsTitle") });
    setBusy(false);
    if (r.ok) { setMsg(tn("cardLimitsSaved")); load(); } else setMsg(tn("cardLimitsFailed", (r.body && r.body.error) || r.status));
  };
  const warnings = Array.isArray(view.warnings) ? view.warnings : [];
  return html`<section class="card s-appearance"><${CardTitle} title=${tn("cardLimitsTitle")} topic="limits" />
    <p class="sub">${tn("cardLimitsLead")}</p>
    <fieldset class="form" disabled=${busy}>
      ${["portrait", "banner", "instance_quota"].map((g) => html`<div key=${g} class="grid3">
        ${LIMIT_FIELDS.filter(([gg]) => gg === g).map(([, k]) => {
          const id = `cardLimit-${g}-${k}`, eff = view.effective[g][k], conf = configured(g, k);
          return html`<div key=${k} class="field"><label for=${id}>${tn(`cardLimit_${g}_${k}`)}</label>
            <input id=${id} type="number" min="1" step="1" placeholder=${String(view.defaults[g][k])} value=${draft[`${g}.${k}`] || ""}
              onInput=${(e) => setDraft({ ...draft, [`${g}.${k}`]: e.target.value })} />
            ${conf !== null && conf !== eff ? html`<span class="note">${tn("cardLimitInForce", eff, view.bounds[g][k][0], view.bounds[g][k][1])}</span>` : null}</div>`;
        })}
      </div>`)}
    </fieldset>
    ${warnings.length ? html`<ul class="note s-limit-warnings">${warnings.map((w, i) => html`<li key=${i}><code>${w.path}</code>: ${w.message}</li>`)}</ul>` : null}
    <div class="save-row"><button type="button" class="btn btn-primary" disabled=${busy} onClick=${save}>${tn("cardLimitsSave")}</button>
      ${msg ? html`<span class="note" role="status">${msg}</span>` : null}</div>
  </section>`;
}

/** #1629 r2 (d): whether this person's screens show agents' themes (and, as they come, effects) — synced. */
function ThemesCard() {
  const s = useStore(themesStore);
  return html`<section class="card s-appearance s-synced s-themes"><${CardTitle} title=${tn("themesTitle")} topic="themes" />
    <label class="check"><input id="fx-show-themes" type="checkbox" checked=${s.shown} disabled=${safeMode()} onChange=${(e) => setThemesShown(e.target.checked)} />
      <span>${tn("themesShow")}</span></label>
    <p class="sub">${safeMode() ? tn("themesSafeMode") : tn("themesShowLead")}</p>
  </section>`;
}

/** An example to start from: the fleet's counts, as a person's sidebar widget may show them. */
export const SIDEBAR_WIDGET_EXAMPLE = {
  spec: { v: 1, title: "Fleet", items: [
    { type: "stat", label: "Working", bind: "fleet.working" },
    { type: "stat", label: "Needs you", bind: "fleet.needs_you" },
    { type: "stat", label: "Idle", bind: "fleet.idle" },
    { type: "stat", label: "Stopped", bind: "fleet.stopped" },
  ] },
  data: {},
};
/**
 * #1629 r4-4: the person's own sidebar widget — a declarative spec and its values, as JSON; drawn under the instance
 * list by the page's own components, with the fleet's counts as the only live values. Synced like the other choices.
 */
function SidebarWidgetCard() {
  useStore(sidebarWidgetStore);
  const app = useStore(appStore);
  const saved = sidebarWidgetRaw();
  const [text, setText] = useState(() => (saved ? JSON.stringify(saved, null, 2) : ""));
  const area = useRef(null);
  const [error, setError] = useState("");
  let parsed = null, problem = "";
  if (text.trim()) {
    try { parsed = JSON.parse(text); problem = widgetProblem("sidebar", parsed) || ""; } catch { problem = tn("widgetNotJson"); }
  }
  const preview = parsed && !problem ? checkWidget("sidebar", parsed) : null;
  const save = () => {
    if (!parsed || problem) { setError(problem || tn("widgetNotJson")); return; }
    setError("");
    setSidebarWidget(parsed);
    toast(tn("widgetSaved"));
  };
  const remove = () => { setSidebarWidget(null); recordEdit(area.current); setText(""); setError(""); toast(tn("widgetRemoved")); };
  return html`<section class="card s-appearance s-synced s-widget"><${CardTitle} title=${tn("widgetTitle")} topic="widgets" />
    <p class="sub">${tn("widgetLead")}</p>
    <label class="field"><span class="sr-only">${tn("widgetTitle")}</span>
      <textarea ref=${area} class="s-widget-text" rows="10" spellcheck=${false} autocapitalize="off" autocomplete="off" value=${text}
        onInput=${(e) => { setText(e.target.value); setError(""); }}></textarea></label>
    ${error || problem ? html`<p class="err" role="alert">${error || problem}</p>` : null}
    ${preview ? html`<div class="s-widget-preview"><${AgentWidget} slot="sidebar" widget=${preview} binds=${fleetBinds(app.instances, app.exec, app.awaiting)} /></div>` : null}
    <div class="s-widget-actions">
      <button type="button" class="btn btn-primary" disabled=${!parsed || !!problem} onClick=${save}><${Icon} name="check" size=${16} />${tn("widgetSave")}</button>
      ${!text.trim() ? html`<button type="button" class="btn" onClick=${() => { recordEdit(area.current); setText(JSON.stringify(SIDEBAR_WIDGET_EXAMPLE, null, 2)); }}>${tn("widgetExample")}</button>` : null}
      ${saved ? html`<button type="button" class="btn" onClick=${remove}>${tn("widgetRemove")}</button>` : null}
    </div>
  </section>`;
}

function OwnerCssCard() {
  const [state, setState] = useState(null);
  const [text, setText] = useState("");
  const area = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trial = useStore(ownerCssTrial);
  const file = useRef(null);
  const load = async (opts = {}) => {
    const r = await call("/ui/owner-css/state");
    if (!r.ok || !r.body) { setState({ failed: true }); return; }
    setState(r.body);
    // #2342: a restored version replaces the editor's text as a step Ctrl+Z goes back from.
    if (opts.undoable) recordEdit(area.current);
    if (opts.text !== false) setText(r.body.text || "");
  };
  useEffect(() => { load(); }, []);
  // A trial answered (kept or reverted) changes what is in force: read it again, keeping the editor's text.
  useEffect(() => { if (state) load({ text: false }); }, [trial && trial.sha]);
  if (!state) return html`<section class="card s-appearance"><${CardTitle} title=${tn("cssTitle")} topic="css" /><p class="sub">…</p></section>`;
  if (state.failed) return html`<section class="card s-appearance"><${CardTitle} title=${tn("cssTitle")} topic="css" /><p class="err">${tn("cssLoadFailed")}</p></section>`;

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
    load({ undoable: true });
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
  return html`<section class="card s-appearance s-owner-css"><${CardTitle} title=${tn("cssTitle")} topic="css" />
    <p class="sub">${tn("cssLead")}</p>
    <p class="s-css-status" role="status">${inForce}</p>
    <label class="field"><span class="sr-only">${tn("cssTitle")}</span>
      <textarea ref=${area} class="s-css-text" rows="14" spellcheck=${false} autocapitalize="off" autocomplete="off" value=${text} disabled=${busy}
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

/** #2117: this device's own switch (not synced): effects play unless it follows the system's reduced-motion setting. */
function MotionCard(props = {}) {
  const [follow, setFollow] = useState(followsReducedMotion);
  useEffect(() => onMotionChange(() => setFollow(followsReducedMotion())), []);
  const setFollowHere = deviceChoice(props, DEVICE_CHOICES[0], tn("themesFollowMotion"), followsReducedMotion, setFollowsReducedMotion);
  return html`<section class="card s-appearance s-local s-motion"><h3>${tn("motionTitle")}</h3>
    <label class="check"><input type="checkbox" id="fx-follow-reduced-motion" checked=${follow} onChange=${(e) => setFollowHere(e.target.checked)} />
      <span>${tn("themesFollowMotion")}</span></label>
    <p class="sub">${tn("themesFollowMotionLead")}</p>
  </section>`;
}

function DeviceCard(props = {}) {
  const [off, setOff] = useState(ownerCssOffHere());
  const setOffHere = deviceChoice(props, DEVICE_CHOICES[1], tn("cssDeviceOff"), ownerCssOffHere, (v) => { setOwnerCssOffHere(v); setOff(ownerCssOffHere()); });
  return html`<section class="card s-appearance s-local"><h3>${tn("cssDeviceTitle")}</h3>
    <label class="check"><input id="css-off-here" type="checkbox" checked=${off} onChange=${(e) => setOffHere(e.target.checked)} />
      <span>${tn("cssDeviceOff")}</span></label>
    <p class="sub">${tn("cssSafe")}</p>
  </section>`;
}
