// The identity card on a phone: portrait and text on one row (the user's ask on the classic chat header at ~430 px).
// Demo agent with a banner, a portrait, a CJK tagline and the long CJK bio; widths 390 and 430, light and dark, sizes
// S / M / L, on the chat header card (open), Details and View; plus the same card with no portrait. Measures where the
// text sits against the portrait, the card's share of the screen and horizontal overflow; saves a crop of each card and
// a contact sheet per width and theme.
//   TAG=before|after PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-id-row.mts
import { writeFileSync } from "node:fs";
import { bootFixture, shotPath, TEXT } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-id-row";
const TAG = process.env.TAG ?? "x";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48400) });
const fm = fx.fm;
const NAME = "observability-dashboards";                                 // a demo name (the fixture's first are not)
const enc = encodeURIComponent;

async function picture(w: number, h: number, label: string, hue: number): Promise<Buffer> {
  const p = await fx.browser.newPage();
  const b64 = await p.evaluate(`(() => { const c = document.createElement("canvas"); c.width = ${w}; c.height = ${h}; const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, ${w}, ${h}); grad.addColorStop(0, "hsl(${hue},55%,42%)"); grad.addColorStop(1, "hsl(${hue + 40},60%,70%)");
    g.fillStyle = grad; g.fillRect(0, 0, ${w}, ${h});
    g.fillStyle = "rgba(255,255,255,.85)"; g.beginPath(); g.arc(${w / 2}, ${h * 0.38}, ${Math.min(w, h) * 0.22}, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#fff"; g.font = "bold ${Math.round(Math.min(w, h) / 9)}px sans-serif"; g.textAlign = "center"; g.fillText(${JSON.stringify(label)}, ${w / 2}, ${h * 0.82});
    return c.toDataURL("image/jpeg", 0.9).split(",")[1]; })()`);
  await p.close();
  return Buffer.from(b64 as string, "base64");
}
const banner = fm.themeStore.addAsset(NAME, "banner", await picture(1600, 600, "DEMO BANNER", 200));
const portrait = fm.themeStore.addAsset(NAME, "portrait", await picture(768, 1024, "DEMO", 20));
if (!banner?.ok || !portrait?.ok) throw new Error("asset refused: " + JSON.stringify({ banner, portrait }));

const results: any = { tag: TAG, cases: [] };
const variants = [{ id: "portrait", card: { banner: banner.id, portrait: portrait.id, tagline: TEXT.taglineCjk, bio: TEXT.bioCjk } },
  { id: "noportrait", card: { banner: banner.id, tagline: TEXT.taglineCjk, bio: TEXT.bioCjk } }];
for (const variant of variants) {
  fx.seedTheme(NAME, { v: 1, card: variant.card } as never);
  for (const width of [390, 430]) for (const theme of variant.id === "portrait" ? ["light", "dark"] as const : ["light"] as const) {
    const { ctx, page } = await fx.page({ device: "phone", theme, lang: "zh-TW" }, { storage: { agend_chat_card: "open" } });
    await page.setViewportSize({ width, height: 844 });
    const rows: string[] = [];
    for (const size of ["s", "m", "l"]) {
      fm.webPrefs.write("operator", new Map<string, unknown>([["card.size", size]]));
      await page.evaluate(`localStorage.setItem("agend_card_size", ${JSON.stringify(size)})`);
      const one = async (surface: string, path: string, sel: string) => {
        await page.goto(`${fx.base}${path}`); await page.waitForTimeout(900);
        if (surface === "chat" && !(await page.$(".chat-card .id-card"))) { await page.click(".chat-card-menu > button").then(() => page.click(".chat-card-menu [role=menuitemcheckbox]")).then(() => page.keyboard.press("Escape")).catch(() => {}); await page.waitForTimeout(400); }
        const el = await page.$(sel);
        if (!el) { results.cases.push({ variant: variant.id, width, theme, size, surface, missing: sel }); return; }
        const m: any = await page.evaluate(`(() => { const card = document.querySelector(${JSON.stringify(sel)}); const box = (q) => { const e = card.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
          const c = card.getBoundingClientRect();
          return { card: { h: Math.round(c.height) }, row: box(".id-row"), portrait: box(".id-portrait"), text: box(".id-text"), size: box(".card-size"),
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || card.scrollWidth > card.clientWidth }; })()`);
        // Beside: the text starts right of the portrait and its top is level with the portrait's (not under it).
        const beside = m.portrait && m.text ? m.text.l >= m.portrait.r && m.text.t < m.portrait.b : null;
        const full = !m.portrait && m.text && m.row ? m.text.w >= m.row.w - 64 : null;
        const file = shotPath(SMOKE, `${TAG}-${variant.id}-w${width}-${theme}`, `${size}-${surface}`);
        // Measured at 844 px tall; shot tall, so a card longer than the screen is never under the bottom nav.
        await page.setViewportSize({ width, height: 3000 }); await page.waitForTimeout(200);
        const buf = await el.screenshot({ path: file });
        await page.setViewportSize({ width, height: 844 });
        results.cases.push({ variant: variant.id, width, theme, size, surface, beside, full, cardH: m.card.h, share: +(m.card.h / 844).toFixed(2),
          portrait: m.portrait && [m.portrait.w, m.portrait.h], text: m.text && [m.text.w, m.text.h], overflow: m.overflow });
        rows.push(`<tr><th>${surface} ${size.toUpperCase()}<br>card ${m.card.h}px (${Math.round(m.card.h / 8.44)}% of 844)<br>${m.portrait ? `portrait ${m.portrait.w}×${m.portrait.h}` : "no portrait"}<br>${beside === null ? "" : beside ? "text beside" : "text BELOW"}</th><td><img src="data:image/png;base64,${buf.toString("base64")}" style="max-width:${width}px"></td></tr>`);
      };
      await one("chat", `/ui/chat/${enc(NAME)}`, ".chat-card");
      await one("details", `/ui/fleet/agent/${enc(NAME)}`, ".p-details .id-card");
      await one("view", `/view/${enc(NAME)}`, ".v-id .id-card");
    }
    const sheet = await fx.browser.newPage({ viewport: { width: 900, height: 800 } });
    await sheet.setContent(`<html><body style="margin:0;font:13px sans-serif;background:${theme === "dark" ? "#222;color:#eee" : "#f4f4f4"}"><h2 style="margin:8px 12px">identity card ${TAG} — ${variant.id}, ${width} px, ${theme}</h2><table style="border-collapse:collapse">${rows.join("")}</table>
      <style>td,th{border:1px solid #888;padding:6px;vertical-align:top;text-align:left} th{width:190px}</style></body></html>`);
    await sheet.screenshot({ path: shotPath(SMOKE, "sheet", `${TAG}-${variant.id}-w${width}-${theme}`), fullPage: true });
    await sheet.close();
    await ctx.close();
  }
}
writeFileSync(shotPath(SMOKE, "sheet", `${TAG}-results`).replace(/\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results.cases.map((c: any) => [c.variant, c.width, c.theme, c.size, c.surface, c.beside ?? c.full, c.share, c.overflow]), null, 0));
if (TAG === "after") {
  const bad = results.cases.filter((c: any) => c.missing || c.overflow || c.beside === false || c.full === false);
  console.log(bad.length ? `FAIL ${JSON.stringify(bad)}` : "PASS");
  await fx.close(); process.exit(bad.length ? 1 : 0);
}
await fx.close();
