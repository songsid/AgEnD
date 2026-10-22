// The lightbox's previous / next across a message's images (the user's report on 2.3.0-beta.24: with 7 images, Next
// "flashes once and then the next image is not visible", the level reads "…"), from defaults (fleet decision a78ebdc5):
// a fresh profile driven through visible UI — sign in, open the agent from the sidebar (a phone: through the drawer),
// click the first picture of a message with 7, then Next through all of them and back with Prev (the thumbnails in
// the thread have already loaded every one: each step is to a cached picture, as in the report).
// Each step: the picture shown (lb-ready, visible, a real size on screen) and the level a percentage, never "…".
// The agent is a stub at the IPC boundary (no CLI, tmux, vendor or account); its message is a synthetic SSE row whose
// attachments are real served files (7 PNGs made here, each its own colour and size).
// Output: lightbox-next/<case>-*.png and result.json.
//   PW_DIR=… REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-lightbox-next.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

/** A PNG of w×h: a colour, with a darker band so each picture reads as its own. */
function png(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const band = y > h * 0.4 && y < h * 0.6 ? 0.55 : 1;
    for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r * band; raw[o + 1] = g * band; raw[o + 2] = b * band; }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const fx = await bootFixture({ port: Number(process.env.HP ?? 48812), instances: 2 });
const fm = fx.fm;
const template = fx.instances.find((i: any) => !i.general)!.name;
const name = "demo-agent";
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Demo agent", description: "Synthetic gallery fixture" };
delete fm.fleetConfig.instances[template];
fm.instanceIpcClients.set(name, { connected: true, send() { return true; } });
fm.getInstanceStatus = () => "running";
const { publicAttachment } = await import(process.env.REPO + "/src/web-upload.ts");
const COLOURS: Array<[number, number, number]> = [[220, 80, 60], [240, 170, 40], [90, 180, 80], [40, 160, 200], [80, 90, 210], [170, 80, 200], [200, 200, 200]];
const SIZES = [[1200, 800], [800, 1200], [1600, 900], [900, 900], [1400, 700], [700, 1400], [1000, 750]];
const attachments = COLOURS.map((colour, i) => {
  const file = join(fx.dir, `shot-${i + 1}.png`);
  writeFileSync(file, png(SIZES[i]![0]!, SIZES[i]![1]!, colour));
  return publicAttachment(fm.webFiles.registerServed({ path: file, instance: name, name: `shot-${i + 1}.png`, mime: "image/png", kind: "photo" }));
});

