// Real app mouse/touch regression in a scratch fixture; no send or live agent actions.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP || 49133), instances: 2, classic: false });
const out = process.env.OUT!; mkdirSync(out, { recursive: true });
const results: unknown[] = [];
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(process.env.REPO + "/src/scheduler/index.ts");
fx.fm.scheduler?.db.close();
fx.fm.scheduler = new Scheduler(join(fx.fm.dataDir, "popup-tasks.db"), () => {}, DEFAULT_SCHEDULER_CONFIG, (name: string) => !!fx.fm.fleetConfig.instances[name]);
fx.fm.attachTaskBoard(fx.fm.scheduler.db);
const card = fx.fm.scheduler.db.board.createCards({ kind: "person", name: "Example Person" }, { cards: [{ title: "Example task", assignee: "general" }] }).cards[0];
try {
  for (const device of ["desk", "phone"] as const) {
    const p = await fx.page({ device, theme: "dark", lang: "en" }, { path: "/ui/chat/general" });
    const page = p.page, box = page.locator("#msgIn"); await box.waitFor();
    let sends = 0; page.on("request", (r: any) => { if (r.method() === "POST" && /\/ui\/send\b/.test(r.url())) sends++; });
    const presses: unknown[] = [];
    for (const pointer of device === "desk" ? ["mouse"] : ["mouse", "touch"]) {
      await box.fill("/"); const row = page.locator("#cmdPalette [role=option]").first(); await row.waitFor();
      const wanted = await row.getAttribute("id");
      await page.evaluate(() => {
        (window as any).__popupPress = [];
        for (const type of ["pointerdown", "mousedown", "click"]) document.addEventListener(type, e => {
          if ((e.target as Element)?.closest("#cmdPalette")) queueMicrotask(() => (window as any).__popupPress.push({ type, prevented: e.defaultPrevented }));
        }, { once: true });
      });
      if (pointer === "touch") await row.tap(); else { const b = await row.boundingBox(); await page.mouse.move(b!.x + 20, b!.y + b!.height / 2); await page.mouse.down(); await page.mouse.up(); }
      const value = await box.inputValue(); const events = await page.evaluate(() => (window as any).__popupPress);
      if (!wanted || value.trim() !== "/" + wanted.slice(4)) throw Error(JSON.stringify({ device, pointer, wanted, value, events }));
      presses.push({ pointer, selected: value, events });
    }
    const taskPresses = [];
    for (const pointer of device === "desk" ? ["mouse"] : ["mouse", "touch"]) {
      await box.fill("#"); const row = page.locator(".task-ref-list [role=option]").first(); await row.waitFor();
      if (pointer === "touch") await row.tap(); else { const b = await row.boundingBox(); await page.mouse.move(b!.x + 20, b!.y + b!.height / 2); await page.mouse.down(); await page.mouse.up(); }
      const value = await box.inputValue();
      if (value.trim() !== "#" + card.code) throw Error(JSON.stringify({ device, pointer, task: card.code, value }));
      taskPresses.push({ pointer, selected: value });
    }
    await box.fill(""); await box.blur();
    const point = await page.locator(".composer-hit").evaluate((el: Element) => { const b = el.getBoundingClientRect(); return { x: b.left + 2, y: b.top + 2 }; });
    await page.mouse.click(point.x, point.y); await page.keyboard.type("Edge still works");
    if (await box.inputValue() !== "Edge still works") throw Error("strip edge lost real input focus");
    // Unknown popup markup is deliberately not a button/tabindex/ARIA role: it must retain its own mouse phase too.
    await page.locator(".composer-hit").evaluate((strip: Element) => {
      const popup = document.createElement("div"); popup.id = "fixture-popup"; popup.textContent = "Example popup row";
      popup.style.cssText = "position:fixed;left:20px;top:120px;background:white;padding:20px;z-index:99999";
      popup.addEventListener("mousedown", () => popup.dataset.chosen = "yes"); strip.append(popup);
    });
    await page.locator("#fixture-popup").click();
    if (await page.locator("#fixture-popup").getAttribute("data-chosen") !== "yes") throw Error("unclassified popup was intercepted");
    await page.locator("#fixture-popup").evaluate((el: Element) => el.remove());
    const csp = await p.csp(); if (csp.length || sends) throw Error(JSON.stringify({ csp, sends }));
    results.push({ device, presses, taskPresses, edgeFocus: true, unclassifiedPopup: true, csp, sends }); await p.ctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(out, "result.json"), JSON.stringify({ source: process.env.SOURCE_HEAD, cases: results }, null, 2) + "\n");
