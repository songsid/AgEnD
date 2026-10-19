// #2217: the chat's identity card, compact, from defaults (fleet decision a78ebdc5): a fresh profile signed in through the
// visible /signin, nothing seeded in the browser. Agents: A (banner, portrait, tagline, bio, a chat_header widget),
// B (no banner), C (banner and tagline: no portrait, no bio). The user (2026-10-20, hotfix): NO control on the card — not
// on the banner, not in its body; showing / hiding the card and folding / unfolding its picture and bio are the chat
// header's (the `ui` helpers below are the only place that knows how).
//   default  — hidden: no row under the header, the header's card control says Show card;
//   shown    — the banner flush under the header; not one button on the card;
//   folded   — picture, tagline and bio gone, the banner and the widget strip stay; still no button on the card; kept
//              over a reload (this device's choice, like Hide card);
//   B / C    — no banner: nothing to fold; C (no bio) still folds;
//   hide     — Hide card: gone, kept over a reload;
//   ?safe=1, the public link and a guest (desk light, Chromium): the same header controls — a guest's header has no ⋯
//              menu; no page error anywhere.
// Also, Chromium: chat switch with the card shown — warm switches shift 0 (#2184 / #2188).
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
  const cardButtons = document.querySelectorAll(".p-chat .chat-card button, .p-chat .chat-card [role=button]").length;
  const head2 = q(".p-chat .panel-head");
  const mb = head2 && head2.querySelector(".chat-card-menu > button");
  const ctl = mb ? { cls: mb.getAttribute("class"), label: mb.getAttribute("aria-label"), haspopup: mb.getAttribute("aria-haspopup") } : null;
  return { head, card: box(".p-chat .chat-card"), banner: box(".p-chat .id-banner-box"), row: box(".p-chat .id-row"), strip: box(".p-chat .aw-chat_header"), main,
    toggleRow: !!q(".chat-card-toggle"), portrait: !!q(".p-chat .id-portrait"), bio: !!q(".p-chat .id-bio"), ctl, cardButtons,
    used: head && main ? main.t - head.b : null, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`);
const shot = async (page: any, tag: string, name: string) => {
  const vp = page.viewportSize();
  await page.screenshot({ path: shotPath(SMOKE, `${TAG}-${ENGINE}-${tag}`, name), clip: { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, 560) } });
};
const go = async (page: any, base: string, path: string) => { await page.goto(`${base}${path}`); await mounted(page, 30000); await page.waitForTimeout(1200); };
/**
 * The header's card controls — the one place that knows the layout. The user's choice (2026-10-20, option B): one card
 * button opening a menu of two checkboxes, ☑ Show card and ☑ Show picture and bio.
 */
const MENU_BTN = ".p-chat .panel-head .chat-card-menu > button";
const ITEM = (k: number) => `.p-chat .chat-card-menu [role=menuitemcheckbox]:nth-of-type(${k + 1})`;
const ui = {
  ready: (page: any) => until(page, () => !!document.querySelector(".p-chat .panel-head .chat-card-menu > button"), null),
  isShown: (page: any) => page.evaluate(`!!document.querySelector(".p-chat .chat-card .id-card")`),
  isFolded: (page: any) => page.evaluate(`!!document.querySelector(".p-chat .id-card.row-hidden")`),
  async open(page: any) { if (!(await page.$(".p-chat .chat-card-menu [role=menu]"))) await page.click(MENU_BTN); return until(page, () => !!document.querySelector(".p-chat .chat-card-menu [role=menu]"), null); },
  async close(page: any) { if (await page.$(".p-chat .chat-card-menu [role=menu]")) await page.keyboard.press("Escape"); return until(page, () => !document.querySelector(".p-chat .chat-card-menu [role=menu]"), null); },
  async toggle(page: any, k: number) { await ui.open(page); await page.click(ITEM(k)); },
  async show(page: any) { if (!(await ui.isShown(page))) await ui.toggle(page, 0); const ok = await until(page, () => !!document.querySelector(".p-chat .chat-card .id-card"), null); await ui.close(page); return ok; },
  async hide(page: any) { if (await ui.isShown(page)) await ui.toggle(page, 0); const ok = await until(page, () => !document.querySelector(".p-chat .chat-card"), null); await ui.close(page); return ok; },
  async fold(page: any) { if (!(await ui.isFolded(page))) await ui.toggle(page, 1); const ok = await until(page, () => !!document.querySelector(".p-chat .id-card.row-hidden") && !document.querySelector(".p-chat .id-row"), null); await ui.close(page); return ok; },
  async unfold(page: any) { if (await ui.isFolded(page)) await ui.toggle(page, 1); const ok = await until(page, () => !!document.querySelector(".p-chat .id-row"), null); await ui.close(page); return ok; },
  /** Whether this card offers a fold at all (its Show picture and bio item enabled while the card is shown). */
  async canFold(page: any) { await ui.open(page); const on = await page.evaluate(`(() => { const b = document.querySelectorAll(".p-chat .chat-card-menu [role=menuitemcheckbox]")[1]; return !!b && !b.disabled; })()`); await ui.close(page); return on; },
};

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
  const readyOk = await ui.ready(page);
  const hidden = await measure(page); await shot(page, k.tag, "1-hidden");
  const showOk = await ui.show(page); await page.waitForTimeout(600);
  const shown = await measure(page); await shot(page, k.tag, "2-shown");
  const foldOk = await ui.fold(page); await page.waitForTimeout(300);
  const folded = await measure(page); await shot(page, k.tag, "3-folded");
  await go(page, p.base, `/ui/chat/${enc(A)}`);
  await until(page, () => !!document.querySelector(".p-chat .id-card.row-hidden"), null);
  const reloaded = await measure(page);
  const store = await page.evaluate(`[localStorage.getItem("agend_chat_card"), localStorage.getItem("agend_chat_card_row")]`);
  const unfoldOk = await ui.unfold(page);
  await go(page, p.base, `/ui/chat/${enc(B)}`);
  const noBanner = await measure(page); const noBannerFold = await ui.canFold(page); await shot(page, k.tag, "4-no-banner");
  await go(page, p.base, `/ui/chat/${enc(C)}`);
  const noBio = await measure(page); const noBioFold = await ui.canFold(page); await shot(page, k.tag, "5-no-bio");
  await go(page, p.base, `/ui/chat/${enc(A)}`);
  const hideOk = await ui.hide(page);
  await go(page, p.base, `/ui/chat/${enc(A)}`);
  const hiddenAgain = await measure(page);
  const errors = other(p.errors);
  const flush = shown.banner && shown.head ? shown.banner.t - shown.head.b : null;
  const ok = readyOk && showOk && foldOk && unfoldOk && hideOk
    && !hidden.toggleRow && !hidden.card && hidden.used !== null
    && shown.card && flush !== null && Math.abs(flush) <= 1 && !shown.toggleRow && shown.cardButtons === 0
    && !folded.row && folded.banner && !folded.portrait && !folded.bio && !!folded.strip && folded.cardButtons === 0
    && folded.used! < shown.used! && !reloaded.row && !!reloaded.banner && store[0] === "open" && store[1] === "hidden"
    && !noBanner.banner && noBanner.bio && !noBannerFold && noBanner.cardButtons === 0
    && noBio.banner && noBioFold && noBio.cardButtons === 0
    && !hiddenAgain.card
    && ![hidden, shown, folded, noBanner, noBio].some((m) => m.overflow) && errors.length === 0;
  const px = (m: any) => m.used;
  verdict(k.tag, !!ok, { heights: { hidden: px(hidden), shown: px(shown), folded: px(folded), saved: px(shown) - px(folded), noBanner: px(noBanner), noBio: px(noBio) },
    bannerFlushPx: flush, cardButtons: [shown.cardButtons, folded.cardButtons, noBanner.cardButtons, noBio.cardButtons],
    header: { hidden: hidden.ctl, shown: shown.ctl, folded: folded.ctl }, strip: !!folded.strip, kept: store, fold: { noBanner: noBannerFold, noBio: noBioFold }, errors });
  await p.ctx.close();
}

// The card menu by keyboard and touch (each engine, desk): the first item takes focus, arrows move, Space toggles, Esc
// closes and gives focus back to the button; an outside tap closes it too.
{
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" } as any, { reducedMotion: true });
  const page = p.page;
  await go(page, p.base, `/ui/chat/${enc(A)}`); await ui.ready(page);
  await page.focus(MENU_BTN); await page.keyboard.press("Enter");
  const opened = await until(page, () => !!document.querySelector(".p-chat .chat-card-menu [role=menu]"), null);
  await until(page, () => !!document.activeElement && document.activeElement.getAttribute("role") === "menuitemcheckbox", null, 3000);   // the menu focuses its first item once drawn
  const first = await page.evaluate(`document.activeElement && document.activeElement.getAttribute("role") + "|" + document.activeElement.textContent`);
  await page.keyboard.press("Space");
  const shownByKey = await until(page, () => !!document.querySelector(".p-chat .chat-card .id-card"), null);
  const stillOpen = !!(await page.$(".p-chat .chat-card-menu [role=menu]"));
  await page.keyboard.press("ArrowDown");
  const second = await page.evaluate(`document.activeElement && document.activeElement.textContent`);
  await page.keyboard.press("Escape");
  const closedByEsc = await until(page, () => !document.querySelector(".p-chat .chat-card-menu [role=menu]"), null);
  const focusBack = await page.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(MENU_BTN)})`);
  await page.click(MENU_BTN); await until(page, () => !!document.querySelector(".p-chat .chat-card-menu [role=menu]"), null);
  const sc = await page.locator(".p-chat .scroller").boundingBox();                  // an outside tap: the middle of the thread
  await page.mouse.click(Math.round(sc.x + sc.width / 2), Math.round(sc.y + sc.height / 2));
  const closedByOutside = await until(page, () => !document.querySelector(".p-chat .chat-card-menu [role=menu]"), null);
  await ui.open(page); await shot(page, "menu", "open"); await ui.close(page);
  verdict("menu keyboard", opened && first === "menuitemcheckbox|Show card" && shownByKey && stillOpen && second === "Show picture and bio" && closedByEsc && focusBack && closedByOutside && other(p.errors).length === 0,
    { opened, first, shownByKey, stillOpen, second, closedByEsc, focusBack, closedByOutside, errors: other(p.errors) });
  await p.ctx.close();
}

