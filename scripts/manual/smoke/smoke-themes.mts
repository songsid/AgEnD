// #1629 B1b smoke on the realistic fixture: an agent's theme on its chat (long Latin name), the sidebar avatar and ring, the
// viewer's "Show agents" switch, ?safe=1, and the ⋯ menu's Lock (desk cases). Per matrix case (desk 1366 / phone 390,
// light / dark, en / zh-TW); the CJK-named agent is the unthemed neighbour.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-themes.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, PICTURES, TEXT } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-themes";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48320) });
const LONG = "rd1-platform-backend-sr4-server-t1547091841202130997", CJK = "研一官網-t1544335726169165914";
const enc = encodeURIComponent;
const fm = fx.fm;

// The themed agent: avatar, background picture, portrait and banner (realistic pictures), colours, bubble, font.
const AV = fm.themeStore.addAsset(LONG, "avatar", await fx.picture({ ...PICTURES.avatar, mime: "image/jpeg" }));
const BG = fm.themeStore.addAsset(LONG, "background", await fx.picture({ w: 800, h: 500, hue: 230, label: "", mime: "image/jpeg", seed: 3 }));
const P = fm.themeStore.addAsset(LONG, "portrait", await fx.picture(PICTURES.portrait));
const B = fm.themeStore.addAsset(LONG, "banner", await fx.picture(PICTURES.bannerWide));
const set = fx.seedTheme(LONG, { v: 1, accent: "#8b5cf6", colors: { dark: { bg: "#101018" }, light: { bg: "#f6f2ff" } }, bubble: { radius: 6, border: "accent" },
  font: "mono", avatar: AV.id, background: { image: BG.id, fit: "cover", opacity: 0.3 }, workingLabel: "Brewing",
  card: { portrait: P.id, banner: B.id, tagline: TEXT.taglineCjk, bio: TEXT.bioCjk } });
// The unthemed neighbour with a long CJK name and a Latin tagline at the cap.
fx.seedTheme(CJK, { v: 1, card: { tagline: TEXT.taglineLatin, bio: TEXT.bioLatin } });

const results: any = { browser: fx.browser.version(), set: { av: AV.id ?? AV, bg: BG.id ?? BG, set } };
const reset = `fetch("/ui/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ set: { "fx.show": null } }) }).then((r) => r.status)`;

for (const c of matrix()) {
  const { ctx, page, csp } = await fx.page(c);
  const errs: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (/Content Security Policy|Refused/.test(m.text())) errs.push("console: " + m.text().slice(0, 200)); });
  const probe = () => page.evaluate(`(() => { const c = document.querySelector(".p-chat"); const img = document.querySelector(".th-bg");
    const avs = [...document.querySelectorAll(".av img")].map((i) => i.getAttribute("src"));
    return { cls: c ? c.className : null, bg: c ? getComputedStyle(c).getPropertyValue("--bg").trim() : null, accent: c ? getComputedStyle(c).getPropertyValue("--accent").trim() : null,
      font: document.querySelector(".p-chat .msg, .p-chat textarea") ? getComputedStyle(document.querySelector(".p-chat textarea") || document.querySelector(".p-chat .msg")).fontFamily : null,
      bgImg: img ? { src: img.getAttribute("src"), loaded: img.naturalWidth, cls: img.className } : null, avs, rings: [...document.querySelectorAll(".av.ring")].length,
      shellBg: getComputedStyle(document.body).getPropertyValue("--bg").trim(), styleAttrs: [...document.querySelectorAll("[style]")].map((e) => e.tagName + "." + e.className).slice(0, 4), csp: window.__csp }; })()`);
  const r: any = { errs, lang: await page.evaluate("document.documentElement.lang") };
  r.reset = await page.evaluate(reset);
  await page.goto(`${fx.base}/ui/chat/${enc(LONG)}`); await page.waitForTimeout(1800); r.themed = await probe();
  await page.screenshot({ path: shotPath(SMOKE, c, "chat-long") });
  if (c.device === "phone") { await page.goto(`${fx.base}/ui/fleet`); await page.waitForTimeout(1200); r.fleetAvs = await page.evaluate(`[...document.querySelectorAll(".av img")].map((i) => i.getAttribute("src") + " " + i.naturalWidth)`); await page.screenshot({ path: shotPath(SMOKE, c, "fleet") }); }
  await page.goto(`${fx.base}/ui/chat/${enc(CJK)}`); await page.waitForTimeout(1200); r.other = await probe();
  await page.screenshot({ path: shotPath(SMOKE, c, "chat-cjk") });
  // The ⋯ menu (desktop): Lock, then Unlock offered.
  if (c.device === "desk") {
    await page.goto(`${fx.base}/ui/chat/${enc(LONG)}`); await page.waitForTimeout(1200);
    const menuBtn = await page.$('.p-chat [aria-haspopup="menu"], .p-chat .menu-btn, .p-chat button[aria-label*="ore"]');
    r.menuBtn = !!menuBtn;
    if (menuBtn) { await menuBtn.click(); await page.waitForTimeout(300); r.menu = await page.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`);
      await page.screenshot({ path: shotPath(SMOKE, c, "menu") });
      const lock = await page.$('[role="menuitem"]:has-text("Lock theme"), [role="menuitem"]:has-text("鎖定主題")'); if (lock) { await lock.click(); await page.waitForTimeout(800); }
      r.lockedOnHost = fm.themeStore.get(LONG).locked; r.agentAfterLock = fm.webAppearance.setTheme(LONG, { set: { font: "system" } }); }
  }
  // The viewer's switch, from Settings → Appearance.
  await page.goto(`${fx.base}/settings/appearance`); await page.waitForTimeout(1200);
  r.switch = await page.evaluate(`(() => { const all = [...document.querySelectorAll("label, .s-row, .row")].filter((e) => /Show agents|顯示 agent/.test(e.textContent)); const i = all.length ? all[0].querySelector("input") || all[0].closest("*").querySelector("input[type=checkbox]") : null; if (!i) return "no switch"; const was = i.checked; i.click(); return { was, now: i.checked }; })()`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: shotPath(SMOKE, c, "appearance"), fullPage: true });
  await page.goto(`${fx.base}/ui/chat/${enc(LONG)}`); await page.waitForTimeout(1500); r.switchedOff = await probe();
  // Back on, then ?safe=1.
  await page.evaluate(reset);
  await page.goto(`${fx.base}/ui/chat/${enc(LONG)}`); await page.waitForTimeout(1500); r.backOn = (await probe()).cls;
  await page.goto(`${fx.base}/ui/chat/${enc(LONG)}?safe=1`); await page.waitForTimeout(1500); r.safe = await probe();
  r.csp = await csp();
  if (c.device === "desk") fm.themeStore.setLocked(LONG, false);
  results.cases = results.cases ?? {}; results.cases[caseName(c)] = r;
  await ctx.close();
}
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify({ smoke: SMOKE, cases: Object.keys(results.cases ?? {}).length }));
await fx.close(); process.exit(0);
