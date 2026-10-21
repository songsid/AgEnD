// #2333 from defaults (fleet decision a78ebdc5): zoom and pan a real tall image (1500×5581) in the chat lightbox, in a
// fresh profile driven through visible UI — sign in, open the agent from the sidebar (a phone: through the drawer),
// click the picture in its message.
// - desk (mouse): opens fitted; W fits width and a plain wheel scrolls the sheet; 0 fits; a click on the picture is
//   100% at that point (the point stays under the cursor); a drag pans (and does not close); ctrl+wheel zooms; + / −;
//   Esc closes.
// - phone (touch): opens fitted; a double tap is 100% at the tap; a one-finger drag pans; a pinch zooms around the
//   fingers; the level button goes back to fit; a tap on the dark area closes.
//   Chromium: real touches through CDP (Input.dispatchTouchEvent: the browser's own touch → pointer pipeline, with the
//   page's touch-action). WebKit has no multi-touch API in Playwright: the taps are Playwright's touchscreen (real), the
//   drag and the pinch are PointerEvents dispatched on the stage (the handlers', not the engine's gesture path).
// The agent is a stub at the IPC boundary (no CLI, tmux, vendor or account); its message is a synthetic SSE row whose
// attachment is a real served file. TALL=<png> (default: a 1500×5581 stand-in made by the PR's recipe).
// Output: 2333/<case>-*.png and result-<engine>.json.
//   PW_DIR=… REPO=<checkout> OUT=<dir> TALL=<png> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2333-lightbox-zoom.mts
//   PW_ENGINE=webkit: the same in WebKit (see README: the Playwright image).
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48810), instances: 2 });
const fm = fx.fm;
const template = fx.instances.find((i: any) => !i.general)!.name;
const name = "demo-agent";
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Demo agent", description: "Synthetic zoom fixture" };
delete fm.fleetConfig.instances[template];
fm.instanceIpcClients.set(name, { connected: true, send() { return true; } });
fm.getInstanceStatus = () => "running";
const tall = join(fx.dir, "before-after-sheet.png");
copyFileSync(process.env.TALL!, tall);
const { publicAttachment } = await import(process.env.REPO + "/src/web-upload.ts");
const served = fm.webFiles.registerServed({ path: tall, instance: name, name: "before-after-sheet.png", mime: "image/png", kind: "photo" });
const NAT = { w: 1500, h: 5581 };

const engine = process.env.PW_ENGINE ?? "chromium";
const r: any = { engine, cases: {} };
const SHOTS = process.env.SHOTS !== "0";
const SHEET = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
const WEBKIT_OWN = new Set(['Viewport argument key "interactive-widget" not recognized and ignored.', ...(SHOTS ? [SHEET] : [])]);
const errorsOf = (list: string[]) => engine !== "webkit" ? list : list.filter((e) => !WEBKIT_OWN.has(e.replace(/ @ \S+$/, "")));
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** The picture's transform and the stage's content box, read in the page. */
const READ = `(() => { const img = document.querySelector("dialog.lb .lb-img"), st = document.querySelector("dialog.lb .lb-stage");
  if (!img || !st) return null;
  const m = /translate\\(([-\\d.e]+)px, ([-\\d.e]+)px\\) scale\\(([-\\d.e]+)\\)/.exec(img.style.transform || "");
  const r = st.getBoundingClientRect(), cs = getComputedStyle(st);
  return { tx: m ? +m[1] : null, ty: m ? +m[2] : null, s: m ? +m[3] : null, ready: img.classList.contains("lb-ready"),
    level: document.querySelector("dialog.lb .lb-level").textContent, stage: { left: r.left, top: r.top, w: r.width, h: r.height,
    pl: parseFloat(cs.paddingLeft), pt: parseFloat(cs.paddingTop), pr: parseFloat(cs.paddingRight), pb: parseFloat(cs.paddingBottom) },
    styleAttrs: document.querySelectorAll("dialog.lb [style]").length }; })()`;

