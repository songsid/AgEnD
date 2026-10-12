// #1723: the public link's preview tunnel starts beside the link and is never waited for, so a page may load while it
// is still starting. This asks the page's own server (/ui/preview-status) until it is up or failed, and hands each answer
// to preview.js — which takes only what it may use, and itself reaches no network (#1306).

/** Every 2 s, for at most 5 minutes. */
export const POLL_MS = 2000;
export const POLL_MAX = 150;

/**
 * Ask while `P.waitingForPublicPreview()`; stop once `P.applyPublicPreviewStatus(answer)` says there is nothing more to
 * wait for, or after POLL_MAX asks. Returns a stop function.
 */
export function pollPublicPreview(P, deps = {}) {
  const get = deps.fetch ?? ((...a) => fetch(...a));
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  if (!P || typeof P.waitingForPublicPreview !== "function" || !P.waitingForPublicPreview()) return () => {};
  let attempts = 0, stopped = false;
  const again = () => { if (!stopped && attempts < POLL_MAX) later(tick, POLL_MS); };
  const tick = () => {
    if (stopped || !P.waitingForPublicPreview()) return;
    attempts++;
    get("/ui/preview-status", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!stopped && !P.applyPublicPreviewStatus(j)) again(); }, again);
  };
  later(tick, POLL_MS);
  return () => { stopped = true; };
}
