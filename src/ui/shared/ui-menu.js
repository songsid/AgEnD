// #1408 §7: the ⋯ menu — a button and a list of actions. Arrow keys move, Enter/Space choose, Esc closes and puts focus
// back on the button. Esc inside the menu is the menu's: it never reaches the app (e.g. never stops an agent's reply).
import { html, useEffect, useRef, useState } from "./app-html.js";
import { Icon } from "./ui-icons.js";
import { t } from "./app-i18n.js";

/** items: [{ key, label, icon?, onSelect, danger?, disabled? }] (falsy entries are skipped). */
export function Menu({ items, label, icon = "more", cls = "" }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null), list = useRef(null);
  const shown = (items || []).filter(Boolean);
  useEffect(() => {
    if (!open) return undefined;
    const first = list.current && list.current.querySelector("[role=menuitem]:not([disabled])");
    if (first) first.focus();
    const outside = (e) => { if (list.current && !list.current.contains(e.target) && btn.current && !btn.current.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  function onKey(e) {
    const all = [...list.current.querySelectorAll("[role=menuitem]:not([disabled])")];
    const i = all.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current && btn.current.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); (all[(i + 1) % all.length] || all[0])?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (all[(i - 1 + all.length) % all.length] || all[0])?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); all[all.length - 1]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  }
  function choose(item) { setOpen(false); btn.current && btn.current.focus(); item.onSelect(); }
  return html`<div class=${`menu ${cls}`}>
    <button ref=${btn} type="button" class="icon-btn" aria-haspopup="menu" aria-expanded=${open ? "true" : "false"}
      aria-label=${label || t("app.more")} title=${label || t("app.more")} onClick=${() => setOpen(!open)}><${Icon} name=${icon} /></button>
    ${open ? html`<div ref=${list} class="menu-list" role="menu" aria-label=${label || t("app.more")} onKeyDown=${onKey}>
      ${shown.map(item => html`<button key=${item.key} type="button" role="menuitem" class=${`menu-item${item.danger ? " danger" : ""}`}
        disabled=${!!item.disabled} onClick=${() => choose(item)}>${item.icon ? html`<${Icon} name=${item.icon} size=${16} />` : null}<span>${item.label}</span></button>`)}
    </div>` : null}
  </div>`;
}
