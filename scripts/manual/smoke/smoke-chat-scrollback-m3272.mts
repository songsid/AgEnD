// M-3272 (the user, 2026-11-17: web chat scroll-back): the real app on the shared fixture (in-process FleetManager, scratch
// home, loopback only; the agent is a stub at the IPC boundary — no CLI, tmux, vendor or account), headless Chromium (CDP
// for the DOM and heap counters). An agent with 4,000 messages: the newest 500 in the window, 3,500 in the archive
// (web-chat-archive.ts, set here as the fleet sets it at start). Cases:
//   phone (390×844, dark, zh-TW) — scrolled up with the wheel, page after page, to the start of the chat:
//     · each page loads only at the very top, and the message the reader was on stays where it was on screen (±2 px);
//     · never more than 1,000 messages on screen; the DOM node count and the JS heap stay bounded (measured after GC);
//     · scrolled back down to the live end (the unloaded newest end read again), then a live message is drawn;
//     · a jump to a message deep in the archive (#m=…, as a search hit opens it) shows it, flashed;
//     · an archived reply's buttons are drawn read-only.
//   desk (1366×900, light, en) — the same chat scrolled back a few pages (a picture).
// BEFORE=1 (on the base, SMOKE_NAME=…-before): the top of the chat as it was — 500 messages, nothing older (a picture).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [HP=<port>] npx tsx scripts/manual/smoke/smoke-chat-scrollback-m3272.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-chat-scrollback-m3272";
const BEFORE = process.env.BEFORE === "1";
const REPO = process.env.REPO!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 49760), instances: 2 });
const fm = fx.fm as any;
const template = fx.instances.find((i: any) => !i.general)!.name;
const name = "demo-agent";
fm.fleetConfig.instances[name] = { ...fm.fleetConfig.instances[template], display_name: "Demo agent", description: "Synthetic scroll-back fixture" };
delete fm.fleetConfig.instances[template];
fm.instanceIpcClients.set(name, { connected: true, send() { return true; } });
fm.getInstanceStatus = () => "running";
let archive: any = null;
if (!BEFORE) {
  const { WebChatArchive } = await import(REPO + "/src/web-chat-archive.ts");
  archive = new WebChatArchive({ home: fx.dir, ownerOf: () => "dir:/smoke", logger: { warn: () => {} } });
  fm.webChatHistory.setArchive(archive);
}
const TOTAL = 4000, T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const words = ["The build passed.", "Deploying the demo build to staging now — the smoke tests run next.", "部署完成，staging 已更新。", "Checked the logs:\n- no errors\n- two warnings, both known", "OK"];
for (let n = 1; n <= TOTAL; n++) {
  const user = n % 5 === 0;
  fm.webChatHistory.record({ instance: name, sender: user ? "Ops" : name, role: user ? "user" : "agent", text: `#${n} ${words[n % words.length]}`, ts: new Date(T0 + n * 60_000).toISOString(),
    ...(n === 121 ? { buttons: { id: "e".repeat(32), labels: ["Ship it", "Hold"], state: "open" } } : {}) });
}
await archive?.flush();
const keyOf = (n: number) => `${fm.webChatHistory.boot}-${n}`;

