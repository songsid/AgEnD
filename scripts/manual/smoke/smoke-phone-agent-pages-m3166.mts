// M-3166 PR 5 (the user, round 2: the tab row goes everywhere on a phone): View, Log and Details get the chat's header —
// "← name ● ⋯" in 44 px — and the same ⋯ sheet, whose first tile is Chat. A real Chrome on the shared fixture (in-process
// FleetManager, scratch home, loopback only, fake agents), a phone with an iPhone's safe area (390×844, touch), light/dark ×
// en/zh-TW; and a desk. Per phone case, for View, Log and Details, judged and pictured:
//   <page>-1-header — 44 px; a 6 px dot and no status word; no tab row, search, text size, usage or menu; the ⋯
//   <page>-2-sheet  — ⋯ opens the sheet: Chat first, the page you are on left out, Search there; Details: no Agent details row
// The desk: each page's header as before (its tab row), no sheet. Everywhere: no horizontal overflow, no page error.
// Run it on the base too (REPO=<base checkout> SMOKE_NAME=…-before): every phone case FAILs there (the tab row, no sheet).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-phone-agent-pages-m3166.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-agent-pages-m3166";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49210), instances: 4 });
const name = fx.instances[1]!.name;
const PAGES = [
  { key: "view", cls: "p-view", path: `/view/${encodeURIComponent(name)}`, own: { en: "View", zh: "檢視" } },
  { key: "log", cls: "p-log", path: `/ui/log/${encodeURIComponent(name)}`, own: { en: "Log", zh: "紀錄" } },
  { key: "details", cls: "p-details", path: `/ui/fleet/agent/${encodeURIComponent(name)}`, own: null },
] as const;
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const open = (c: any, path: string) => freshPage(fx, c, { account: "operator", path, beforeNavigate: async (ctx: any, page: any) => {
  await ctx.addInitScript({ content: "window.__name = (f) => f" });
  if (c.device === "phone") { const s = await ctx.newCDPSession(page); await s.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } }); }
} });
try {
  for (const c of matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW,phone-dark-en,phone-light-zh-TW")) {
    if (c.device !== "phone") continue;
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const zh = c.lang === "zh-TW";
    const p = await open(c, PAGES[0].path); const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    for (const pg of PAGES) {
      await page.goto(`${(fx as any).base}${pg.path}`);
      need(await mounted(page, 30000), `${pg.key}: the app mounted`);
      await page.waitForSelector(`.${pg.cls} > .panel-head`, { timeout: 20000 }); await page.waitForTimeout(1200);
      const head = await page.evaluate((cls: string) => {
        const h = document.querySelector(`.${cls} > .panel-head`) as HTMLElement, shown = (s: string) => [...h.querySelectorAll(s)].some((e) => (e as HTMLElement).getBoundingClientRect().width > 0);
        const dot = h.querySelector(".panel-sub .dot") as HTMLElement | null, status = h.querySelector(".panel-sub .status") as HTMLElement | null;
        return { h: Math.round(h.getBoundingClientRect().height - parseFloat(getComputedStyle(h).paddingTop)), dot: dot ? Math.round(dot.getBoundingClientRect().width) : 0,
          word: status ? getComputedStyle(status).fontSize : null, extra: ["sb-search", "inst-switch", "hd-text", "hd-usage"].filter((x) => shown(`.${x}`)),
          more: shown(".chat-sheet-more"), wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      }, pg.cls);
      need(head.h <= 45 && head.dot === 6 && head.word === "0px", `${pg.key}: the header is 44 px, a 6 px dot, no status word (${JSON.stringify(head)})`);
      need(!head.extra.length && head.more && !head.wide, `${pg.key}: only ← name ● ⋯ (${JSON.stringify(head)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), `${pg.key}-1-header`) });
      if (!head.more) continue;
      await page.locator(`.${pg.cls} .chat-sheet-more`).tap(); await page.waitForSelector(".chat-sheet", { timeout: 10000 }); await page.waitForTimeout(500);
      const sheet = await page.evaluate(() => {
        const s = document.querySelector(".chat-sheet") as HTMLElement;
        return { tiles: [...s.querySelectorAll(".chat-sheet-tile")].map((b) => (b.textContent || "").trim()),
          rows: [...s.querySelectorAll(".chat-sheet-row")].map((b) => (b.textContent || "").trim()) };
      });
      const chat = zh ? "聊天" : "Chat", search = zh ? "搜尋" : "Search", details = zh ? "Agent 詳細資料" : "Agent details";
      need(sheet.tiles[0] === chat && sheet.tiles.includes(search), `${pg.key}: the sheet starts with ${chat} and has ${search} (${JSON.stringify(sheet.tiles)})`);
      if (pg.own) need(!sheet.tiles.includes(zh ? pg.own.zh : pg.own.en), `${pg.key}: no tile for the page you are on (${JSON.stringify(sheet.tiles)})`);
      need(sheet.rows.some((r) => r.startsWith(details)) === (pg.key !== "details"), `${pg.key}: Agent details ${pg.key === "details" ? "left out" : "a row"} (${JSON.stringify(sheet.rows)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), `${pg.key}-2-sheet`) });
      await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    }
    need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await p.ctx.close();
  }
  for (const theme of ["light", "dark"] as const) {
    const c = { device: "desk", theme, lang: "en" } as any;
    const p = await open(c, PAGES[1].path); const page = p.page;
    const failed: string[] = [];
    for (const pg of PAGES) {
      await page.goto(`${(fx as any).base}${pg.path}`); await mounted(page, 30000);
      await page.waitForSelector(`.${pg.cls} > .panel-head`, { timeout: 20000 }); await page.waitForTimeout(900);
      const d = await page.evaluate((cls: string) => { const h = document.querySelector(`.${cls} > .panel-head`) as HTMLElement;
        return [!!h.querySelector(".chat-sheet-more"), [...h.querySelectorAll(".inst-switch")].some((e) => (e as HTMLElement).getBoundingClientRect().width > 0)]; }, pg.cls);
      if (JSON.stringify(d) !== "[false,true]") failed.push(`desk ${pg.key}: no sheet, its tab row as before (${JSON.stringify(d)})`);
      await page.screenshot({ path: shotPath(SMOKE, `desk-${theme}`, pg.key) });
    }
    results.push({ name: `desk-${theme}`, ok: failed.length === 0, failed });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
