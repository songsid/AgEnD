// #2117 smoke, on the realistic fixture, from defaults (fleet decision a78ebdc5): no seeded preference or consent —
// the switches are flipped only through the page's own controls. An agent sets falling petals (set_web_ambient, the
// agent's own tool) and General sets click stars for the user (set_web_settings); then, per case:
//   - reduced motion OFF and ON (emulated): the petals move (two samples differ) and a click/tap in the thread bursts
//     stars that clean themselves up, while the click still lands on what is under it;
//   - the blocked state, set through visible UI: Settings → Appearance → "Effects: follow the system's reduced-motion
//     setting" with the system asking for reduced motion → nothing drawn, the chat's ⋯ menu names why, and its line
//     opens the switch; unticked again → it plays;
//   - "Show agents' themes, effects and widgets" off (through the page) → the ⋯ line names it; ?safe=1 → none;
//   - a hidden tab pauses every ambient animation;
//   - the public link (a real one through FleetManager; from-defaults.mts stubs only the tunnel transport);
//   - CSP violations, page errors, the stacking order (layer under the thread), pointer-events none, aria-hidden.
// Then a performance run: phone 390, a 1,200-message chat, 4× CPU throttle, scrolling — frame times and long tasks with
// the ambient on vs off.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> MATRIX=full FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-ambient.mts
import { join, dirname } from "node:path";
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, labelOf, seedChat, freshPage, openPublicLink } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-ambient";
const REPO = process.env.REPO ?? process.cwd();
const fx = await bootFixture({ port: Number(process.env.HP ?? 48720) });
const enc = encodeURIComponent;
// Demo names only (the fixture's first instances are a real fleet's), as smoke-from-defaults-probe does.
const DEMO = new Set(["observability-dashboards", "billing-reconciliation", "search-indexer", "資料清洗與報表自動化助理"]);
for (const n of Object.keys(fx.fm.fleetConfig.instances)) if (!DEMO.has(n)) delete fx.fm.fleetConfig.instances[n];
const WITH = "observability-dashboards";
const PERF = "billing-reconciliation";

const PETALS = { preset: "fall", glyphs: ["🌸", "❀", "✿"], colors: ["#f4a7b9", "#ffd1dc", "#e75480"] };
const STARS = { preset: "burst-on-click", glyphs: ["✦", "✧"], colors: ["#ffd700", "#ff69b4", "#87ceeb", "#98fb98", "#dda0dd"], count: 12 };
const results: Record<string, any> = { browser: fx.browser.version(), engine: process.env.PW_ENGINE ?? "chromium", cases: {}, setup: {} };
// WebKit-only lines that are the engine's or this harness's, never the dashboard's (#2127) — recorded apart:
// "Refused to apply a stylesheet…" is WebKit's own internal sheet for each <select> (renders identically); a
// style-src-elem violation is Playwright's caret-hiding <style> at page.screenshot(); the viewport meta's
// interactive-widget key WebKit doesn't know; and a stream or poll a navigation cancels ("… due to access control checks").
const WEBKIT = process.env.PW_ENGINE === "webkit";
const KNOWN_WEBKIT = /Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'|Viewport argument key "interactive-widget" not recognized|cannot load .* due to access control checks/;
const fail: string[] = [];
const check = (cond: unknown, what: string) => { if (!cond) fail.push(what); return !!cond; };

await seedChat(fx, [WITH], 30);
// The agent's own tool, and General's tool for the user (both write the agent's record, never a viewer's prefs): the product's write paths, not the store.
results.setup.agent = fx.fm.webAppearance.handleTool(WITH, "set_web_ambient", PETALS);
results.setup.general = fx.fm.webSettings.change(undefined, { what: "ambient", instance: WITH, ambient: STARS });
check(results.setup.agent?.kind === "loop", "setup: set_web_ambient");
check(results.setup.general?.ok === true, "setup: set_web_settings ambient");

