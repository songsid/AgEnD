// #1629 r4 §1 / r4.1 Q3 (a): an instance's identity card — banner, portrait, tagline, bio — as the host resolves it
// (GET /api/card/<name>: the person's fields over the agent's). Shown on Details, in View, and folded into the agent's
// own chat header. Public (/assets/): View's anonymous reader sees cards too.
//
// Nothing the agent wrote is markup: the tagline and bio are text nodes (never linkified), the pictures are same-origin
// <img> elements whose URLs are checked here again, and sizes are class tokens only (card-s | card-m | card-l, heights in
// app.css) — no style attribute, no CSSOM size (#1300). #2086: the banner's focus is a position, not a size: one custom
// property set through the CSSOM (`--id-focus`), and the banner is never drawn wider than BANNER_MAX_ASPECT : 1. The size is a viewer's choice: every card's default
// (`card.size`) and the cards set apart from it (`card.sizeByInstance`, at most 200), synced like the other preferences.
import { html, useEffect, useState } from "./app-html.js";
import { t } from "./app-i18n.js";
import { createStore, useStore } from "./app-store.js";
import { onPrefsChanged, prefInForce, savePref } from "./app-prefs.js";
import { Icon } from "./ui-icons.js";
import "./card-strings.js";

export const CARD_SIZES = ["s", "m", "l"];
/**
 * #2086: the widest a banner is ever drawn (width : height) — app.css caps its width at this many times its size's
 * tallest height. So the band of the picture shown everywhere is (picture's aspect ÷ this) of its height, at the focus.
 */
export const BANNER_MAX_ASPECT = 5;
/**
 * #2086 (#2089 review): the narrowest a card draws its banner — 9 : 4 (app.css caps a banner's height at its box's width ÷ 2.25, on
 * every layout) — which crops a wide picture's sides. Every card is between this and BANNER_MAX_ASPECT, so the area shown on every screen is
 * the narrowest box's width (centred) × the widest box's height (at the focus).
 */
export const BANNER_MIN_ASPECT = 9 / 4;
/** The share of a picture's height a box of `boxAspect` shows (1: all of it; a narrower box crops the sides instead). */
export const bannerShownHeight = (pictureAspect, boxAspect) => Math.min(1, pictureAspect / boxAspect);
/** The share of a picture's width a box of `boxAspect` shows, centred (1: all of it). */
export const bannerShownWidth = (pictureAspect, boxAspect) => Math.min(1, boxAspect / pictureAspect);
/** The area every screen shows, as shares of the picture: { left, top, width, height } at focus `f`. */
export function bannerSafeArea(pictureAspect, f) {
  const width = bannerShownWidth(pictureAspect, BANNER_MIN_ASPECT), height = bannerShownHeight(pictureAspect, BANNER_MAX_ASPECT);
  return { left: (1 - width) / 2, top: bannerBandTop(height, f), width, height };
}
/** That band's top, as a share of the picture's height, at focus `f` (0–100) — object-position's own rule. */
export const bannerBandTop = (shown, f) => (1 - shown) * (f / 100);
export const MAX_CARD_SIZES = 200;
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const readLocal = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

/** Bumped whenever a size choice changes (here or on another device), so cards redraw. */
export const cardSizeStore = createStore({ n: 0 });
const bump = () => cardSizeStore.set((s) => ({ n: s.n + 1 }));
onPrefsChanged((changed) => { if (changed.has("card.size") || changed.has("card.sizeByInstance")) bump(); });

/** Every card's size unless set apart: the person's choice, else M. */
export function cardSizeDefault() {
  const f = prefInForce("card.size");
  const v = f ? f.value : readLocal("agend_card_size");
  return CARD_SIZES.includes(v) ? v : "m";
}
function overrides() {
  const f = prefInForce("card.sizeByInstance");
  let v = f ? f.value : undefined;
  if (!f) { try { v = JSON.parse(readLocal("agend_card_sizes") || "null"); } catch { v = null; } }
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
/** The size `name`'s card is drawn at: its own, else the default. */
export function cardSizeFor(name) {
  const o = overrides();
  return own(o, name) && CARD_SIZES.includes(o[name]) ? o[name] : cardSizeDefault();
}
/**
 * The size for one card (its own control). Choosing the default size removes its entry, so it follows the default
 * again; a new or changed entry goes last, and past 200 the oldest go.
 */
export function setCardSize(name, size) {
  if (!CARD_SIZES.includes(size)) return;
  const next = Object.create(null);
  for (const [k, v] of Object.entries(overrides())) if (k !== name) Object.defineProperty(next, k, { value: v, enumerable: true, writable: true, configurable: true });
  if (size !== cardSizeDefault()) Object.defineProperty(next, name, { value: size, enumerable: true, writable: true, configurable: true });
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CARD_SIZES))) delete next[k];
  const plain = {};
  for (const k of Object.keys(next)) Object.defineProperty(plain, k, { value: next[k], enumerable: true, writable: true, configurable: true });
  savePref("card.sizeByInstance", Object.keys(plain).length ? plain : null);
  bump();
}
/** Every card's default size (Settings → Appearance). M is the default, so choosing it clears the choice. */
export function setCardSizeDefault(size) {
  if (!CARD_SIZES.includes(size)) return;
  savePref("card.size", size === "m" ? null : size);
  bump();
}

