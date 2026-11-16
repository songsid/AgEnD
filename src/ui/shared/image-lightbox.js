// A chat image, full size, in the page: a dark overlay with the image fitted to the viewport, ✕ to close, a click on
// the dark area or Esc closes it too, and focus goes back to the thumbnail. "Open original" opens the same URL in a
// new tab (the thumbnail's link, unchanged: a ctrl-, meta-, shift- or middle-click on it still does what the browser
// does). Several images: previous / next, and the arrow keys — M-3210: every picture in this chat, in message order (it
// was the clicked message's alone), from the first to the last (no wrap). On a phone a picture that fits swipes:
// sideways to the previous or next one, up or down to close, the backdrop fading as it is pulled (image-zoom.js).
//
// The native <dialog> opened with showModal(): the browser traps focus and makes the rest inert. No style attribute
// (#1300): classes only. Only a file URL the chat itself rendered (/ui/file/<32 hex>, or a Hub room's
// /hub/v1/rooms/<uuid>/files/<uuid>/inline) is ever shown.
//
// #2333: zoom and pan (image-zoom.js). The toolbar has −, the level (it toggles fit ↔ 100%), + and Fit width; the keys
// + / − / 0 (fit) / 1 (100%) / W (fit width). Each image opens fitted; stepping to another fits it again.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { createStore, useStore } from "/assets/app-store.js";
import { Icon } from "/assets/ui-icons.js";
import { createZoom, STEP } from "./image-zoom.js";

// M-3125 PR3: or a Hub room's own picture, at its inline route (the Hub's page only; the Fleet chat never renders one).
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FILE_URL = new RegExp(`^(?:/ui/file/[0-9a-f]{32}|/hub/v1/rooms/${UUID_RE}/files/${UUID_RE}/inline)$`);
// #3727: the viewer's own word for the annotate button (here, so an older cached chat dictionary is never shown a raw key).
register("lbAnnotate", { en: { open: "Annotate", failed: "The annotation tools could not be loaded. Reload this page to try again." },
  "zh-TW": { open: "標註", failed: "無法載入標註工具。請重新整理頁面再試。" } });
/** The annotation editor, loaded on the first 「標註」 (its module and stylesheet stay out of every other page load). */
const loadAnnotate = () => import("./image-annotate.js");
/** What is shown: { items: [{ src, name }], index, opener } or null. One per page; the chat that shows it owns it. */
export const lightboxStore = createStore({ open: null });
let seq = 0;

/**
 * The images of a message, from its thumbnails' links; `index` the one clicked. Anything that is not a chat file URL
 * is left out (and nothing opens if the clicked one is not).
 */
export function openLightbox(links, clicked, annotate = null) {
  const items = [], thumbs = [];   // thumbs[i]: items[i]'s thumbnail (focus goes back to the one last shown)
  let index = -1;
  for (const a of links) {
    const src = a.getAttribute("href") || "";
    if (!FILE_URL.test(src)) continue;
    if (a === clicked) index = items.length;
    const img = a.querySelector("img");
    items.push({ src, name: (img && img.getAttribute("alt")) || "" });
    thumbs.push(a);
  }
  if (index < 0) return false;
  // #3727: `annotate` — { targets: [{ key, label, quote(file) }], notice(text) } — only from a chat that can quote.
  lightboxStore.set({ open: { items, thumbs, index, opener: clicked, seq: ++seq, annotate: annotate && annotate.targets?.length ? annotate : null } });
  return true;
}
/**
 * Close it — the one way every close goes: ✕, the dark area, Esc, the dialog's own close (the browser's, a form with
 * method=dialog), the chat leaving. The store is the truth; unmounting the dialog is the one cleanup (scroll unlocked,
 * focus back on the thumbnail). `seq`: only that lightbox — a late close of one already replaced closes nothing.
 */
export function closeLightbox(seq) {
  const open = lightboxStore.get().open;
  if (open && (seq === undefined || open.seq === seq)) lightboxStore.set({ open: null });
}

/** Rendered by the chat; gone with it (another instance, another panel). */
export function LightboxHost({ owner } = {}) {
  const { open } = useStore(lightboxStore);
  const owned = useRef(null);
  const mine = !owner || owner.current?.contains(open?.opener);
  if (open && mine) owned.current = open.seq;
  useEffect(() => () => {
    if (!owner) closeLightbox();
    else if (owned.current !== null) closeLightbox(owned.current);
  }, []);
  return open && mine ? html`<${ImageLightbox} key=${open.seq} items=${open.items} thumbs=${open.thumbs || []} index=${open.index} opener=${open.opener} annotate=${open.annotate} onClose=${() => closeLightbox(open.seq)} />` : null;
}

