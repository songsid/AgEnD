/** Pin only the owned page's Office animation clock while locating and pressing a painted target. */
export async function pinOfficePointerClock(page: any): Promise<void> {
  await page.evaluate(`(() => {
    const g = globalThis;
    if (g.__officeSmokePointerClock) throw new Error("Office pointer clock already pinned");
    const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
    const at = performance.now();
    g.__officeSmokePointerClock = { descriptor };
    Object.defineProperty(performance, "now", { configurable: true, value: () => at });
  })()`);
}
export async function resumeOfficePointerClock(page: any): Promise<void> {
  await page.evaluate(`(() => {
    const g = globalThis, pinned = g.__officeSmokePointerClock;
    if (!pinned) return;
    if (pinned.descriptor) Object.defineProperty(performance, "now", pinned.descriptor);
    else delete performance.now;
    delete g.__officeSmokePointerClock;
  })()`);
}
/** The current tooltip must name a real person button; a hot canvas alone also means a chat bubble. */
export async function findOfficePersonPoint(page: any): Promise<{ x: number; y: number } | null> {
  const b = await page.locator(".oo-canvas").boundingBox();
  const points: Array<[number, number]> = [];
  for (let y = b.y + 40; y < b.y + b.height - 30; y += 22)
    for (let x = b.x + 30; x < b.x + b.width - 30; x += 22) points.push([x, y]);
  const mid = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  points.sort((p, q) => Math.hypot(p[0] - mid.x, p[1] - mid.y) - Math.hypot(q[0] - mid.x, q[1] - mid.y));
  for (const [x, y] of points) {
    await page.mouse.move(x, y);
    const person = await page.evaluate(`new Promise(resolve => queueMicrotask(() => {
      const name = document.querySelector(".oo-tip strong")?.textContent;
      resolve(!!name && [...document.querySelectorAll("button.oo-desk[data-name]")].some(el => el.textContent === name));
    }))`);
    if (person) return { x, y }; // press exactly the observed point; do not offset it after the hit test
  }
  return null;
}
/** Positive guard: the acquisition seam must be gone before gestures/walk-back use the real clock. */
export async function officePointerClockIsLive(page: any): Promise<boolean> {
  return page.evaluate(`new Promise(resolve => {
    const at = performance.now();
    requestAnimationFrame(() => resolve(!globalThis.__officeSmokePointerClock && performance.now() > at));
  })`);
}
