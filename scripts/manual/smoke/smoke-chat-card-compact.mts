// #2217: the chat's identity card, compact (the user, 2026-10-19), from defaults (fleet decision a78ebdc5): a fresh profile signed
// in through the visible /signin, nothing seeded in the browser. Agents: A (banner, portrait, tagline, bio, a chat_header
// widget), B (no banner), C (banner and tagline: no portrait, no bio).
//   default  — hidden: no row under the header, the header's Show card button;
//   shown    — the banner flush under the header, Hide card on its top-right corner, Hide picture and bio on the row;
//   folded   — picture, tagline and bio gone, the banner and the widget strip stay; the way back on the banner; kept
//              over a reload (this device's choice, like Hide card);
//   B / C    — no banner: Hide card on the row, nothing to fold; C (no bio) still folds;
//   switch   — A → B → A with the card shown: no layout shift (Chromium's layout-shift entries; #2184 / #2188);
//   hide     — Hide card: gone, Show card back, kept over a reload;
//   ?safe=1, the public link and a guest (desk light, Chromium): the same controls work — a guest's header has no ⋯
//              menu, which is why Show card is a header button; no page error anywhere.
// Heights: the header's bottom to the chat's first row (the card's share), per state; a screenshot of the top per state.
//   PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] [TAG=before|after] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-chat-card-compact.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, openPublicLink, seedCards, seedWidgets, shotPath, TEXT } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-chat-card-compact";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const TAG = process.env.TAG ?? "after";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/(events|poll|traffic)|auth\/sessions?)(\?\S*)? due to access control checks\.$/;
const other = (errors: string[]) => errors.filter((e) => { const t = e.replace(/ @ \S+$/, ""); return !(ENGINE === "webkit" && (WEBKIT_OWN.has(t) || CANCEL.test(t))); });

const fx = await bootFixture({ port: Number(process.env.HP ?? 48700), classic: false, webYaml: "  guests:\n    enabled: true" });
const fm = fx.fm;
const running = fx.instances.filter((i: any) => i.status === "running" && !i.general).map((i: any) => i.name);
const [A, B, C] = running;
await seedCards(fx, [A, B, C]);
const card = (n: string) => fm.themeStore.get(n).theme;
fx.seedTheme(B, { ...card(B), card: { tagline: TEXT.taglineLatin, bio: TEXT.bioLatin } });             // no banner (no portrait)
fx.seedTheme(C, { ...card(C), card: { banner: card(C).card.banner, tagline: TEXT.taglineCjk } });      // no portrait, no bio
await seedWidgets(fx, A);
const enc = encodeURIComponent;

const results: any = { engine: ENGINE, tag: TAG, agents: { A, B, C }, cases: {} };
let failed = false;
const verdict = (name: string, ok: boolean, d: any) => { results.cases[name] = { ok, ...d }; if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${ENGINE} ${name}: ${JSON.stringify(d).slice(0, 700)}`); };
const until = async (page: any, fn: (a: any) => boolean, arg: any, ms = 8000) => { try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 100 }); return true; } catch { return false; } };
/** Where things are: the header's bottom, the card's box, the banner's top, the strip, the chat's top; controls and where they sit. */
// String expressions: tsx names inner functions with a helper the page does not have.
const measure = (page: any) => page.evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const box = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) }; };
  const head = box(".p-chat .panel-head"), main = box(".p-chat .chat-main");
  const ctl = [...document.querySelectorAll(".p-chat .id-ctl")].map((b) => { const r = b.getBoundingClientRect(); return { cls: b.getAttribute("class"), in: b.parentElement && b.parentElement.getAttribute("class"), label: b.getAttribute("aria-label"), title: b.getAttribute("title"), w: Math.round(r.width), h: Math.round(r.height) }; });
  return { head, card: box(".p-chat .chat-card"), banner: box(".p-chat .id-banner-box"), row: box(".p-chat .id-row"), strip: box(".p-chat .aw-chat_header"), main,
    toggleRow: !!q(".chat-card-toggle"), show: !!q(".p-chat .panel-head .chat-card-show"), portrait: !!q(".p-chat .id-portrait"), bio: !!q(".p-chat .id-bio"), ctl,
    used: head && main ? main.t - head.b : null, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`);
