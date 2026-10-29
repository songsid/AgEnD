// #1306 §6.1 (Q4): an agent's .html / .htm attachment gets the same preview card as a ```html block. Its HTML is read
// from /ui/file/<id> — same origin, this session's cookie — only on a click (Preview, Open in panel), never to show a
// card. What runs is then handed to the preview frame exactly like a block's (AgendPreview.start): the file URL itself
// is never opened or framed on the dashboard's origin.

/**
 * #2863: the sizes a preview takes (UTF-8 bytes of the HTML), the same as a block's (preview.js LIMITS): up to ASK it
 * runs at once; above it the person is asked first ("Preview anyway?"); above MAX there is no preview, only the
 * download. MAX is the frame's own ceiling (web-preview.ts PREVIEW_HTML_MAX_BYTES).
 */
export const HTML_PREVIEW_ASK = 8 * 1024 * 1024;
export const HTML_PREVIEW_MAX = 50 * 1024 * 1024;

/**
 * Read an attachment's HTML: { ok: true, code } or { ok: false, reason } with reason "large" (above `ask` and not
 * `anyway`: nothing is fetched when its listed size says so; `size` is what it is), "over" (above `max`: its listed size
 * is checked before anything is fetched, the bytes again after), "gone" (the fleet no longer serves that id — the file
 * changed, or the fleet restarted), or "failed". The text card reads with its own, single cap (ask = max).
 */
export async function loadHtmlAttachment(att, fetchImpl = globalThis.fetch, { ask = HTML_PREVIEW_ASK, max = HTML_PREVIEW_MAX, anyway = false } = {}) {
  if (!att || typeof att.id !== "string" || !/^[0-9a-f]{32}$/.test(att.id)) return { ok: false, reason: "failed" };
  if (typeof att.size === "number" && att.size > max) return { ok: false, reason: "over" };
  if (typeof att.size === "number" && att.size > ask && !anyway) return { ok: false, reason: "large", size: att.size };
  let res;
  try { res = await fetchImpl(`/ui/file/${att.id}`, { credentials: "same-origin", cache: "no-store" }); }
  catch { return { ok: false, reason: "failed" }; }
  if (!res || !res.ok) return { ok: false, reason: res && res.status === 404 ? "gone" : "failed" };
  let bytes;
  try { bytes = await res.arrayBuffer(); } catch { return { ok: false, reason: "failed" }; }
  if (bytes.byteLength > max) return { ok: false, reason: "over" };
  if (bytes.byteLength > ask && !anyway) return { ok: false, reason: "large", size: bytes.byteLength };
  // UTF-8, as a block's text is; a BOM is dropped.
  return { ok: true, code: new TextDecoder("utf-8").decode(bytes) };
}

/** #2863: a size as the person reads it: "12.3 MB" (1 MB = 1024 × 1024 bytes, as the caps are). */
export function sizeLabel(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}
