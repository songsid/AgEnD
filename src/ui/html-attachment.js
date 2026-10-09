// #1306 §6.1 (Q4): an agent's .html / .htm attachment gets the same preview card as a ```html block. Its HTML is read
// from /ui/file/<id> — same origin, this session's cookie — only on a click (Preview, Open in panel), never to show a
// card. What runs is then handed to the preview frame exactly like a block's (AgendPreview.start): the file URL itself
// is never opened or framed on the dashboard's origin.

/** The same cap as a block's (preview.js LIMITS.maxBytes): UTF-8 bytes of the HTML. */
export const HTML_ATTACHMENT_MAX = 1024 * 1024;

/**
 * Read an attachment's HTML: { ok: true, code } or { ok: false, reason } with reason "over" (the file is over the
 * cap: its listed size is checked before anything is fetched, the bytes again after), "gone" (the fleet no longer
 * serves that id — the file changed, or the fleet restarted), or "failed".
 */
export async function loadHtmlAttachment(att, fetchImpl = globalThis.fetch) {
  if (!att || typeof att.id !== "string" || !/^[0-9a-f]{32}$/.test(att.id)) return { ok: false, reason: "failed" };
  if (typeof att.size === "number" && att.size > HTML_ATTACHMENT_MAX) return { ok: false, reason: "over" };
  let res;
  try { res = await fetchImpl(`/ui/file/${att.id}`, { credentials: "same-origin", cache: "no-store" }); }
  catch { return { ok: false, reason: "failed" }; }
  if (!res || !res.ok) return { ok: false, reason: res && res.status === 404 ? "gone" : "failed" };
  let bytes;
  try { bytes = await res.arrayBuffer(); } catch { return { ok: false, reason: "failed" }; }
  if (bytes.byteLength > HTML_ATTACHMENT_MAX) return { ok: false, reason: "over" };
  // UTF-8, as a block's text is; a BOM is dropped.
  return { ok: true, code: new TextDecoder("utf-8").decode(bytes) };
}