const shot = async (page: any, tag: string, name: string) => {
  const vp = page.viewportSize();
  await page.screenshot({ path: shotPath(SMOKE, `${TAG}-${ENGINE}-${tag}`, name), clip: { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, 560) } });
};
const go = async (page: any, base: string, path: string) => { await page.goto(`${base}${path}`); await mounted(page, 30000); await page.waitForTimeout(1200); };

/**
 * #2184 / #2188: switching chats with the card shown — layout-shift entries per switch (Chromium), the card opened the
 * way each build has it (localStorage, so this part runs on main too). B → A → B → A: the first visit to B reads its
 * card (it arrives after the chat's first paint, on any build); the later switches are warm.
 */
async function switchShifts(tag: string, c: any, width?: number) {
  const p = await freshPage(fx, c, { reducedMotion: true });
  if (width) await p.page.setViewportSize({ width, height: 800 });
  await go(p.page, p.base, `/ui/chat/${enc(A)}`);
  await p.page.evaluate(`localStorage.setItem("agend_chat_card", "open")`);
  await go(p.page, p.base, `/ui/chat/${enc(A)}`);
  const r = await p.page.evaluate(`(async () => {
    const per = []; let cur = null;
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput && cur) { cur.sum += e.value; cur.n++; cur.src.push(...(e.sources || []).map((x) => (x.node && x.node.className ? String(x.node.className).slice(0, 40) : "?"))); } });
    po.observe({ type: "layout-shift" });
    for (const n of ${JSON.stringify([B, A, B, A])}) {
      cur = { to: n, sum: 0, n: 0, src: [] }; per.push(cur);
      const a = document.querySelector('a[href="/ui/chat/' + encodeURIComponent(n) + '"]'); if (a) a.click(); else cur.missing = true;
      await new Promise((r) => setTimeout(r, 1800));
    }
    po.disconnect(); return per.map((x) => ({ ...x, sum: +x.sum.toFixed(4), src: [...new Set(x.src)].slice(0, 4) }));
  })()`);
  await p.ctx.close();
  return r;
}
if (ENGINE === "chromium") {
  const desk = await switchShifts("desk", { device: "desk", theme: "light", lang: "en" });
  const phone = await switchShifts("phone", { device: "phone", theme: "light", lang: "en" }, 360);
  const warm = (r: any[]) => r.slice(2).every((x) => x.sum === 0 && !x.missing);
  verdict("switch", warm(desk) && warm(phone), { desk, phone, rule: "warm switches (3rd, 4th) shift 0; the first visit is recorded (its card is read then)" });
  if (process.env.ONLY_SWITCH === "1") { writeFileSync(shotPath(SMOKE, "results", `${TAG}-${ENGINE}-switch`).replace(/\.png$/, ".json"), JSON.stringify(results, null, 1)); await fx.close(); process.exit(failed ? 1 : 0); }
}

