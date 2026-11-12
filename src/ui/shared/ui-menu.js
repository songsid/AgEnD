// #1408 §7: the ⋯ menu — a button and a list of actions. Arrow keys move, Enter/Space choose, Esc closes and puts focus
// back on the button. Esc inside the menu is the menu's: it never reaches the app (e.g. never stops an agent's reply).
import { html, useEffect, useLayoutEffect, useRef, useState } from "./app-html.js";
import { Icon } from "./ui-icons.js";
import { t } from "./app-i18n.js";

/**
 * items: [{ key, label, icon?, onSelect, danger?, disabled? }] (falsy entries are skipped). `checked` makes a radio item;
 * `checkbox: true` with `checked` a checkbox item (#2217 hotfix: the chat's card menu), which toggles and keeps the menu
 * open. `active`: the button shows a pressed look (what it controls is on), without changing its role.
 * Optional `trigger` and `triggerClass` customize the button content and styling; `label` remains its accessible name.
 */
export function Menu({ items, label, icon = "more", cls = "", active = false, trigger, triggerClass = "icon-btn", disabled = false, fit = false, topLayer = false, ownerKey, inactive = false, onOpen, leading }) {
  const [open, setOpen] = useState(false);
  const [placement,setPlacement] = useState("");
  const btn = useRef(null), list = useRef(null);
  const shown = (items || []).filter(Boolean);
  const anchored = topLayer && open && typeof getComputedStyle === "function" && getComputedStyle(document.documentElement).getPropertyValue("--agent-menu-version").trim() === "1";
  useLayoutEffect(() => { setOpen(false); }, [ownerKey]);
  useLayoutEffect(() => { if (inactive) setOpen(false); }, [inactive]);
  useLayoutEffect(() => {
    if (!open || !fit || !btn.current?.getBoundingClientRect || !list.current) return;
    const menu = list.current;
    if (anchored) menu.showPopover?.(); // escape the sidebar's scrolling clip; the same Menu keeps focus/ownership
    const place = () => {
      if (!btn.current || !list.current) return;
      const rect = btn.current.getBoundingClientRect();
      const boundary = btn.current.closest?.(".dlg-body")?.getBoundingClientRect();
      const top = Math.max(0,boundary?.top || 0), bottom = Math.min(window.innerHeight,boundary?.bottom || window.innerHeight);
      const above = rect.top-top-8, below = bottom-rect.bottom-8;
      const up = below < Math.min(list.current.scrollHeight || 280,280) && above > below;
      const available = up ? above : below;
      setPlacement(`${up ? " menu-up" : ""}${available < 180 ? " menu-short" : available < 280 ? " menu-compact" : ""}`);
      if (anchored) {
        menu.style.setProperty("--menu-available", `${Math.max(44, available)}px`);
        const popup = menu.getBoundingClientRect();
        menu.style.setProperty("--menu-x", `${Math.max(8, Math.min(rect.right - popup.width, window.innerWidth - popup.width - 8))}px`);
        menu.style.setProperty("--menu-y", `${Math.max(8, up ? rect.top - popup.height - 4 : rect.bottom + 4)}px`);
        return;
      }
      list.current.style.setProperty("--menu-shift", "0px");
      const popup = list.current.getBoundingClientRect();
      const shift = Math.max(8 - popup.left, Math.min(0, window.innerWidth - 8 - popup.right));
      list.current.style.setProperty("--menu-shift", `${shift}px`);
    };
    place();
    window.addEventListener("resize",place);
    if (anchored) window.addEventListener("scroll",place,true);
    return () => { window.removeEventListener("resize",place); if (anchored) { window.removeEventListener("scroll",place,true); if (menu.isConnected) menu.hidePopover?.(); } };
  },[open,fit,anchored]);
  useEffect(() => {
    if (!open || disabled) { if (open && disabled) setOpen(false); return undefined; }
    const first = list.current && list.current.querySelector("[role=menuitem]:not([disabled]), [role=menuitemradio]:not([disabled]), [role=menuitemcheckbox]:not([disabled])");
    if (first) first.focus({ preventScroll: true });
    const outside = (e) => { if (list.current && !list.current.contains(e.target) && btn.current && !btn.current.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, disabled]);
  function onKey(e) {
    if (e.target.closest?.("dialog[open]")) return;
    if (e.target.closest?.("[role=menu]") !== list.current) return; // a nested card menu owns its own keys
    const all = [...list.current.querySelectorAll("[role=menuitem]:not([disabled]), [role=menuitemradio]:not([disabled]), [role=menuitemcheckbox]:not([disabled])")];
    const i = all.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current && btn.current.focus({ preventScroll: true }); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); document.activeElement?.click(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); (all[(i + 1) % all.length] || all[0])?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (all[(i - 1 + all.length) % all.length] || all[0])?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); all[all.length - 1]?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  }
  function choose(item) { if (disabled || item.disabled) return; setOpen(false); btn.current && btn.current.focus({ preventScroll: true }); item.onSelect(); }
  return html`<div class=${`menu ${cls}`}>
    <button ref=${btn} type="button" class=${`${triggerClass}${active ? " active" : ""}`} aria-haspopup="menu" aria-expanded=${open ? "true" : "false"} disabled=${disabled}
      aria-label=${label || t("app.more")} title=${label || t("app.more")} onClick=${() => { if (!disabled) { if (!open) onOpen?.(); setOpen(!open); } }}
      onKeyDown=${(e) => { if (!disabled && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); onOpen?.(); setOpen(true); } }}>${trigger === undefined ? html`<${Icon} name=${icon} />` : trigger}</button>
    ${open && !disabled ? html`<div data-trust="menu" ref=${list} popover=${anchored ? "manual" : undefined} class=${`menu-list${anchored ? " menu-anchored" : ""}${fit ? placement : ""}`} role="menu" aria-label=${label || t("app.more")} onKeyDown=${onKey}>
      ${leading || null}
      ${shown.map(item => item.heading
        ? html`<div key=${item.key} class="menu-heading" role="presentation">${item.label}</div>`
        : item.checkbox
          ? html`<button key=${item.key} type="button" role="menuitemcheckbox" aria-checked=${item.checked ? "true" : "false"} class="menu-item menu-radio"
            title=${item.title} disabled=${!!item.disabled} onClick=${() => item.onSelect()}><span class="menu-tick" aria-hidden="true">${item.icon ? html`<${Icon} name=${item.icon} size=${16} />` : item.checked ? html`<${Icon} name="check" size=${16} />` : null}</span><span>${item.label}</span>${item.icon && item.checked ? html`<span class="menu-state" aria-hidden="true"><${Icon} name="check" size=${14} /></span>` : null}</button>`
        : item.checked !== undefined
          // #2196: one of a group of choices (Page colours): a radio item, the chosen one ticked.
          ? html`<button key=${item.key} type="button" role="menuitemradio" aria-checked=${item.checked ? "true" : "false"} class="menu-item menu-radio"
            title=${item.title} disabled=${!!item.disabled} onClick=${() => choose(item)}><span class="menu-tick" aria-hidden="true">${item.icon ? html`<${Icon} name=${item.icon} size=${16} />` : item.checked ? html`<${Icon} name="check" size=${16} />` : null}</span><span>${item.label}</span>${item.icon && item.checked ? html`<span class="menu-state" aria-hidden="true"><${Icon} name="check" size=${14} /></span>` : null}</button>`
          : html`<button key=${item.key} type="button" role="menuitem" class=${`menu-item${item.danger ? " danger" : ""}`}
            title=${item.title} disabled=${!!item.disabled} onClick=${() => choose(item)}>${item.icon ? html`<${Icon} name=${item.icon} cls=${item.iconClass || ""} size=${16} />` : null}<span>${item.label}</span></button>`)}
    </div>` : null}
  </div>`;
}
Menu.workspaceVersion = 1;
