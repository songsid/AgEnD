// M-3210 (the user, phone): the image viewer swipes like a phone's photo viewer — sideways to the previous / next picture
// of this chat (every picture, in message order, across messages; no wrap), up or down to close (the picture follows the
// finger, the dark fades), a short one springs back, and a zoomed-in picture pans instead of switching.
// A real Chromium phone (390×844, touch) with real touch input (CDP Input.dispatchTouchEvent → the page's pointer
// events), light/dark: sign in, open the agent from the drawer, tap the first picture of two messages of two pictures each.
// Judged per case; pictured: open, mid-swipe (finger down, the next picture's side), mid-pull (finger down, faded).
// The agent is a stub at the IPC boundary; its messages are synthetic SSE rows whose attachments are real served files.
// Run it on the base too (SMOKE_NAME=…-before): it FAILs there (nothing swipes; the set is one message's).
//   PW_DIR=… REPO=<checkout> OUT=<dir> [MATRIX=…] npx tsx scripts/manual/smoke/smoke-lightbox-swipe-m3210.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

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

const SMOKE = process.env.SMOKE_NAME ?? "smoke-lightbox-swipe-m3210";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48813), instances: 2 });
const fm = fx.fm;
const template = fx.instances.find((i: any) => !i.general)!.name;
const name = "demo-agent";
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Demo agent", description: "Synthetic gallery fixture" };
delete fm.fleetConfig.instances[template];
fm.instanceIpcClients.set(name, { connected: true, send() { return true; } });
fm.getInstanceStatus = () => "running";
const { publicAttachment } = await import(process.env.REPO + "/src/web-upload.ts");
const COLOURS: Array<[number, number, number]> = [[220, 80, 60], [240, 170, 40], [90, 180, 80], [40, 160, 200]];
const SIZES = [[1200, 800], [800, 1200], [1600, 900], [900, 900]];
const att = COLOURS.map((colour, i) => {
  const file = join(fx.dir, `pic-${i + 1}.png`);
  writeFileSync(file, png(SIZES[i]![0]!, SIZES[i]![1]!, colour));
  return publicAttachment(fm.webFiles.registerServed({ path: file, instance: name, name: `pic-${i + 1}.png`, mime: "image/png", kind: "photo" }));
});
const srcOf = (i: number) => `/ui/file/${att[i]!.id}`;
const READ = `(() => { const d = document.querySelector("dialog.lb"); if (!d) return null;
  const img = d.querySelector(".lb-img"), rc = img.getBoundingClientRect(), bg = getComputedStyle(d).backgroundColor;
  return { count: (d.querySelector(".lb-count") || {}).textContent || "", src: img.getAttribute("src"), ready: img.classList.contains("lb-ready"),
    left: Math.round(rc.left), top: Math.round(rc.top), w: Math.round(rc.width), pull: d.style.getPropertyValue("--lb-pull") || "", bg,
    prevOff: !!d.querySelector(".lb-prev")?.disabled, nextOff: !!d.querySelector(".lb-next")?.disabled }; })()`;
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
// The chat: two messages of two pictures each (once: every case reads the same history).
fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "Two pictures", ts: new Date().toISOString(), attachments: att.slice(0, 2) });
fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "Two more", ts: new Date(Date.now() + 1000).toISOString(), attachments: att.slice(2, 4) });

