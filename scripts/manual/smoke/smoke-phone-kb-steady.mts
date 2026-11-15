// beta.4 (the user, iPhone): while typing, every keypress made the screen flicker — the page re-aligned with the keyboard on
// each key. A keystroke can move the visual viewport (the predictive or candidate bar coming and going, the caret panned into
// view, one reading as tall as no keyboard at all). The shell took each reading at its word: the keyboard came "down" and
// went up again, the shell gave its height back to the stylesheet (M-3111's fit) and — since #3972 — the dock's padding
// switched between 8 px and the home-indicator inset, so the box jumped on every key.
// A real Chrome on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents), a phone with an
// iPhone's safe area (390×844, touch, CDP Emulation.setSafeAreaInsetsOverride: bottom 34), ✓ Verified (the user's case: no
// line under the box). Chrome raises no on-screen keyboard, so window.visualViewport is a stand-in installed before the app
// loads: the real Shell's keyboard detector, fit and CSS run on its readings. Per case, in an agent's chat:
//   1-typing — the box tapped, the keyboard up (the view 480 px); then a keystroke after each reading of an iOS-like sequence
//              (bar 44 px on/off, a pan, one full-height reading): the box's place, the dock's padding, the shell's height
//              and kb-open never change
//   2-rest   — the box left and the view back to full height: kb-open goes, the dock keeps the inset (#3972 still holds)
// Run it on the base too (REPO=<base checkout> SMOKE_NAME=…-before): "typing" FAILs there (beta.4: the box jumps).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-phone-kb-steady.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-kb-steady";
const INSET = { top: 47, bottom: 34, left: 0, right: 0 };
// The stand-in visual viewport: the page's own size until told otherwise; window.__vv(height, offsetTop) moves it and fires
// what Safari fires (resize for a new height, scroll for a pan).
const FAKE_VV = `(() => {
  const t = new EventTarget();
  // The window's own size until a reading is set (read live: at document start the page is not yet at its viewport's width).
  let set = null;
  const vv = { get width() { return innerWidth; }, get height() { return set ?? innerHeight; }, offsetTop: 0, offsetLeft: 0, pageTop: 0, scale: 1,
    addEventListener: t.addEventListener.bind(t), removeEventListener: t.removeEventListener.bind(t) };
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
  window.__vv = (height, top = 0) => {
    const resized = height !== vv.height, panned = top !== vv.offsetTop;
    set = height; vv.offsetTop = top;
    if (resized) t.dispatchEvent(new Event("resize"));
    if (panned) t.dispatchEvent(new Event("scroll"));
  };
})();`;
const fx = await bootFixture({ port: Number(process.env.HP ?? 49120), instances: 3 });
const name = fx.instances[1]!.name;
const cases = matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW,phone-dark-en,phone-light-zh-TW").filter((c) => c.device === "phone");
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
try {
  for (const c of cases) {
    const failed: string[] = [];
    const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
    const p = await freshPage(fx, c, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}`, beforeNavigate: async (ctx: any, page: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f;" + FAKE_VV });
      const s = await ctx.newCDPSession(page);
      await s.send("Emulation.setSafeAreaInsetsOverride", { insets: INSET });
      await ctx.route("**/ui/authorization", (r: any) => r.request().method() === "GET"
        ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "verified", until: Date.now() + 3_600_000 }) }) : r.continue());
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    need(await mounted(page, 30000), "the app mounted");
    await page.waitForSelector("#msgIn", { timeout: 20000 }); await page.waitForTimeout(800);
    const read = () => page.evaluate(() => {
      const shell = document.querySelector(".shell") as HTMLElement, box = document.querySelector(".composer") as HTMLElement;
      const dock = box?.closest(".dock") as HTMLElement, r = box.getBoundingClientRect();
      return { kb: shell.classList.contains("kb-open"), shellH: shell.style.height || null, bottom: Math.round(r.bottom), pad: getComputedStyle(dock).paddingBottom };
    });
    const vv = (h: number, top = 0) => page.evaluate(([a, b]: [number, number]) => (window as any).__vv(a, b), [h, top] as [number, number]);
    await page.locator("#msgIn").tap(); await page.waitForTimeout(200);
    await vv(480); await page.waitForTimeout(1000);                       // the keyboard up, past the focus follow window
    const first = await read();
    need(first.kb && first.shellH === "480px" && first.pad === "8px", `the keyboard up: kb-open, the shell the view's 480 px, the dock 8 px (${JSON.stringify(first)})`);
    const seen: any[] = [];
    // An iOS-like keystroke sequence: the predictive bar off/on (±44), a pan, a one-off full-height reading.
    const readings: Array<[number, number]> = [[436, 0], [480, 0], [480, 12], [844, 0], [480, 0], [436, 0], [844, 0], [480, 0]];
    for (const [i, [h, top]] of readings.entries()) {
      await vv(h, top);
      await page.keyboard.type("hello 你好"[i] || "x"); await page.waitForTimeout(60);
      seen.push({ at: [h, top], ...(await read()) });
    }
    await page.waitForTimeout(500); seen.push({ at: "settled", ...(await read()) });
    // The box sits on the keyboard: at the 480 px view, or held there through a one-off full-height reading; it may follow the
    // predictive bar (436) or a pan, as the keyboard's own edge does; a one-off full-height reading leaves it where it was.
    const moved = seen.filter((m, i) => {
      if (!m.kb || m.pad !== first.pad) return true;
      if (m.at[0] === 844) {                                     // held where it was (less the pan before it: this reading is not panned)
        const was = seen[i - 1] ?? first, pan = Array.isArray(was.at) ? was.at[1] : 0;
        return m.shellH !== was.shellH || m.bottom !== was.bottom - pan;
      }
      return m.at[0] === 480 && m.at[1] === 0 && (m.bottom !== first.bottom || m.shellH !== first.shellH);
    });
    need(moved.length === 0, `typing: kb-open, the dock's padding and the box's place never change (${JSON.stringify(moved.slice(0, 2))})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-typing") });
    // Left the box, the keyboard down: kb-open goes and the dock keeps the inset (#3972).
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur()); await vv(844); await page.waitForTimeout(1000);
    const rest = await read();
    need(!rest.kb && rest.pad === `${INSET.bottom}px`, `rest: no kb-open, the dock keeps the home-indicator inset (${JSON.stringify(rest)})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-rest") });
    need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length === cases.length && results.every((r) => r.ok) ? 0 : 1);