const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const report: Record<string, unknown> = {};
try {
  for (const c of [{ device: "phone", theme: "dark", lang: "zh-TW" }, { device: "desk", theme: "light", lang: "en" }] as const) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const p = await freshPage(fx, c, { path: `/ui/chat/${encodeURIComponent(name)}` });
    const page = p.page;
    const shot = (label: string) => page.screenshot({ path: shotPath(SMOKE, c as any, label), caret: "initial" });
    const cdp = await page.context().newCDPSession(page);
    const measure = async () => { await cdp.send("HeapProfiler.collectGarbage"); const heap = await cdp.send("Runtime.getHeapUsage"), dom = await cdp.send("Memory.getDOMCounters");
      return { heapMB: Math.round(heap.usedSize / 1e5) / 10, nodes: dom.nodes, msgs: await page.locator(".p-chat .thread .msg[data-key]").count() }; };
    const ids = () => page.evaluate(() => [...document.querySelectorAll(".p-chat .thread .msg[data-key]")].map(e => Number(e.getAttribute("data-key")!.split("-")[1])));
    /** The first message on screen (below the header) and its top on screen. */
    const anchor = () => page.evaluate(() => {
      const sc = document.querySelector(".p-chat .scroller") as HTMLElement, top = sc.getBoundingClientRect().top;
      const el = [...document.querySelectorAll(".p-chat .thread .msg[data-key]")].find(e => e.getBoundingClientRect().bottom > top + 8) as HTMLElement | undefined;
      return el ? { key: el.getAttribute("data-key")!, y: Math.round(el.getBoundingClientRect().top) } : null;
    });
    const toTop = async () => { await page.locator(".p-chat .scroller").hover(); for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -4000); await page.waitForTimeout(30); if (await page.evaluate(() => (document.querySelector(".p-chat .scroller") as HTMLElement).scrollTop <= 1)) break; } };
    const toBottom = async () => { await page.locator(".p-chat .scroller").hover(); for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 4000); await page.waitForTimeout(30); if (await page.evaluate(() => { const s = document.querySelector(".p-chat .scroller") as HTMLElement; return s.scrollHeight - s.scrollTop - s.clientHeight <= 1; })) break; } };
    try {
      need(await mounted(page, 30000), "the app mounted");
      await page.locator("#msgIn").waitFor({ timeout: 20000 }); await page.waitForTimeout(1500);
      if (BEFORE) {
        await toTop(); await page.waitForTimeout(1500); await toTop(); await page.waitForTimeout(800);
        await shot("1-top"); results.push({ name: tag, ok: true, failed }); await p.ctx.close(); continue;
      }
      const start = await measure();
      if (c.device === "desk") {
        for (let i = 0; i < 4; i++) { await toTop(); await page.waitForTimeout(900); }
        await shot("1-scrolled-back");
        need((await ids())[0]! < TOTAL - 500, "desk: scrolled back past the 500");
        results.push({ name: tag, ok: failed.length === 0, failed }); await p.ctx.close(); continue;
      }
      // Page after page to the start of the chat.
      const jumps: number[] = [], seen: Array<{ page: number; msgs: number; nodes: number; heapMB: number }> = [];
      let pageNo = 0, lastFirst = Infinity;
      for (; pageNo < 60; pageNo++) {
        await toTop();
        const a = await anchor();
        await page.waitForTimeout(700);                                  // the page's read and its chunks drawn
        const first = (await ids())[0]!;
        if (a) { const b = await page.evaluate((k) => { const el = document.querySelector(`.p-chat .thread .msg[data-key="${k}"]`); return el ? Math.round(el.getBoundingClientRect().top) : null; }, a.key); if (b !== null) jumps.push(Math.abs(b - a.y)); }
        if (pageNo % 10 === 9) { const m = await measure(); seen.push({ page: pageNo + 1, ...m }); }
        if (first >= lastFirst) break;                                     // the start: nothing older came
        lastFirst = first;
        if (pageNo === 2) await shot("1-older-loaded");
      }
      const end = await measure();
      report[tag] = { start, end, seen, pages: pageNo, maxJump: Math.max(0, ...jumps) };
      need((await ids())[0] === 1, `the start of the chat reached (first ${(await ids())[0]})`);
      need(Math.max(0, ...jumps) <= 2, `a page loads with the reader kept where they were (largest move ${Math.max(0, ...jumps)} px)`);
      need(seen.every(s => s.msgs <= 1000) && end.msgs <= 1000, `never more than 1,000 on screen (${JSON.stringify(seen.map(s => s.msgs))})`);
      const maxNodes = Math.max(...seen.map(s => s.nodes), end.nodes), maxHeap = Math.max(...seen.map(s => s.heapMB), end.heapMB);
      need(maxNodes < (seen[0]?.nodes ?? end.nodes) * 1.5, `DOM nodes bounded (${JSON.stringify(seen.map(s => s.nodes))})`);
      need(maxHeap < (seen[0]?.heapMB ?? end.heapMB) + 25, `heap bounded (${JSON.stringify(seen.map(s => s.heapMB))} MB)`);
      // An archived reply's buttons: drawn, read-only.
      await page.evaluate(() => { location.hash = ""; });
      const btns = page.locator(`.p-chat .msg[data-key="${keyOf(121)}"] .rb-row button`);
      if (await btns.count()) {
        await page.locator(`.p-chat .msg[data-key="${keyOf(121)}"]`).scrollIntoViewIfNeeded();
        need(await btns.evaluateAll((bs) => bs.every((b) => (b as HTMLButtonElement).disabled)), "an archived reply's buttons are read-only");
        await shot("2-archived-buttons");
      } else need(false, "the archived reply with buttons is held at the start of the chat");
      // Back down to the live end, then a live message is drawn.
      for (let i = 0; i < 80; i++) { await toBottom(); await page.waitForTimeout(400); if ((await ids()).at(-1) === TOTAL) break; }
      need((await ids()).at(-1) === TOTAL, `scrolled back down to the live end (last ${(await ids()).at(-1)})`);
      need((await ids()).length <= 1000, "still at most 1,000 on the way down");
      fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text: "A live message after scrolling back.", ts: new Date().toISOString() });
      await page.waitForTimeout(800);
      need(await page.locator(".p-chat .msg", { hasText: "A live message after scrolling back." }).count() === 1, "attached again: a live message is drawn");
      // A jump deep into the archive (#m=, as a search hit or a pin opens it).
      await page.evaluate((k) => { history.replaceState(null, "", `${location.pathname}#m=${k}`); dispatchEvent(new HashChangeEvent("hashchange")); }, keyOf(300));
      await page.waitForTimeout(1500);
      need(await page.evaluate((k) => !!document.querySelector(`.p-chat .msg[data-key="${k}"]`), keyOf(300)), "a jump into the archive shows the message");
      await shot("3-jump-archive");
      need(p.errors.length === 0, `page errors: ${p.errors.join(" | ")}`);
    } catch (err) {
      failed.push(`threw: ${String(err).slice(0, 300)}`);
      await shot("error").catch(() => {});
    }
    results.push({ name: tag, ok: failed.length === 0, failed });
    await p.ctx.close();
  }
} finally {
  console.log(JSON.stringify(report, null, 1));
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length === 2 && results.every((r) => r.ok) ? 0 : 1);
