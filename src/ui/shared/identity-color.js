// #1958: an instance's identity colour on the page — the cue people scan the sidebar by — and where it shows (the
// name, a bar at the row's left edge, the avatar's ring). The server sends each instance's tiers in the status frame
// (`color`, `color_show`); this module resolves them as src/web-identity-color.ts does (a test pins the two equal),
// paints the sidebar row through the CSSOM (no style attribute, #1300), and holds the Color dialog.
//   colour: a person's pick > the agent's (themes shown) > its own bot's role colour > automatic (a few soft colours)
//   places: a person's choice > the agent's (themes shown) > this host's default (color.show) > ring + bar
//   Settings → Web appearance can turn colours off for the host (color.off): nothing is painted, every pick is kept.
import { html, useEffect, useState } from "./app-html.js";
import { createStore, useStore } from "./app-store.js";
import { onPrefsChanged, prefInForce, savePref } from "./app-prefs.js";
import { register, t } from "./app-i18n.js";
import { themesShown, themesStore } from "./app-themes.js";
import { Dialog } from "./ui-dialog.js";
import { toast } from "./ui-toast.js";

// ── The palettes (src/web-identity-palette.ts: the same values, pinned by a test) ──

export const IDENTITY_PALETTE = [
  { id: "red", light: "#cf222e", dark: "#ff7b72" }, { id: "orange", light: "#bc4c00", dark: "#ffa657" },
  { id: "amber", light: "#8a5d00", dark: "#e3b341" }, { id: "lime", light: "#4d7c0f", dark: "#a3e635" },
  { id: "green", light: "#1a7f37", dark: "#56d364" }, { id: "teal", light: "#0f766e", dark: "#2dd4bf" },
  { id: "cyan", light: "#0e7490", dark: "#22d3ee" }, { id: "blue", light: "#0a62c2", dark: "#7ab7ff" },
  { id: "indigo", light: "#4f46e5", dark: "#a5b4fc" }, { id: "violet", light: "#8250df", dark: "#d2a8ff" },
  { id: "pink", light: "#bf3989", dark: "#f778ba" }, { id: "slate", light: "#57606a", dark: "#b1bac4" },
];
export const AUTO_PALETTE = [
  { id: "sand", light: "#8a6d3b", dark: "#d4b98a" }, { id: "clay", light: "#9c5a4a", dark: "#d9a294" },
  { id: "rose", light: "#9b4f6a", dark: "#d99ab0" }, { id: "plum", light: "#7a5a8c", dark: "#c3a6d6" },
  { id: "dusk", light: "#5a628f", dark: "#a9b0db" }, { id: "sea", light: "#3f7286", dark: "#92c2d4" },
  { id: "moss", light: "#5b7340", dark: "#a9c48d" }, { id: "slate", light: "#5f6b78", dark: "#aeb8c4" },
];
export const PLACEMENTS = ["name", "bar", "ring"];
export const DEFAULT_PLACEMENTS = ["bar", "ring"];
const HEX = /^#[0-9a-f]{6}$/;
const presetOf = (c) => (typeof c === "string" && c.startsWith("preset:") ? IDENTITY_PALETTE.find((p) => p.id === c.slice(7)) : undefined);
const autoOf = (c) => (typeof c === "string" && c.startsWith("auto:") ? AUTO_PALETTE.find((p) => p.id === c.slice(5)) : undefined);
/** A colour as the server sends it (preset:<id>, auto:<id>, #rrggbb), checked; null for anything else. */
export function colorOk(c) {
  if (typeof c !== "string") return null;
  if (presetOf(c) || autoOf(c) || HEX.test(c)) return c;
  return null;
}
/** A place list, in PLACEMENTS order; null for anything that is not one. */
export function placesOk(v) {
  if (!Array.isArray(v) || v.length > 3 || !v.every((p) => PLACEMENTS.includes(p)) || new Set(v).size !== v.length) return null;
  return PLACEMENTS.filter((p) => v.includes(p));
}
/** The colour drawn for `c` on a page in `mode`. */
export function colorValue(c, mode) {
  const p = presetOf(c) || autoOf(c);
  return p ? p[mode] : c;
}

// ── Contrast: name text reads at 4.5:1 on the page's and the sidebar's background (tokens.css) ──

