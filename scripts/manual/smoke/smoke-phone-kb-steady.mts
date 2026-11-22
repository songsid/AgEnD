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
// M-3206 (the user, iPhone, beta.5: typing still flickered): the shell still followed every smaller per-key reading (the
// suggestion bar's 44 px, a few px of pan), and the box's own height was collapsed and set again on every key. Now, typing,
// nothing moves on a reading that comes and goes with a key, and a key that fits on the line writes no style at all (the
// box, the shell): "typing" counts those writes.
// Run it on the base too (REPO=<base checkout> SMOKE_NAME=…-before): "typing" FAILs there (beta.4 and beta.5: the box moves).
// PW_ENGINE=webkit runs it in WebKit (Safari's engine; no CDP there, so no safe-area inset: the rest case checks the 8 px floor).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] [PW_ENGINE=webkit] scripts/manual/smoke/run.sh smoke-phone-kb-steady.mts
// ui-gate: {"name": "Phone keyboard steady while typing (no re-align on a keystroke)", "hp": 19661}
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-kb-steady";
const INSET = { top: 47, bottom: 34, left: 0, right: 0 };
const WEBKIT = process.env.PW_ENGINE === "webkit";
// Every style write on the box and the shell (a MutationObserver from the start): window.__writes().
const WRITES = `(() => {
  const seen = []; window.__writes = () => seen.splice(0);
  const watch = () => new MutationObserver((ms) => { for (const m of ms) { const t = m.target; if (t.id === "msgIn" || t.classList?.contains("shell")) seen.push((t.id || "shell") + ": " + t.getAttribute("style")); } })
    .observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["style"] });
  if (document.documentElement) watch(); else document.addEventListener("DOMContentLoaded", watch);
})();`;
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
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49120), instances: 3 });
const name = fx.instances[1]!.name;
const cases = matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW,phone-dark-en,phone-light-zh-TW").filter((c) => c.device === "phone");
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
try {
  for (const c of cases) {
    const failed: string[] = [];
    const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
    const p = await freshPage(fx, c, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}`, beforeNavigate: async (ctx: any, page: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f;" + FAKE_VV + WRITES });
      if (!WEBKIT) {
        const s = await ctx.newCDPSession(page);
        await s.send("Emulation.setSafeAreaInsetsOverride", { insets: INSET });
      }
      await ctx.route("**/ui/authorization", (r: any) => r.request().method() === "GET"
        ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "verified", until: Date.now() + 3_600_000 }) }) : r.continue());
    } });
    const page = p.page;
    // WebKit reports a ResizeObserver loop it settled itself as a page error (on the base too): not the page's.
    const errs: string[] = []; page.on("pageerror", (e: any) => { const m = String(e); if (!(WEBKIT && /ResizeObserver loop completed/.test(m))) errs.push(m.slice(0, 200)); });
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
    await page.evaluate(() => (window as any).__writes());
    // An iOS-like keystroke sequence: each key comes with a reading that goes with the next one — the suggestion bar on
    // (436), a pan (12 px), a one-off full-height reading — and the view back at 480 between them.
    const readings: Array<[number, number]> = [[436, 0], [480, 0], [480, 12], [480, 0], [844, 0], [480, 0], [436, 0], [480, 0]];
    for (const [i, [h, top]] of readings.entries()) {
      await vv(h, top);
      await page.keyboard.type("hello 你好"[i] || "x"); await page.waitForTimeout(60);
      seen.push({ at: [h, top], ...(await read()) });
    }
    const writes: string[] = await page.evaluate(() => (window as any).__writes());
    await page.waitForTimeout(500); seen.push({ at: "settled", ...(await read()) });
    // The box sits on the keyboard at the 480 px view through all of it: no reading that came and went moved anything.
    const moved = seen.filter((m) => !m.kb || m.pad !== first.pad || m.shellH !== first.shellH || m.bottom !== first.bottom);
    need(moved.length === 0, `typing: kb-open, the dock's padding, the shell's height and the box's place never change (${JSON.stringify(moved.slice(0, 2))})`);
    need(writes.length === 0, `typing: keys that fit on the line write no style on the box or the shell (${writes.length}: ${JSON.stringify(writes.slice(0, 4))})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-typing") });
    // Left the box, the keyboard down: kb-open goes and the dock keeps the inset (#3972).
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur()); await vv(844); await page.waitForTimeout(1000);
    const rest = await read();
    // WebKit: no inset to emulate, so the dock's 8 px floor.
    need(!rest.kb && rest.pad === (WEBKIT ? "8px" : `${INSET.bottom}px`), `rest: no kb-open, the dock keeps the home-indicator inset (${JSON.stringify(rest)})`);
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