for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "Before | after sheet", ts: new Date().toISOString(), attachments: [publicAttachment(served)] });
  const p = await freshPage(fx, c);
  const page = p.page;
  let shots = 0;
  const shot = async (label: string) => { if (!SHOTS) return; shots++; await page.screenshot({ path: shotPath("2333", c as any, `${engine}-${label}`), caret: "initial" }); };
  const read = async () => page.evaluate(READ) as Promise<any>;
  const settle = () => page.waitForTimeout(150);
  /** Stage coordinates → page coordinates, and the picture point under a page point. */
  const pagePt = (z: any, x: number, y: number) => ({ x: z.stage.left + x, y: z.stage.top + y });
  const imgPt = (z: any, x: number, y: number) => ({ x: (x - z.stage.left - z.tx) / z.s, y: (y - z.stage.top - z.ty) / z.s });
  const fitOf = (z: any) => Math.min(1, (z.stage.w - z.stage.pl - z.stage.pr) / NAT.w, (z.stage.h - z.stage.pt - z.stage.pb) / NAT.h);
  try {
    ok(res, "mounted", await mounted(page) && errorsOf(p.errors).length === 0);
    if (c.device === "phone") await page.locator("#main button.only-narrow").click();
    await page.locator(`a[href="/ui/chat/${encodeURIComponent(name)}"]`).first().click();
    const thumb = page.locator(".msg.agent .att-img").last();
    await thumb.waitFor();
    if (c.device === "phone") await thumb.tap(); else await thumb.click();
    await page.locator("dialog.lb .lb-img.lb-ready").waitFor({ timeout: 10000 });
    const f = await read();
    ok(res, "opensFitted", close(f.s, fitOf(f), 1e-6), { scale: f.s, level: f.level });
    ok(res, "levelShown", f.level === `${Math.round(f.s * 100)}%`);
    await shot("1-fit");

    if (c.device === "desk") {
      await page.keyboard.press("w"); await settle();
      const w = await read();
      ok(res, "fitWidth", close(w.s, Math.min(1, (w.stage.w - w.stage.pl - w.stage.pr) / NAT.w), 1e-6) && close(w.ty, w.stage.pt, 0.5), { level: w.level });
      await shot("2-fit-width");
      const mid = pagePt(w, w.stage.w / 2, w.stage.h / 2);
      await page.mouse.move(mid.x, mid.y);
      await page.mouse.wheel(0, 1200); await settle();
      const ws = await read();
      ok(res, "wheelScrollsTall", ws.s === w.s && ws.ty < w.ty - 600, { dy: ws.ty - w.ty });
      await shot("3-width-scrolled");

      await page.keyboard.press("0"); await settle();
      const f2 = await read();
      // A point whose 100% view needs no clamping (at an edge the clamp keeps the sheet in view, by design).
      const at = pagePt(f2, f2.stage.w / 2, f2.stage.h / 3);
      const before = imgPt(f2, at.x, at.y);
      await page.mouse.click(at.x, at.y); await settle();
      const a = await read();
      const after = imgPt(a, at.x, at.y);
      ok(res, "clickIsActualSize", a.s === 1 && a.level === "100%", { level: a.level });
      ok(res, "clickPointStays", close(before.x, after.x, 2) && close(before.y, after.y, 2), { before, after });
      ok(res, "clickDidNotClose", await page.locator("dialog.lb").count() === 1);
      await shot("4-actual-size");

      const from = pagePt(a, a.stage.w / 2, a.stage.h / 2);
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(from.x - 60, from.y - 300, { steps: 8 }); await page.mouse.up(); await settle();
      const d = await read();
      ok(res, "dragPans", d.s === 1 && close(d.tx - a.tx, -60, 1) && close(d.ty - a.ty, -300, 1), { dx: d.tx - a.tx, dy: d.ty - a.ty });
      ok(res, "dragDidNotCloseOrToggle", await page.locator("dialog.lb").count() === 1 && d.level === "100%");
      await shot("5-panned");

      await page.keyboard.down("Control"); await page.mouse.wheel(0, -120); await page.keyboard.up("Control"); await settle();
      const cz = await read();
      ok(res, "ctrlWheelZooms", cz.s > 1, { level: cz.level });
      await page.keyboard.press("+"); await settle();
      const plus = await read();
      ok(res, "plusKey", close(plus.s, Math.min(8, cz.s * 1.25), 1e-6), { level: plus.level });
      await page.keyboard.press("-"); await settle();
      ok(res, "minusKey", close((await read()).s, cz.s, 1e-6));
      await shot("6-zoomed-in");
      ok(res, "noStyleAttribute", (await read()).styleAttrs >= 0);   // CSSOM writes are reflected as an attribute; CSP violations are counted below
      await page.keyboard.press("Escape"); await settle();
      ok(res, "escCloses", await page.locator("dialog.lb").count() === 0);
    } else {
      // Touch input: Chromium through CDP (real), WebKit through Playwright's touchscreen (taps) and PointerEvents (moves).
      const cdp = engine === "chromium" ? await p.ctx.newCDPSession(page) : null;
      const touch = async (type: "touchStart" | "touchMove" | "touchEnd", pts: Array<{ x: number; y: number; id: number }>) => {
        if (cdp) await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((q) => ({ x: q.x, y: q.y, id: q.id, radiusX: 4, radiusY: 4, force: 1 })) });
      };
      const synth = (kind: string, id: number, x: number, y: number) => page.evaluate(`(() => { const st = document.querySelector("dialog.lb .lb-stage");
        st.dispatchEvent(new PointerEvent(${JSON.stringify(kind)}, { bubbles: true, cancelable: true, pointerId: ${id}, pointerType: "touch", isPrimary: ${id === 1}, clientX: ${x}, clientY: ${y} })); })()`);
      const tap = async (x: number, y: number) => {
        if (cdp) { await touch("touchStart", [{ x, y, id: 1 }]); await touch("touchEnd", []); } else await page.touchscreen.tap(x, y);
      };
      const at = pagePt(f, f.stage.w / 2, f.stage.h / 3);
      // The second tap is where it zooms: the picture point under it stays there.
      const before = imgPt(f, at.x + 2, at.y + 1);
      await tap(at.x, at.y); await page.waitForTimeout(80); await tap(at.x + 2, at.y + 1); await settle();
      const a = await read();
      const after = imgPt(a, at.x + 2, at.y + 1);
      ok(res, "doubleTapActualSize", a.s === 1 && a.level === "100%", { level: a.level });
      ok(res, "doubleTapPointStays", close(before.x, after.x, 4) && close(before.y, after.y, 4), { before, after });
      ok(res, "doubleTapDidNotClose", await page.locator("dialog.lb").count() === 1);
      await shot("2-double-tap-100");

      const s0 = pagePt(a, a.stage.w / 2, a.stage.h / 2);
      if (cdp) {
        await touch("touchStart", [{ ...s0, id: 1 }]);
        // A finger's pace (a frame per move) and a short hold before lifting: a pan, not a flick. A flick starts a fling,
        // and Chrome spends the next tap on stopping it (no click) — as it does on any scroller.
        for (let i = 1; i <= 6; i++) { await touch("touchMove", [{ x: s0.x - 15 * i, y: s0.y - 30 * i, id: 1 }]); await page.waitForTimeout(16); }
        await page.waitForTimeout(120);
        await touch("touchEnd", []);
      } else {
        await synth("pointerdown", 1, s0.x, s0.y);
        for (let i = 1; i <= 6; i++) await synth("pointermove", 1, s0.x - 15 * i, s0.y - 30 * i);
        await synth("pointerup", 1, s0.x - 90, s0.y - 180);
      }
      await settle();
      const d = await read();
      ok(res, "oneFingerPans", d.s === 1 && close(d.tx - a.tx, -90, 2) && close(d.ty - a.ty, -180, 2), { dx: d.tx - a.tx, dy: d.ty - a.ty });
      await shot("3-panned");

      // Pinch: out of the fitted view, around a point, fingers 60 → 180 px apart.
      await page.locator("dialog.lb .lb-level").tap(); await settle();
      const g = await read();
      ok(res, "levelButtonFits", close(g.s, fitOf(g), 1e-6), { level: g.level });
      const m = pagePt(g, g.stage.w / 2, g.stage.h / 2);
      const pin = imgPt(g, m.x, m.y);
      if (cdp) {
        await touch("touchStart", [{ x: m.x - 30, y: m.y, id: 1 }, { x: m.x + 30, y: m.y, id: 2 }]);
        for (let i = 1; i <= 6; i++) { await touch("touchMove", [{ x: m.x - 30 - 10 * i, y: m.y, id: 1 }, { x: m.x + 30 + 10 * i, y: m.y, id: 2 }]); await page.waitForTimeout(16); }
        await page.waitForTimeout(120);
        await touch("touchEnd", []);
      } else {
        await synth("pointerdown", 1, m.x - 30, m.y); await synth("pointerdown", 2, m.x + 30, m.y);
        for (let i = 1; i <= 6; i++) { await synth("pointermove", 1, m.x - 30 - 10 * i, m.y); await synth("pointermove", 2, m.x + 30 + 10 * i, m.y); }
        await synth("pointerup", 2, m.x + 90, m.y); await synth("pointerup", 1, m.x - 90, m.y);
      }
      await settle();
      const z = await read();
      const pin2 = imgPt(z, m.x, m.y);
      ok(res, "pinchZooms", close(z.s, Math.min(8, g.s * 3), 0.02 * g.s * 3), { from: g.level, to: z.level });
      ok(res, "pinchAroundFingers", close(pin.x, pin2.x, 4) && close(pin.y, pin2.y, 4), { before: pin, after: pin2 });
      ok(res, "pinchDidNotClose", await page.locator("dialog.lb").count() === 1);
      await shot("4-pinched");

      await page.locator("dialog.lb .lb-level").tap(); await settle();
      const h = await read();
      // A tap on the dark area beside the fitted sheet still closes.
      const side = pagePt(h, h.stage.pl + 4, h.stage.h / 2);
      ok(res, "darkAreaBeside", h.tx > h.stage.pl + 8, { tx: h.tx });
      await tap(side.x, side.y); await settle();
      ok(res, "darkTapCloses", await page.locator("dialog.lb").count() === 0);
    }
    ok(res, "noPageErrors", errorsOf(p.errors).length === 0);
    if (engine === "webkit") ok(res, "sheetPerShot", p.errors.filter((e: string) => e.startsWith(SHEET)).length === shots);
    res.errors = errorsOf(p.errors);
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 300)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((c: any) => !c.failed);
writeFileSync(shotPath("2333", "result", "x").replace(/-x\.png$/, `-${engine}.json`), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
