// #2308: the app icon from Settings → Web appearance, in a real browser (PW_ENGINE=webkit for Safari's engine).
// - The App icon card as it starts (the AgEnD icon), a JPG (not square, not PNG) chosen: the cropped preview, then
//   Use this icon — the card shows the new icon, and this page's own links follow at once (versioned, no SVG).
// - What a browser fetches: the favicon (32/48), the touch icon (180, on white), the manifest's 192/512 and the
//   manifest itself, drawn on one probe page; a fresh sign-in page already links the new version.
// - Restore default: the AgEnD icon again, the SVG link back. Nothing here adds a CSP violation to what the page logged
//   as it loaded (WebKit logs 7 style-src-attr reports on Settings → Web appearance at load on main too; and its
//   style-src-elem report at each page.screenshot() is Playwright's caret-hiding <style>, as smoke-ambient records).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [PW_ENGINE=webkit] [MATRIX=quick] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2308-app-icon.mts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = `smoke-2308-app-icon-${process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium"}`;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48480), instances: 4 });
const results: Record<string, Record<string, unknown>> = {};
let failed = false;

const headLinks = (page: any) => page.evaluate(`[...document.head.querySelectorAll("link[rel=icon], link[rel=apple-touch-icon], link[rel=manifest]")].map(l => l.getAttribute("rel") + " " + l.getAttribute("href"))`) as Promise<string[]>;
const until = async (fn: () => Promise<boolean>, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return fn(); };

