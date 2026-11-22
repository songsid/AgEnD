// M-3252 (the user, 11-16): the agent list's 詳細 / 精簡 is kept apart for the phone's drawer and the desktop's sidebar
// (changing one changed the other: one synced preference). The user's defaults: the desktop 精簡, the phone 詳細.
// The real app on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents with faces); a
// desk (1366×900) and a phone (390×844, touch), both signed in as the same person, so a choice reaches the other through
// the host as on two devices. Headless. Per case (light en, dark zh-TW), pictured:
//   1-desk-default (精簡), 2-phone-default (詳細, the drawer open), 3-phone-compact (the phone's ⋯ → 精簡),
//   4-desk-detailed (the desk's ⋯ → 詳細, after the phone's change: still its own); then the phone again: still 精簡.
// Run it on the base too (SMOKE_NAME=…-before): it FAILs there (one shared value, 詳細 by default).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> HP=<port> [MATRIX=light-en,dark-zh-TW] npx tsx scripts/manual/smoke/smoke-density-split-m3252.mts
// ui-gate: {"name": "Sidebar density per layout (desk compact, phone detailed)", "hp": 19675}
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
import { clearDensity, faces, withFaces } from "../smoke-fixture/faces.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-density-split-m3252";
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49000), instances: 6 });
const names = fx.instances.map((i: any) => i.name);
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const READ = () => {
  const list = document.querySelector("#sidebar .inst-nav");
  const rows = [...document.querySelectorAll("#sidebar .v-inst")].filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0);
  return { compact: !!list && list.classList.contains("compact"), rows: rows.length, avatars: rows.filter((r) => r.querySelector(".av")).length,
    open: document.querySelector(".shell")?.classList.contains("sb-open") ?? null, wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
};
const pick = async (page: any, phone: boolean, value: "detailed" | "compact") => {
  const btn = phone ? "#sidebar .nav-sort-phone > .nav-sort-btn" : "#sidebar .inst-head .nav-sort-btn";
  if (phone) await page.locator(btn).tap(); else await page.locator(btn).click();
  await page.waitForTimeout(300);
  const radio = page.locator(`#sidebar input[name="nav-sort-density"][value="${value}"]`).first();
  if (phone) await radio.tap(); else await radio.check();
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(900);   // the host write (a short debounce) before the other device reads
};
const openDrawer = async (page: any) => {
  if (!(await page.evaluate(() => document.querySelector(".shell")!.classList.contains("sb-open")))) { await page.locator("#sbOpen").tap(); await page.waitForTimeout(700); }
};

try {
  for (const look of (process.env.MATRIX ?? "light-en,dark-zh-TW").split(",")) {
    const [theme, ...l] = look.split("-"), lang = l.join("-") as "en" | "zh-TW";
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    clearDensity(fx);   // nothing chosen yet: each layout's default
    const open = (device: "desk" | "phone") => freshPage(fx, { device, theme: theme as "light" | "dark", lang }, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async (ctx: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" }); await withFaces(ctx, names);
    } });
    const desk = await open("desk"), phone = await open("phone");
    const errs: string[] = [];
    for (const p of [desk, phone]) p.page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const ready = async (p: any, isPhone: boolean) => { need(await mounted(p.page, 30000), "the app mounted"); await faces(p.page, names); await p.page.waitForTimeout(700); if (isPhone) await openDrawer(p.page); };
    try {
      await ready(desk, false);
      const a = await desk.page.evaluate(READ);
      need(a.compact && a.rows > 0 && a.avatars === 0 && !a.wide, `1. the desk: 精簡 by default (${JSON.stringify(a)})`);
      await desk.page.screenshot({ path: shotPath(SMOKE, look, "1-desk-default") });

      await ready(phone, true);
      const b = await phone.page.evaluate(READ);
      need(b.open && !b.compact && b.rows > 0 && b.avatars === b.rows && !b.wide, `2. the phone's drawer: 詳細 by default (${JSON.stringify(b)})`);
      await phone.page.screenshot({ path: shotPath(SMOKE, look, "2-phone-default") });

      await pick(phone.page, true, "compact"); await openDrawer(phone.page);
      const c = await phone.page.evaluate(READ);
      need(c.compact && c.avatars === 0, `3. the phone's ⋯ → 精簡: its drawer compact (${JSON.stringify(c)})`);
      await phone.page.screenshot({ path: shotPath(SMOKE, look, "3-phone-compact") });

      await desk.page.reload(); await ready(desk, false);
      const d0 = await desk.page.evaluate(READ);
      need(d0.compact, "the desk after the phone's change: still its own (精簡, the default)");
      await pick(desk.page, false, "detailed");
      const d = await desk.page.evaluate(READ);
      need(!d.compact && d.avatars === d.rows, `4. the desk's ⋯ → 詳細: its sidebar detailed (${JSON.stringify(d)})`);
      await desk.page.screenshot({ path: shotPath(SMOKE, look, "4-desk-detailed") });

      await phone.page.reload(); await ready(phone, true);
      const e = await phone.page.evaluate(READ);
      need(e.compact, `5. the phone after the desk's change: still 精簡 (${JSON.stringify(e)})`);
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    } catch (err) {
      failed.push(`threw: ${String(err).slice(0, 300)}`);
      await desk.page.screenshot({ path: shotPath(SMOKE, look, "error-desk") }).catch(() => {});
      await phone.page.screenshot({ path: shotPath(SMOKE, look, "error-phone") }).catch(() => {});
    }
    results.push({ name: look, ok: failed.length === 0, failed });
    await desk.ctx.close(); await phone.ctx.close();
  }
} finally {
  clearDensity(fx);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
