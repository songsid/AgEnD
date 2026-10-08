// #1408 §7: one dialog for the whole app — the native <dialog> opened with showModal(), so the browser traps focus,
// makes the rest inert and closes it on Esc. Focus goes back to whatever opened it. On a phone it is a bottom sheet
// with its own × (app.css). Text and buttons only; no style attribute (#1300).
import { html, useEffect, useLayoutEffect, useRef } from "./app-html.js";
import { Icon } from "./ui-icons.js";
import { t } from "./app-i18n.js";

/**
 * <${Dialog} title="Create task" onClose=${…} actions=${html`…`}>…body…</${Dialog}>
 * Rendered = open; the parent unmounts it to close. `busy` keeps Esc and the backdrop from closing it mid-request.
 */
export function Dialog({ title, onClose, actions, children, busy = false, wide = false, label }) {
  const ref = useRef(null);
  const opener = useRef(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useLayoutEffect(() => {
    const d = ref.current;
    opener.current = typeof document !== "undefined" ? document.activeElement : null;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
    return () => {
      if (d && d.open && typeof d.close === "function") d.close();
      const back = opener.current;
      if (back && typeof back.focus === "function" && document.contains?.(back)) back.focus();
    };
  }, []);
  useEffect(() => {
    const d = ref.current;
    if (!d) return undefined;
    // Esc: the browser fires "cancel"; we close through the parent so its state stays the truth.
    const onCancel = (e) => { e.preventDefault(); if (!busyRef.current) onClose(); };
    // A click on the backdrop lands on the <dialog> element itself, outside its inner box.
    const onClick = (e) => { if (e.target === d && !busyRef.current) onClose(); };
    d.addEventListener("cancel", onCancel);
    d.addEventListener("click", onClick);
    return () => { d.removeEventListener("cancel", onCancel); d.removeEventListener("click", onClick); };
  }, [onClose]);
  return html`<dialog ref=${ref} class=${`dlg${wide ? " dlg-wide" : ""}`} aria-label=${label || title}>
    <div class="dlg-box">
      <div class="dlg-head"><h2 class="dlg-title">${title}</h2>
        <button type="button" class="icon-btn dlg-x" aria-label=${t("app.close")} title=${t("app.close")} onClick=${() => { if (!busyRef.current) onClose(); }}><${Icon} name="close" /></button></div>
      <div class="dlg-body">${children}</div>
      ${actions ? html`<div class="dlg-actions">${actions}</div>` : null}
    </div></dialog>`;
}
