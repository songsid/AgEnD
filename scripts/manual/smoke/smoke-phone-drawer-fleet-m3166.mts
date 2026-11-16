// M-3166 PR 4 (Argon 4–5, the user's OK of round 2): a phone moves around by its drawer alone, and Fleet is two rows. A real
// Chrome on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents, two Needs-you items), a phone
// (390×844, touch, an iPhone's safe area), light/dark × en/zh-TW; and a desk. Per phone case, judged and pictured:
//   1-fleet   no bottom tab bar; Fleet's tabs in the header's row beside ☰ (no title, search, docs or text size there);
//             the page's tools one row under it; the org page opens on its list; no count anywhere; the row scrolls
//             sideways when it does not fit, and the open last tab (用量) is in view
//   3-memory  a host-memory warning (the header's subtitle) stays, on its own line under ☰ and the tabs
//   2-drawer  ☰ opens the drawer: the screen's width (M-3211; it was 300 px); the agent filter at the top with [+] beside it; Fleet 概覽 and 等你處理 (no count),
//             no 搜尋 / 通知 rows, no filter block at the bottom; agent rows ≥ 48 px with no CLI mark, % or ⋯ (their faces:
//             smoke-phone-drawer-avatars-m3209)
// The desk: the sidebar as before (its search row, its filters) and Fleet's title; no phone tabs. No horizontal overflow, no page error.
// Run it on the base too (SMOKE_NAME=…-before): every phone case FAILs there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-phone-drawer-fleet-m3166.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-drawer-fleet-m3166";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49000), instances: 8 });
const names = fx.instances.map((i: any) => i.name);
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const needs = (page: any) => page.evaluate(async (all: string[]) => {
  const m = await import("/assets/app-store.js");
  m.appStore.set((s: any) => ({ ...s, needs: [{ instance: all[2], nonce: "a", type: "permission" }, { instance: all[3], nonce: "b", type: "permission" }], needsLoaded: true }));
}, names);
try {
  for (const c of matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW,phone-dark-en,phone-light-zh-TW")) {
    if (c.device !== "phone") continue;
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const p = await freshPage(fx, c, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async (ctx: any, page: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
      const s = await ctx.newCDPSession(page); await s.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    need(await mounted(page, 30000), "the app mounted"); await needs(page); await page.waitForTimeout(1500);
    const f = await page.evaluate(() => {
      const shown = (s: string) => [...document.querySelectorAll(s)].some((e) => (e as HTMLElement).getBoundingClientRect().width > 0);
      const head = document.querySelector(".p-fleet > .panel-head") as HTMLElement;
      return { tabsBar: shown(".tabs"), inHead: head ? head.querySelectorAll(".fleet-phone-tabs a").length : 0, under: shown(".p-fleet > nav.seg"),
        headExtra: ["sb-search", "panel-title", "hd-docs", "hd-text"].filter((c) => [...head.querySelectorAll(`.${c}`)].some((e) => (e as HTMLElement).getBoundingClientRect().width > 0)),
        list: !!document.querySelector(".oc.oc-list"), counts: shown(".oc-bar .org-counts") || shown(".tab-badge") || shown(".sb-badge"),
        wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    need(!f.tabsBar, "no bottom tab bar");
    need(f.inHead === 6 && !f.under && !f.headExtra.length, `Fleet's tabs in the header's row, nothing else there (${JSON.stringify(f)})`);
    need(f.list && !f.counts && !f.wide, `the list by default, no counts, no overflow (${JSON.stringify(f)})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-fleet") });
    // The row scrolls sideways when it does not fit beside ☰: the last tab (用量), opened, is in view.
    await page.goto(`${(fx as any).base}/ui/fleet/usage`); need(await mounted(page, 30000), "usage: the app mounted"); await page.waitForTimeout(800);
    const u = await page.evaluate(() => {
      const nav = document.querySelector(".p-fleet > .panel-head .fleet-phone-tabs") as HTMLElement, on = nav?.querySelector(".active") as HTMLElement;
      if (!nav || !on) return null;
      const n = nav.getBoundingClientRect(), a = on.getBoundingClientRect();
      return { inView: a.left >= n.left - 0.5 && a.right <= n.right + 0.5, href: on.getAttribute("href") };
    });
    need(!!u?.inView && /usage/.test(u.href || ""), `the open last tab is in view (${JSON.stringify(u)})`);
    await page.goto(`${(fx as any).base}/ui/fleet/org`); need(await mounted(page, 30000), "org: the app mounted"); await needs(page); await page.waitForTimeout(800);
    // A host-memory warning (the header's subtitle) stays: its own line under ☰ and the tabs (#4008 review).
    await page.evaluate(async () => { const m = await import("/assets/app-store.js"); m.appStore.set((s: any) => ({ ...s, hostMemory: "critical", hostMemoryTop: [{ name: "node", pid: 4242, rssBytes: 2147483648, owner: "instance", instance: "planner" }] })); });
    await page.waitForTimeout(500);
    const hm = await page.evaluate(() => {
      const w = document.querySelector(".p-fleet > .panel-head .host-mem") as HTMLElement, tabs = document.querySelector(".p-fleet > .panel-head .fleet-phone-tabs") as HTMLElement;
      if (!w || !tabs) return null;
      const r = w.getBoundingClientRect(), t = tabs.getBoundingClientRect();
      return { shown: r.width > 0 && r.height > 0, under: r.top >= t.bottom - 1, inside: r.left >= 0 && r.right <= innerWidth + 0.5, tabsTop: Math.round(t.top),
        wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    need(!!hm?.shown && hm.under && hm.inside && !hm.wide, `a host-memory warning shows on its own line under the tabs (${JSON.stringify(hm)})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "3-memory") });
    await page.evaluate(async () => { const m = await import("/assets/app-store.js"); m.appStore.set((s: any) => ({ ...s, hostMemory: null, hostMemoryTop: [] })); });
    await page.waitForTimeout(300);
    await page.locator("#sbOpen").tap(); await page.waitForTimeout(700);
    const d = await page.evaluate(() => {
      const sb = document.querySelector("#sidebar") as HTMLElement, r = sb.getBoundingClientRect();
      const shown = (e: Element | null) => !!e && (e as HTMLElement).getBoundingClientRect().width > 0;
      const filter = sb.querySelector(".v-filter") as HTMLElement, plus = sb.querySelector(".side-new") as HTMLElement, overview = sb.querySelector(".side-overview") as HTMLElement;
      const rows = [...sb.querySelectorAll(".v-inst")].filter(shown) as HTMLElement[];
      return { w: Math.round(r.width), filterTop: shown(filter) && shown(overview) && filter.getBoundingClientRect().top < overview.getBoundingClientRect().top,
        plusBeside: shown(plus) && Math.abs(plus.getBoundingClientRect().top - filter.getBoundingClientRect().top) < 24,
        links: [...sb.querySelectorAll(".side-nav > .side-row:not(.side-new)")].filter(shown).map((e) => (e.querySelector(".grow")?.textContent || "").trim()),
        counts: [...sb.querySelectorAll(".nav-count, .v-group-head .count")].filter(shown).length, facets: shown(sb.querySelector(".nav-facets")),
        rowMin: rows.length ? Math.min(...rows.map((e) => e.getBoundingClientRect().height)) : 0,
        extra: [...sb.querySelectorAll(".av-cli, .inst-row-menu, .v-meta")].filter(shown).length };
    });
    const zh = c.lang === "zh-TW";
    need(d.w === 390 && d.filterTop && d.plusBeside, `the drawer: the screen's width (M-3211), the filter at the top with [+] beside it (${JSON.stringify(d)})`);
    need(JSON.stringify(d.links) === JSON.stringify(zh ? ["Fleet 概覽", "等你處理"] : ["Fleet", "Needs you"]) && d.counts === 0 && !d.facets, `two links, no count, no filter block (${JSON.stringify(d.links)}, ${d.counts}, ${d.facets})`);
    need(d.rowMin >= 47.5 && d.extra === 0, `agent rows ≥ 48 px, no CLI mark, % or ⋯ (${d.rowMin}, ${d.extra})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-drawer") });
    // The tab bar's room goes; only a list page keeps the home-indicator inset: never inside an agent's pages (the dock keeps
    // it, #3972) nor with the keyboard up (the box sits on the keyboard, #2478) — no band, no double inset.
    const mainPad = () => page.evaluate(() => getComputedStyle(document.querySelector(".main") as HTMLElement).paddingBottom);
    await page.evaluate(() => { document.querySelector(".shell")!.classList.remove("sb-open"); });
    const listPad = await mainPad();
    await page.evaluate(() => document.querySelector(".shell")!.classList.add("kb-open"));
    const listKbPad = await mainPad();
    await page.evaluate(() => document.querySelector(".shell")!.classList.remove("kb-open"));
    await page.goto(`${(fx as any).base}/ui/chat/${encodeURIComponent(names[1])}`); need(await mounted(page, 30000), "chat: the app mounted");
    await page.waitForSelector("#msgIn", { timeout: 20000 }); await page.waitForTimeout(600);
    const chatPad = await mainPad();
    need(listPad === "34px" && listKbPad === "0px" && chatPad === "0px", `the page's bottom padding: a list page the inset, 0 with the keyboard up or in a chat (${listPad}, ${listKbPad}, ${chatPad})`);
    need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await p.ctx.close();
  }
  for (const theme of ["light", "dark"] as const) {
    const c = { device: "desk", theme, lang: "en" } as any;
    const p = await freshPage(fx, c, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async (ctx: any) => { await ctx.addInitScript({ content: "window.__name = (f) => f" }); } }); const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await mounted(page, 30000); await needs(page); await page.waitForTimeout(1200);
    const d = await page.evaluate(() => { const shown = (s: string) => [...document.querySelectorAll(s)].some((e) => (e as HTMLElement).getBoundingClientRect().width > 0);
      return [shown("#sidebar .side-search"), shown("#sidebar .nav-facets"), shown(".p-fleet .fleet-phone-tabs"), shown(".p-fleet .panel-head .panel-title")]; });
    const want = "[true,true,false,true]";
    const failed = [...(JSON.stringify(d) === want ? [] : [`desk: the sidebar as before (its search row and filters), Fleet's title, no phone tabs (${JSON.stringify(d)})`]),
      ...(errs.length ? [`page errors: ${errs.join(" | ")}`] : [])];
    results.push({ name: `desk-${theme}`, ok: failed.length === 0, failed });
    await page.screenshot({ path: shotPath(SMOKE, `desk-${theme}`, "fleet") });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
