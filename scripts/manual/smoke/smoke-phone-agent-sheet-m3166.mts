// M-3166 PR 2 (Argon 2–3, the user's OK of round 2): a phone's chat header "← name ● ⋯" in 44 px, and its ⋯ sheet. A real
// Chrome on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents), a phone with an iPhone's
// safe area (390×844, touch), light/dark × en/zh-TW; and a desk. Per phone case, judged and pictured:
//   1-header  44 px; the name, a 6 px status dot (no status word); no search, card, text size, usage or tab row; ← has no count
//   2-sheet   ⋯ opens the sheet: the tiles (View, Log, Search, …), Text size, Appearance, Agent details, This agent's
//             controls (…, Stop, Delete…), ✓ Verified at the foot; every control at least 44 px tall
//   3-look    Appearance opens this chat's colour / theme items in place
//   4-toast   a toast is one line (a pill)
// The desk: the header as before (its chips, the tab row, the ⋯ menu), no sheet. A guest on a phone (chat-level and Trusted,
// #4002 review): no ⋯ sheet, so its header keeps its own controls — a Trusted guest's tab row too. Everywhere: no horizontal
// overflow, no page error.
// Run it on the base too (REPO=<base checkout> SMOKE_NAME=…-before): every phone case FAILs there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-phone-agent-sheet-m3166.mts
import { bootFixture, caseName, freshPage, matrix, mounted, seedChat, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-agent-sheet-m3166";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48960), instances: 4, webYaml: "  guests:\n    enabled: true" });
const name = fx.instances[1]!.name;
await seedChat(fx as never, [name], 12);
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
async function open(c: any) {
  return freshPage(fx, c, { account: "operator", path: `/ui/chat/${encodeURIComponent(name)}`, beforeNavigate: async (ctx: any, page: any) => {
    await ctx.addInitScript({ content: "window.__name = (f) => f" });
    if (c.device === "phone") { const s = await ctx.newCDPSession(page); await s.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } }); }
    await ctx.route("**/ui/authorization", (r: any) => r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "verified", until: Date.now() + 3_600_000 }) }) : r.continue());
  } });
}
const waiting = (page: any) => page.evaluate(async (n: string) => {
  const m = await import("/assets/app-store.js");
  m.appStore.set((s: any) => ({ ...s, needs: [{ instance: n, nonce: "smoke-1", type: "permission" }], needsLoaded: true }));
}, name);
try {
  for (const c of matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW,phone-dark-en,phone-light-zh-TW")) {
    if (c.device !== "phone") continue;
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const p = await open(c); const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await mounted(page, 30000); await page.waitForSelector("#msgIn", { timeout: 20000 }); await waiting(page); await page.waitForTimeout(900);
    const head = await page.evaluate(() => {
      const h = document.querySelector(".p-chat > .panel-head") as HTMLElement, shown = (s: string) => [...h.querySelectorAll(s)].some((e) => (e as HTMLElement).getBoundingClientRect().width > 0);
      const dot = h.querySelector(".panel-sub .dot") as HTMLElement | null, status = h.querySelector(".panel-sub .status") as HTMLElement | null;
      return { h: Math.round(h.getBoundingClientRect().height - parseFloat(getComputedStyle(h).paddingTop)), dot: dot ? Math.round(dot.getBoundingClientRect().width) : 0,
        word: status ? getComputedStyle(status).fontSize : null, extra: ["sb-search", "inst-switch", "hd-text", "hd-usage", "chat-card-menu"].filter((c) => shown(`.${c}`)),
        more: shown(".chat-sheet-more"), badge: !!h.querySelector("#sbOpen .sb-badge") };
    });
    need(head.h <= 45 && head.dot === 6 && head.word === "0px", `the header: 44 px, a 6 px dot, no status word (${JSON.stringify(head)})`);
    need(!head.extra.length && head.more && !head.badge, `the header: only ← name ● ⋯, no count on ← (${JSON.stringify(head)})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-header") });
    if (!(await page.locator(".chat-sheet-more").count())) {   // the base: its ⋯ menu, pictured, and the case FAILs
      await page.locator(".p-chat .panel-head .panel-actions .menu > button").last().tap(); await page.waitForTimeout(600);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-sheet") });
      results.push({ name: caseName(c), ok: false, failed: [...failed, "no ⋯ sheet"] }); await p.ctx.close(); continue;
    }
    await page.locator(".chat-sheet-more").tap(); await page.waitForSelector(".chat-sheet", { timeout: 10000 }); await page.waitForTimeout(500);
    const sheet = await page.evaluate(() => {
      const s = document.querySelector(".chat-sheet") as HTMLElement;
      const tiles = [...s.querySelectorAll(".chat-sheet-tile")].map((b) => (b.textContent || "").trim());
      const rows = [...s.querySelectorAll(".chat-sheet-row")].map((b) => (b.textContent || "").trim());
      const small = [...s.querySelectorAll(".chat-sheet-row, .chat-sheet-tile")].filter((b) => (b as HTMLElement).getBoundingClientRect().height < 44).length;
      return { tiles, rows, small, foot: (s.querySelector(".chat-sheet-foot")?.textContent || "").trim() };
    });
    const zh = c.lang === "zh-TW";
    need(sheet.tiles.slice(0, 3).join() === (zh ? "檢視,紀錄,搜尋" : "View,Log,Search"), `the tiles (${sheet.tiles.join()})`);
    need([zh ? "文字大小" : "Text size", zh ? "外觀" : "Appearance", zh ? "Agent 詳細資料" : "Agent details"].every((w) => sheet.rows.some((r) => r.startsWith(w))), `the rows (${sheet.rows.join(" | ")})`);
    need(sheet.rows.some((r) => /^(停止|Stop)/.test(r)) && sheet.rows.some((r) => /^(刪除|Delete)/.test(r)), `stop and delete reachable (${sheet.rows.join(" | ")})`);
    need(/^✓/.test(sheet.foot) && sheet.small === 0, `✓ Verified at the foot; every control ≥ 44 px (${sheet.foot}, ${sheet.small} small)`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-sheet") });
    await page.locator(".chat-sheet .chat-sheet-row", { hasText: zh ? "外觀" : "Appearance" }).first().tap(); await page.waitForTimeout(400);
    const look = await page.evaluate(() => [...document.querySelectorAll(".chat-sheet-sub .chat-sheet-row, .chat-sheet-sub .menu-heading")].map((b) => (b.textContent || "").trim()));
    need(look.length >= 2, `Appearance opens this chat's look items in place (${look.join(" | ")})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "3-look") });
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    await page.evaluate(async () => { const m = await import("/assets/ui-toast.js"); m.toast("code-reviewer 正在等你回應 — a long notice that must stay on one line"); });
    await page.waitForTimeout(400);
    const pill = await page.evaluate(() => { const t = document.querySelector(".toast") as HTMLElement | null; return t ? [getComputedStyle(t).whiteSpace, Math.round(t.getBoundingClientRect().height)] : null; });
    need(pill && pill[0] === "nowrap" && (pill[1] as number) < 40, `a toast is one line (${JSON.stringify(pill)})`);
    await page.screenshot({ path: shotPath(SMOKE, caseName(c), "4-toast") });
    need(!(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), "no horizontal overflow");
    need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await p.ctx.close();
  }
  for (const theme of ["light", "dark"] as const) {
    const c = { device: "desk", theme, lang: "en" } as any;
    const p = await open(c); const page = p.page;
    await mounted(page, 30000); await page.waitForSelector("#msgIn", { timeout: 20000 }); await page.waitForTimeout(800);
    const d = await page.evaluate(() => [!!document.querySelector(".chat-sheet-more"), !!document.querySelector(".p-chat .panel-head .inst-switch"), !!document.querySelector(".p-chat .panel-head .menu")]);
    results.push({ name: `desk-${theme}`, ok: JSON.stringify(d) === "[false,true,true]", failed: JSON.stringify(d) === "[false,true,true]" ? [] : [`desk: no sheet, the tab row and the ⋯ menu (${JSON.stringify(d)})`] });
    await page.screenshot({ path: shotPath(SMOKE, `desk-${theme}`, "header") });
    await p.ctx.close();
  }
  // A guest's phone: no sheet to give its controls to, so it keeps them (a guest's session, as smoke-2848 makes one).
  const fm = fx.fm as any;
  const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
  const owner = { adapterId: "discord", userId: "424242424242424242" };
  fm.guestScope = () => new Set([name]);
  fm.initializeWebSessions();
  for (const level of ["chat", "trusted"] as const) {
    fm.guestTrusted = () => level === "trusted";
    const sid = fm.webSessions.create({ tier: "guest", surface: "local", label: "smoke", tokenEpoch: tokenEpoch(fm.webToken), owner }).sessionId;
    const ctx = await fx.browser.newContext({ viewport: VIEWPORTS.phone, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await ctx.addCookies([{ name: "agend_session", value: sid, url: fx.base }]);
    await ctx.addInitScript({ content: `window.__name = (f) => f; try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); } catch {}` });
    const page = await ctx.newPage();
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(name)}`);
    await page.waitForSelector("#msgIn", { timeout: 20000 }); await page.waitForTimeout(1200);
    const g = await page.evaluate(() => {
      const head = document.querySelector(".p-chat > .panel-head") as HTMLElement;
      const shown = (e: Element) => (e as HTMLElement).getBoundingClientRect().width > 0;
      return { tier: document.body.dataset.tier, level: document.body.dataset.guestLevel || "chat", sheet: !!head.querySelector(".chat-sheet-more"),
        controls: [...head.querySelectorAll(".panel-actions > *")].filter(shown).length, tabs: [...head.querySelectorAll(".inst-switch")].some(shown),
        wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    const failed: string[] = [];
    if (!(g.tier === "guest" && g.level === level)) failed.push(`a ${level} guest's page (${JSON.stringify(g)})`);
    if (g.sheet || g.controls < 1 || g.tabs !== (level === "trusted") || g.wide) failed.push(`no sheet; its own controls shown${level === "trusted" ? ", its tab row too" : ""} (${JSON.stringify(g)})`);
    if (errs.length) failed.push(`page errors: ${errs.join(" | ")}`);
    results.push({ name: `guest-${level}-phone`, ok: failed.length === 0, failed });
    await page.screenshot({ path: shotPath(SMOKE, `guest-${level}-phone`, "header") });
    await ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