// Prism (#2227): a banner that fails to load is not drawn, and then the card cannot fold — the menu's second item greys out
// with it (a positive control first: the same card with its banner loading folds). Each engine, desk.
{
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" } as any, { reducedMotion: true });
  const page = p.page;
  const itemState = () => page.evaluate(`(() => { const b = document.querySelectorAll(".p-chat .chat-card-menu [role=menuitemcheckbox]")[1]; return b ? { disabled: b.disabled, checked: b.getAttribute("aria-checked") } : null; })()`);
  await go(page, p.base, `/ui/chat/${enc(A)}`); await ui.ready(page); await ui.show(page);
  await ui.open(page); const okItem = await itemState(); await ui.close(page);
  const okFolds = await ui.fold(page); await ui.unfold(page);
  await page.route(/\/api\/card\/[^/]+\/banner\?/, (r: any) => r.abort());
  await go(page, p.base, `/ui/chat/${enc(A)}`);
  await until(page, () => !!document.querySelector(".p-chat .id-row") && !document.querySelector(".p-chat img.id-banner"), null);
  await ui.open(page); const brokenItem = await itemState();
  await page.click(ITEM(1), { force: true }).catch(() => {}); await page.waitForTimeout(300);
  const afterClick = await itemState(); await ui.close(page);
  const brokenRow = await page.evaluate(`({ banner: !!document.querySelector(".p-chat img.id-banner"), row: !!document.querySelector(".p-chat .id-row"), kept: localStorage.getItem("agend_chat_card_row") })`);
  await shot(page, "broken-banner", "menu");
  verdict("broken banner", !!okItem && !okItem.disabled && okFolds && !!brokenItem && brokenItem.disabled && brokenItem.checked === "false" && afterClick?.disabled && !brokenRow.banner && brokenRow.row && brokenRow.kept === null,
    { okItem, okFolds, brokenItem, afterClick, brokenRow, errors: other(p.errors) });
  await p.ctx.close();
}

