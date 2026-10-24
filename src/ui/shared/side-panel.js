// #2585 (the user): settings-like editors docked on the right. On a screen wide enough for the usage rail (RAIL_MEDIA,
// #1673) an editor opens in the rail's place, beside the page — not modal: the page stays in view and in use (the
// Office re-fits beside it). While one is open the rail steps aside; it comes back as it was when the panel closes (its
// shown/hidden choice is never touched). Narrower, the same editor is the shared Dialog (centred; a phone's sheet).
//
// <${SidePanel} title=… onClose=… actions=… busy=…>…body…</${SidePanel}>: rendered = open, the owner unmounts it to
// close (like Dialog). Docked, the owner renders nothing itself: it publishes its title, body and actions to the shell's
// host (sidePanelStore) on every render, so the body keeps the owner's state and closures; the owner going (a close, a
// navigation) takes the panel with it. Esc in the panel and its × close it (not while `busy`); focus moves into it when
// it opens and goes back to what opened it when it closes. Docked, the body renders under the shell, not under its
// owner: a context provided above the owner does not reach it (pass what it needs as props, or read a store).
// `dirty`: the editor holds unsaved changes. Docked, the page beside it is in use (its links, search): leaving the page
// then closes the panel as Cancel does — and with changes, asks first (the app's leave guard; one at a time).
// `dock` false keeps it from docking (the Office in fullscreen, where the shell is out of view); `fallback`, when given,
// is what it is below the rail's width (or not docked) instead of the Dialog — Edit layout's bar over the canvas.
import { html, useEffect, useLayoutEffect, useRef } from "./app-html.js";
import { createStore, useStore } from "./app-store.js";
import { t } from "./app-i18n.js";
import { Icon } from "./ui-icons.js";
import { Dialog } from "./ui-dialog.js";
import { confirmDialog } from "./ui-confirm.js";
import { navigate, setLeaveGuard } from "./app-nav.js";
import { UsageRail, useRailWidth } from "./header-tools.js";

/** { panel: { id, title, label, body, actions, busy, onClose } | null } — the one docked panel. */
export const sidePanelStore = createStore({ panel: null });
let seq = 0;
const clear = (id) => { if (sidePanelStore.get().panel?.id === id) sidePanelStore.set({ panel: null }); };

/** An editor: docked on a wide screen, the shared Dialog (`wide`) elsewhere. */
export function SidePanel({ title, label, onClose, actions, busy = false, dirty = false, dock = true, fallback, children }) {
  const docked = useRailWidth() && dock;
  const id = useRef(0);
  if (!id.current) id.current = ++seq;
  const opener = useRef(undefined);
  if (opener.current === undefined) opener.current = typeof document !== "undefined" ? document.activeElement : null;
  useLayoutEffect(() => {
    if (docked) sidePanelStore.set({ panel: { id: id.current, title, label, body: children, actions, busy, onClose } });
    else clear(id.current);
  });
  useLayoutEffect(() => () => {
    const host = typeof document !== "undefined" ? document.querySelector(".side-panel") : null;
    const inside = !!host && (host.contains(document.activeElement) || document.activeElement === document.body);
    clear(id.current);
    // Focus back to what opened it — when it was in the panel (or nowhere): a person who moved on keeps their place.
    const back = opener.current;
    if ((inside || !host) && back && typeof back.focus === "function" && document.contains?.(back)) back.focus();
  }, []);
  // Leaving the page with changes in the docked panel: asked in the app's dialog; yes = Cancel, then on to there.
  const live = useRef(null);
  live.current = { title, onClose };
  useEffect(() => {
    if (!docked || !dirty) return undefined;
    let asking = false;
    return setLeaveGuard((_to, path) => {
      if (!asking) {
        asking = true;
        confirmDialog({ message: t("app.sidePanelLeave", live.current.title), confirmLabel: t("app.sidePanelDiscard"), danger: true }).then((yes) => {
          asking = false;
          if (!yes) return;
          live.current.onClose();
          navigate(path, { force: true });
        });
      }
      return false;
    });
  }, [docked, dirty]);
  if (docked) return null;
  if (fallback !== undefined) return fallback;
  return html`<${Dialog} title=${title} label=${label} onClose=${onClose} actions=${actions} busy=${busy} wide=${true}>${children}</${Dialog}>`;
}

/** The docked panel itself: a non-modal dialog in the rail's place. */
function SidePanelHost({ panel }) {
  const box = useRef(null);
  // Into the panel as it opens (its box: no ring; Tab moves on), once per panel.
  useLayoutEffect(() => { if (box.current && typeof box.current.focus === "function") box.current.focus({ preventScroll: true }); }, [panel.id]);
  const close = () => { if (!panel.busy) panel.onClose(); };
  const onKeyDown = (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); close(); } };
  return html`<dialog open data-trust="dialog" class="dlg side-panel" aria-label=${panel.label || panel.title} onKeyDown=${onKeyDown}>
    <div class="dlg-box" tabindex="-1" ref=${box}>
      <div class="dlg-head"><h2 class="dlg-title">${panel.title}</h2>
        <button type="button" class="icon-btn dlg-x" aria-label=${t("app.close")} title=${t("app.close")} onClick=${close}><${Icon} name="close" /></button></div>
      <div class="dlg-body">${panel.body}</div>
      ${panel.actions ? html`<div class="dlg-actions">${panel.actions}</div>` : null}
    </div>
  </dialog>`;
}

/** The shell's right-hand column: a docked panel when one is open (wide screens), else the usage rail. */
export function RightRail({ route }) {
  const { panel } = useStore(sidePanelStore);
  const wide = useRailWidth();
  return panel && wide ? html`<${SidePanelHost} panel=${panel} />` : html`<${UsageRail} route=${route} />`;
}
