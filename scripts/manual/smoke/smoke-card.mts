// #1629 identity card smoke on the realistic fixture: the card (portrait, banner, tagline, bio) on Details (sizes S / M / L),
// the chat header (folded, then open), View (and the Edit-profile override), and the Settings limits — per matrix case
// (desk 1366 / phone 390, light / dark, en / zh-TW). The long Latin name carries the card; the CJK name is the second one.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-card.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, labelOf, PICTURES, TEXT } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-card";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48340) });
const fm = fx.fm;
const LONG = "rd1-platform-backend-sr4-server-t1547091841202130997", CJK = "研一官網-t1544335726169165914";
const enc = encodeURIComponent;

const P = fm.themeStore.addAsset(LONG, "portrait", await fx.picture(PICTURES.portrait));
const B = fm.themeStore.addAsset(LONG, "banner", await fx.picture(PICTURES.bannerWide));
// Escaped markup at the tagline cap: "<b>" must show as text.
const set = fx.seedTheme(LONG, { v: 1, card: { portrait: P.id, banner: B.id, tagline: "Reviews your PRs <b>fast</b> — release trains, crash triage", bio: TEXT.bioLatin } });
const P2 = fm.themeStore.addAsset(CJK, "portrait", await fx.picture({ ...PICTURES.portrait, seed: 5, hue: 120 }));
const B2 = fm.themeStore.addAsset(CJK, "banner", await fx.picture({ ...PICTURES.bannerTall, mime: "image/jpeg" }));
const set2 = fx.seedTheme(CJK, { v: 1, card: { portrait: P2.id, ...(B2?.ok ? { banner: B2.id } : {}), tagline: TEXT.taglineCjk, bio: TEXT.bioCjk } });
// The tall 800×1200 banner is past the default 1600×600 banner cap: its refusal (not a missing picture) is what the CJK card shows.
const results: any = { browser: fx.browser.version(), set: { P: P.id ?? P, B: B.id ?? B, set: set?.ok ?? set }, cjk: { set: set2?.ok ?? set2, tallBanner: B2?.ok ? "accepted" : B2 } };

