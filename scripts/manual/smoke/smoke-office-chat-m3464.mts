// M-3464: synthetic web-only scratch host; no CLI, tmux, Fleet start or model calls.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName, mounted } from "../smoke-fixture/index.mts";
const out = process.env.OUT ?? ".artifacts/m3464/captures"; mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP ?? 49120), classic: false, host: true, roster: [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "example-agent", backend: "codex", displayName: "Example helper", status: "running" },
] });
// A persistent fixture state makes the always-visible state bubble deterministic across stream refreshes.
fx.fm.getInstanceExecutionState = (name: string) => name === "example-agent" ? "stuck" : "idle";
const results: any[] = [];
try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW")) {
    const { ctx, page, csp } = await fx.page(c, { path: "/ui/fleet/org", storage: { agend_org_mode: "office", agend_org_office_skin: "cozy" } });
    const errors: string[] = [], sends: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    ctx.on("request", (r: any) => { if (r.url().includes("/ui/send")) sends.push(r.method()); });
    if (!(await mounted(page, 30000))) throw new Error("Office did not mount");
    await page.locator(".oo-canvas").waitFor();
    if (c.device === "phone") await page.locator(".oo-more-btn").click();
    await page.locator(".oo-dialogue input").check();
    if (c.device === "phone") await page.locator(".oo-sheet .dlg-x").click();
    await page.locator(".oo-dialogue-live").waitFor({ state: "attached" });
    // Let Preact commit the newly enabled stream subscription before publishing the fixture event.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    fx.fm.emitSseEvent("message", { instance: "example-agent", role: "user", sender: "Example colleague", text: c.lang === "en" ? "Example update is ready." : "範例更新已準備好。", ts: new Date().toISOString() });
    try { await page.waitForFunction(() => (document.querySelector(".oo-dialogue-live")?.textContent ?? "").length > 4); }
    catch (err) { await page.screenshot({ path: join(out, caseName(c) + "-debug.png") }); throw err; }
    await page.waitForTimeout(500); // capture/click after the existing dialogue entrance animation
    await page.screenshot({ path: join(out, caseName(c) + "-office.png") });
    const point = await page.locator(".oo-canvas").evaluate(async (cv: HTMLCanvasElement) => {
      const d = await import("/ui/js/fleet-office-dialogue.js");
      const r = cv.getBoundingClientRect();
      const L = d.fitBox(d.boxLayout(r.width, r.height), 1, false);
      return { x: r.left + L.box.x + L.box.w - 20, y: r.top + L.box.y + L.box.h - 6 };
    });
    const next = page.waitForEvent("popup");
    if (c.device === "phone") await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
    const child = await next;
    await child.setViewportSize(c.device === "phone" ? { width: 390, height: 844 } : { width: 960, height: 800 });
    await child.locator("#msgIn").waitFor();
    if (new URL(page.url()).pathname !== "/ui/fleet/org") throw new Error("source left Office");
    if (new URL(child.url()).pathname !== "/ui/chat/example-agent") throw new Error("wrong chat");
    if (await child.evaluate(() => window.opener !== null)) throw new Error("opener retained");
    await child.locator("#msgIn").fill(c.lang === "en" ? "Example unsent draft" : "尚未送出的範例草稿");
    await child.screenshot({ path: join(out, caseName(c) + "-chat.png") });
    await child.close(); await page.bringToFront();
    // Native keyboard route: the same agent card's Chat action opens a fresh window.
    const desk = page.locator('.oo-desk[data-name="example-agent"]');
    await desk.focus(); await page.keyboard.press("Enter");
    await page.locator(".oo-card").waitFor();
    const action = page.locator(".oo-card-chat");
    await action.focus();
    await page.screenshot({ path: join(out, caseName(c) + "-keyboard.png") });
    const kb = page.waitForEvent("popup"); await page.keyboard.press("Enter");
    const second = await kb; await second.locator("#msgIn").waitFor(); await second.close(); await page.bringToFront();
    await page.evaluate(async () => {
      const w = window as any; w.__officeBubble = null;
      const original = CanvasRenderingContext2D.prototype.fillText;
      const wanted = new Set(["Hmm, stuck?", "Still thinking…", "嗯，卡住了？", "還在想…"]);
      CanvasRenderingContext2D.prototype.fillText = function(text: string, x: number, y: number, ...rest: any[]) {
        if (this.canvas.classList.contains("oo-canvas") && wanted.has(text)) {
          const m = this.getTransform(), r = this.canvas.getBoundingClientRect();
          w.__officeBubble = { text, at: performance.now(), hidden: document.hidden, x: r.left + (m.a * x + m.e) * r.width / this.canvas.width, y: r.top + (m.d * y + m.f) * r.height / this.canvas.height };
        }
        return original.call(this, text, x, y, ...rest);
      };

    });
    await page.waitForFunction(() => !!(window as any).__officeBubble);
    await page.screenshot({ path: join(out, caseName(c) + "-bubble.png") });
    const statePoint = await page.evaluate(() => (window as any).__officeBubble);
    console.log(JSON.stringify({ case: caseName(c), statePoint, diagnostic: await page.evaluate((pt: any) => ({ hidden: document.hidden, target: document.elementFromPoint(pt.x, pt.y)?.className, canvas: document.querySelector(".oo-canvas")?.getBoundingClientRect().toJSON(), now: performance.now() }), statePoint) }));
    const statePopup = page.waitForEvent("popup");
    // The phone tap is outside the tiny painted box, inside its 44px effective target.
    if (c.device === "phone") await page.touchscreen.tap(statePoint.x, statePoint.y + 15);
    else await page.mouse.click(statePoint.x, statePoint.y);
    const third = await statePopup; await third.locator("#msgIn").waitFor();
    if (new URL(third.url()).pathname !== "/ui/chat/example-agent") throw new Error("state bubble opened wrong agent");
    await third.close();
    if (new URL(page.url()).pathname !== "/ui/fleet/org" || sends.length) throw new Error("source changed or chat sent");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow || errors.length || (await csp()).length) throw new Error(JSON.stringify({ overflow, errors, csp: await csp() }));
    results.push({ case: caseName(c), dialogue: true, stateBubble: true, touchTarget: c.device === "phone" ? 44 : null, keyboard: true, sourceRetained: true, noSend: true, noOverflow: true });
    await ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2) + "\n");