// What the page shows: the layers, their nodes and animations, two samples of one particle, styles, stacking.
const probe = (page: any) => page.evaluate(`(async () => {
  const main = document.querySelector(".p-chat .chat-main"); if (!main) return { main: false };
  const layer = main.querySelector(".amb-layer"), front = main.querySelector(".amb-burst");
  const anims = document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest(".amb-layer, .amb-burst"));
  const p = layer && layer.firstElementChild;
  const at = () => p ? p.getBoundingClientRect().top : null;
  const t0 = at(); await new Promise((r) => setTimeout(r, 600)); const t1 = at();
  const z = (e) => e ? getComputedStyle(e).zIndex : null;
  const sc = main.querySelector(".scroller");
  return { main: true, hasAmb: main.classList.contains("has-amb"), layer: layer ? layer.children.length : null, front: front ? front.children.length : null,
    running: anims.filter((a) => a.playState === "running").length, paused: anims.filter((a) => a.playState === "paused").length,
    moved: t0 !== null && t1 !== null && Math.abs(t1 - t0) > 0.5, styleAttrs: main.querySelectorAll(".amb-layer [style], .amb-burst [style]").length,
    pe: layer ? getComputedStyle(layer).pointerEvents : null, zLayer: z(layer), zScroller: z(sc), zFront: z(front),
    layerBeforeScroller: !!(layer && sc && (layer.compareDocumentPosition(sc) & Node.DOCUMENT_POSITION_FOLLOWING)),
    ariaHidden: layer ? layer.getAttribute("aria-hidden") : null, csp: window.__csp };
})()`);

/** A click (desk) or tap (phone) in the thread, at a message; returns how many clicks that message received. */
async function clickInThread(page: any, c: any) {
  const box = await page.evaluate(`(() => { const m = [...document.querySelectorAll(".p-chat .scroller .msg")].reverse().find((e) => { const r = e.getBoundingClientRect(); return r.top > 80 && r.bottom < innerHeight - 140; });
    if (!m) return null; m.dataset.ambClicks = "0"; m.addEventListener("click", () => { m.dataset.ambClicks = String(+m.dataset.ambClicks + 1); });
    const r = m.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2) }; })()`);
  if (!box) return null;
  const go = () => c.device === "phone" ? page.touchscreen.tap(box.x, box.y) : page.mouse.click(box.x, box.y);
  await go(); await page.waitForTimeout(120);
  const burst = await page.evaluate(`(() => { const f = document.querySelector(".amb-burst"); const n = f ? f.children.length : 0;
    const top = document.elementFromPoint(${box.x}, ${box.y}); return { n, topIsAmbient: !!(top && top.closest(".amb-layer, .amb-burst")) }; })()`);
  await go();                                                       // a second click lands through the burst
  await page.waitForTimeout(100);
  const clicks = await page.evaluate(`(() => { const m = document.querySelector(".msg[data-amb-clicks]"); return m ? +m.dataset.ambClicks : -1; })()`);
  return { ...burst, clicks, box };
}

async function openMenu(page: any) {
  const more = page.locator(".p-chat .panel-head button[aria-haspopup], .p-chat .panel-head .menu-btn").last();
  await more.click(); await page.waitForTimeout(300);
  return page.evaluate(`[...document.querySelectorAll("[role=menu] [role=menuitem], [role=menu] button")].map((e) => e.textContent.trim())`);
}