const BG = { light: ["#ffffff", "#f9f9f9"], dark: ["#212121", "#171717"] };
const TEXT = { light: "#0d0d0d", dark: "#ececec" };
function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
/** The shade of `hex` name text uses: itself if readable, else the nearest step toward black (light) or white (dark). */
export function readableShade(hex, mode) {
  if (!HEX.test(hex)) return TEXT[mode];
  const toward = mode === "light" ? 0 : 255;
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let step = 0; step <= 20; step++) {
    const shade = `#${ch.map((c) => Math.round(c + (toward - c) * (step / 20)).toString(16).padStart(2, "0")).join("")}`;
    if (BG[mode].every((bg) => contrast(shade, bg) >= 4.5)) return shade;
  }
  return TEXT[mode];
}

// ── Resolution ──

/** The colour in force and its source, from the frame's tiers. */
export function resolveColor(tiers, showThemes) {
  const t2 = tiers && typeof tiers === "object" ? tiers : {};
  const person = colorOk(t2.person);
  if (person) return { color: person, source: "person" };
  const agent = showThemes ? colorOk(t2.agent) : null;
  if (agent && !autoOf(agent)) return { color: agent, source: "agent" };
  const role = typeof t2.role === "string" && HEX.test(t2.role) ? t2.role : null;
  if (role) return { color: role, source: "role" };
  return { color: autoOf(t2.auto) ? t2.auto : "auto:sand", source: "auto" };
}
/** Where it shows, and whose choice that is. */
export function resolvePlaces(tiers, showThemes, hostDefault) {
  const t2 = tiers && typeof tiers === "object" ? tiers : {};
  const person = placesOk(t2.person);
  if (person) return { show: person, source: "person" };
  const agent = showThemes ? placesOk(t2.agent) : null;
  if (agent) return { show: agent, source: "agent" };
  return { show: placesOk(hostDefault) || [...DEFAULT_PLACEMENTS], source: "host" };
}

// ── This host's settings (web prefs color.show / color.off) ──

export const colorPrefsStore = createStore({ n: 0 });
const bump = () => colorPrefsStore.set((s) => ({ n: s.n + 1 }));
onPrefsChanged((changed) => { if (changed.has("color.show") || changed.has("color.off")) bump(); });
const readLocal = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
/** Where colours show by default on this host (Settings → Web appearance). */
export function defaultPlaces() {
  const f = prefInForce("color.show");
  let v = f ? f.value : undefined;
  if (!f) { try { v = JSON.parse(readLocal("agend_color_show") || "null"); } catch { v = null; } }
  return placesOk(v) || [...DEFAULT_PLACEMENTS];
}
export function colorsOff() {
  const f = prefInForce("color.off");
  return f ? f.value === true : readLocal("agend_color_off") === "on";
}
/** The default places (null: back to ring + bar). */
export function setDefaultPlaces(list) {
  const v = list === null ? null : placesOk(list);
  const same = v && v.length === DEFAULT_PLACEMENTS.length && v.every((p, i) => p === DEFAULT_PLACEMENTS[i]);
  savePref("color.show", v === null || same ? null : v);
  bump();
}
export function setColorsOff(off) {
  savePref("color.off", off ? true : null);
  bump();
}

/** What one instance's row shows: its colour per mode, name shades, places, and whether anything is painted at all. */
export function identityOf(it, opts = {}) {
  const showThemes = opts.showThemes ?? themesShown();
  const c = resolveColor(it && it.color, showThemes);
  const p = resolvePlaces(it && it.color_show, showThemes, opts.hostDefault ?? defaultPlaces());
  const light = colorValue(c.color, "light"), dark = colorValue(c.color, "dark");
  return {
    color: c.color, source: c.source, show: p.show, showSource: p.source, off: opts.off ?? colorsOff(),
    light, dark, nameLight: readableShade(light, "light"), nameDark: readableShade(dark, "dark"),
  };
}
/** The row's classes for its identity colour ("" when colours are off or shown nowhere). */
export function identityClasses(id) {
  if (!id || id.off || !id.show.length) return "";
  return ["idc", ...id.show.map((p) => `id-${p}`)].join(" ");
}
/** Paint an element (a callback ref): the colour's values for both modes as custom properties; the stylesheet picks. */
export function paintIdentity(el, id) {
  if (!el || !el.style || typeof el.style.setProperty !== "function") return;
  const on = id && !id.off && id.show.length;
  for (const [k, v] of [["--id-light", id && id.light], ["--id-dark", id && id.dark], ["--id-name-light", id && id.nameLight], ["--id-name-dark", id && id.nameDark]]) {
    if (on && v) el.style.setProperty(k, v); else el.style.removeProperty(k);
  }
}
/** Redraw when this host's colour settings or the viewer's themes switch change. */
export function useIdentityColors() {
  useStore(colorPrefsStore);
  useStore(themesStore);
}

