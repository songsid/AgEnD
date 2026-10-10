// A chat image, full size, in the page: a dark overlay with the image fitted to the viewport, ✕ to close, a click on
// the dark area or Esc closes it too, and focus goes back to the thumbnail. "Open original" opens the same URL in a
// new tab (the thumbnail's link, unchanged: a ctrl-, meta-, shift- or middle-click on it still does what the browser
// does). Several images in one message: previous / next, and the arrow keys.
//
// The native <dialog> opened with showModal(): the browser traps focus and makes the rest inert. No style attribute
// (#1300): classes only. Only a file URL the chat itself rendered (/ui/file/<32 hex>) is ever shown.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { createStore, useStore } from "/assets/app-store.js";
import { Icon } from "/assets/ui-icons.js";

const FILE_URL = /^\/ui\/file\/[0-9a-f]{32}$/;
/** What is shown: { items: [{ src, name }], index, opener } or null. One per page; the chat that shows it owns it. */
export const lightboxStore = createStore({ open: null });
let seq = 0;

/**
 * The images of a message, from its thumbnails' links; `index` the one clicked. Anything that is not a chat file URL
 * is left out (and nothing opens if the clicked one is not).
 */
export function openLightbox(links, clicked) {
  const items = [];
  let index = -1;
  for (const a of links) {
    const src = a.getAttribute("href") || "";
    if (!FILE_URL.test(src)) continue;
    if (a === clicked) index = items.length;
    const img = a.querySelector("img");
    items.push({ src, name: (img && img.getAttribute("alt")) || "" });
  }
  if (index < 0) return false;
  lightboxStore.set({ open: { items, index, opener: clicked, seq: ++seq } });
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
export function LightboxHost() {
  const { open } = useStore(lightboxStore);
  useEffect(() => () => closeLightbox(), []);
  return open ? html`<${ImageLightbox} key=${open.seq} items=${open.items} index=${open.index} opener=${open.opener} onClose=${() => closeLightbox(open.seq)} />` : null;
}

function ImageLightbox({ items, index, opener, onClose }) {
  const [at, setAt] = useState(index);
  const ref = useRef(null);
  const close = useRef(null);
  const item = items[at] || items[0];
  const many = items.length > 1;
  const step = (d) => setAt((n) => (n + d + items.length) % items.length);
  useLayoutEffect(() => {
    const d = ref.current;
    const root = typeof document !== "undefined" ? document.documentElement : null;
    if (root) root.classList.add("lb-open");                 // the chat behind it does not scroll
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
    if (close.current && typeof close.current.focus === "function") close.current.focus();
    return () => {
      if (root) root.classList.remove("lb-open");
      if (d && d.open && typeof d.close === "function") d.close();
      if (opener && typeof opener.focus === "function" && document.contains?.(opener)) opener.focus();
    };
  }, []);
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
      if (!many) return;
      if (e.key === "ArrowRight") { e.preventDefault(); step(1); } else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    };
    d.addEventListener("cancel", onCancel);
    d.addEventListener("close", onNativeClose);
    d.addEventListener("click", onClick);
    d.addEventListener("keydown", onKey);
    return () => { d.removeEventListener("cancel", onCancel); d.removeEventListener("close", onNativeClose); d.removeEventListener("click", onClick); d.removeEventListener("keydown", onKey); };
  }, [onClose, many, items.length]);
  const label = item.name ? t("chat.lbLabel", item.name) : t("chat.lbLabelNoName");
  return html`<dialog ref=${ref} class="lb" role="dialog" aria-modal="true" aria-label=${label}>
    <div class="lb-bar">
      <span class="lb-name" title=${item.name}>${item.name}</span>
      ${many ? html`<span class="lb-count">${t("chat.lbCount", at + 1, items.length)}</span>` : null}
      <a class="btn btn-sm lb-orig" href=${item.src} target="_blank" rel="noopener noreferrer"><${Icon} name="external" size=${14} /><span class="lbl">${t("chat.lbOpenOriginal")}</span></a>
      <button type="button" class="icon-btn lb-close" ref=${close} aria-label=${t("chat.lbClose")} title=${t("chat.lbClose")} onClick=${onClose}><${Icon} name="close" /></button>
    </div>
    <div class="lb-stage"><img class="lb-img" src=${item.src} alt=${item.name} /></div>
    ${many ? html`<button type="button" class="icon-btn lb-nav lb-prev" aria-label=${t("chat.lbPrev")} title=${t("chat.lbPrev")} onClick=${() => step(-1)}><${Icon} name="back" /></button>
      <button type="button" class="icon-btn lb-nav lb-next" aria-label=${t("chat.lbNext")} title=${t("chat.lbNext")} onClick=${() => step(1)}><${Icon} name="forward" /></button>` : null}
  </dialog>`;
}
