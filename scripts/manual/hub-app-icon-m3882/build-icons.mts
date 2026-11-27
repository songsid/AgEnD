/**
 * M-3882: renders the Hub's app icons from src/ui/icons/hub-favicon.svg (rounded tile) and hub-maskable.svg (full bleed)
 * in headless Chromium, and packs hub-favicon.ico (16/32/64 PNG entries). Re-run after editing either SVG:
 *   CHROME=<chromium> PW_DIR=<playwright-core> npx tsx scripts/manual/hub-app-icon-m3882/build-icons.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const ICONS = join(process.cwd(), "src", "ui", "icons");
const { chromium } = createRequire(join(process.env.PW_DIR!, "node_modules", "x.js"))("playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function render(svg: string, size: number, opaque: boolean): Promise<Buffer> {
  const src = "data:image/svg+xml;base64," + readFileSync(join(ICONS, svg)).toString("base64");
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:${opaque ? "#1d5fae" : "transparent"}"><img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`);
  await page.waitForFunction(() => document.querySelector("img")!.complete);
  return page.screenshot({ omitBackground: !opaque, clip: { x: 0, y: 0, width: size, height: size } });
}
const out = (name: string, b: Buffer) => { writeFileSync(join(ICONS, name), b); console.log(name, b.length); };
out("hub-icon-192.png", await render("hub-favicon.svg", 192, false));
out("hub-icon-512.png", await render("hub-favicon.svg", 512, false));
out("hub-icon-maskable-192.png", await render("hub-maskable.svg", 192, true));
out("hub-icon-maskable-512.png", await render("hub-maskable.svg", 512, true));
out("hub-apple-touch-icon.png", await render("hub-maskable.svg", 180, true));   // iOS rounds the corners itself; no transparency
// favicon.ico: an ICONDIR, one ICONDIRENTRY per size, then each PNG (PNG-in-ICO).
const sizes = [16, 32, 64], pngs = [] as Buffer[];
for (const s of sizes) pngs.push(await render("hub-favicon.svg", s, false));
const head = Buffer.alloc(6 + 16 * sizes.length); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => { const e = 6 + 16 * i; head.writeUInt8(s, e); head.writeUInt8(s, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(pngs[i]!.length, e + 8); head.writeUInt32LE(offset, e + 12); offset += pngs[i]!.length; });
out("hub-favicon.ico", Buffer.concat([head, ...pngs]));
await browser.close();