// ── The card's data: read once per version (the status frame's / View roster's card_v) ──
/** { <name>: { v, epoch, card } } — card null until read; a failed read keeps the last one. */
export const cardsStore = createStore({});
const SRC = /^\/api\/card\/[^/?#\\]+\/(portrait|banner)\?v=[0-9a-f]{32}$/;
const ID = /^[0-9a-f]{32}$/;
/** What the host said, checked again: same-origin picture paths of this card, text as text. */
export function checkCard(name, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out = {};
  const base = `/api/card/${encodeURIComponent(name)}/`;
  for (const slot of ["portrait", "banner"]) {
    const p = body[slot];
    if (p && typeof p === "object" && typeof p.src === "string" && SRC.test(p.src) && p.src.startsWith(base + slot + "?") && ID.test(p.id) && (p.by === "human" || p.by === "agent")) out[slot] = { src: p.src, by: p.by };
  }
  // The host's bounds (web-theme.ts TAGLINE_MAX_UNITS / BIO_MAX_UNITS): anything it stores is shown.
  const MAX = { tagline: 600, bio: 2800 };
  for (const k of ["tagline", "bio"]) {
    const v = body[k];
    if (v && typeof v === "object" && typeof v.text === "string" && v.text.length && v.text.length <= MAX[k] && (v.by === "human" || v.by === "agent")) out[k] = { text: v.text, by: v.by };
  }
  // #2086: the banner's focus, a whole number 0 (top) … 100 (bottom).
  const f = body.banner_focus;
  if (f && typeof f === "object" && Number.isInteger(f.value) && f.value >= 0 && f.value <= 100 && (f.by === "human" || f.by === "agent")) out.banner_focus = { value: f.value, by: f.by };
  return Object.keys(out).length ? out : null;
}
// #1889 review: per instance, an epoch that moves whenever the version this page wants changes (a clear included).
// GET /api/card is not versioned — its body is whatever the host had then — so a read belongs to the epoch that started
// it: only a read of the current epoch is shared or applied, and an older read never touches its replacement.
const want = new Map();        // name → { epoch, v }
const inflight = new Map();    // name → { epoch, promise }
/** Read `name`'s card if `v` is newer than what this page has (no version: no card). */
export async function loadCard(name, v, fetcher = (u) => fetch(u, { credentials: "same-origin" })) {
  if (!name) return;
  const target = v || null;
  const cur = want.get(name);
  const epoch = cur && cur.v === target ? cur.epoch : (cur ? cur.epoch : 0) + 1;
  if (!cur || cur.v !== target) want.set(name, { epoch, v: target });
  const have = own(cardsStore.get(), name) ? cardsStore.get()[name] : null;
  if (!target) {
    if (have) cardsStore.set((s) => { const n = { ...s }; delete n[name]; return n; });
    return;
  }
  if (have && have.v === target && have.epoch === epoch) return;          // read in this epoch already
  const out = inflight.get(name);
  if (out && out.epoch === epoch) return out.promise;                       // this epoch's read is on its way
  const current = () => want.get(name)?.epoch === epoch;
  const entry = { epoch, promise: null };
  entry.promise = (async () => {
    try {
      const r = await fetcher(`/api/card/${encodeURIComponent(name)}`);
      if (!r.ok || !current()) return;
      const card = checkCard(name, await r.json());
      if (!current()) return;                                               // superseded or cleared while it was read
      cardsStore.set((s) => ({ ...s, [name]: { v: target, epoch, card } }));
    } catch { /* the next version tries again */ } finally { if (inflight.get(name) === entry) inflight.delete(name); }
  })();
  inflight.set(name, entry);
  return entry.promise;
}
/** `name`'s card for version `v` (null while none or not read yet). */
export function useCard(name, v) {
  const cards = useStore(cardsStore);
  useEffect(() => { loadCard(name, v); }, [name, v]);
  const c = name && own(cards, name) ? cards[name] : null;
  return c && c.v === v ? c.card : c ? c.card : null;
}

/** The S / M / L control (a segmented one): sets this card's size. */
function SizeControl({ name, size }) {
  return html`<div class="card-size" role="group" aria-label=${t("card.size")}>
    ${CARD_SIZES.map((s) => html`<button key=${s} type="button" class=${`seg-item${s === size ? " active" : ""}`} aria-pressed=${s === size ? "true" : "false"}
      title=${t(`card.size${s.toUpperCase()}Name`)} onClick=${() => setCardSize(name, s)}>${t(`card.size${s.toUpperCase()}`)}</button>`)}
  </div>`;
}

/** A small round control on the card (the chat's Hide card and Hide picture and bio). */
function CardControl({ cls, icon, label, onClick, expanded }) {
  return html`<button type="button" class=${`id-ctl ${cls}`} aria-label=${label} title=${label}
    aria-expanded=${expanded === undefined ? undefined : expanded ? "true" : "false"} onClick=${onClick}><${Icon} name=${icon} size=${16} /></button>`;
}

/**
 * The card. `compact`: the chat header's own small size (no size control; the banner still follows the size choice,
 * #2038). Nothing when the card is empty. The
 * tagline and bio say whose they are (title), since a person's field wins over the agent's.
 * #2217: the chat's controls, on the card itself (the user, 2026-10-19): `onHide` — Hide card, on the banner's top-right corner
 * (on the row when there is no banner); `onToggleRow` — hide the picture, tagline and bio and keep the banner, from the
 * row's bottom-right corner, and back from the banner's bottom-right while they are hidden (`rowHidden`). Only a card
 * with a banner and something on its row can fold its row (else it would be the card hidden).
 */
export function IdentityCard({ name, card, compact = false, sizeControl = !compact, onHide = null, rowHidden = false, onToggleRow = null }) {
  useStore(cardSizeStore);
  const [broken, setBroken] = useState({});
  if (!card) return null;
  const size = compact ? "c" : cardSizeFor(name);
  // #2038: the chat header's card is its own small size, but its banner follows the person's size choice too.
  const bannerSize = compact ? ` bs-${cardSizeFor(name)}` : "";
  const whose = (f) => t(f.by === "human" ? "card.byHuman" : "card.byAgent");
  const pic = (slot, cls, alt) => card[slot] && broken[slot] !== card[slot].src
    ? html`<img class=${cls} src=${card[slot].src} alt=${alt} title=${whose(card[slot])} decoding="async" onError=${() => setBroken({ ...broken, [slot]: card[slot].src })} />` : null;
  // #2086: the banner at its focus; on a screen wider than BANNER_MAX_ASPECT it is centred over a blurred copy of itself.
  const focus = card.banner_focus ? card.banner_focus.value : 50;
  const atFocus = (el) => { if (el && el.style) el.style.setProperty("--id-focus", `${focus}%`); };
  const banner = pic("banner", "id-banner", "");
  const portrait = pic("portrait", "id-portrait", t("card.portraitAlt", name));
  const foldable = !!(onToggleRow && banner && (portrait || card.tagline || card.bio));
  const rowShown = !(foldable && rowHidden);
  const hide = onHide ? html`<${CardControl} cls="id-hide" icon="eyeOff" label=${t("card.hide")} onClick=${onHide} />` : null;
  const fold = foldable ? html`<${CardControl} cls=${rowShown ? "id-fold" : "id-fold id-unfold"} icon=${rowShown ? "up" : "user"}
    label=${t(rowShown ? "card.hideRow" : "card.showRow")} expanded=${rowShown} onClick=${onToggleRow} />` : null;
  return html`<section class=${`id-card card-${size}${bannerSize}${rowShown ? "" : " row-hidden"}`} aria-label=${t("card.label", name)}>
    ${banner ? html`<div class="id-banner-box" ref=${atFocus}><img class="id-banner-fill" src=${card.banner.src} alt="" aria-hidden="true" decoding="async" />${banner}${hide}${rowShown ? null : fold}</div>` : null}
    ${rowShown ? html`<div class="id-row">
      ${portrait}
      <div class="id-text">
        ${card.tagline ? html`<p class="id-tagline" title=${whose(card.tagline)}>${card.tagline.text}</p>` : null}
        ${card.bio ? html`<p class="id-bio" title=${whose(card.bio)}>${card.bio.text}</p>` : null}
      </div>
      ${sizeControl ? html`<${SizeControl} name=${name} size=${size} />` : null}
      ${banner ? null : hide}${fold}
    </div>` : null}
  </section>`;
}

// ── #2086: the banner's focus, set in View's Edit profile — the whole picture, what each screen shows of it ──
/**
 * #2089 review: the picture the focus preview shows — a file just chosen (a blob URL this owns: released when another is
 * chosen and when the dialog closes) or the banner drawn now (a server URL, never released).
 */
export function useBannerPreview() {
  const [preview, setPreview] = useState(null);
  useEffect(() => () => { if (preview && preview.blob) { try { URL.revokeObjectURL(preview.blob); } catch { /* already gone */ } } }, [preview]);
  return [preview, {
    fromFile(file) { let url = null; try { url = URL.createObjectURL(file); } catch { return; } setPreview({ src: url, blob: url }); },
    fromSrc(src) { setPreview({ src }); },
  }];
}
/** A phone draws an M card's banner at about 3 : 1 (app.css, ≤479 px) — a guide for that size, not every phone card. */
export const BANNER_PHONE_ASPECT = 3;
/**
 * The banner whole, with the band every screen shows at this focus (dashed; outside it shaded) and the band a phone
 * shows (solid) — measured from the picture itself once it has loaded. Positions go through the CSSOM (#1300).
 */
export function BannerFocusPreview({ src, focus }) {
  const [size, setSize] = useState(null);
  if (!src) return null;
  const ar = size ? size.w / size.h : null;
  const put = (el, a) => { for (const k of ["left", "top", "width", "height"]) el.style.setProperty(k, `${(a[k] * 100).toFixed(2)}%`); };
  // Every screen: the safe area (both crops). The phone guide: an M card on a phone, as drawn there (both crops too).
  const safe = (el) => { if (el && el.style && ar) put(el, bannerSafeArea(ar, focus)); };
  const phone = (el) => {
    if (!el || !el.style || !ar) return;
    const width = bannerShownWidth(ar, BANNER_PHONE_ASPECT), height = bannerShownHeight(ar, BANNER_PHONE_ASPECT);
    put(el, { left: (1 - width) / 2, top: bannerBandTop(height, focus), width, height });
  };
  return html`<div class="bf-wrap">
    <img class="bf-pic" src=${src} alt="" onLoad=${(e) => { const i = e.currentTarget; if (i.naturalWidth && i.naturalHeight) setSize({ w: i.naturalWidth, h: i.naturalHeight }); }} />
    ${ar ? html`<div class="bf-band bf-phone" ref=${phone}><span>${t("card.bannerPhone")}</span></div>
      <div class="bf-band bf-safe" ref=${safe}><span>${t("card.bannerSafe")}</span></div>` : null}
  </div>`;
}

// ── A person's picture for the card (View's Edit profile), fitted before it is sent (r4.1 Q3 (b)) ──
/**
 * `file` fitted to `limit` ({ max_width, max_height, max_bytes }): as it is when it already fits; otherwise, once the
 * person agrees (`ask(w, h, nw, nh)`), drawn smaller and re-encoded as WebP (which also drops its metadata). The server
 * checks whatever is sent like any upload — this is a convenience, never the check. Returns the Blob to send, null when
 * the person declined, or throws when the picture cannot be read or made small enough.
 */
export async function fitPicture(file, limit, ask, io = browserImageIo) {
  const okType = /^image\/(png|jpeg|webp)$/.test(file.type);
  const bitmap = await io.decode(file);
  const w = bitmap.width, h = bitmap.height;
  if (okType && w <= limit.max_width && h <= limit.max_height && file.size <= limit.max_bytes) return file;
  let scale = Math.min(1, limit.max_width / w, limit.max_height / h);
  let nw = Math.max(1, Math.floor(w * scale)), nh = Math.max(1, Math.floor(h * scale));
  if (!(await ask(w, h, nw, nh))) return null;
  for (let tries = 0; tries < 6; tries++) {
    for (const quality of [0.9, 0.8, 0.7]) {
      const out = await io.encode(bitmap, nw, nh, quality);
      if (out && out.size <= limit.max_bytes) return out;
    }
    scale *= 0.8;
    nw = Math.max(1, Math.floor(w * scale)); nh = Math.max(1, Math.floor(h * scale));
  }
  throw new Error("too_large");
}
/** The browser's decoder and encoder: createImageBitmap (no URL, so img-src stays 'self') and a canvas to WebP (or JPEG). */
export const browserImageIo = {
  decode: (file) => createImageBitmap(file),
  encode: (bitmap, w, h, quality) => new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) { resolve(null); return; }
    ctx.drawImage(bitmap, 0, 0, w, h);
    // WebP where the browser encodes it; JPEG where it does not (it answers PNG then) — either drops the metadata.
    canvas.toBlob((b) => {
      if (b && b.type === "image/webp") { resolve(b); return; }
      canvas.toBlob((j) => resolve(j && j.type === "image/jpeg" ? j : null), "image/jpeg", quality);
    }, "image/webp", quality);
  }),
};
