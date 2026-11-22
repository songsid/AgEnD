// M-3217 (the user, beta.6, a Fleet connected to a Hub, a narrow ~500 px desk window):
//   1. the drawer's + sat on the 我的 Fleet / Hub switch's row, over the Hub's name — it was placed at a fixed height under
//      the brand, and the switch pushed the filter row (its row) down. Our drawer smokes never had the switch.
//   2. 「Fleet 安全通知」's 「在 Hub 查看並撤銷」 was a bare link styled as a button, flush under the text, unevenly spaced.
// A real browser on the shared fixture (in-process FleetManager, scratch home, loopback only), the fleet a Hub member
// (hub_member.enabled saved to its fleet.yaml), its member pairing answered by a route: paired with "Demo AgEnD Hub" at an
// https origin, one security notice. Headless. Cases: a 500 px desk window light zh-TW and dark en, a phone dark zh-TW.
// Judged and pictured per case: 1-banner (Settings, the notice), 2-drawer (☰ open).
//   the drawer: one + shown, inside the drawer, off the switch, in the filter's row (centres within 6 px), right of it
//   the notice: its action a primary button in a row of its own, on the text's left edge, ≥ 8 px under the text, the
//               notice's lines evenly spaced
// Run it on the base too (SMOKE_NAME=…-before): every case FAILs there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [PW_ENGINE=webkit] scripts/manual/smoke/run.sh smoke-hub-member-drawer-m3217.mts
// ui-gate: {"name": "Hub member drawer and security notice", "hp": 19666}
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-hub-member-drawer-m3217";
const webkit = process.env.PW_ENGINE === "webkit";
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49000), instances: 4, classic: false });
(fx.fm as any).saveFleetConfig([{ path: ["hub_member", "enabled"], value: true }]);
const PAIRING = { pairing: { state: "paired", hub: { name: "Demo AgEnD Hub", webOrigin: "https://hub.example.test" } },
  notices: [{ id: "notice-1", label: "Demo Fleet", source: "group", at: new Date().toISOString(), fleetId: "fleet-0123456789abcdef", generation: 1 }] };
const CASES = [
  { name: "desk500-light-zh-TW", c: { device: "desk", theme: "light", lang: "zh-TW" }, width: 500 },
  { name: "desk500-dark-en", c: { device: "desk", theme: "dark", lang: "en" }, width: 500 },
  { name: "phone-dark-zh-TW", c: { device: "phone", theme: "dark", lang: "zh-TW" }, width: 0 },
] as const;
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];

