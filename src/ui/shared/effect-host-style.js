/** Fixed same-origin host stylesheet only. No new sheet, inline style, owner CSS or supplied URL. */
export function effectHostStyle(host) {
  try {
    const link = host?.document?.querySelector('link[rel="stylesheet"][href="/assets/app.css"]');
    const href = new URL("/assets/app.css", host.location.origin).href;
    if (!link || link.tagName !== "LINK" || link.ownerDocument !== host.document || link.isConnected !== true || link.disabled !== false || !link.sheet || link.sheet.ownerNode !== link || link.sheet.href !== href || link.sheet.disabled !== false) return null;
    const sheet = link.sheet;
    return typeof sheet.insertRule === "function" && typeof sheet.deleteRule === "function" && sheet.cssRules ? sheet : null;
  } catch { return null; }
}
