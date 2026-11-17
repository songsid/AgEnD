// M-3271 (the user: 「右鍵可以釘選訊息，這樣比較好找」): pin web chat messages, in the real app on the shared fixture
// (in-process FleetManager, scratch home, loopback only; the agent is a stub at the IPC boundary — no CLI, tmux, vendor or
// account). Headless. Per case (a desk: light, en, right-click; a phone: dark, zh-TW, a long press):
//   1-menu    — the message menu: Reply / Pin / Copy text / Copy link
//   2-header  — Pin → the header's 📌 with its count (1, then 2 with a second message pinned)
//   3-list    — the 📌 → the list, newest first; a row → the message, flashed
//   4-copy    — 500 newer messages push the pinned one out of the chat's history; after a reload the row opens the copy
//               the pin kept (its words, author, time)
//   then × in the list unpins (the count goes; with none, no 📌).
// BEFORE=1 (on the base, SMOKE_NAME=…-before): only the menu and the header, as they are there (no Pin, no 📌).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [HP=<port>] npx tsx scripts/manual/smoke/smoke-chat-pins-m3271.mts
// ui-gate: {"name": "Chat pinned messages (desk and phone)", "hp": 19691}
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-chat-pins-m3271";
const BEFORE = process.env.BEFORE === "1";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49730), instances: 2 });
const fm = fx.fm;
const template = fx.instances.find((i: any) => !i.general)!.name;
const name = "demo-agent";
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Demo agent", description: "Synthetic pin fixture" };
delete fm.fleetConfig.instances[template];
fm.instanceIpcClients.set(name, { connected: true, send() { return true; } });
fm.getInstanceStatus = () => "running";
const PLAN = "The deploy plan: build at 14:00, staging at 15:00, production after the smoke tests pass.";
const ASK = "Please keep the staging URL handy.";
const TOUCH = `const touch = (el, type, x, y, id) => { const t = { identifier: id, target: el, clientX: x, clientY: y }; let ev;
  try { const one = new Touch(t); ev = new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [one], changedTouches: [one] }); }
  catch { ev = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(ev, "touches", { value: type === "touchend" ? [] : [t] }); Object.defineProperty(ev, "changedTouches", { value: [t] }); }
  el.querySelector(".body").dispatchEvent(ev); };
`;
const RUN = (el: any, src: string) => (0, eval)(src)(el);
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
try {
  for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    (fm as any).pinStore?.forget(name);                       // each case starts with none (a separate store, not a pref)
    fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: PLAN, ts: new Date().toISOString() });
    fm.emitSseEvent("message", { instance: name, sender: "Ops", role: "user", text: ASK, ts: new Date().toISOString() });
    const p = await freshPage(fx, c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    const page = p.page;
    const shot = (label: string) => page.screenshot({ path: shotPath(SMOKE, c as any, label), caret: "initial" });
    const menuOn = async (text: string) => {
      const m = page.locator(".msg", { hasText: text }).last();
      if (c.device === "desk") await m.locator(".body").click({ button: "right" });
      else await m.evaluate(RUN, `(el) => { ${TOUCH} return new Promise((done) => { const r0 = el.getBoundingClientRect(); touch(el, "touchstart", r0.left + 30, r0.top + 10, 2); setTimeout(done, 650); }); }`);
      const menu = page.locator(".msg-menu"); await menu.waitFor({ timeout: 5000 });
      return menu;
    };
    const count = () => page.evaluate(() => document.querySelector(".chat-pins-btn .chat-pins-count")?.textContent ?? null);
    // The list: the header's 📌 on a desk; on a phone (its header: ← title ⋯) the ⋯ sheet's 「釘選的訊息 · N」.
    const openList = async () => {
      if (c.device === "desk") await page.locator(".chat-pins-btn").click();
      else { await page.locator(".chat-sheet-more").click(); await page.waitForTimeout(400);
        await page.locator(".chat-sheet-tile", { hasText: "釘選的訊息" }).click(); }
      await page.locator(".chat-pins-dlg").waitFor({ timeout: 5000 });
    };
    try {
      need(await mounted(page, 30000), "the app mounted");
      await page.locator("#msgIn").waitFor({ timeout: 20000 }); await page.waitForTimeout(800);
      const menu = await menuOn(PLAN);
      const items = await menu.locator("button").allTextContents();
      await shot("1-menu");
      if (BEFORE) {
        await page.keyboard.press("Escape"); await page.waitForTimeout(200); await shot("2-header");
        results.push({ name: tag, ok: true, failed }); await p.ctx.close(); continue;
      }
      need(JSON.stringify(items) === (c.lang === "en" ? '["Reply","Pin","Copy text","Copy link"]' : '["回覆","釘選","複製文字","複製連結"]'), `1. the menu: ${JSON.stringify(items)}`);
      await menu.locator('[data-item="pin"]').click();
      await page.waitForFunction(() => document.querySelector(".chat-pins-btn .chat-pins-count")?.textContent === "1", undefined, { timeout: 5000 }).catch(() => {});
      need(await count() === "1", `2. Pin → the header's 📌 counts 1 (${await count()})`);
      const again = await menuOn(PLAN);
      need((await again.locator("button").allTextContents())[1] === (c.lang === "en" ? "Unpin" : "取消釘選"), "2. pinned: the menu says Unpin");
      await page.keyboard.press("Escape");
      await (await menuOn(ASK)).locator('[data-item="pin"]').click();
      await page.waitForFunction(() => document.querySelector(".chat-pins-btn .chat-pins-count")?.textContent === "2", undefined, { timeout: 5000 }).catch(() => {});
      need(await count() === "2", "2. a second pin: 2");
      await page.waitForTimeout(400); await shot("2-header");
      await openList();
      const dlg = page.locator(".chat-pins-dlg");
      const rows = await dlg.locator(".chat-pin-text").allTextContents();
      need(rows.length === 2 && rows[0] === ASK && rows[1] === PLAN, `3. the list, newest first (${JSON.stringify(rows)})`);
      await page.waitForTimeout(300); await shot("3-list");
      await dlg.locator(".chat-pin-go").nth(1).click();
      await page.waitForTimeout(250);
      need(await page.evaluate((t) => [...document.querySelectorAll(".msg")].some((m) => m.classList.contains("flash") && (m.textContent || "").includes(t)), PLAN),
        "3. a row → its message, flashed");
      need(await page.locator(".chat-pins-dlg").count() === 0, "3. the list closes on a jump");
      // 500 newer messages: the pinned ones leave the chat's history (the host's 500) — the pins keep their copies.
      for (let i = 0; i < 500; i++) fm.webChatHistory.record({ instance: name, sender: name, role: "agent", text: `later ${i}`, ts: new Date().toISOString() } as never);
      await page.reload(); await page.locator("#msgIn").waitFor({ timeout: 20000 }); await page.waitForTimeout(1200);
      need(await count() === "2", "4. after the reload: still 2 pins");
      await openList();
      await page.locator(".chat-pins-dlg .chat-pin-go").nth(1).click();
      const copy = page.locator(".chat-pin-copy"); await copy.waitFor({ timeout: 8000 }).catch(() => {});
      need(await copy.count() === 1 && (await copy.locator(".chat-pin-copy-text").textContent()) === PLAN, "4. a pin no longer in the chat: its copy");
      await page.waitForTimeout(300); await shot("4-copy");
      await page.keyboard.press("Escape"); await page.waitForTimeout(200);
      await openList();
      for (let n = 0; n < 2; n++) { await page.locator(".chat-pins-dlg .chat-pin-x").first().click(); await page.waitForTimeout(500); }
      need(await page.locator(".chat-pins-dlg .chat-pin").count() === 0, "5. × unpins: the list is empty");
      await page.keyboard.press("Escape"); await page.waitForTimeout(300);
      need(await page.locator(".chat-pins-btn").count() === 0, "5. none pinned: no 📌");
      need(p.errors.length === 0, `page errors: ${p.errors.join(" | ")}`);
    } catch (err) {
      failed.push(`threw: ${String(err).slice(0, 300)}`);
      await shot("error").catch(() => {});
    }
    results.push({ name: tag, ok: failed.length === 0, failed });
    await p.ctx.close();
  }
} finally {
  (fm as any).pinStore?.forget(name);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length === 2 && results.every((r) => r.ok) ? 0 : 1);