const CASES = [
  { tag: "desk-light", c: { device: "desk", theme: "light", lang: "en" } },
  { tag: "desk-dark", c: { device: "desk", theme: "dark", lang: "zh-TW" } },
  { tag: "phone-light", c: { device: "phone", theme: "light", lang: "zh-TW" }, width: 360 },
  { tag: "phone-dark", c: { device: "phone", theme: "dark", lang: "en" }, width: 360 },
] as const;
for (const k of CASES) {
  const p = await freshPage(fx, k.c as any, { reducedMotion: true });
  const page = p.page;
  if ("width" in k) await page.setViewportSize({ width: k.width, height: 800 });
  await go(page, p.base, `/ui/chat/${enc(A)}`);
  await until(page, () => !!document.querySelector(".p-chat .panel-head .chat-card-show"), null);
  const hidden = await measure(page); await shot(page, k.tag, "1-hidden");
  await page.click(".p-chat .panel-head .chat-card-show");
  await until(page, () => !!document.querySelector(".p-chat .id-banner-box .id-hide"), null);
  await page.waitForTimeout(600);
  const shown = await measure(page); await shot(page, k.tag, "2-shown");
  await page.click(".p-chat .id-row .id-fold");
  await until(page, () => !document.querySelector(".p-chat .id-row") && !!document.querySelector(".p-chat .id-banner-box .id-unfold"), null);
  await page.waitForTimeout(300);
  const folded = await measure(page); await shot(page, k.tag, "3-folded");
  await go(page, p.base, `/ui/chat/${enc(A)}`);
  await until(page, () => !!document.querySelector(".p-chat .id-banner-box .id-unfold"), null);
  const reloaded = await measure(page);
  const store = await page.evaluate(`[localStorage.getItem("agend_chat_card"), localStorage.getItem("agend_chat_card_row")]`);
  await page.click(".p-chat .id-banner-box .id-unfold");
  await until(page, () => !!document.querySelector(".p-chat .id-row .id-fold"), null);
  await go(page, p.base, `/ui/chat/${enc(B)}`);
  const noBanner = await measure(page); await shot(page, k.tag, "4-no-banner");
  await go(page, p.base, `/ui/chat/${enc(C)}`);
  const noBio = await measure(page); await shot(page, k.tag, "5-no-bio");
  await go(page, p.base, `/ui/chat/${enc(A)}`);
  await page.click(".p-chat .id-banner-box .id-hide");
  await until(page, () => !document.querySelector(".p-chat .chat-card") && !!document.querySelector(".p-chat .chat-card-show"), null);
  await go(page, p.base, `/ui/chat/${enc(A)}`);
  const hiddenAgain = await measure(page);
  const errors = other(p.errors);
  const flush = shown.banner && shown.head ? shown.banner.t - shown.head.b : null;
  const ok = !hidden.toggleRow && hidden.show && !hidden.card && hidden.used !== null
    && shown.card && flush !== null && Math.abs(flush) <= 1 && !shown.toggleRow && !shown.show
    && shown.ctl.some((c: any) => c.cls === "id-ctl id-hide" && c.in === "id-banner-box" && c.label && c.title === c.label)
    && shown.ctl.some((c: any) => c.cls === "id-ctl id-fold" && c.in === "id-row")
    && !folded.row && folded.banner && !folded.portrait && !folded.bio && !!folded.strip && folded.ctl.some((c: any) => c.cls === "id-ctl id-fold id-unfold" && c.in === "id-banner-box")
    && folded.used! < shown.used! && !reloaded.row && !!reloaded.banner && store[0] === "open" && store[1] === "hidden"
    && !noBanner.banner && noBanner.ctl.length === 1 && noBanner.ctl[0].cls === "id-ctl id-hide" && noBanner.ctl[0].in === "id-row" && noBanner.bio
    && noBio.banner && noBio.ctl.map((c: any) => c.cls).join() === "id-ctl id-hide,id-ctl id-fold"
    && !hiddenAgain.card && hiddenAgain.show
    && ![hidden, shown, folded, noBanner, noBio].some((m) => m.overflow) && errors.length === 0;
  const px = (m: any) => m.used;
  verdict(k.tag, !!ok, { heights: { hidden: px(hidden), shown: px(shown), folded: px(folded), saved: px(shown) - px(folded), noBanner: px(noBanner), noBio: px(noBio) },
    bannerFlushPx: flush, controls: shown.ctl.map((c: any) => [c.cls, c.in, c.label, `${c.w}×${c.h}`]), foldedControls: folded.ctl.map((c: any) => [c.cls, c.in]),
    strip: !!folded.strip, kept: store, noBanner: noBanner.ctl.map((c: any) => [c.cls, c.in]), noBio: noBio.ctl.map((c: any) => c.cls), errors });
  await p.ctx.close();
}

