/**
 * M-3556: on a desk the Office's display options (Style, the toggles, Key) sit behind ⚙ Display options, a dropdown.
 * `withDisplay(page, fn)` opens it (when it is not open already), runs `fn`, and closes it again with Escape — so a smoke
 * that goes on to hover or click the scene is not covered by it. On a phone (no ⚙: the options are in the ⋯ sheet) it
 * only runs `fn`.
 */
export async function withDisplay<T>(page: any, fn: () => Promise<T>): Promise<T> {
  const btn = page.locator(".oo-display-btn");
  const open = (await btn.count()) > 0 && (await btn.getAttribute("aria-expanded")) !== "true";
  if (open) { await btn.click(); await page.locator(".oo-display-pop").waitFor(); }
  try { return await fn(); }
  finally {
    if (open) { await page.keyboard.press("Escape"); await page.locator(".oo-display-pop").waitFor({ state: "detached" }).catch(() => {}); }
  }
}