// ?safe=1 and the public link: the same controls (desk light, Chromium only).
if (ENGINE === "chromium") {
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" } as any, { reducedMotion: true });
  await go(p.page, p.base, `/ui/chat/${enc(A)}?safe=1`);
  const okShow = (await ui.ready(p.page)) && (await ui.show(p.page));
  const safeFold = okShow && (await ui.fold(p.page)) && (await ui.unfold(p.page));
  const safeBtns = await measure(p.page);
  await shot(p.page, "safe", "shown");
  verdict("safe=1", okShow && safeFold && safeBtns.cardButtons === 0 && other(p.errors).length === 0, { okShow, safeFold, cardButtons: safeBtns.cardButtons, errors: other(p.errors) });
  await p.ctx.close();
  const link = await openPublicLink(fx);
  const q = await link.publicPage({ device: "desk", theme: "light", lang: "en" } as any, { reducedMotion: true, path: `/ui/chat/${enc(A)}` });
  await mounted(q.page, 30000); await q.page.waitForTimeout(1200);
  const pShow = (await ui.ready(q.page)) && (await ui.show(q.page));
  const pFold = pShow && (await ui.fold(q.page));
  await shot(q.page, "public", "folded");
  const pBtns = await measure(q.page);
  const pHide = pFold && (await ui.unfold(q.page)) && (await ui.hide(q.page));
  verdict("public link", pShow && pFold && pHide && pBtns.cardButtons === 0 && other(q.errors).length === 0, { pShow, pFold, pHide, cardButtons: pBtns.cardButtons, errors: other(q.errors) });
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
  const gGuest = await g.evaluate(`({ tier: document.body.dataset.tier, menu: [...document.querySelectorAll(".p-chat .panel-head [aria-haspopup='menu']")].some((b) => !b.closest(".chat-card-menu")) })`);
  const gShowBtn = await ui.ready(g);
  await g.screenshot({ path: shotPath(SMOKE, `${TAG}-${ENGINE}-guest`, "1-hidden"), clip: { x: 0, y: 0, width: 1366, height: 560 } });
  const gShown = gShowBtn && (await ui.show(g));
  await g.screenshot({ path: shotPath(SMOKE, `${TAG}-${ENGINE}-guest`, "2-shown"), clip: { x: 0, y: 0, width: 1366, height: 560 } });
  const gFolded = gShown && (await ui.fold(g));
  await g.screenshot({ path: shotPath(SMOKE, `${TAG}-${ENGINE}-guest`, "3-folded"), clip: { x: 0, y: 0, width: 1366, height: 560 } });
  const gUnfolded = gFolded && (await ui.unfold(g));
  const gHidden = gUnfolded && (await ui.hide(g));
  const gKept = await g.evaluate(`[localStorage.getItem("agend_chat_card"), localStorage.getItem("agend_chat_card_row")]`);
  verdict("guest", gGuest.tier === "guest" && !gGuest.menu && gShowBtn && gShown && gFolded && gUnfolded && gHidden && gErrors.length === 0,
    { ...gGuest, gShowBtn, gShown, gFolded, gUnfolded, gHidden, kept: gKept, errors: gErrors });
  await gctx.close();
}

writeFileSync(shotPath(SMOKE, "results", `${TAG}-${ENGINE}`).replace(/\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} ${ENGINE}`);
await fx.close();
process.exit(failed ? 1 : 0);
