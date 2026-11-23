/**
 * Fill and submit in one page turn, as the seeded fixture does. A complete code also auto-submits on input; the
 * product deduplicates input + submit while in flight. Never inspect #go after an awaited navigation timeout:
 * automatic sign-in may have removed the form in that gap (M-3551 contention run 24). Wait only for the destination.
 */
export async function signIn(page: any, code: string, home: string) {
  await page.waitForSelector("#code", { timeout: 10000 });
  await page.locator("#code").evaluate((input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form!.requestSubmit();
  }, code);
  await page.waitForURL(home, { timeout: 15000 });
}