/** The file URL the chat shows the i-th picture at. */
const srcOf = (i: number) => `/ui/file/${attachments[i]!.id}`;
const r: any = { cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
/** What the lightbox shows now, read in the page. */
const READ = `(() => { const d = document.querySelector("dialog.lb"); if (!d) return null;
  const img = d.querySelector(".lb-img"), rc = img.getBoundingClientRect();
  return { count: (d.querySelector(".lb-count") || {}).textContent || "", level: d.querySelector(".lb-level").textContent,
    ready: img.classList.contains("lb-ready"), visibility: getComputedStyle(img).visibility, src: img.getAttribute("src"),
    w: Math.round(rc.width), h: Math.round(rc.height), nat: img.naturalWidth + "x" + img.naturalHeight }; })()`;

for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = { steps: [] });
  fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "Seven screenshots", ts: new Date().toISOString(), attachments });
  const p = await freshPage(fx, c);
  const page = p.page;
  const shot = (label: string) => page.screenshot({ path: shotPath("lightbox-next", c as any, label), caret: "initial" });
  try {
    ok(res, "mounted", await mounted(page) && p.errors.length === 0);
    if (c.device === "phone") await page.locator("#main button.only-narrow").click();
    await page.locator(`a[href="/ui/chat/${encodeURIComponent(name)}"]`).first().click();
    const thumbs = page.locator(".msg.agent").last().locator(".att-img");
    await thumbs.nth(6).waitFor();
    // Every thumbnail loaded: each picture is in the browser's cache before the lightbox steps to it.
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".msg.agent .att-img img")].slice(-7).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10000 });
    if (c.device === "phone") await thumbs.first().tap(); else await thumbs.first().click();
    await page.locator("dialog.lb").waitFor();
    // A step's settled state: given time to load and fit, as a person waits (the bug never settles).
    const settled = async () => { await page.waitForFunction(() => (document.querySelector("dialog.lb .lb-img") as HTMLImageElement | null)?.complete === true, null, { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(400); return page.evaluate(READ) as Promise<any>; };
    const shown = (z: any) => z && z.ready && z.visibility === "visible" && /^\d+%$/.test(z.level) && z.w > 50 && z.h > 50;
    const first = await settled();
    res.steps.push({ step: "open", ...first });
    ok(res, "opensShown", shown(first), first);
    await shot("1-open");
    const next = page.locator("dialog.lb .lb-next"), prev = page.locator("dialog.lb .lb-prev");
    // The order of events on the first step: the picture's load, and every change to its lb-ready class.
    await page.evaluate(`(() => { const img = document.querySelector("dialog.lb .lb-img"), log = (window.__lbTrace = []), t0 = performance.now();
      const at = () => Math.round(performance.now() - t0) + "ms", ready = () => (img.classList.contains("lb-ready") ? "+lb-ready" : "-lb-ready");
      img.addEventListener("load", () => log.push(at() + " load " + img.getAttribute("src").slice(-6) + " (" + ready() + ")"));
      new MutationObserver(() => log.push(at() + " class " + ready())).observe(img, { attributes: true, attributeFilter: ["class"] });
      new MutationObserver(() => log.push(at() + " src " + img.getAttribute("src").slice(-6))).observe(img, { attributes: true, attributeFilter: ["src"] }); })()`);
    for (let i = 2; i <= 7; i++) {
      if (c.device === "phone") await next.tap(); else await next.click();
      const z = await settled();
      res.steps.push({ step: `next→${i}`, ...z });
      ok(res, `next${i}Shown`, shown(z) && z.src === srcOf(i - 1), z);
      if (i === 3) await shot("2-next-3of7");
      if (i === 2) res.trace = await page.evaluate("window.__lbTrace");
    }
    if (c.device === "phone") await next.tap(); else await next.click();         // wraps to 1
    const wrapped = await settled();
    ok(res, "wrapsTo1", shown(wrapped) && wrapped.src === srcOf(0), wrapped);
    for (const want of [7, 6]) {
      if (c.device === "phone") await prev.tap(); else await prev.click();
      const z = await settled();
      res.steps.push({ step: `prev→${want}`, ...z });
      ok(res, `prev${want}Shown`, shown(z) && z.src === srcOf(want - 1), z);
    }
    await page.keyboard.press("ArrowRight");                                       // the arrow keys too
    const key = await settled();
    ok(res, "arrowShown", shown(key) && key.src === srcOf(6), key);
    await shot("3-prev-and-keys");
    // Not cached: the cache off and each picture held 800 ms. A step is hidden while it loads ("…", never the previous
    // picture), then shown with its level.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await page.route(/\/ui\/file\/[0-9a-f]{32}$/, async (route: any) => { await new Promise((done) => setTimeout(done, 800)); await route.continue(); });
    if (c.device === "phone") await prev.tap(); else await prev.click();
    await page.waitForTimeout(200);
    const loading = await page.evaluate(READ) as any;
    ok(res, "uncachedHiddenWhileLoading", !loading.ready && loading.visibility === "hidden" && loading.level === "…" && loading.src === srcOf(5), loading);
    const loaded = await settled().then(async (z) => (z.ready ? z : (await page.waitForTimeout(1500), page.evaluate(READ) as Promise<any>)));
    ok(res, "uncachedShownOnceLoaded", shown(loaded) && loaded.src === srcOf(5), loaded);
    await page.unroute(/\/ui\/file\/[0-9a-f]{32}$/);
    ok(res, "noPageErrors", p.errors.length === 0);
    res.errors = p.errors;
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 300)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((c: any) => !c.failed);
writeFileSync(shotPath("lightbox-next", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, failed: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, v.failed ?? []])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