for (const c of process.env.ONLY_PUBLIC || process.env.ONLY_PERF ? [] : matrix()) {
  for (const reduce of [false, true]) {
    const name = `${caseName(c)}-${reduce ? "rm" : "nm"}`;
    // From defaults (a78ebdc5): a fresh profile, nothing seeded, signed in through /signin as its own account; the
    // reduced-motion cases on a LAN name (a non-loopback origin), the others on loopback.
    const fp = await freshPage(fx, c, { origin: reduce ? "lan" : "loopback", reducedMotion: reduce, path: `/ui/chat/${enc(WITH)}`,
      beforeNavigate: (ctx: any) => ctx.addInitScript({ content: `window.__csp = []; document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || "")));` }) });
    const { ctx, page } = fp;
    const base = fp.base;
    const csp = async () => page.evaluate("window.__csp || []") as Promise<string[]>;
    const errs = fp.errors;
    const r: any = { origin: base };
    await page.waitForTimeout(1800);
    // From defaults: it plays, reduced motion or not (the user's direction).
    r.defaults = await probe(page);
    check(r.defaults.layer === 12 && r.defaults.running >= 12 && r.defaults.moved, `${name}: plays from defaults`);
    // Positions are CSSOM writes (they show in the style attribute, as theme colours do); CSP governs only markup, and
    // the zero-violation check below is the proof. The contract: no pointer, under the thread, hidden from readers.
    check(r.defaults.pe === "none" && r.defaults.layerBeforeScroller && r.defaults.zLayer === "0" && r.defaults.zScroller === "1" && r.defaults.ariaHidden === "true", `${name}: layer contract`);
    await page.screenshot({ path: shotPath(SMOKE, name, "petals") });
    r.click = await clickInThread(page, c);
    check(r.click && r.click.n >= 12 && !r.click.topIsAmbient && r.click.clicks === 2, `${name}: burst + clicks land`);
    await page.screenshot({ path: shotPath(SMOKE, name, "stars") });
    await page.waitForTimeout(2200);
    r.afterBurst = await page.evaluate(`document.querySelector(".amb-burst") ? document.querySelector(".amb-burst").children.length : -1`);
    check(r.afterBurst === 0, `${name}: bursts clean up`);
    // A hidden tab pauses (the page's own visibilitychange path).
    r.hidden = await page.evaluate(`(async () => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange"));
      const a = document.getAnimations().filter((x) => x.effect.target.closest(".amb-layer")); const paused = a.filter((x) => x.playState === "paused").length;
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange"));
      return { total: a.length, paused, runningAfter: document.getAnimations().filter((x) => x.effect.target.closest(".amb-layer") && x.playState === "running").length }; })()`);
    // The one-time note (the user's direction): reduced motion on and this device not following it → said once.
    r.note = await page.evaluate(`(() => { const n = document.querySelector(".p-chat .amb-note"); return n ? { text: n.textContent, link: !!n.querySelector(".amb-note-off") } : null; })()`);
    check(reduce ? !!(r.note && r.note.link) : r.note === null, `${name}: the reduced-motion note ${reduce ? "shown" : "absent"}`);
    check(r.hidden.total === r.hidden.paused && r.hidden.runningAfter === r.hidden.total, `${name}: hidden tab pauses`);
    if (reduce) {
      // The blocked state, through visible UI only: the note's "Turn off here" sets this device's switch, right here.
      await page.screenshot({ path: shotPath(SMOKE, name, "note") });
      await page.locator(".p-chat .amb-note .amb-note-off").click(); await page.waitForTimeout(800);
      r.offHere = await probe(page);
      check(r.offHere.layer === null && r.offHere.running === 0, `${name}: the note turns it off right here`);
      // Settings shows the same switch, ticked.
      await page.goto(`${base}/settings/appearance`); await page.waitForTimeout(1500);
      const box = page.locator("#fx-follow-reduced-motion");
      await box.scrollIntoViewIfNeeded(); r.switchTicked = await box.isChecked();
      check(r.switchTicked === true, `${name}: Settings shows the switch ticked`);
      await page.screenshot({ path: shotPath(SMOKE, name, "settings-switch") });
      await page.goto(`${base}/ui/chat/${enc(WITH)}`); await page.waitForTimeout(1500);
      r.blocked = await probe(page);
      check(r.blocked.layer === null && r.blocked.running === 0, `${name}: following reduced motion hides it`);
      r.menu = await openMenu(page);
      const why = labelOf(c, { en: "this device follows reduced motion", zh: "這台裝置跟隨「減少動態效果」" });
      check(r.menu.some((t: string) => t.includes(why)), `${name}: the ⋯ menu names the reason`);
      // The evidence shows the line itself (a phone's menu sheet scrolls), and what is drawn at that moment.
      const line = page.locator("[role=menu] [role=menuitem], [role=menu] button", { hasText: why }).first();
      await line.scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
      r.blockedAtShot = await page.evaluate(`document.querySelectorAll(".amb-layer > *, .amb-burst > *").length`);
      check(r.blockedAtShot === 0, `${name}: nothing drawn while blocked`);
      await page.screenshot({ path: shotPath(SMOKE, name, "blocked-menu") });
      // Choosing the reason fixes it right here: this device stops following, and it plays again.
      await page.locator("[role=menu] [role=menuitem], [role=menu] button", { hasText: why }).first().click();
      await page.waitForTimeout(1500);
      r.unblocked = await probe(page);
      check(r.unblocked.layer === 12 && r.unblocked.moved, `${name}: the reason line plays it again`);
      r.noteAgain = await page.evaluate(`!!document.querySelector(".p-chat .amb-note")`);
      check(r.noteAgain === false, `${name}: the note is said once`);
    } else if (c.lang === "en") {
      // The show switch off, through Settings; the ⋯ line names it; then on again. ?safe=1 draws none.
      await page.goto(`${base}/settings/appearance`); await page.waitForTimeout(1500);
      const show = page.locator("label.check", { hasText: "Show agents' themes, effects and widgets" }).locator("input");
      await show.uncheck(); await page.waitForTimeout(800);
      await page.goto(`${base}/ui/chat/${enc(WITH)}`); await page.waitForTimeout(1500);
      r.hiddenSwitch = await probe(page);
      r.menuHidden = await openMenu(page);
      check(r.hiddenSwitch.layer === null && r.menuHidden.some((t: string) => t.includes("agents' themes are off")), `${name}: show switch off is named`);
      await page.screenshot({ path: shotPath(SMOKE, name, "hidden-menu") });
      // The line turns the switch on, right here.
      await page.locator("[role=menu] [role=menuitem], [role=menu] button", { hasText: "agents' themes are off" }).first().click(); await page.waitForTimeout(1500);
      r.hiddenFixed = await probe(page);
      check(r.hiddenFixed.layer === 12, `${name}: the show-switch line turns it on`);
      await page.goto(`${base}/ui/chat/${enc(WITH)}?safe=1`); await page.waitForTimeout(1500);
      r.safe = await page.evaluate(`document.querySelectorAll(".amb-layer, .amb-burst").length`);
      check(r.safe === 0, `${name}: ?safe=1 draws none`);
    }
    r.csp = await csp();
    if (WEBKIT) { r.webkitStyleRefusals = errs.filter((e) => KNOWN_WEBKIT.test(e)).length; r.errs = errs.filter((e) => !KNOWN_WEBKIT.test(e)); } else r.errs = errs;
    // Playwright's screenshot <style> (#2127), as a securitypolicyviolation.
    if (WEBKIT) { r.webkitStyleElem = r.csp.filter((v: string) => /^style-src-elem inline/.test(v)).length; r.csp = r.csp.filter((v: string) => !/^style-src-elem inline/.test(v)); }
    check(r.csp.length === 0 && r.errs.length === 0, `${name}: no CSP violation or page error`);
    results.cases[name] = r;
    await ctx.close();
  }
}

