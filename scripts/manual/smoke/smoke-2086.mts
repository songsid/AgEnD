// #2086 identity-card banner focus and safe band, on the realistic fixture: the user's case (a 1600×600 banner with a
// face near the top) on the chat header card (open), Details and View, at card sizes S / M / L and widths 1366, 1920,
// 2560 and 390, with focus top / centre / bottom. Measures each banner box (its aspect and the share of the picture's
// height it shows) and saves a crop of each card plus one contact sheet per width.
//   TAG=before|after FOCI=0,50,100 WIDTHS=1366,1920,2560,390 PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir>
//   FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2086.mts
import { writeFileSync } from "node:fs";
import { bootFixture, shotPath, TEXT, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2086";
const TAG = process.env.TAG ?? "x";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48360) });
const fm = fx.fm;
const NAME = "rd1-platform-backend-sr4-server-t1547091841202130997";
const enc = encodeURIComponent;
const widths = (process.env.WIDTHS ?? "1366,1920,2560,390").split(",").map(Number);
const foci = (process.env.FOCI ?? "50").split(",").map(Number);

// The user's case: 1600×600 with a face near the top, a grid every 10% of the height so a crop is read at a glance.
async function faceBanner(): Promise<Buffer> {
  const p = await fx.browser.newPage();
  const b64 = await p.evaluate(`(() => { const c = document.createElement("canvas"); c.width = 1600; c.height = 600; const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 600); grad.addColorStop(0, "#2b4a7a"); grad.addColorStop(1, "#7aa0c8"); g.fillStyle = grad; g.fillRect(0, 0, 1600, 600);
    g.strokeStyle = "rgba(255,255,255,.35)"; g.fillStyle = "#fff"; g.font = "bold 20px sans-serif";
    for (let i = 1; i < 10; i++) { g.beginPath(); g.moveTo(0, i * 60); g.lineTo(1600, i * 60); g.stroke(); g.fillText(i * 10 + "%", 8, i * 60 - 6); }
    g.fillStyle = "#f2c9a0"; g.beginPath(); g.arc(800, 120, 80, 0, Math.PI * 2); g.fill();            // the face, near the top
    g.fillStyle = "#222"; g.beginPath(); g.arc(770, 105, 9, 0, Math.PI * 2); g.arc(830, 105, 9, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#222"; g.lineWidth = 5; g.beginPath(); g.arc(800, 135, 32, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
    g.fillStyle = "#fff"; g.font = "bold 44px sans-serif"; g.textAlign = "center"; g.fillText("FACE NEAR THE TOP · 1600×600", 800, 300);
    return c.toDataURL("image/jpeg", 0.9).split(",")[1]; })()`);
  await p.close();
  return Buffer.from(b64 as string, "base64");
}