for (const c of matrix(process.env.MATRIX ?? "quick")) {
  const chk: Record<string, unknown> = {};
  fx.fm.appIcon.reset();
  const { ctx, page, csp } = await fx.page(c, { path: "/settings/appearance" });
  const card = page.locator(".s-app-icon");
  await card.waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);                                         // the page settled: what it logs by itself
  const atLoad = (await csp()).length;
  chk.cspAtLoad = atLoad;
  await card.scrollIntoViewIfNeeded();
  chk.startsDefault = (await card.locator("img.s-app-icon-big").getAttribute("src")) === "/apple-touch-icon.png?v=default";
  chk.headStartsBundled = JSON.stringify(await headLinks(page)) === JSON.stringify(["icon /favicon.ico?v=default", "icon /favicon.svg?v=default", "apple-touch-icon /apple-touch-icon.png?v=default", "manifest /manifest.webmanifest?v=default"]);
  await card.screenshot({ path: shotPath(SMOKE, c, "1-card-default") });

  // A JPG, wider than tall: an orange field with a white ring and a blue dot — drawn by the browser itself.
  const jpg = Buffer.from(await page.evaluate(`(() => { const c = document.createElement("canvas"); c.width = 900; c.height = 600; const g = c.getContext("2d");
    g.fillStyle = "#e8711c"; g.fillRect(0, 0, 900, 600); g.strokeStyle = "#fff"; g.lineWidth = 48; g.beginPath(); g.arc(450, 300, 190, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#1c4fe8"; g.beginPath(); g.arc(450, 300, 90, 0, Math.PI * 2); g.fill(); g.fillStyle = "#000"; g.fillRect(0, 0, 150, 600); g.fillRect(750, 0, 150, 600);
    return c.toDataURL("image/jpeg", 0.92).split(",")[1]; })()`) as string, "base64");
  await page.setInputFiles("#s-app-icon-file", { name: "icon.jpg", mimeType: "image/jpeg", buffer: jpg });
  await card.locator(".s-app-icon-new img").waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  await card.screenshot({ path: shotPath(SMOKE, c, "2-card-preview") });
  await card.locator("button.btn-primary").click();
  chk.saved = await until(async () => (await card.locator("figcaption").first().textContent())?.includes(c.lang === "zh-TW" ? "你的圖示" : "Your icon") ?? false);
  const state = fx.fm.appIcon.current();
  const v = state?.version ?? "?";
  chk.versioned = /^[0-9a-f]{16}$/.test(v);
  await page.waitForTimeout(400);
  await card.screenshot({ path: shotPath(SMOKE, c, "3-card-custom") });
  chk.headFollows = JSON.stringify(await headLinks(page)) === JSON.stringify([`icon /favicon.ico?v=${v}`, `apple-touch-icon /apple-touch-icon.png?v=${v}`, `manifest /manifest.webmanifest?v=${v}`]);

  // What the browser fetches, on one probe page of this origin (images by their addresses, the manifest as text).
  const manifest = await page.evaluate(`fetch("/manifest.webmanifest?v=${v}").then(r => r.text())`) as string;
  const m = JSON.parse(manifest);
  chk.manifest = m.name === "AgEnD" && m.display === "standalone" && m.start_url === "/" && m.icons.map((i: any) => i.src).join() === `/icon-192.png?v=${v},/icon-512.png?v=${v}`;
  const sizes = await page.evaluate(`Promise.all(["/favicon.ico?v=${v}", "/apple-touch-icon.png?v=${v}", "/icon-192.png?v=${v}", "/icon-512.png?v=${v}"].map(src => new Promise(ok => {
    const i = new Image(); i.onload = () => ok(src.split("?")[0] + " " + i.naturalWidth + "x" + i.naturalHeight); i.onerror = () => ok(src + " error"); i.src = src; })))`) as string[];
  chk.sizes = sizes.join(", ");
  chk.sizesOk = sizes[1] === "/apple-touch-icon.png 180x180" && sizes[2] === "/icon-192.png 192x192" && sizes[3] === "/icon-512.png 512x512" && !sizes[0]!.includes("error");
  const cache = await page.evaluate(`Promise.all([fetch("/icon-192.png?v=${v}"), fetch("/icon-192.png")]).then(rs => rs.map(r => r.headers.get("cache-control")))`) as string[];
  chk.cacheByVersion = cache[0] === "public, max-age=31536000, immutable" && cache[1] === "no-cache";
  const probe = await ctx.newPage();
  await probe.goto(`${fx.base}/apple-touch-icon.png?v=${v}`);            // a same-origin page to draw on (CSP: images of self)
  await probe.evaluate(`(() => { document.documentElement.innerHTML = "<head><title>icons</title></head><body></body>";
    const add = (tag, attrs, text) => { const el = document.createElement(tag); for (const [k, val] of Object.entries(attrs)) el.setAttribute(k, val); if (text) el.textContent = text; document.body.appendChild(el); return el; };
    add("h3", {}, "favicon.ico (32, 48) · apple-touch-icon.png (180) · icon-192.png · icon-512.png (shown at 256)");
    add("img", { src: "/favicon.ico?v=${v}", width: "32", height: "32" }); add("img", { src: "/favicon.ico?v=${v}", width: "48", height: "48" });
    add("img", { src: "/apple-touch-icon.png?v=${v}", width: "180", height: "180" }); add("img", { src: "/icon-192.png?v=${v}", width: "192", height: "192" });
    add("img", { src: "/icon-512.png?v=${v}", width: "256", height: "256" });
    add("h3", {}, "GET /manifest.webmanifest?v=${v}"); add("pre", {}, JSON.stringify(${manifest}, null, 2)); })()`);
  await probe.waitForTimeout(600);
  await probe.screenshot({ path: shotPath(SMOKE, c, "4-icons-and-manifest"), fullPage: true });
  writeFileSync(join(dirname(shotPath(SMOKE, c, "x")), `${caseName(c)}-manifest.json`), manifest);
  await probe.close();

  // A fresh sign-in page (no session) links the new version, without the SVG.
  const anon = await fx.browser.newContext();
  const signin = await anon.newPage();
  await signin.goto(`${fx.base}/signin`);
  chk.signinLinks = JSON.stringify(await headLinks(signin)) === JSON.stringify([`icon /favicon.ico?v=${v}`, `apple-touch-icon /apple-touch-icon.png?v=${v}`, `manifest /manifest.webmanifest?v=${v}`]);
  await anon.close();

  // Restore default.
  await card.locator("button", { hasText: c.lang === "zh-TW" ? "恢復預設" : "Restore default" }).click();
  chk.reset = await until(async () => (await card.locator("img.s-app-icon-big").getAttribute("src")) === "/apple-touch-icon.png?v=default");
  chk.headBack = (await headLinks(page)).includes("icon /favicon.svg?v=default");
  await page.locator(".toast").first().waitFor({ state: "detached", timeout: 10000 }).catch(() => {});   // its toast gone
  await card.screenshot({ path: shotPath(SMOKE, c, "5-card-reset") });
  const added = (await csp()).slice(atLoad).filter((x: string) => !(process.env.PW_ENGINE === "webkit" && /^style-src-elem inline/.test(x)));
  chk.noNewCspViolation = added.length === 0;
  if (added.length) chk.csp = added;
  await ctx.close();
  results[caseName(c)] = chk;
  const bad = Object.entries(chk).filter(([k, val]) => val === false).map(([k]) => k);
  if (bad.length) failed = true;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${caseName(c)}${bad.length ? ` [${bad.join(", ")}]` : ""} — ${chk.sizes}`);
}
writeFileSync(join(dirname(shotPath(SMOKE, "x", "x")), "results.json"), JSON.stringify(results, null, 2));
await fx.close();
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
