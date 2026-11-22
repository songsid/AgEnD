// M-3235 (the user, beta.6, desk): the 「我的 Fleet | <Hub> ↗」 switch was off the sidebar's other content (wider than the
// nav rows, left and right) and the Hub's name ran into its right edge. Now it sits on the column's gutters — a desk's nav
// rows (their boxes), the phone drawer's filter row (the filter's left, the + button's right) — in two equal halves, and a
// long name ends in "…" before its ↗, the whole name in the link's title and accessible name.
// A real browser on the shared fixture (in-process FleetManager, scratch home, loopback only), the fleet a Hub member
// (hub_member saved to its fleet.yaml), its member pairing answered by a route with Hub names of 8, 16, 30 and 60
// characters (en, and zh for the zh-TW cases). Headless. Cases: desk light en / dark zh-TW, phone light en / dark zh-TW
// (the drawer open). Pictured per case: the 16- and 60-character names.
// Run it on the base too (SMOKE_NAME=…-before): it FAILs there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-hub-switch-names-m3235.mts
// ui-gate: {"name": "Hub switch alignment and long Hub names", "hp": 19668}
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-hub-switch-names-m3235";
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49000), instances: 4, classic: false });
(fx.fm as any).saveFleetConfig([{ path: ["hub_member", "enabled"], value: true }]);
const BASE = {
  en: "Research and Development Hub for the Platform Infrastructure Group in Asia Pacific",
  zh: "研發一部平台基礎設施與發佈工程中心亞太區域合作服務整合團隊第二代測試環境與資料平台共用的知識管理工作區",
};
/** A Hub name of exactly `n` characters (code points), never ending in a space. */
const nameOf = (lang: "en" | "zh", n: number) => { const s = [...BASE[lang]].slice(0, n); if (s[s.length - 1] === " ") s[s.length - 1] = "X"; return s.join(""); };
let hubName = "Team Hub";
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];

try {
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const lang = c.lang === "zh-TW" ? "zh" : "en";
    const p = await freshPage(fx, c, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async (ctx: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
      await ctx.route("**/api/hub/member/pairing**", (r: any) => r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ pairing: { state: "paired", hub: { name: hubName, webOrigin: "https://hub.example.test" } }, notices: [] }) }));
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    try {
      for (const n of [8, 16, 30, 60]) {
        hubName = nameOf(lang, n);
        await page.reload(); need(await mounted(page, 30000), `${n}: the app mounted`);
        await page.waitForSelector(".hub-switch a.hub-switch-item", { timeout: 15000, state: "attached" });   // in a closed drawer on a phone
        if (c.device === "phone") { await page.locator("#sbOpen").tap(); await page.waitForTimeout(700); } else await page.waitForTimeout(400);
        const m = await page.evaluate(`(() => { var q = function (s) { return document.querySelector(s); };
          var b = function (e) { if (!e) return null; var r = e.getBoundingClientRect(); return r.width ? { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) } : null; };
          var a = q(".hub-switch a.hub-switch-item"), nm = a && a.querySelector(".hub-switch-name"), ic = a && a.querySelector(".icon");
          var cur = q(".hub-switch-item.is-current"), cn = cur && cur.querySelector(".hub-switch-name");
          return { sw: b(q(".hub-switch")), seg1: b(q(".hub-switch-item.is-current")), seg2: b(a), icon: b(ic), row: b(q("#sidebar .side-nav > .side-row")),
            filter: b(q("#sidebar .v-filter-box")), plus: b(q("#sidebar .v-filter-new")), name: nm ? nm.textContent : (a ? a.textContent : null),
            cut: nm ? nm.scrollWidth > nm.clientWidth + 0.5 : null, curCut: cn ? cn.scrollWidth > cn.clientWidth + 0.5 : null,
            pad1: cur && cn ? Math.round(cur.getBoundingClientRect().width - cn.getBoundingClientRect().width) : null,
            pad2: a && nm && ic ? Math.round(a.getBoundingClientRect().width - nm.getBoundingClientRect().width - ic.getBoundingClientRect().width - parseFloat(getComputedStyle(a).columnGap || "0")) : null, ellipsis: nm ? getComputedStyle(nm).textOverflow : null,
            title: a ? a.getAttribute("title") : null, label: a ? a.getAttribute("aria-label") : null }; })()`) as any;
        const near = (x: number | undefined, y: number | undefined) => x != null && y != null && Math.abs(x - y) <= 1;
        const gut = c.device === "phone" ? { l: m.filter?.l, r: m.plus?.r, what: "the filter row" } : { l: m.row?.l, r: m.row?.r, what: "the nav rows" };
        need(m.sw && near(m.sw.l, gut.l) && near(m.sw.r, gut.r), `${n}: the switch on ${gut.what}' gutters (${JSON.stringify({ sw: m.sw, gutter: gut })})`);
        need(m.seg1 && m.seg2 && !m.curCut && (m.cut || Math.abs(m.pad1 - m.pad2) <= 2), `${n}: 我的 Fleet whole; the same padding in both halves while the name fits (${JSON.stringify({ pad: [m.pad1, m.pad2], cut: m.cut, curCut: m.curCut })})`);
        need(m.name === hubName, `${n}: the whole name in the page (${JSON.stringify(m.name)})`);
        need(!m.cut || m.ellipsis === "ellipsis", `${n}: a name that does not fit ends in "…" (${JSON.stringify({ cut: m.cut, ellipsis: m.ellipsis })})`);
        need(n > 8 || !m.cut, `${n}: a short name is not cut`);
        need(m.icon && m.seg2 && m.icon.r <= m.seg2.r - 6 && m.icon.l >= m.seg2.l, `${n}: ↗ inside, clear of the right edge (${JSON.stringify({ icon: m.icon, seg2: m.seg2 })})`);
        need((m.title || "").includes(hubName) && (m.label || "").includes(hubName), `${n}: the whole name on hover and to a screen reader (${JSON.stringify({ title: m.title, label: m.label })})`);
        if (n === 16 || n === 60) await page.screenshot({ path: shotPath(SMOKE, caseName(c), `name-${n}`), clip: c.device === "phone" ? { x: 0, y: 0, width: 390, height: 260 } : { x: 0, y: 0, width: 300, height: 260 } });
      }
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    } catch (err) {
      failed.push(`threw: ${String(err).slice(0, 300)}`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "error") }).catch(() => {});
    }
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