for (const c of matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW")) {
  if (c.device !== "phone") continue;
  const failed: string[] = [];
  const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
  const p = await freshPage(fx, c);
  const page = p.page;
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type: string, x?: number, y?: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: x == null ? [] : [{ x, y }] });
  /** One finger from (x0,y0) to (x1,y1) in `n` moves ~16 ms apart; `lift` false leaves it down (for a picture). */
  const swipe = async (x0: number, y0: number, x1: number, y1: number, n = 8, lift = true) => {
    await touch("touchStart", x0, y0);
    for (let i = 1; i <= n; i++) { await touch("touchMove", x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n); await page.waitForTimeout(16); }
    if (lift) await touch("touchEnd");
  };
  const read = async () => { await page.waitForTimeout(450); return page.evaluate(READ) as Promise<any>; };
  const shot = (label: string) => page.screenshot({ path: shotPath(SMOKE, caseName(c), label), caret: "initial" });
  try {
    need(await mounted(page), "the app mounted");
    await page.locator("#sbOpen").tap(); await page.waitForTimeout(500);
    await page.locator(`#sidebar a[href="/ui/chat/${encodeURIComponent(name)}"]`).first().tap();
    const thumbs = page.locator(".msg.agent .att-img");
    await thumbs.nth(3).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".msg.agent .att-img img")].slice(-4).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10000 });
    const n = await thumbs.count();
    /**
     * Open the viewer on the i-th thumbnail, deterministically (the post-merge of #4032 timed out once on a reopen tap that
     * opened nothing): no viewer up and the page unlocked, the thumbnail in view and still for three frames, and it is what
     * the tap lands on — then the tap, and the viewer within 5 s. Anything else fails with what was there instead.
     */
    const openViewer = async (i: number) => {
      await page.waitForFunction(() => !document.querySelector("dialog.lb") && !document.documentElement.classList.contains("lb-open"), null, { timeout: 5000 });
      await thumbs.nth(i).scrollIntoViewIfNeeded();
      const ready = await page.evaluate(async (idx: number) => {
        const el = document.querySelectorAll(".msg.agent .att-img")[idx] as HTMLElement | undefined;
        if (!el) return { still: false, hit: false, what: "no thumbnail" };
        let last = "", same = 0;
        for (let k = 0; k < 90 && same < 3; k++) {
          await new Promise((r) => requestAnimationFrame(r));
          const b = el.getBoundingClientRect(), key = `${Math.round(b.left)},${Math.round(b.top)}`;
          same = key === last ? same + 1 : 0; last = key;
        }
        const b = el.getBoundingClientRect(), at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return { still: same >= 3, hit: !!at && el.contains(at), what: at ? `${at.tagName}.${(at as HTMLElement).className}` : null, box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] };
      }, i);
      if (!ready.still || !ready.hit) throw new Error(`picture ${i} is not ready for a tap: ${JSON.stringify(ready)}`);
      await thumbs.nth(i).tap();
      await page.locator("dialog.lb").waitFor({ timeout: 5000 }).catch(async () => {
        const at = await page.evaluate(() => ({ scrollTop: (document.querySelector(".p-chat .scroller") as HTMLElement)?.scrollTop, active: `${document.activeElement?.tagName}.${(document.activeElement as HTMLElement)?.className}` }));
        throw new Error(`a tap on picture ${i} opened nothing (${JSON.stringify({ ready, ...at })})`);
      });
    };
    await openViewer(n - 4);
    const open = await read();
    need(open?.src === srcOf(0) && open.count === "1 / 4" && open.prevOff && !open.nextOff, `opens on the first of the chat's four (${JSON.stringify(open)})`);
    await shot("1-open");
    // Sideways: the picture follows the finger (pictured with the finger down), then the next; across messages; back.
    await swipe(320, 420, 140, 424, 8, false);
    const mid = await page.evaluate(READ) as any;
    need(mid && mid.left < open.left - 100 && mid.src === srcOf(0), `mid-swipe the picture follows the finger (${open.left} → ${mid?.left})`);
    await shot("2-mid-swipe");
    await touch("touchEnd");
    const two = await read();
    await swipe(320, 420, 120, 420);
    const three = await read();
    await swipe(100, 420, 300, 420);
    const back = await read();
    need(two?.src === srcOf(1) && three?.src === srcOf(2) && three.count === "3 / 4" && back?.src === srcOf(1),
      `a swipe left is the next (into the next message), right the previous (${[two, three, back].map((z) => z?.count).join(", ")})`);
    // Short and slow springs back; the last picture stays the last.
    await swipe(250, 420, 215, 420, 10);
    const sprung = await read();
    need(sprung?.src === srcOf(1) && Math.abs(sprung.left - back.left) <= 1, `a short, slow swipe springs back (${JSON.stringify(sprung)})`);
    await swipe(320, 420, 120, 420); await swipe(320, 420, 120, 420); await swipe(320, 420, 120, 420);
    const last = await read();
    need(last?.src === srcOf(3) && last.nextOff && last.count === "4 / 4", `the last picture stays the last (${JSON.stringify(last)})`);
    // Zoomed in (a double tap), a finger pans: the same picture.
    await page.touchscreen.tap(195, 420); await page.waitForTimeout(80); await page.touchscreen.tap(195, 420); await page.waitForTimeout(400);
    await swipe(300, 420, 200, 420, 4);
    await swipe(100, 420, 200, 420, 4);
    const zoomed = await read();
    need(zoomed?.src === srcOf(3), `zoomed in, a swipe pans and does not switch (${zoomed?.src === srcOf(3)})`);
    await page.locator("dialog.lb .lb-level").tap(); await page.waitForTimeout(300);   // back to fit
    // Down: the picture follows, the dark fades (pictured), and it closes.
    const before = await page.evaluate(READ) as any;
    await swipe(195, 300, 199, 520, 8, false);
    const pulling = await page.evaluate(READ) as any;
    // The computed colour: rgba(r, g, b, a) or, for a color-mix, color(srgb r g b / a).
    const alpha = (bg: string) => { const m = /\/\s*([\d.]+)\s*\)$/.exec(bg || "") || /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(bg || ""); return m ? parseFloat(m[1]!) : 1; };
    need(pulling && pulling.top > before.top + 150 && Number(pulling.pull) > 0.2 && alpha(pulling.bg) < 0.8, `mid-pull the picture follows and the dark fades (${JSON.stringify({ top: [before?.top, pulling?.top], pull: pulling?.pull, bg: pulling?.bg })})`);
    await shot("3-mid-pull");
    await touch("touchEnd"); await page.waitForTimeout(400);
    need(!(await page.locator("dialog.lb").count()), "pulled down far enough, it closed");
    // Closed on the last picture: focus (and the thread) on its thumbnail, not back on the first one opened.
    const focusAt = await page.evaluate(() => { const all = [...document.querySelectorAll(".msg.agent .att-img")]; return all.indexOf(document.activeElement as Element) - all.length; });
    need(focusAt === -1, `closed on the last picture, its thumbnail has the focus (${focusAt})`);
    // A short pull springs back and stays open; up closes too.
    await openViewer(n - 3); await page.waitForTimeout(400);
    await swipe(195, 400, 195, 440, 10);
    const stays = await read();
    need(stays && (stays.pull === "" || Number(stays.pull) === 0), `a short pull springs back, open (${JSON.stringify(stays)})`);
    await swipe(195, 600, 195, 300);
    await page.waitForTimeout(300);
    need(!(await page.locator("dialog.lb").count()), "pulled up, it closed");
    need(p.errors.length === 0, `page errors: ${p.errors.join(" | ")}`);
  } catch (err) {
    failed.push(`threw: ${String(err).slice(0, 300)}`);
    await shot("error").catch(() => {});
  }
  results.push({ name: caseName(c), ok: failed.length === 0, failed });
  await p.ctx.close();
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
await fx.close();
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
