// #2347 §6 settings search on a fresh profile — desk light (en), desk dark (zh-TW), phone light (en). Checks: "/"
// focuses the box; "token" lists results grouped by section (marks and config keys shown) without a page error or a
// sideways page scroll; Enter lands on the first one's section with the field focused and flashed.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2347-search.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48854), instances: 2 });
fx.fm.getInstanceStatus = () => "running";
const results: Array<{ name: string; failed: string[] }> = [];
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const) {
  const name = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [];
  const ok = (k: string, v: boolean) => { if (!v) failed.push(k); };
  const p = await freshPage(fx, c);
  const errors: string[] = [];
  p.page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  await mounted(p.page, 30000);
  await p.page.goto(new URL("/settings/agents", p.page.url()).href);
  await p.page.locator("#settingsSearch").waitFor({ timeout: 15000 });
  await p.page.locator(".p-settings .panel-body").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await p.page.keyboard.press("/");
  ok("slashFocuses", await p.page.evaluate(`document.activeElement && document.activeElement.id === "settingsSearch"`) === true);
  await p.page.keyboard.type("token");
  await p.page.locator(".s-find-results").waitFor({ timeout: 5000 });
  const r = await p.page.evaluate(`(() => ({ heads: [...document.querySelectorAll(".s-find-head")].length, items: [...document.querySelectorAll(".s-find-item")].length,
    marks: document.querySelectorAll(".s-find-item mark").length, keys: document.querySelectorAll(".s-find-key").length,
    overflowX: document.documentElement.scrollWidth > innerWidth }))()`) as any;
  ok("grouped", r.heads >= 2 && r.items >= 3);
  ok("marked", r.marks >= 1 && r.keys >= 1);
  ok("noSideScroll", !r.overflowX);
  await p.page.screenshot({ path: shotPath("2347s", c as any, "1-results") });
  await p.page.keyboard.press("Enter");
  await p.page.waitForTimeout(900);
  const landed = await p.page.evaluate(`(() => ({ path: location.pathname, focused: document.activeElement && document.activeElement.id, flash: !!document.querySelector(".s-flash") }))()`) as any;
  ok("landed", landed.path === "/settings/access" && landed.focused === "publicTunnelToken");
  ok("flashed", landed.flash);
  await p.page.screenshot({ path: shotPath("2347s", c as any, "2-landed") });
  ok("noPageErrors", errors.length === 0);
  results.push({ name, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? " " + failed.join(", ") : ""} ${JSON.stringify({ r, landed })}${errors.length ? " errors=" + JSON.stringify(errors) : ""}`);
  await p.ctx.close();
}
console.log(results.some((r) => r.failed.length) ? "FAIL" : "PASS");
await fx.close();
process.exit(results.some((r) => r.failed.length) ? 1 : 0);
