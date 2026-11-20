// M-3492 (the user) / M-3493: 最新 (scroll to latest) shows while the reader scrolls and fades out JUMP_IDLE_MS after
// the last scroll, so it never sits over a bubble in a still view (a screenshot); the next scroll brings it back. One
// behaviour for the Fleet chat (panel-chat.js) and every Hub conversation (panel-hub.js): the Hub copies the Fleet chat.
// Faded (.is-idle in app.css), taps pass through it; it stays in the tab order and the accessibility tree, and keyboard
// focus shows it again. Whether it has focus is read from the button there when the timer fires, never latched: an
// activated 最新 goes away without a blur. A timer runs only while it is shown, owned by the conversation too (a thread
// reused for another one with 最新 still up arms anew).
import { useEffect, useRef, useState } from "/assets/app-html.js";

/** How long 最新 stays after the last scroll before it fades out (the user asked for about 2–3 s). */
export const JUMP_IDLE_MS = 2500;

/**
 * scroller: the thread's scrolling element (a ref); show: whether 最新 is drawn; owner: what the thread shows (a chat's
 * name, a room's store). Returns what the button takes: `idle` (add .is-idle), `ref`, `onFocus`, `onBlur`.
 */
export function useJumpIdle(scroller, show, owner) {
  const [idle, setIdle] = useState(false);
  const timer = useRef(0), button = useRef(null), shown = useRef(false);
  shown.current = !!show;
  const rest = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { const b = button.current; if (!b || b.ownerDocument.activeElement !== b) setIdle(true); }, JUMP_IDLE_MS);
  };
  useEffect(() => {
    const sc = scroller.current; if (!sc) return undefined;
    const wake = () => { setIdle(false); if (shown.current) rest(); };
    sc.addEventListener("scroll", wake, { passive: true });
    setIdle(false);
    return () => { sc.removeEventListener("scroll", wake); clearTimeout(timer.current); };
  }, [owner]);
  useEffect(() => {
    if (show) { setIdle(false); rest(); } else clearTimeout(timer.current);
  }, [!!show, owner]);
  return { idle, ref: button, onFocus: () => { clearTimeout(timer.current); setIdle(false); }, onBlur: rest };
}