// ?safe=1 and the public link: the same controls (desk light, Chromium only).
if (ENGINE === "chromium") {
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" } as any, { reducedMotion: true });
  await go(p.page, p.base, `/ui/chat/${enc(A)}?safe=1`);
  const okShow = await until(p.page, () => !!document.querySelector(".p-chat .chat-card-show"), null);
  if (okShow) await p.page.click(".p-chat .chat-card-show");
  const safe = await until(p.page, () => !!document.querySelector(".p-chat .id-banner-box .id-hide") && !!document.querySelector(".p-chat .id-row .id-fold"), null);
  await shot(p.page, "safe", "shown");
  verdict("safe=1", okShow && safe && other(p.errors).length === 0, { okShow, safe, errors: other(p.errors) });
  await p.ctx.close();
  const link = await openPublicLink(fx);
  const q = await link.publicPage({ device: "desk", theme: "light", lang: "en" } as any, { reducedMotion: true, path: `/ui/chat/${enc(A)}` });
  await mounted(q.page, 30000); await q.page.waitForTimeout(1200);
  const pShow = await until(q.page, () => !!document.querySelector(".p-chat .chat-card-show"), null);
  if (pShow) await q.page.click(".p-chat .chat-card-show");
  const pCard = await until(q.page, () => !!document.querySelector(".p-chat .id-banner-box .id-hide"), null);
  if (pCard) await q.page.click(".p-chat .id-row .id-fold");
  const pFold = await until(q.page, () => !document.querySelector(".p-chat .id-row") && !!document.querySelector(".p-chat .id-unfold"), null);
  await shot(q.page, "public", "folded");
  verdict("public link", pShow && pCard && pFold && other(q.errors).length === 0, { pShow, pCard, pFold, errors: other(q.errors) });
  await q.ctx.close(); await link.close();

  // A guest (#1920): a session scoped to A, as an accepted invite gives one (minted here; nothing seeded in the browser).
  const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
  fm.guestScope = () => new Set([A]);
  const owner = { adapterId: "discord", userId: "424242424242424242" };
  fm.webPrefs.setProfileName(`person:${owner.adapterId}:${owner.userId}`, "Guest Person");
  fm.initializeWebSessions();
  const sid = fm.webSessions.create({ tier: "guest", surface: "local", label: "smoke-2217", tokenEpoch: tokenEpoch(fm.webToken), owner }).sessionId;
  const gctx = await fx.browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });
  await gctx.addCookies([{ name: "agend_session", value: sid, url: fx.base }]);
  const g = await gctx.newPage();
  const gErrors: string[] = [];
  g.on("pageerror", (e: any) => gErrors.push(String(e).slice(0, 200)));
  g.on("console", (m: any) => { if (m.type() === "error") gErrors.push(m.text().slice(0, 200)); });
  await g.goto(`${fx.base}/ui/chat/${enc(A)}`); await g.waitForSelector("#msgIn", { timeout: 30000 }); await g.waitForTimeout(1200);
  const gGuest = await g.evaluate(`({ tier: document.body.dataset.tier, menu: !!document.querySelector(".p-chat .panel-head .menu-btn, .p-chat .panel-head [aria-haspopup='menu']") })`);
  const gShowBtn = await until(g, () => !!document.querySelector(".p-chat .panel-head .chat-card-show"), null);
  await g.screenshot({ path: shotPath(SMOKE, `${TAG}-${ENGINE}-guest`, "1-hidden"), clip: { x: 0, y: 0, width: 1366, height: 560 } });
  if (gShowBtn) await g.click(".p-chat .panel-head .chat-card-show");
  const gShown = await until(g, () => !!document.querySelector(".p-chat .id-banner-box .id-hide") && !!document.querySelector(".p-chat .id-row .id-fold"), null);
  await g.screenshot({ path: shotPath(SMOKE, `${TAG}-${ENGINE}-guest`, "2-shown"), clip: { x: 0, y: 0, width: 1366, height: 560 } });
  if (gShown) await g.click(".p-chat .id-row .id-fold");
  const gFolded = await until(g, () => !document.querySelector(".p-chat .id-row") && !!document.querySelector(".p-chat .id-banner-box .id-unfold"), null);
  await g.screenshot({ path: shotPath(SMOKE, `${TAG}-${ENGINE}-guest`, "3-folded"), clip: { x: 0, y: 0, width: 1366, height: 560 } });
  if (gFolded) await g.click(".p-chat .id-banner-box .id-unfold");
  const gUnfolded = await until(g, () => !!document.querySelector(".p-chat .id-row .id-fold"), null);
  if (gUnfolded) await g.click(".p-chat .id-banner-box .id-hide");
  const gHidden = await until(g, () => !document.querySelector(".p-chat .chat-card") && !!document.querySelector(".p-chat .panel-head .chat-card-show"), null);
  const gKept = await g.evaluate(`[localStorage.getItem("agend_chat_card"), localStorage.getItem("agend_chat_card_row")]`);
  verdict("guest", gGuest.tier === "guest" && !gGuest.menu && gShowBtn && gShown && gFolded && gUnfolded && gHidden && gErrors.length === 0,
    { ...gGuest, gShowBtn, gShown, gFolded, gUnfolded, gHidden, kept: gKept, errors: gErrors });
  await gctx.close();
}

writeFileSync(shotPath(SMOKE, "results", `${TAG}-${ENGINE}`).replace(/\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} ${ENGINE}`);
await fx.close();
process.exit(failed ? 1 : 0);