// ── The Color dialog (Chat ⋯, Details ⋯, View's Edit profile) ──

export const colorDialogStore = createStore({ name: null, it: null });
export function openColorDialog(name, it) { colorDialogStore.set({ name, it: it || null }); }
const closeColorDialog = () => colorDialogStore.set({ name: null, it: null });

/** The ⋯ entry: on the public link too (decision 3: colours change wherever the profile does). */
export function colorMenuItem(name, it) {
  return { key: "identity-color", label: t("color.menu"), icon: "palette", onSelect: () => openColorDialog(name, it) };
}

export function ColorDialogHost() {
  const s = useStore(colorDialogStore);
  return s.name ? html`<${ColorDialog} key=${s.name} name=${s.name} it=${s.it} onClose=${closeColorDialog} />` : null;
}

function ColorDialog({ name, it, onClose }) {
  useIdentityColors();
  const [loaded, setLoaded] = useState(null);           // the person's choice as stored: { color, color_show }
  const [color, setColor] = useState(null);             // the colour picked here (null: none — the next tier)
  const [hex, setHex] = useState("");
  const [places, setPlaces] = useState(null);           // null: the default places
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    fetch(`/api/profile/${encodeURIComponent(name)}`).then((r) => (r.ok ? r.json() : null)).then((row) => {
      if (!live) return;
      const c = row ? colorOk(row.color) : null, s = row ? placesOk(row.color_show) : null;
      setLoaded({ color: c, show: s }); setColor(c); setHex(c && HEX.test(c) ? c : ""); setPlaces(s);
    }).catch(() => { if (live) setLoaded({ color: null, show: null }); });
    return () => { live = false; };
  }, [name]);
  // The preview: the instance as it would be drawn with the choice here.
  const preview = identityOf({ ...(it || {}), color: { ...((it && it.color) || {}), person: color || undefined }, color_show: { ...((it && it.color_show) || {}), person: places || undefined } }, { off: false });
  const pick = (c) => { setColor(c); setHex(c && HEX.test(c) ? c : ""); setError(""); };
  const togglePlace = (p) => {
    const base = places || preview.show;
    setPlaces(base.includes(p) ? base.filter((x) => x !== p) : PLACEMENTS.filter((x) => x === p || base.includes(x)));
  };
  async function save(body) {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/profile/${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { setError(t("color.failed", (r && (r.detail || r.error)) || `HTTP ${res.status}`)); setBusy(false); return; }
      toast(t("color.saved", name));
      onClose();
    } catch (err) { setError(t("color.failed", (err && err.message) || "network")); setBusy(false); }
  }
  const onHex = (v) => { setHex(v); const c = /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null; if (c) { setColor(c); setError(""); } };
  const off = colorsOff();
  return html`<${Dialog} title=${t("color.title", name)} onClose=${onClose} busy=${busy}
      actions=${html`<button type="button" class="btn" disabled=${busy || !loaded} onClick=${() => save({ color: null, color_show: null })}>${t("color.reset")}</button>
        <span class="dlg-spacer"></span>
        <button type="button" class="btn" disabled=${busy} onClick=${onClose}>${t("color.cancel")}</button>
        <button type="button" class="btn btn-primary" disabled=${busy || !loaded} onClick=${() => save({ color, color_show: places })}>${t("color.save")}</button>`}>
    ${off ? html`<p class="note" role="status">${t("color.offNote")}</p>` : null}
    <p class="sub">${t(`color.src_${preview.source}`)}</p>
    <fieldset class="idc-swatches"><legend>${t("color.colour")}</legend>
      ${IDENTITY_PALETTE.map((p) => html`<button type="button" key=${p.id} class=${`idc-swatch${color === `preset:${p.id}` ? " on" : ""}`}
        aria-pressed=${color === `preset:${p.id}` ? "true" : "false"} aria-label=${t(`color.p_${p.id}`)} title=${t(`color.p_${p.id}`)}
        ref=${(el) => { if (el && el.style) { el.style.setProperty("--sw-light", p.light); el.style.setProperty("--sw-dark", p.dark); } }}
        onClick=${() => pick(`preset:${p.id}`)}></button>`)}
      <label class="idc-custom">${t("color.custom")}
        <input type="color" value=${HEX.test(hex) ? hex : "#808080"} onInput=${(e) => onHex(e.currentTarget.value)} aria-label=${t("color.custom")} />
        <input type="text" class="idc-hex" inputmode="text" spellcheck=${false} maxlength="7" placeholder="#rrggbb" value=${hex} onInput=${(e) => onHex(e.currentTarget.value.trim())} aria-label=${t("color.hex")} /></label>
      <button type="button" class="btn btn-sm" disabled=${!color} onClick=${() => pick(null)}>${t("color.noPick")}</button>
    </fieldset>
    <fieldset class="idc-places"><legend>${t("color.places")}</legend>
      ${PLACEMENTS.map((p) => html`<label key=${p} class="check"><input type="checkbox" checked=${preview.show.includes(p)} onChange=${() => togglePlace(p)} /> ${t(`color.place_${p}`)}</label>`)}
      <label class="check"><input type="checkbox" checked=${places === null} onChange=${() => setPlaces(places === null ? [...preview.show] : null)} /> ${t("color.useDefault")}</label>
    </fieldset>
    <div class="idc-preview" aria-hidden="true"><span class=${`inst v-inst ${identityClasses(preview)}`} ref=${(el) => paintIdentity(el, preview)}>
      <span class="av"><span class="av-text">${(name || "?").slice(0, 1).toUpperCase()}</span></span>
      <span class="inst-text"><span class="inst-name">${name}</span></span></span></div>
    ${error ? html`<p class="err" role="alert">${error}</p>` : null}
  </${Dialog}>`;
}

