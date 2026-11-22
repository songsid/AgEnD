// M-3211 (the user, 11-16): on a phone the ☰ agent drawer is the whole screen's width, and its rows are sized like a
// messenger's chat list (Telegram's as the reference): the name ~17 px semibold, the second line ~15 px, the avatar ~54 px
// (Detailed), a row ~72–76 px; Compact keeps the dot alone, with the same bigger text. It closes by a tap on a row, by ←
// (its first control, top left), or by a swipe to the left.
// A real browser on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents with faces:
// pictures, an emoji, a letter), a phone (390×844, touch, an iPhone's safe area), light/dark; per case and density, judged
// and pictured with the drawer open. Run it on the base too (SMOKE_NAME=…-before): every case FAILs there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] [PW_ENGINE=webkit] scripts/manual/smoke/run.sh smoke-phone-drawer-telegram-m3211.mts
// ui-gate: {"name": "Phone drawer full width, chat-list rows", "hp": 19663}
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";
import { clearDensity, density, faces, withFaces } from "../smoke-fixture/faces.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-drawer-telegram-m3211";
const webkit = process.env.PW_ENGINE === "webkit";
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49000), instances: 8 });
const names = fx.instances.map((i: any) => i.name);
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const isOpen = (page: any) => page.evaluate(() => document.querySelector(".shell")!.classList.contains("sb-open"));
const openDrawer = async (page: any) => { if (!(await isOpen(page))) { await page.locator("#sbOpen").tap(); await page.waitForTimeout(500); } };

try {
  for (const c of matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW")) {
    if (c.device !== "phone") continue;
    let cdp: any = null;
    const p = await freshPage(fx, c, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async (ctx: any, page: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
      await withFaces(ctx, names);
      if (!webkit) { cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } }); }
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => { const m = String(e); if (!(webkit && /ResizeObserver loop/.test(m))) errs.push(m.slice(0, 200)); });
    const boot: string[] = [];
    if (!(await mounted(page, 30000))) boot.push("the app mounted");
    await faces(page, names); await page.waitForTimeout(800);
    await openDrawer(page);
    for (const d of ["detailed", "compact"] as const) {
      const failed = [...boot];
      const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
      await density(page, d); await faces(page, names); await page.waitForTimeout(900);   // the pictures load
      const r = await page.evaluate(() => {
        const sb = document.querySelector("#sidebar") as HTMLElement, sr = sb.getBoundingClientRect();
        const shown = (e: Element | null) => !!e && (e as HTMLElement).getBoundingClientRect().width > 0;
        const px = (e: Element | null, k: string) => e ? parseFloat(getComputedStyle(e)[k as any]) : 0;
        const head = sb.querySelector(".side-head") as HTMLElement, close = head?.querySelector(".side-collapse") as HTMLElement, brand = head?.querySelector(".brand") as HTMLElement;
        const back = close?.querySelector(".ic-close");
        return { w: Math.round(sr.width), left: Math.round(sr.left), vw: innerWidth, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          close: close && shown(close) ? { first: !!brand && close.getBoundingClientRect().right <= brand.getBoundingClientRect().left + 0.5,
            back: shown(back), w: Math.round(close.getBoundingClientRect().width), h: Math.round(close.getBoundingClientRect().height) } : null,
          rows: [...sb.querySelectorAll(".v-inst")].filter(shown).map((row) => {
            const name = row.querySelector(".inst-name"), two = row.querySelector(".inst-line2 .inst-alt, .inst-line2 .inst-when");
            const av = row.querySelector(".av"), dot = row.querySelector(".av-dot, .inst-status");
            return { h: Math.round(row.getBoundingClientRect().height), machine: shown(row.querySelector(".inst-machine")),
              name: px(name, "fontSize"), weight: name ? Number(getComputedStyle(name).fontWeight) : 0, two: two && shown(two) ? px(two, "fontSize") : null,
              av: av && shown(av) ? Math.round(av.getBoundingClientRect().width) : null, dot: shown(dot) };
          }) };
      });
      need(r.w === r.vw && r.left === 0 && !r.wide, `the drawer is the screen's width (${r.w} of ${r.vw}, left ${r.left}, overflow ${r.wide})`);
      need(r.close && r.close.first && r.close.back && r.close.w >= 44 && r.close.h >= 44, `✕ closes it (M-3245; was ←): the head's first control, a full tap target (${JSON.stringify(r.close)})`);
      need(r.rows.length >= 8, `the agents are listed (${r.rows.length})`);
      const text = r.rows.filter((x) => x.name !== 17 || x.weight < 600 || (x.two != null && x.two !== 15));
      need(!text.length, `names 17 px semibold, the second line 15 px (${JSON.stringify(text.slice(0, 2))})`);
      if (d === "detailed") {
        const bad = r.rows.filter((x) => x.av !== 54 || !x.dot || (!x.machine && (x.h < 72 || x.h > 76)));
        need(!bad.length, `detailed: 54 px avatars with their dot, rows 72–76 px (${JSON.stringify(bad.slice(0, 2))})`);
      } else {
        const bad = r.rows.filter((x) => x.av != null || !x.dot || x.h < 48);
        need(!bad.length, `compact: the dot alone, rows ≥ 48 px (${JSON.stringify(bad.slice(0, 2))})`);
      }
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), `drawer-${d}`) });
      if (d === "detailed") {
        // It closes three ways: ←, a swipe to the left (Chromium: real touch input), a tap on an agent (which opens it).
        const ways: Record<string, boolean | null> = {};
        await page.locator("#sidebar .side-collapse").tap().catch(() => {}); await page.waitForTimeout(500);
        ways.back = !(await isOpen(page));
        if (cdp) {
          await openDrawer(page);
          const y = 520, pts = [320, 280, 230, 170, 110];
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pts[0], y }] });
          for (const x of pts.slice(1)) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 4 }] }); await page.waitForTimeout(16); }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await page.waitForTimeout(500);
          ways.swipe = !(await isOpen(page));
        } else ways.swipe = null;
        await openDrawer(page);
        await page.locator("#sidebar .v-inst").nth(1).tap(); await page.waitForTimeout(800);
        ways.row = !(await isOpen(page)) && /\/ui\/chat\//.test(page.url());
        need(ways.back && ways.swipe !== false && ways.row, `closes by ✕, a swipe left and a tap on an agent (${JSON.stringify(ways)})`);
        await page.goto(`${(fx as any).base}/ui/fleet/org`); await mounted(page, 30000); await faces(page, names); await page.waitForTimeout(600);
        await openDrawer(page);
      }
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
      results.push({ name: `${caseName(c)}-${d}`, ok: failed.length === 0, failed });
    }
    await p.ctx.close();
    clearDensity(fx);
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
