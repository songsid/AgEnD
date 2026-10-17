// #2038 identity-card banner on the realistic fixture: five banner shapes (1600×900, 1600×600, 1500×500, 400×150, 800×1200)
// with fixture pictures, on the chat header card (folded and open), Details and View, at card sizes S / M / L, per matrix
// case (desk 1280 / phone 390, light / dark, en / zh-TW). The banner caps are raised for this run (1600×1200, 2048 KiB).
// Crops of each card are saved, one contact sheet per banner and matrix case, and an over-cap picture is probed for refusal.
//   BANNERS=1600x600,800x1200 (optional subset) PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2038.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, PICTURES, TEXT, type PictureSpec, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2038";
// The 16:9 and tall pictures exceed the default banner limit (1600×600): raise it (bounds 1200 high, 2048 KiB).
const fx = await bootFixture({ port: Number(process.env.HP ?? 48350),
  webYaml: "  appearance:\n    banner: { max_width: 1600, max_height: 1200, max_kib: 2048 }" });
const fm = fx.fm;
const LONG = "rd1-platform-backend-sr4-server-t1547091841202130997";
const enc = encodeURIComponent;
// The 16:9 picture is JPEG: as a noisy PNG it is past the 2048 KiB banner cap, and that refusal is not what this run tests.
const BANNER_SPECS: Record<string, PictureSpec> = { "1600x900": { ...PICTURES.banner169, mime: "image/jpeg" },"1600x600": PICTURES.bannerWide, "1500x500": PICTURES.bannerShort,
  "400x150": PICTURES.bannerSmall, "800x1200": PICTURES.bannerTall };
const labels = (process.env.BANNERS ?? Object.keys(BANNER_SPECS).join(",")).split(",");
const results: any = { browser: fx.browser.version(), shots: [], banners: {} as Record<string, unknown> };

const P = fm.themeStore.addAsset(LONG, "portrait", await fx.picture({ ...PICTURES.portrait, seed: 1 }));
// Over-cap probe: a 4000×3000 picture is past every banner bound — the refusal is what the page should show.
const huge = fm.themeStore.addAsset(LONG, "banner", await fx.picture(PICTURES.huge));
results.refusals = { huge: huge?.ok ? "accepted" : (huge?.error ?? huge) };

const sizeOf = (surface: string, size: string, label: string) => `${label}-${size}-${surface}`;
for (const label of labels) {
  const B = fm.themeStore.addAsset(LONG, "banner", await fx.picture(BANNER_SPECS[label]));
  if (!B?.ok) { results.banners[label] = { refused: B }; continue; }
  const set = fx.seedTheme(LONG, { v: 1, card: { portrait: P.id, banner: B.id, tagline: TEXT.taglineCjk, bio: TEXT.bioCjk } });
  results.banners[label] = { set: set?.ok ?? set };
  for (const c of matrix()) {
    const { ctx, page, csp } = await fx.page(c, { storage: { agend_view_card_expanded: "1" } });
    const sheetRows: Array<{ surface: string; size: string; src: string; dims: any }> = [];
    for (const size of ["s", "m", "l"]) {
      fm.webPrefs.write("operator", new Map<string, unknown>([["theme", c.theme], ["lang", c.lang], ["card.size", size]]));
      await page.evaluate(`localStorage.setItem("agend_card_size", ${JSON.stringify(size)})`);
      const shot = async (surface: string, sel: string) => {
        const el = await page.$(sel);
        const file = shotPath(SMOKE, c, sizeOf(surface, size, label));
        if (!el) { results.shots.push({ file, case: caseName(c), missing: sel }); return; }
        const m = await page.evaluate(`(() => { const c = document.querySelector(${JSON.stringify(sel)}); const b = c.querySelector(".id-banner"); const r = (e) => e && e.getBoundingClientRect();
          return { card: r(c) && [Math.round(r(c).width), Math.round(r(c).height)], banner: b ? [Math.round(r(b).width), Math.round(r(b).height), b.naturalWidth] : null }; })()`);
        const buf = await el.screenshot({ path: file });
        results.shots.push({ file, case: caseName(c), label, size, surface, ...m });
        sheetRows.push({ surface, size, src: "data:image/png;base64," + buf.toString("base64"), dims: m.banner });
      };
      await page.goto(`${fx.base}/ui/fleet/agent/${enc(LONG)}`); await page.waitForTimeout(1000);
      await shot("details", ".p-details .id-card");
      await page.goto(`${fx.base}/ui/chat/${enc(LONG)}`); await page.waitForTimeout(1000);
      if (size === "m") await shot("chatFolded", ".chat-card");
      // Open the card only when it is folded: the toggle keeps its state from the previous size.
      if (!(await page.$(".chat-card .id-card"))) { await page.click(".chat-card-toggle").catch(() => {}); await page.waitForTimeout(500); }
      await shot("chatOpen", ".chat-card");
      await page.goto(`${fx.base}/view/${enc(LONG)}`); await page.waitForTimeout(1000);
      await shot("view", ".v-id .id-card");
    }
    // The contact sheet for this banner and case: rows = surface, columns = S / M / L.
    const sheet = await fx.browser.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 1 });
    const cls = c.device === "phone" ? "phone" : "desk";
    const rows = ["chatOpen", "details", "view"].map((surface) => `<tr><th>${surface}</th>${["s", "m", "l"].map((size) => {
      const cell = sheetRows.find((x) => x.surface === surface && x.size === size);
      return `<td><div class="cap">${size.toUpperCase()} · banner ${cell?.dims ? cell.dims[0] + "×" + cell.dims[1] : "—"}</div>${cell ? `<img src="${cell.src}" class="${cls}">` : "missing"}</td>`;
    }).join("")}</tr>`).join("");
    const dark = c.theme === "dark";
    await sheet.setContent(`<html><body style="margin:0;background:${dark ? "#111" : "#f4f4f4"};color:${dark ? "#eee" : "#111"};font:13px sans-serif"><h2 style="margin:8px 12px">#2038 — banner ${label} — ${caseName(c)}</h2><table style="border-collapse:collapse">${rows}</table>
      <style>td,th{border:1px solid #888;padding:6px;vertical-align:top} th{width:70px;text-align:left} img.desk{width:540px} img.phone{width:300px} .cap{font-size:11px;margin-bottom:4px}</style></body></html>`);
    await sheet.waitForTimeout(200);
    await sheet.screenshot({ path: shotPath(SMOKE, "sheet", `${label}-${caseName(c)}`), fullPage: true });
    await sheet.close();
    results.shots.push({ sheet: caseName(c), label, csp: await csp() });
    await ctx.close();
  }
}
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify({ smoke: SMOKE, n: results.shots.length, missing: results.shots.filter((s: any) => s.missing).length, banners: Object.keys(results.banners) }));
await fx.close(); process.exit(0);
