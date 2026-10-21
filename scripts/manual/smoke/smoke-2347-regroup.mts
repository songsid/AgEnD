// #2347 regrouping on a fresh profile — desk light (en), desk dark (zh-TW), phone light (en). Checks: the nav has the
// two named groups (You, Fleet) with the eight sections; on a wide screen it is a column on the left of the content; an
// old address (/settings/general) lands on Agent defaults, /settings/classic on Chat & connections at ClassicBot; every
// section draws without a page error.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2347-regroup.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48853), instances: 2 });
fx.fm.getInstanceStatus = () => "running";
const SECTIONS = ["preferences", "look", "agents", "agent-defaults", "chat", "web-dashboard", "access", "advanced"];
const results: Array<{ name: string; failed: string[] }> = [];
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const) {
  const name = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [];
  const ok = (k: string, v: boolean) => { if (!v) failed.push(k); };
  const p = await freshPage(fx, c);
  const errors: string[] = [];
  p.page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  await mounted(p.page, 30000);
  const go = async (path: string) => { await p.page.goto(new URL(path, p.page.url()).href); await p.page.locator(".s-nav").waitFor({ timeout: 15000 }); await p.page.waitForTimeout(500); };
  await go("/settings");
  const nav = await p.page.evaluate(`(() => { const n = document.querySelector(".s-nav"), b = document.querySelector(".p-settings > .panel-body");
    const nr = n.getBoundingClientRect(), br = b.getBoundingClientRect();
    return { groups: [...n.querySelectorAll(".s-nav-group")].map((g) => g.querySelectorAll(".seg-item").length), heads: [...n.querySelectorAll(".s-nav-head")].map((h) => getComputedStyle(h).display),
      left: nr.right <= br.left + 1 && nr.top >= br.top - 1, overflowX: document.documentElement.scrollWidth > innerWidth }; })()`) as any;
  ok("twoGroups", JSON.stringify(nav.groups) === "[2,6]");
  ok("groupNamesShown", nav.heads.every((d: string) => d !== "none"));
  if (c.device === "desk") ok("leftColumn", nav.left);
  ok("noSideScroll", !nav.overflowX);
  await p.page.screenshot({ path: shotPath("2347g", c as any, "1-agents") });
  for (const s of SECTIONS) {
    await go(`/settings/${s}`);
    ok(`drawn:${s}`, (await p.page.locator(".p-settings .panel-body .col").count()) === 1);
    // The section shown is in view in the nav (on a phone, a row that scrolls sideways).
    const seen = await p.page.evaluate(`(() => { const a = document.querySelector(".s-nav .seg-item.active"), n = document.querySelector(".s-nav");
      const ar = a.getBoundingClientRect(), nr = n.getBoundingClientRect(); return ar.left >= nr.left - 1 && ar.right <= nr.right + 1; })()`);
    ok(`activeInView:${s}`, seen === true);
    // …without moving the page or the nav column sideways (only the phone's row of sections scrolls).
    const still = await p.page.evaluate(`(() => [document.querySelector(".main").scrollLeft, document.querySelector(".s-nav").scrollLeft])()`) as number[];
    ok(`pageStill:${s}`, still[0] === 0 && still[1] === 0);
  }
  await go("/settings/access");
  await p.page.screenshot({ path: shotPath("2347g", c as any, "2-access") });
  await go("/settings/general");
  ok("oldGeneral", new URL(p.page.url()).pathname === "/settings/agent-defaults");
  await go("/settings/classic");
  const u = new URL(p.page.url());
  ok("oldClassic", u.pathname === "/settings/chat" && u.hash === "#classicbot");
  await p.page.screenshot({ path: shotPath("2347g", c as any, "3-chat-classicbot") });
  ok("noPageErrors", errors.length === 0);
  results.push({ name, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? " " + failed.join(", ") : ""}${errors.length ? " errors=" + JSON.stringify(errors) : ""}`);
  await p.ctx.close();
}
console.log(results.some((r) => r.failed.length) ? "FAIL" : "PASS");
await fx.close();
process.exit(results.some((r) => r.failed.length) ? 1 : 0);
