// #1629 r4 §1 / r4.1 Q3 (a): an instance's identity card — banner, portrait, tagline, bio — as the host resolves it
// (GET /api/card/<name>: the person's fields over the agent's). Shown on Details, in View, and folded into the agent's
// own chat header. Public (/assets/): View's anonymous reader sees cards too.
//
// Nothing the agent wrote is markup: the tagline and bio are text nodes (never linkified), the pictures are same-origin
// <img> elements whose URLs are checked here again, and sizes are class tokens only (card-s | card-m | card-l, heights in
// app.css) — no style attribute, no CSSOM size (#1300). The size is a viewer's choice: every card's default
// (`card.size`) and the cards set apart from it (`card.sizeByInstance`, at most 200), synced like the other preferences.
import { html, useEffect, useState } from "./app-html.js";
import { t } from "./app-i18n.js";
import { createStore, useStore } from "./app-store.js";
import { onPrefsChanged, prefInForce, savePref } from "./app-prefs.js";
import "./card-strings.js";

export const CARD_SIZES = ["s", "m", "l"];
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

/**
 * The card. `compact`: the chat header's own small size (no size control). Nothing when the card is empty. The
 * tagline and bio say whose they are (title), since a person's field wins over the agent's.
 */
export function IdentityCard({ name, card, compact = false, sizeControl = !compact }) {
  useStore(cardSizeStore);
  const [broken, setBroken] = useState({});
  if (!card) return null;
  const size = compact ? "c" : cardSizeFor(name);
  const whose = (f) => t(f.by === "human" ? "card.byHuman" : "card.byAgent");
  const pic = (slot, cls, alt) => card[slot] && broken[slot] !== card[slot].src
    ? html`<img class=${cls} src=${card[slot].src} alt=${alt} title=${whose(card[slot])} decoding="async" onError=${() => setBroken({ ...broken, [slot]: card[slot].src })} />` : null;
  return html`<section class=${`id-card card-${size}`} aria-label=${t("card.label", name)}>
    ${pic("banner", "id-banner", "")}
    <div class="id-row">
      ${pic("portrait", "id-portrait", t("card.portraitAlt", name))}
      <div class="id-text">
        ${card.tagline ? html`<p class="id-tagline" title=${whose(card.tagline)}>${card.tagline.text}</p>` : null}
        ${card.bio ? html`<p class="id-bio" title=${whose(card.bio)}>${card.bio.text}</p>` : null}
      </div>
      ${sizeControl ? html`<${SizeControl} name=${name} size=${size} />` : null}
    </div>
  </section>`;
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