register("color", {
  en: {
    menu: "Colour…", title: "Colour for {0}", colour: "Colour", custom: "Custom", hex: "Hex colour", noPick: "Not chosen",
    places: "Where it shows", place_name: "Name", place_bar: "Left bar", place_ring: "Ring", useDefault: "Use this host's default places",
    src_person: "Shown now: picked by a person.", src_agent: "Shown now: the agent's own colour.", src_role: "Shown now: the colour of its bot's Discord role.",
    src_auto: "Shown now: an automatic colour.", save: "Save", cancel: "Cancel", reset: "Reset",
    saved: "Colour saved for {0}", failed: "Couldn't save the colour: {0}",
    offNote: "Colours are turned off on this host (Settings → Web appearance). What you pick here is kept for when they're on.",
    p_red: "Red", p_orange: "Orange", p_amber: "Amber", p_lime: "Lime", p_green: "Green", p_teal: "Teal", p_cyan: "Cyan", p_blue: "Blue",
    p_indigo: "Indigo", p_violet: "Violet", p_pink: "Pink", p_slate: "Slate",
  },
  "zh-TW": {
    menu: "顏色…", title: "{0} 的顏色", colour: "顏色", custom: "自訂", hex: "色碼", noPick: "不指定",
    places: "顯示位置", place_name: "名稱", place_bar: "左側色條", place_ring: "頭像外框", useDefault: "使用這台主機的預設位置",
    src_person: "目前顯示：有人挑選的顏色。", src_agent: "目前顯示：agent 自己的顏色。", src_role: "目前顯示：它的 bot 在 Discord 身分組的顏色。",
    src_auto: "目前顯示：自動配色。", save: "儲存", cancel: "取消", reset: "重設",
    saved: "已儲存 {0} 的顏色", failed: "無法儲存顏色：{0}",
    offNote: "這台主機已關閉顏色（設定 → 網頁外觀）。在這裡挑的顏色會保留，重新開啟後就會出現。",
    p_red: "紅", p_orange: "橙", p_amber: "琥珀", p_lime: "萊姆", p_green: "綠", p_teal: "青綠", p_cyan: "青", p_blue: "藍",
    p_indigo: "靛", p_violet: "紫", p_pink: "粉紅", p_slate: "石板灰",
  },
});