function ImageLightbox({ items, thumbs = [], index, opener, annotate = null, onClose }) {
  const [at, setAt] = useState(index);
  const ref = useRef(null);
  const close = useRef(null);
  const stage = useRef(null);
  const img = useRef(null);
  const zoom = useRef(null);
  const [level, setLevel] = useState(null);   // { scale, fit, mode } once the picture has loaded
  const item = items[at] || items[0];
  const many = items.length > 1;
  // #3727: the editor's component once 「標註」 has loaded it; while it shows, the viewer's own keys stand aside.
  const [Editor, setEditor] = useState(null);
  const editing = !!Editor;
  const startAnnotate = () => {
    // M-3168: shown once its stylesheet has arrived too (annotateCssReady settles on load, error or a bounded wait), so the
    // first open paints in its final layout. A module without it (an older cached one) opens as before.
    loadAnnotate().then((m) => {
      if (!(m && m.annotateV1 === true && typeof m.AnnotateEditor === "function")) throw new Error("old module");
      return Promise.resolve(typeof m.annotateCssReady === "function" ? m.annotateCssReady() : null).then(() => setEditor(() => m.AnnotateEditor));
    }).catch(() => annotate?.notice?.(t("lbAnnotate.failed")));
  };
  // M-3210: from the first to the last, no wrap — a chat's pictures are a line, not a ring.
  const step = (d) => setAt((n) => Math.min(items.length - 1, Math.max(0, n + d)));
  const atRef = useRef(at); atRef.current = at;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const via = useRef(0);                                         // the last step came by a swipe: ±1 (its slide), else 0
  useLayoutEffect(() => {
    const d = ref.current;
    const root = typeof document !== "undefined" ? document.documentElement : null;
    if (root) root.classList.add("lb-open");                 // the chat behind it does not scroll
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
    if (close.current && typeof close.current.focus === "function") close.current.focus();
    return () => {
      if (root) root.classList.remove("lb-open");
      if (d && d.open && typeof d.close === "function") d.close();
      // M-3210: back on the picture last shown — a swipe through the chat may end far from the one opened — else the opener.
      const shown = thumbs[atRef.current];
      const back = shown && typeof shown.focus === "function" && document.contains?.(shown) ? shown : opener;
      if (back && typeof back.focus === "function" && document.contains?.(back)) back.focus();
    };
  }, []);
  useEffect(() => {
    if (!stage.current || !img.current) return undefined;
    const d = ref.current;
    const pull = (p) => { if (d && d.style && typeof d.style.setProperty === "function") d.style.setProperty("--lb-pull", String(Math.round(p * 1000) / 1000)); };
    const z = createZoom({ stage: stage.current, img: img.current, onChange: setLevel,
      canSwipe: (dir) => atRef.current + dir >= 0 && atRef.current + dir < items.length,
      onSwipe: (dir) => { via.current = dir; step(dir); },
      onDismiss: () => closeRef.current(),
      onPull: pull });
    zoom.current = z;
    return () => { z.destroy(); zoom.current = null; };
  }, []);
  // Another image: hidden until it has loaded and been fitted (its load resets the zoom). A layout effect — in the same
  // commit that set the new src, before any load can arrive: a picture already in the cache (every thumbnail above it
  // has loaded) fires its load before a passive effect would run, and such an effect then hid it for good with the
  // level at "…" (the report on beta.24: Next "flashes once, then the next image is not visible"). A picture that is
  // already complete here (the same file again: no load comes) is fitted at once.
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    const el = img.current;
    if (el) el.classList.remove("lb-ready");
    setLevel(null);
    // A swipe's next picture slides in from the side it came from (app.css; none under reduced motion).
    const st = stage.current;
    if (st && st.classList && via.current) {
      const cls = via.current > 0 ? "lb-in-next" : "lb-in-prev";
      st.classList.remove("lb-in-next", "lb-in-prev");
      st.classList.add(cls);
      setTimeout(() => st.classList.remove(cls), 260);
    }
    via.current = 0;
    if (el && el.complete && el.naturalWidth > 0 && zoom.current) zoom.current.reset();
  }, [at]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return undefined;
    // Esc: the browser fires "cancel"; closing goes through the store so its state stays the truth.
    const onCancel = (e) => { e.preventDefault(); onClose(); };
    // The dialog closed by itself — the browser (a close request it did not ask about) or a form with method=dialog:
    // the same close as every other, so the store and the cleanup follow (#1558 review).
    const onNativeClose = () => onClose();
    // The dark area (the dialog itself, or the stage around the image) closes it; the image and the controls do not.
    const onClick = (e) => { if (e.target === d || (e.target && e.target.classList && e.target.classList.contains("lb-stage"))) onClose(); };
    const onKey = (e) => {
      if (editing) return;                                     // the editor's keys (tools, colours, undo) are its own
      const z = zoom.current;
      if (z && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const act = { "+": () => z.zoomBy(STEP), "=": () => z.zoomBy(STEP), "-": () => z.zoomBy(1 / STEP), "_": () => z.zoomBy(1 / STEP),
          "0": () => z.fit(), "1": () => z.actual(), w: () => z.fitWidth(), W: () => z.fitWidth() }[e.key];
        if (act) { e.preventDefault(); act(); return; }
      }
      if (!many) return;
      if (e.key === "ArrowRight") { e.preventDefault(); step(1); } else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    };
    d.addEventListener("cancel", onCancel);
    d.addEventListener("close", onNativeClose);
    d.addEventListener("click", onClick);
    d.addEventListener("keydown", onKey);
    return () => { d.removeEventListener("cancel", onCancel); d.removeEventListener("close", onNativeClose); d.removeEventListener("click", onClick); d.removeEventListener("keydown", onKey); };
  }, [onClose, many, items.length, editing]);
  const label = item.name ? t("chat.lbLabel", item.name) : t("chat.lbLabelNoName");
  const pct = level ? Math.round(level.scale * 100) : null;
  if (editing) {
    return html`<dialog data-trust="lightbox" ref=${ref} class="lb lb-annotating" role="dialog" aria-modal="true" aria-label=${label}>
      <${Editor} src=${item.src} name=${item.name} targets=${annotate.targets} onClose=${onClose} onError=${(text) => annotate.notice?.(text)} />
    </dialog>`;
  }
  return html`<dialog data-trust="lightbox" ref=${ref} class="lb" role="dialog" aria-modal="true" aria-label=${label}>
    <div class="lb-bar">
      <span class="lb-name" title=${item.name}>${item.name}</span>
      ${many ? html`<span class="lb-count">${t("chat.lbCount", at + 1, items.length)}</span>` : null}
      <span class="lb-zoom" role="group">
        <button type="button" class="icon-btn lb-zoom-out" disabled=${!level} aria-label=${t("chat.lbZoomOut")} title=${t("chat.lbZoomOut")}
          onClick=${() => zoom.current && zoom.current.zoomBy(1 / STEP)}><${Icon} name="minus" /></button>
        <button type="button" class="btn btn-sm lb-level" disabled=${!level} aria-label=${t("chat.lbZoomLevel", pct ?? "")} title=${t("chat.lbZoomLevel", pct ?? "")}
          onClick=${() => zoom.current && zoom.current.toggle()}>${pct === null ? "…" : `${pct}%`}</button>
        <button type="button" class="icon-btn lb-zoom-in" disabled=${!level} aria-label=${t("chat.lbZoomIn")} title=${t("chat.lbZoomIn")}
          onClick=${() => zoom.current && zoom.current.zoomBy(STEP)}><${Icon} name="plus" /></button>
        <button type="button" class=${`icon-btn lb-fit-width${level && level.mode === "width" ? " on" : ""}`} disabled=${!level} aria-pressed=${level && level.mode === "width" ? "true" : "false"}
          aria-label=${t("chat.lbFitWidth")} title=${t("chat.lbFitWidth")} onClick=${() => zoom.current && zoom.current.fitWidth()}><${Icon} name="fitwidth" /></button>
      </span>
      ${annotate ? html`<button type="button" class="btn btn-sm lb-annotate" aria-label=${t("lbAnnotate.open")} title=${t("lbAnnotate.open")} onClick=${startAnnotate}><${Icon} name="edit" size=${14} /><span class="lbl">${t("lbAnnotate.open")}</span></button>` : null}
      <a class="btn btn-sm lb-orig" href=${item.src} target="_blank" rel="noopener noreferrer"><${Icon} name="external" size=${14} /><span class="lbl">${t("chat.lbOpenOriginal")}</span></a>
      <button type="button" class="icon-btn lb-close" ref=${close} aria-label=${t("chat.lbClose")} title=${t("chat.lbClose")} onClick=${onClose}><${Icon} name="close" /></button>
    </div>
    <div class="lb-stage" ref=${stage}><img class="lb-img" ref=${img} src=${item.src} alt=${item.name} draggable=${false} /></div>
    ${many ? html`<button type="button" class="icon-btn lb-nav lb-prev" disabled=${at === 0} aria-label=${t("chat.lbPrev")} title=${t("chat.lbPrev")} onClick=${() => step(-1)}><${Icon} name="back" /></button>
      <button type="button" class="icon-btn lb-nav lb-next" disabled=${at === items.length - 1} aria-label=${t("chat.lbNext")} title=${t("chat.lbNext")} onClick=${() => step(1)}><${Icon} name="forward" /></button>` : null}
  </dialog>`;
}

LightboxHost.paneOwner = true;