const B = fm.themeStore.addAsset(NAME, "banner", await faceBanner());
if (!B?.ok) throw new Error("banner refused: " + JSON.stringify(B));
const results: any = { tag: TAG, browser: fx.browser.version(), cases: [] };
const c: MatrixCase = { device: "desk", theme: "light", lang: "en" };
for (const focus of foci) {
  const card: Record<string, unknown> = { banner: B.id, tagline: TEXT.taglineCjk };
  if (TAG !== "before" && focus !== 50) card.bannerFocus = focus;
  fx.seedTheme(NAME, { v: 1, card } as never);
  for (const width of widths) {
    const phone = width < 600;
    const { ctx, page } = await fx.page({ ...c, device: phone ? "phone" : "desk" }, { storage: { agend_view_card_expanded: "1", agend_chat_card: "open" } });
    await page.setViewportSize({ width, height: phone ? 844 : 1000 });
    const rows: string[] = [];
    for (const size of ["s", "m", "l"]) {
      fm.webPrefs.write("operator", new Map<string, unknown>([["card.size", size]]));
      await page.evaluate(`localStorage.setItem("agend_card_size", ${JSON.stringify(size)})`);
      const one = async (surface: string, path: string, sel: string) => {
        await page.goto(`${fx.base}${path}`); await page.waitForTimeout(900);
        if (surface === "chat" && !(await page.$(".chat-card .id-card"))) { await page.click(".chat-card-toggle").catch(() => {}); await page.waitForTimeout(400); }
        const el = await page.$(sel);
        if (!el) { results.cases.push({ focus, width, size, surface, missing: sel }); return; }
        const m: any = await page.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).querySelector(".id-banner"); if (!b) return null; const r = b.getBoundingClientRect();
          const cs = getComputedStyle(b); return { w: Math.round(r.width), h: Math.round(r.height), pos: cs.objectPosition }; })()`);
        const ar = m ? m.w / m.h : 0, shown = m ? Math.min(1, (1600 / 600) / ar) : 0;
        const file = shotPath(SMOKE, `${TAG}-w${width}-f${focus}`, `${size}-${surface}`);
        const buf = await el.screenshot({ path: file });
        results.cases.push({ focus, width, size, surface, box: m && [m.w, m.h], ar: +ar.toFixed(2), shownHeight: +shown.toFixed(2), pos: m?.pos });
        rows.push(`<tr><th>${surface} ${size.toUpperCase()}<br>${m ? `${m.w}×${m.h} (${ar.toFixed(2)}:1) shows ${(shown * 100).toFixed(0)}%` : "—"}</th><td><img src="data:image/png;base64,${buf.toString("base64")}" style="max-width:${phone ? 320 : 900}px"></td></tr>`);
      };
      await one("chat", `/ui/chat/${enc(NAME)}`, ".chat-card");
      await one("details", `/ui/fleet/agent/${enc(NAME)}`, ".p-details .id-card");
      await one("view", `/view/${enc(NAME)}`, ".v-id .id-card");
    }
    const sheet = await fx.browser.newPage({ viewport: { width: 1200, height: 800 } });
    await sheet.setContent(`<html><body style="margin:0;font:13px sans-serif;background:#f4f4f4"><h2 style="margin:8px 12px">#2086 ${TAG} — width ${width}, focus ${focus}%</h2><table style="border-collapse:collapse">${rows.join("")}</table>
      <style>td,th{border:1px solid #888;padding:6px;vertical-align:top;text-align:left} th{width:170px}</style></body></html>`);
    await sheet.screenshot({ path: shotPath(SMOKE, "sheet", `${TAG}-w${width}-f${focus}`), fullPage: true });
    await sheet.close();
    await ctx.close();
  }
}
// Edit profile's focus control (after only): the picture whole, the band every screen shows and a phone's, at each focus.
if (TAG !== "before") {
  for (const width of [1366, 390]) {
    const { ctx, page } = await fx.page({ ...c, device: width < 600 ? "phone" : "desk" }, { storage: { agend_view_card_expanded: "1" } });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${fx.base}/view/${enc(NAME)}`); await page.waitForTimeout(900);
    const edit = await page.$("button:has-text('Edit profile')");
    if (edit) {
      await edit.click(); await page.waitForTimeout(1200);
      for (const f of [0, 50, 100]) {
        await page.evaluate(`(() => { const r = document.querySelector('.bf-field input[type=range]'); if (!r) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(r, "${f}"); r.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await page.waitForTimeout(300);
        const el = await page.$(".bf-field");
        if (el) await el.screenshot({ path: shotPath(SMOKE, `${TAG}-edit-w${width}`, `focus${f}`) });
        results.cases.push({ edit: width, focus: f, present: !!el });
      }
    } else results.cases.push({ edit: width, missing: "Edit profile" });
    await ctx.close();
  }
}
writeFileSync(shotPath(SMOKE, "result", TAG).replace(/\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results.cases.map((x: any) => x.edit ? `edit ${x.edit} f${x.focus} ${x.present ?? x.missing}` : x.missing ? `${x.width} ${x.size} ${x.surface} MISSING` : `${x.width} f${x.focus} ${x.size} ${x.surface} ${x.box?.join("×")} ${x.ar}:1 shows ${x.shownHeight} pos ${x.pos}`)));
await fx.close(); process.exit(0);