// ── The public link: a real one through FleetManager (from-defaults.mts: only the tunnel transport is stubbed). ──
if (!process.env.ONLY_PERF && !process.env.SKIP_EXTRA) {
  const link = await openPublicLink(fx);
  const pub: any = {};
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) {
    for (const reduce of [false, true]) {
      const name = `public-${caseName(c)}-${reduce ? "rm" : "nm"}`;
      const p = await link.publicPage(c, { reducedMotion: reduce, path: `/ui/chat/${enc(WITH)}`,
        beforeNavigate: (ctx: any) => ctx.addInitScript({ content: `window.__csp = []; document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective));` }) });
      const page = p.page;
      await page.waitForTimeout(2000);
      const r: any = { isPublic: await page.evaluate(`document.body.dataset.publicLink === "1"`), probe: await probe(page) };
      r.note = await page.evaluate(`!!document.querySelector(".p-chat .amb-note .amb-note-off")`);
      check(r.note === reduce, `${name}: the reduced-motion note ${reduce ? "shown" : "absent"} on the public link`);
      r.click = await clickInThread(page, c);
      r.menu = await openMenu(page).catch(() => null);
      if (reduce) {
        // On the public link too: the note turns it off right here, and the ⋯ reason line turns it back on.
        await page.keyboard.press("Escape"); await page.waitForTimeout(300);
        await page.locator(".p-chat .amb-note .amb-note-off").click(); await page.waitForTimeout(800);
        r.offHere = (await probe(page)).layer;
        const why = labelOf(c, { en: "this device follows reduced motion", zh: "這台裝置跟隨「減少動態效果」" });
        const items = await openMenu(page);
        await page.locator("[role=menu] [role=menuitem], [role=menu] button", { hasText: why }).first().click(); await page.waitForTimeout(1500);
        r.backOn = (await probe(page)).layer;
        check(r.offHere === null && items.some((t: string) => t.includes(why)) && r.backOn === 12, `${name}: off and back on, right there on the public link`);
      }
      // In WebKit, requests the harness carries (route.fetch) can fail its access-control check: the transport, not the
      // page (the same flows pass in Chromium); every check below still has to pass.
      r.errs = p.errors.filter((e: string) => !(WEBKIT && KNOWN_WEBKIT.test(e)));
      check(r.isPublic && r.probe.layer === 12 && r.probe.moved, `${name}: plays on the public link`);
      check(r.click && r.click.n >= 12 && r.click.clicks === 2, `${name}: stars on the public link`);
      check(!(r.menu ?? []).some((t: string) => /Clear the|清除/.test(t)), `${name}: no Clear over the public link`);
      const v = (r.probe.csp ?? []).filter((x: string) => !(WEBKIT && /^style-src-elem/.test(x)));
      check(r.errs.length === 0 && v.length === 0, `${name}: no CSP violation or page error`);
      await page.screenshot({ path: shotPath(SMOKE, name, "public") });
      pub[name] = r;
      await p.ctx.close();
    }
  }
  await link.close();
  results.publicLink = pub;
}