for (const c of matrix()) {
  const { ctx, page, csp } = await fx.page(c);
  const errs: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (/Content Security Policy|Refused/.test(m.text())) errs.push("console: " + m.text().slice(0, 200)); });
  const probe = (sel: string) => page.evaluate(`(() => { const c = document.querySelector(${JSON.stringify(sel)}); if (!c) return null; const p = c.querySelector(".id-portrait"), b = c.querySelector(".id-banner");
    const rect = (e) => e ? (({ width, height, left, right }) => ({ w: Math.round(width), h: Math.round(height), l: Math.round(left), r: Math.round(right) }))(e.getBoundingClientRect()) : null;
    return { cls: c.className, portrait: p ? { ...rect(p), loaded: p.naturalWidth } : null, banner: b ? { ...rect(b), loaded: b.naturalWidth } : null, card: rect(c),
      tagline: c.querySelector(".id-tagline")?.textContent, bioLines: c.querySelector(".id-bio")?.getClientRects().length, links: c.querySelectorAll("a").length, bold: c.querySelectorAll("b").length,
      hscroll: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth || [...document.querySelectorAll(".panel-body")].some((e) => e.scrollWidth > e.clientWidth + 1),
      styleAttrs: [...document.querySelectorAll("[style]")].filter((e) => e.closest(".id-card, .chat-card")).length, csp: window.__csp }; })()`);
  const r: any = { errs, lang: await page.evaluate("document.documentElement.lang") };

  // The size segments are S / M / L in English and 小 / 中 / 大 in zh-TW: pick them by position, and start each case at M.
  fm.webPrefs.write("operator", new Map<string, unknown>([["theme", c.theme], ["lang", c.lang], ["card.size", "m"]]));
  await page.goto(`${fx.base}/ui/fleet/agent/${enc(LONG)}`); await page.waitForTimeout(1800);
  r.detailsM = await probe(".p-details .id-card");
  await page.screenshot({ path: shotPath(SMOKE, c, "details-m") });
  for (const [i, s] of [[0, "S"], [2, "L"]] as const) {
    const btn = page.locator(".p-details .card-size .seg-item").nth(i); await btn.click(); await page.waitForTimeout(400);
    r[`details${s}`] = await probe(".p-details .id-card");
    r[`details${s}Active`] = await page.evaluate(`[...document.querySelectorAll(".p-details .card-size .seg-item")].findIndex((e) => e.classList.contains("on") || e.getAttribute("aria-checked") === "true" || e.getAttribute("aria-pressed") === "true")`);
    await page.screenshot({ path: shotPath(SMOKE, c, `details-${s.toLowerCase()}`) });
  }
  await page.locator(".p-details .card-size .seg-item").nth(1).click(); await page.waitForTimeout(300);
  await page.goto(`${fx.base}/ui/chat/${enc(LONG)}`); await page.waitForTimeout(1500);
  r.chatFolded = await page.evaluate(`({ show: !!document.querySelector(".p-chat .panel-head .chat-card-menu > button"), card: !!document.querySelector(".p-chat .id-card"), row: !!document.querySelector(".p-chat .chat-card") })`);
  await page.screenshot({ path: shotPath(SMOKE, c, "chat-folded") });
  await page.click(".chat-card-menu > button").then(() => page.click(".chat-card-menu [role=menuitemcheckbox]")).then(() => page.keyboard.press("Escape")); await page.waitForTimeout(500);
  r.chatOpen = await probe(".p-chat .id-card");
  await page.screenshot({ path: shotPath(SMOKE, c, "chat-open") });
  await page.goto(`${fx.base}/view/${enc(LONG)}`); await page.waitForTimeout(1500);
  const exp = await page.$('.v-card button[aria-expanded="false"]'); if (exp) { await exp.click(); await page.waitForTimeout(800); }
  r.view = await probe(".v-id .id-card");
  await page.screenshot({ path: shotPath(SMOKE, c, "view") });
  // Edit profile: a person's tagline wins.
  // Required in every language: a missing control fails the case instead of skipping it.
  const edit = page.locator(".v-card .btn", { hasText: labelOf(c, { en: "Edit profile", zh: "編輯個人資料" }) }).first();
  await edit.waitFor({ timeout: 5000 });
  {
    await edit.click(); await page.waitForTimeout(800);
    await page.screenshot({ path: shotPath(SMOKE, c, "edit"), fullPage: true });
    const tag = page.locator("dialog label", { hasText: labelOf(c, { en: "Tagline", zh: "標語" }) }).locator("input").first();
    await tag.waitFor({ timeout: 5000 }); await tag.fill("A person's tagline");
    await page.click('dialog .btn-primary'); await page.waitForTimeout(1200);
    r.afterEdit = await page.evaluate(`fetch("/api/card/${enc(LONG)}").then((x) => x.json()).then((c) => ({ tagline: c.tagline, bio: c.bio && c.bio.by }))`);
    await page.evaluate(`fetch("/api/card/${enc(LONG)}", { method: "DELETE" }).then((x) => x.status)`);
  }
  // The CJK-named agent's details card, at the default size: its tall banner and zh-TW tagline and bio.
  await page.goto(`${fx.base}/ui/fleet/agent/${enc(CJK)}`); await page.waitForTimeout(1500);
  r.cjkDetails = await probe(".p-details .id-card");
  await page.screenshot({ path: shotPath(SMOKE, c, "cjk-details") });
  await page.goto(`${fx.base}/settings/appearance`); await page.waitForTimeout(1500);
  r.settings = await page.evaluate(`({ sizeCard: !!document.querySelector(".s-appearance .card-size"), limits: [...document.querySelectorAll('input[id^="cardLimit-"]')].map((i) => i.id + "=" + (i.value || "(" + i.placeholder + ")")) })`);
  await page.screenshot({ path: shotPath(SMOKE, c, "settings"), fullPage: true });
  r.csp = await csp();
  results.cases = results.cases ?? {}; results.cases[caseName(c)] = r;
  await ctx.close();
}
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify({ smoke: SMOKE, cases: Object.keys(results.cases ?? {}).length }));
await fx.close(); process.exit(0);
