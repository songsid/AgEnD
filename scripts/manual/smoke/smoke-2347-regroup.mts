// #2347 regrouping on a fresh profile — desk light (en), desk dark (zh-TW), phone light (en). Checks: the nav has the
// two named groups (You, Fleet) with the eight sections; on a wide screen it is a column on the left of the content;
// every section draws without a page error. It is THE smoke that visits the old addresses on purpose (the others use the
// new ones): each of the six lands on its section, loaded from scratch as a bookmark would be — /settings/device →
// preferences, appearance → look, general → agent-defaults, bots → chat, classic → chat#classicbot, web → access.
// On a phone (§7) /settings is the list of sections and a section is shown on its own with "‹ Settings": the nav checks
// are the desk's; the phone's are which view is shown.
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
  const go = async (path: string) => { await p.page.goto(new URL(path, p.page.url()).href); await p.page.locator(".p-settings .panel-body .col").waitFor({ state: "attached", timeout: 15000 }); await p.page.waitForTimeout(500); };
  const view = () => p.page.evaluate(`(() => ({ view: document.querySelector(".p-settings").getAttribute("data-view"), back: (() => { const b = document.querySelector(".p-settings .s-back"); return !!b && getComputedStyle(b).display !== "none"; })() }))()`) as Promise<any>;
  await go("/settings");
  const nav = await p.page.evaluate(`(() => { const n = document.querySelector(".s-nav"), b = document.querySelector(".p-settings > .panel-body");
    const nr = n.getBoundingClientRect(), br = b.getBoundingClientRect();
    return { groups: [...n.querySelectorAll(".s-nav-group")].map((g) => g.querySelectorAll(".seg-item").length), heads: [...n.querySelectorAll(".s-nav-head")].map((h) => getComputedStyle(h).display),
      left: nr.right <= br.left + 1 && nr.top >= br.top - 1, overflowX: document.documentElement.scrollWidth > innerWidth }; })()`) as any;
  ok("twoGroups", JSON.stringify(nav.groups) === "[2,6]");
  ok("groupNamesShown", nav.heads.every((d: string) => d !== "none"));
  if (c.device === "desk") ok("leftColumn", nav.left);
  else ok("phone:listAtSettings", (await view()).view === "index");
  ok("noSideScroll", !nav.overflowX);
  await p.page.screenshot({ path: shotPath("2347g", c as any, "1-agents") });
  for (const s of SECTIONS) {
    await go(`/settings/${s}`);
    ok(`drawn:${s}`, (await p.page.locator(".p-settings .panel-body .col").count()) === 1);
    if (c.device === "phone") { const v = await view(); ok(`phone:alone:${s}`, v.view === "section" && v.back); continue; }
    // The section shown is in view in the nav.
    const seen = await p.page.evaluate(`(() => { const a = document.querySelector(".s-nav .seg-item.active"), n = document.querySelector(".s-nav");
      const ar = a.getBoundingClientRect(), nr = n.getBoundingClientRect(); return ar.left >= nr.left - 1 && ar.right <= nr.right + 1; })()`);
    ok(`activeInView:${s}`, seen === true);
    // …without moving the page or the nav column sideways.
    const still = await p.page.evaluate(`(() => [document.querySelector(".main").scrollLeft, document.querySelector(".s-nav").scrollLeft])()`) as number[];
    ok(`pageStill:${s}`, still[0] === 0 && still[1] === 0);
  }
  await go("/settings/access");
  await p.page.screenshot({ path: shotPath("2347g", c as any, "2-access") });
  for (const [old, path, hash] of [["device", "/settings/preferences", ""], ["appearance", "/settings/look", ""], ["general", "/settings/agent-defaults", ""],
    ["bots", "/settings/chat", ""], ["web", "/settings/access", ""], ["classic", "/settings/chat", "#classicbot"]] as const) {
    await go(`/settings/${old}`);
    const u = new URL(p.page.url());
    ok(`old:${old}`, u.pathname === path && u.hash === hash && (await p.page.locator(".s-nav .seg-item.active").getAttribute("href")) === path);
  }
  await p.page.screenshot({ path: shotPath("2347g", c as any, "3-chat-classicbot") });
  ok("noPageErrors", errors.length === 0);
  results.push({ name, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? " " + failed.join(", ") : ""}${errors.length ? " errors=" + JSON.stringify(errors) : ""}`);
  await p.ctx.close();
}
console.log(results.some((r) => r.failed.length) ? "FAIL" : "PASS");
await fx.close();
process.exit(results.some((r) => r.failed.length) ? 1 : 0);