// ── Performance: phone, a 1,200-message chat, 4× CPU throttle, scrolling; ambient on vs off. ──
// (Chromium only: CPU throttling is a DevTools Protocol call.)
if (!process.env.ONLY_PUBLIC && !process.env.SKIP_EXTRA && process.env.PW_ENGINE !== "webkit") {
  await seedChat(fx, [PERF], 1200);
  const run = async (on: boolean) => {
    if (on) { fx.fm.webAppearance.humanSetAmbient(PERF, PETALS); fx.fm.webAppearance.humanSetAmbient(PERF, STARS); }
    else fx.fm.webAppearance.humanSetAmbient(PERF, null);
    const c = { device: "phone", theme: "dark", lang: "en" } as any;
    const { ctx, page } = await fx.page(c, { path: `/ui/chat/${enc(PERF)}` });
    await page.waitForTimeout(3000);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const m = await page.evaluate(`(async () => {
      const longs = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(e.duration); }); po.observe({ entryTypes: ["longtask"] });
      const sc = document.querySelector(".p-chat .scroller"); const frames = []; let last = performance.now(), stop = false;
      const tick = (t) => { frames.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      const t0 = performance.now();
      while (performance.now() - t0 < 10000) { if (sc) sc.scrollTop = Math.max(0, sc.scrollTop - 120); await new Promise((r) => setTimeout(r, 50)); }
      stop = true; po.disconnect(); frames.sort((a, b) => a - b);
      const q = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))];
      return { frames: frames.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), over50: frames.filter((f) => f > 50).length,
        longTasks: longs.length, longTaskMs: Math.round(longs.reduce((a, b) => a + b, 0)), msgs: document.querySelectorAll(".p-chat .msg").length,
        nodes: document.querySelectorAll(".amb-layer > *, .amb-burst > *").length }; })()`);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await ctx.close();
    return m;
  };
  // Alternating rounds (PERF_ROUNDS, default 2): one throttled run is noisy; the medians are what to compare.
  const rounds = Number(process.env.PERF_ROUNDS ?? 2), off: any[] = [], on: any[] = [];
  for (let i = 0; i < rounds; i++) { off.push(await run(false)); on.push(await run(true)); }
  const med = (xs: any[], k: string) => { const v = xs.map((x) => x[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const sum = (xs: any[]) => Object.fromEntries(["p50", "p95", "p99", "over50", "longTasks", "longTaskMs", "frames"].map((k) => [k, med(xs, k)]));
  results.perf = { rounds, off: sum(off), on: sum(on), runs: { off, on } };
}

results.fail = fail;
writeFileSync(join(dirname(shotPath(SMOKE, "result", "x")), "results.json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify({ fail, perf: results.perf, cases: Object.keys(results.cases).length, publicLink: Object.keys(results.publicLink ?? {}).length }));
await fx.close(); process.exit(fail.length ? 1 : 0);
