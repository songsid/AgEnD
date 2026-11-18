// M-3327 (the user's iPhone screen recording, beta.11): the keyboard opening dropped the chat's header to mid-screen over a
// black band (sometimes pushing the whole chat under the keyboard), then snapped it back; the keyboard closing left the box
// hanging mid-air over a black band for ~350 ms, then dropped it in one frame.
// A real WebKit (Safari's engine) on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents),
// a phone (390×844, touch). WebKit here raises no on-screen keyboard and does not pan, so the page gets a stand-in iOS
// installed before the app loads — what the recording shows iOS doing, frame by frame:
//   open:  the keyboard rises over 300 ms; iOS pans the page at once to show the box (reports offsetTop 380 at once, while
//          the pan on screen eases in over 250 ms), reports the shorter view (480) ~130 ms in, and once the box is in view
//          without the pan takes the pan back (on screen over 200 ms, the report only at its end). A page's scrollTo(0, 0)
//          ends the pan at once (as Safari does).
//   close: the keyboard slides down over 350 ms; iOS reports the taller view only once it has gone (~350 ms).
// What the person sees is drawn: the page is moved up by the pan on screen (html's transform; the stand-in only) and a dark
// block is the keyboard. Per frame (rAF) it records the header's top and the box's bottom on screen, and the keyboard's top.
//   open:  the header never leaves the top (≤ 2 px), and once the view is the keyboard's, the box is above the keyboard;
//   close: no band opens between the box and the keyboard (the box ≥ the keyboard's top − 12 px in every frame: the
//          keyboard's first frame of movement comes before the shell's ease has started).
// Both of iOS's orders, each way (the user: "sometimes it stalls, sometimes it doesn't"): open — the pan first or the shorter
// view first; close — the focusout first (the taller view at 350 ms) or the taller view first (the focusout 45 ms later).
// BASELINE=1 (the base): expects the recording's defects (the header off the top on open, the band on close) in the
// recording's order (pan first, focusout first).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> PW_ENGINE=webkit [MATRIX=…] [BASELINE=1] scripts/manual/smoke/run.sh smoke-phone-keyboard-motion-m3327.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-keyboard-motion-m3327";
const BASELINE = process.env.BASELINE === "1";
const IOS = `(() => {
  const t = new EventTarget();
  let height = null, reported = 0, screenPan = 0, kbTop = null, scrolls = 0;
  const vv = { get width() { return innerWidth; }, get height() { return height ?? innerHeight; }, get offsetTop() { return reported; }, offsetLeft: 0, pageTop: 0, scale: 1,
    addEventListener: t.addEventListener.bind(t), removeEventListener: t.removeEventListener.bind(t) };
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
  const fire = (n) => t.dispatchEvent(new Event(n));
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  let panAnim = null;                                                   // { from, to, start, ms }
  const scrollAt = [];
  window.scrollTo = (x, y) => { scrolls++; scrollAt.push([Math.round(performance.now() - t0), reported, screenPan]); if (y === 0 && (reported || screenPan)) { panAnim = null; screenPan = 0; reported = 0; fire("scroll"); } };
  const draw = () => {
    document.documentElement.style.transform = screenPan ? "translateY(" + (-screenPan) + "px)" : "";
    let kb = document.getElementById("ios-kb");
    if (!kb && document.body) { kb = document.createElement("div"); kb.id = "ios-kb"; document.body.append(kb);
      Object.assign(kb.style, { position: "fixed", left: "0", right: "0", height: "844px", background: "#3a3a3c", zIndex: "2147483647", pointerEvents: "none" }); }
    if (kb) { kb.style.top = ((kbTop ?? innerHeight) + screenPan) + "px"; kb.style.display = kbTop == null ? "none" : ""; }
  };
  const log = [];
  let t0 = 0, rec = false;
  const sample = () => {
    const now = performance.now();
    if (panAnim) { const k = ease((now - panAnim.start) / panAnim.ms); screenPan = Math.round(panAnim.from + (panAnim.to - panAnim.from) * k); if (k >= 1) { const end = panAnim.end; panAnim = null; end?.(); } }
    draw();
    if (rec) {
      const head = document.querySelector(".panel-head"), box = document.querySelector(".composer"), shell = document.querySelector(".shell");
      const hr = head?.getBoundingClientRect(), br = box?.getBoundingClientRect();
      // On screen: the rects already carry the stand-in pan (html's transform); the keyboard block is drawn compensated.
      log.push({ t: Math.round(now - t0), head: hr ? Math.round(hr.top) : null, box: br ? Math.round(br.bottom) : null,
        kb: Math.round(kbTop ?? innerHeight), reported, screenPan, shellH: shell?.style.height || null, transform: shell?.style.transform || null });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  const anim = (from, to, ms, set) => new Promise((done) => { const start = performance.now(); const step = () => { const k = ease((performance.now() - start) / ms); set(from + (to - from) * k); if (k < 1) requestAnimationFrame(step); else done(); }; requestAnimationFrame(step); });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // order "pan-first": the pan at 16 ms, the shorter view at 130 ms (the recording); "view-first": the other way round.
  window.__iosOpen = async (order) => {
    log.length = 0; t0 = performance.now(); rec = true; scrolls = 0; scrollAt.length = 0;
    const H = innerHeight, K = 480, PAN = 380;
    const rise = anim(H, K, 300, (v) => { kbTop = v; });
    const pan = () => {
      panAnim = { from: 0, to: PAN, start: performance.now(), ms: 250 }; // the pan: on screen over 250 ms…
      reported = PAN; fire("scroll");                                    // …reported at once
    };
    const shorter = () => { height = K; fire("resize"); };
    await wait(16);
    if (order === "view-first") shorter(); else pan();
    await wait(114);
    if (order === "view-first") pan(); else shorter();
    await rise; await wait(20);
    if (reported || screenPan) {                                         // the box in view without the pan: iOS takes it back
      await new Promise((done) => { panAnim = { from: screenPan, to: 0, start: performance.now(), ms: 200, end: done }; });
      if (reported) { reported = 0; fire("scroll"); }                    // reported only at its end
    }
    await wait(300); rec = false;
    return { log: log.slice(), scrolls, scrollAt: scrollAt.slice() };
  };
  // order "blur-first": the focusout at once, the taller view once the keyboard has gone (350 ms: the recording);
  // "view-first": the keyboard goes with no event at all (the field keeps its focus), the late taller view at 350 ms, the
  // focusout 45 ms after it. Nothing can follow a keyboard that sends nothing: what counts is the shell at its full height
  // within a frame of the focusout (not held), whichever came first.
  let outAt = null;
  window.__iosClose = async (order) => {
    log.length = 0; t0 = performance.now(); rec = true; outAt = null;
    const H = 844;
    const blur = () => { outAt = Math.round(performance.now() - t0); document.activeElement && document.activeElement.blur && document.activeElement.blur(); };
    const taller = () => { height = null; fire("resize"); };
    const fall = anim(kbTop ?? 480, H, 350, (v) => { kbTop = v; });
    if (order !== "view-first") blur();
    await fall;
    kbTop = null;
    taller();
    if (order === "view-first") { await wait(45); blur(); }
    await wait(300); rec = false;
    return { log: log.slice(), outAt };
  };
})();`;
const fx = await bootFixture({ port: Number(process.env.HP ?? 49127), instances: 3 });
const name = fx.instances[1]!.name;
const cases = matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW").filter((c) => c.device === "phone");
const results: Array<{ name: string; ok: boolean; failed: string[]; runs?: any[] }> = [];
try {
  for (const c of cases) {
    const failed: string[] = [];
    const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
    const p = await freshPage(fx, c, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}`, beforeNavigate: async (ctx: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f;" + IOS });
      await ctx.route("**/ui/authorization", (r: any) => r.request().method() === "GET"
        ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "verified", until: Date.now() + 3_600_000 }) }) : r.continue());
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => { const m = String(e); if (!/ResizeObserver loop completed/.test(m)) errs.push(m.slice(0, 200)); });
    need(await mounted(page, 30000), "the app mounted");
    await page.waitForSelector("#msgIn", { timeout: 20000 }); await page.waitForTimeout(800);
    // The user: "sometimes it stalls, sometimes it doesn't" — iOS's order varies. Both orders, each way.
    const runs: any[] = [];
    for (const [openOrder, closeOrder] of [["pan-first", "blur-first"], ["view-first", "view-first"]]) {
    const tag = `${openOrder}-${closeOrder}`;
    // Open: the box tapped, iOS's keyboard and pan as recorded. PNGs mid-way (the frames are the measure). The recording's
    // first tap focuses the box (a box with the focus already: the "settled" case, in the unit tests).
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur()); await page.waitForTimeout(1000);
    await page.locator("#msgIn").tap();
    const opening = page.evaluate((o: string) => (window as any).__iosOpen(o), openOrder);
    await page.waitForTimeout(110); await page.screenshot({ path: shotPath(SMOKE, caseName(c), `${tag}-1-open-110ms`) });
    await page.waitForTimeout(240); await page.screenshot({ path: shotPath(SMOKE, caseName(c), `${tag}-2-open-350ms`) });
    const open = await opening;
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), `${tag}-3-open-settled`) });
    const headOff = open.log.filter((f: any) => f.head != null && Math.abs(f.head) > 2);
    const viewSet = open.log.filter((f: any) => f.t >= 300);
    const under = viewSet.filter((f: any) => f.box != null && f.box > f.kb + 2);
    const transformed = open.log.filter((f: any) => f.transform);
    // Close: the box left (focusout) and the keyboard slides away, in either order with iOS's late taller view.
    const closingP = page.evaluate((o: string) => (window as any).__iosClose(o), closeOrder);
    await page.waitForTimeout(170); await page.screenshot({ path: shotPath(SMOKE, caseName(c), `${tag}-4-close-170ms`) });
    const close = await closingP;
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), `${tag}-5-close-settled`) });
    // The focusout first: no band while the keyboard slides away — past the first frame (the keyboard's first step comes
    // before the shell's ease has started). The taller view first: from a frame after the focusout, the box at the bottom.
    const band = closeOrder === "view-first"
      ? close.log.filter((f: any) => f.t > close.outAt + 20 && f.box != null && 844 - f.box > 60)
      : close.log.filter((f: any) => f.t > 20 && f.box != null && f.kb - f.box > 12 && f.kb < 844);
    const worstBand = band.reduce((m: number, f: any) => Math.max(m, (closeOrder === "view-first" ? 844 : f.kb) - f.box), 0);
    const worstHead = headOff.reduce((m: number, f: any) => Math.max(m, Math.abs(f.head)), 0);
    if (BASELINE) {
      if (tag === "pan-first-blur-first") need(worstHead > 100 && worstBand > 100, `baseline ${tag}: expected the recording's defects (header off ${worstHead} px, band ${worstBand} px)`);
    } else {
      need(headOff.length === 0, `${tag} open: the header stays at the top (${headOff.length} frames off, worst ${worstHead} px: ${JSON.stringify(headOff.slice(0, 2))})`);
      need(transformed.length === 0, `${tag} open: no transform on the shell (${transformed.length} frames)`);
      need(open.scrolls > 0, `${tag} open: the pan was undone (scrollTo 0)`);
      need(under.length === 0, `${tag} open: once the view is the keyboard's, the box is above it (${JSON.stringify(under.slice(0, 2))})`);
      need(band.length === 0, closeOrder === "view-first" ? `${tag} close: the box at the bottom from a frame after the focusout (${band.length} frames, worst ${worstBand} px)`
        : `${tag} close: no band between the box and the keyboard (${band.length} frames, worst ${worstBand} px)`);
    }
    runs.push({ tag, open: { frames: open.log.length, worstHead, scrolls: open.scrolls, under: under.length }, close: { frames: close.log.length, worstBand } });
    }
    need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    results.push({ name: caseName(c), ok: failed.length === 0, failed, runs });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} ${JSON.stringify(r.runs)}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length === cases.length && results.every((r) => r.ok) ? 0 : 1);