try {
  for (const k of CASES) {
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const p = await freshPage(fx, k.c as any, { account: "operator", path: "/settings", beforeNavigate: async (ctx: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
      await ctx.route("**/api/hub/member/pairing**", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PAIRING) }));
    } });
    const page = p.page;
    if (k.width) await page.setViewportSize({ width: k.width, height: 900 });
    const errs: string[] = []; page.on("pageerror", (e: any) => { const m = String(e); if (!(webkit && /ResizeObserver loop/.test(m))) errs.push(m.slice(0, 200)); });
    try {
      need(await mounted(page, 30000), "the app mounted");
      await page.waitForSelector("[data-pairing-notice]", { timeout: 15000 });
      await page.waitForTimeout(600);
      // The notice: its action a primary button in its own row, on the text's left edge, under the text with room.
      const n = await page.evaluate(() => {
        const box = document.querySelector("[data-pairing-notice]") as HTMLElement;
        const ps = [...box.querySelectorAll(":scope > p")] as HTMLElement[];
        const act = box.querySelector(".hub-notice-actions > a.btn, .hub-notice-actions > button.btn") as HTMLElement | null;
        const r = (e: Element) => e.getBoundingClientRect();
        const gaps = ps.slice(1).map((e, i) => Math.round(r(e).top - r(ps[i]!).bottom));
        return { act: act ? { cls: act.className, left: Math.round(r(act).left), top: Math.round(r(act).top), h: Math.round(r(act).height) } : null,
          bare: !!box.querySelector(":scope > a"), textLeft: Math.round(r(ps[0]!).left), lastBottom: Math.round(r(ps.at(-1)!).bottom), gaps };
      });
      need(n.act && /\bbtn-primary\b/.test(n.act.cls) && !n.bare, `the action is a primary button in a row of its own (${JSON.stringify(n.act)}, bare link ${n.bare})`);
      need(n.act && Math.abs(n.act.left - n.textLeft) <= 1 && n.act.top - n.lastBottom >= 8 && n.act.h >= 36, `the button on the text's left edge, ≥ 8 px under it (${JSON.stringify({ act: n.act, textLeft: n.textLeft, lastBottom: n.lastBottom })})`);
      need(n.gaps.length && Math.max(...n.gaps) - Math.min(...n.gaps) <= 1 && Math.min(...n.gaps) >= 2, `the notice's lines evenly spaced (${JSON.stringify(n.gaps)})`);
      await page.screenshot({ path: shotPath(SMOKE, k.name, "1-banner") });
      // The drawer: the switch present, one + in the filter's row, off the switch.
      await page.locator("#sbOpen").click(); await page.waitForTimeout(700);
      const d = await page.evaluate(() => {
        const sb = document.querySelector("#sidebar") as HTMLElement;
        const shown = (e: Element | null) => !!e && (e as HTMLElement).getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== "hidden";
        const b = (e: Element | null) => { if (!e) return null; const x = (e as HTMLElement).getBoundingClientRect(); return { l: Math.round(x.left), t: Math.round(x.top), r: Math.round(x.right), b: Math.round(x.bottom) }; };
        const pluses = [...sb.querySelectorAll(".side-new, .v-filter-new")].filter(shown);
        return { sb: b(sb), sw: shown(sb.querySelector(".hub-switch")) ? b(sb.querySelector(".hub-switch")) : null, filter: b(sb.querySelector(".v-filter-box")), plus: pluses.map(b), count: pluses.length };
      });
      const plus = d.plus[0], sw = d.sw, f = d.filter;
      const overlap = (a: any, c: any) => !!a && !!c && a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b;
      need(sw, "the Hub switch is in the drawer");
      need(d.count === 1 && plus && d.sb && plus.l >= d.sb.l && plus.r <= d.sb.r + 0.5, `one + shown, inside the drawer (${JSON.stringify({ plus: d.plus, sb: d.sb })})`);
      need(plus && !overlap(plus, sw), `the + is off the Hub switch (${JSON.stringify({ plus, sw })})`);
      need(plus && f && Math.abs((plus.t + plus.b) / 2 - (f.t + f.b) / 2) <= 6 && plus.l >= f.r - 1, `the + is in the filter's row, right of it (${JSON.stringify({ plus, filter: f })})`);
      await page.screenshot({ path: shotPath(SMOKE, k.name, "2-drawer") });
      // A revoked notice (Fable, #4036): its 已撤銷 tag keeps its own size in the column, not a full-width bar.
      await page.unroute("**/api/hub/member/pairing**");
      await page.route("**/api/hub/member/pairing**", (r: any) => r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ...PAIRING, notices: PAIRING.notices.map((x) => ({ ...x, revoked: true })) }) }));
      await page.reload(); await mounted(page, 30000);
      await page.waitForSelector("[data-pairing-notice] .tag", { timeout: 15000 }); await page.waitForTimeout(300);
      const tag = await page.evaluate(() => { const box = document.querySelector("[data-pairing-notice]") as HTMLElement, t = box.querySelector(":scope > .tag") as HTMLElement;
        return { tag: Math.round(t.getBoundingClientRect().width), box: Math.round(box.getBoundingClientRect().width) }; });
      need(tag.tag > 0 && tag.tag < tag.box / 2, `a revoked notice's tag keeps its own size (${JSON.stringify(tag)})`);
      await page.screenshot({ path: shotPath(SMOKE, k.name, "3-revoked") });
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    } catch (err) {
      failed.push(`threw: ${String(err).slice(0, 300)}`);
      await page.screenshot({ path: shotPath(SMOKE, k.name, "error") }).catch(() => {});
    }
    results.push({ name: k.name, ok: failed.length === 0, failed });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
