// M-3443 (the user, 11-20): the one info icon (ⓘ) of the web UI — docs/design/ui-style-guide.md, "Info icons". Before it
// there were three: Settings' InfoTip (a bordered "i"), and the usage dialog's ⓘ, as a button in a full card and as a
// hover-only image (role=img) in a compact row that a keyboard could not reach and a phone could only tap by luck.
//
// For secondary detail only — what a field is for, what a choice leaves out, where something lives — never information the
// person needs to act, a warning, or an action. Its words are a sentence or two.
//
// One button: its detail on a hover (where the pointer can hover), a keyboard focus, or a tap or click (which keeps it open
// until the next tap); Esc, a click elsewhere, a scroll or the focus leaving it closes it (and unpins it: a later Esc
// elsewhere is never taken). A hover covers the ⓘ and its bubble: the pointer may cross the gap into the bubble (to read or
// select its words) without it closing; it closes LEAVE_MS after the pointer has left both. On a touch screen its box
// is the --tap size (44px) while it draws 18px (negative margins keep the row's layout). The bubble is fixed to the window
// (no rounded group's overflow clips it), placed by CSS custom properties (the page allows no style attribute), hidden while
// closed — always the button's description (aria-describedby), so a screen reader says it on focus. Inside a <label> a press
// opens it, never toggles the label's control.
import { html, useEffect, useLayoutEffect, useRef, useState } from "./app-html.js";
import { Icon } from "./ui-icons.js";

let seq = 0;
const BUBBLE_MAX = 280;
const LEAVE_MS = 150;

/** `text`: the detail. `label`: the button's name ("About <what it explains>"). `cls`: a class for its place. */
export function InfoTip({ text, label, cls = "" }) {
  const [at, setAt] = useState(null);
  const [pinned, setPinned] = useState(false);
  const btn = useRef(null), bubble = useRef(null), id = useRef(null), wrap = useRef(null), leaving = useRef(null);
  if (!id.current) id.current = `info-tip-${++seq}`;
  const show = () => {
    // Beside the ⓘ as drawn (on a touch screen the button's box is the larger tap target around it).
    const mark = btn.current && (btn.current.querySelector?.("svg") || btn.current);
    const r = mark && mark.getBoundingClientRect ? mark.getBoundingClientRect() : null;
    const w = (typeof window !== "undefined" && window.innerWidth) || 0, h = (typeof window !== "undefined" && window.innerHeight) || 0;
    if (!r || !w) { setAt({ x: 8, y: 8, above: false }); return; }
    const above = !!h && r.bottom + 120 > h;
    const width = Math.min(BUBBLE_MAX, w - 16);
    setAt({ x: Math.round(Math.max(8, Math.min(r.left - 8, w - width - 8))), y: Math.round(above ? h - r.top + 6 : r.bottom + 6), above });
  };
  const stay = () => { if (leaving.current) { clearTimeout(leaving.current); leaving.current = null; } };
  const hide = () => { stay(); setAt(null); setPinned(false); };
  useEffect(() => () => stay(), []);
  useLayoutEffect(() => {
    const b = bubble.current;
    if (b && b.style && at) { b.style.setProperty("--tip-x", `${at.x}px`); b.style.setProperty("--tip-y", `${at.y}px`); }
  }, [at]);
  useEffect(() => {
    if (!at) return undefined;
    // Esc closes this bubble only: a dialog it sits in stays open (a native <dialog> cancels on the key's default action).
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); hide(); } };
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) hide(); };
    document.addEventListener("keydown", esc, true); document.addEventListener("click", away); window.addEventListener("scroll", hide, true);
    return () => { document.removeEventListener("keydown", esc, true); document.removeEventListener("click", away); window.removeEventListener("scroll", hide, true); };
  }, [!!at]);
  // A hover shows it unless the screen says it has none (a phone's tap also sends a mouseenter; the tap then pins it).
  const canHover = () => typeof matchMedia !== "function" || !matchMedia("(hover: none)").matches;
  const press = (e) => { e.stopPropagation(); e.preventDefault(); if (pinned) hide(); else { show(); setPinned(true); } };
  // The hover is the whole tip's (the ⓘ, its bubble, the gap between): leaving starts a short wait that coming back cancels.
  const enter = () => { stay(); if (!at && canHover()) show(); };
  const leave = () => { if (pinned) return; stay(); leaving.current = setTimeout(() => { leaving.current = null; setAt(null); }, LEAVE_MS); };
  return html`<span class=${`info-tip${cls ? ` ${cls}` : ""}`} ref=${wrap} onMouseEnter=${enter} onMouseLeave=${leave}><button type="button" class="info-tip-btn" ref=${btn} aria-label=${label}
      aria-expanded=${at ? "true" : "false"} aria-describedby=${id.current}
      onFocus=${show} onBlur=${hide} onClick=${press}><${Icon} name="info" size=${14} /></button><span
      id=${id.current} ref=${bubble} role="tooltip" class=${`info-tip-body${at && at.above ? " above" : ""}`} hidden=${!at}>${text}</span></span>`;
}
