/**
 * M-3556: the Office's display options (style, the toggles, the key) sit behind ⚙ Display options on a desk — a
 * dropdown. Open it (when it is not open already) before reaching for one of them.
 */
import { settle } from "./app-harness.js";

export async function openDisplay(root: any): Promise<void> {
  const b = root.querySelector(".oo-display-btn");
  if (b && b.getAttribute("aria-expanded") !== "true") { b.click(); await settle(2); }
}
