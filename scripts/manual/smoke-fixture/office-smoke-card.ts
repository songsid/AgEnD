/** Smoke-only card entry: the named accessible desk is stable while the canvas strolls/paints bubbles. */
export async function openOfficePersonCard(page: any): Promise<string> {
  if (await page.locator(".oo-card").count()) throw new Error("Office card was already open before card entry");
  const person = page.locator("button.oo-desk").first();
  const name = await person.getAttribute("data-name");
  if (!name) throw new Error("Office person target has no instance identity");
  await person.focus();
  await person.press("Enter");
  await page.locator(".oo-card").waitFor();
  const shown = (await page.locator(".oo-card-instance").innerText()).trim();
  if (shown !== name) throw new Error(`Office card target mismatch: expected ${name}, got ${shown}`);
  return name;
}

export async function closeOfficePersonCard(page: any): Promise<void> {
  // A missing card is a failed precondition, not a 30s ignored click or a retry.
  if ((await page.locator(".oo-card").count()) !== 1) throw new Error("Expected one Office card before closing");
  await page.locator(".oo-card-close").click();
  await page.locator(".oo-card").waitFor({ state: "hidden" });
}
