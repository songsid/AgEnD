// #2347 §10 on a fresh profile — desk light (en), desk dark (zh-TW), phone light (en). Checks: Fleet has no Config tab;
// the old /ui/fleet/config (loaded straight, as a bookmark would) lands on Settings → Agent defaults at Project folders,
// with that card in view; adding a folder there is one unsaved change in the bar and Discard takes it back; no side
// scroll and no page error.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2347-fleet-config.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48857), instances: 2 });
fx.fm.getInstanceStatus = () => "running";
const results: Array<{ name: string; failed: string[] }> = [];
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const) {
  const name = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [];
  const ok = (k: string, v: boolean) => { if (!v) failed.push(k); };
  const p = await freshPage(fx, c);
  const errors: string[] = [];
  p.page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  await mounted(p.page, 30000);
  await p.page.goto(new URL("/ui/fleet", p.page.url()).href);
  await p.page.locator(".p-fleet .seg, [data-trust=panel-navigation]").first().waitFor({ timeout: 15000 });
  const tabs = await p.page.evaluate(`[...document.querySelectorAll("[data-trust=panel-navigation] .seg-item")].map((a) => new URL(a.href).pathname)`) as string[];
  ok("tabsDrawn", tabs.length === 6);
  ok("noConfigTab", !tabs.some((t) => t.endsWith("/config")));
  // A bookmark: the old address loaded from scratch (the server serves the shell, the page moves the address).
  const res = await p.page.goto(new URL("/ui/fleet/config", p.page.url()).href);
  ok("servedShell", res?.status() === 200);
  await p.page.locator("#project-roots").waitFor({ timeout: 15000 });
  await p.page.waitForTimeout(800);
  const u = new URL(p.page.url());
  ok("landed", u.pathname === "/settings/agent-defaults" && u.hash === "#project-roots");
  const view = await p.page.evaluate(`(() => { const r = document.querySelector("#project-roots").getBoundingClientRect();
    return { inView: r.top < innerHeight && r.bottom > 0, overflowX: document.documentElement.scrollWidth > innerWidth,
      active: document.querySelector(".s-nav .seg-item.active")?.getAttribute("href") }; })()`) as any;
  ok("cardInView", view.inView);
  ok("navActive", view.active === "/settings/agent-defaults");
  ok("noSideScroll", !view.overflowX);
  await p.page.screenshot({ path: shotPath("2347fc", c as any, "1-project-folders") });
  const box = p.page.locator("#project-roots");
  await box.locator("input[type=text]").fill("/srv/projects");
  await box.locator(".field-row button").click();
  await p.page.locator(".s-pending").waitFor({ timeout: 5000 });
  const staged = await p.page.evaluate(`(() => ({ chips: [...document.querySelectorAll("#project-roots .chip")].map((c) => c.textContent.trim()),
    dirty: document.querySelector("#g-roots").classList.contains("s-dirty"), overflowX: document.documentElement.scrollWidth > innerWidth }))()`) as any;
  ok("chipAdded", JSON.stringify(staged.chips) === JSON.stringify(["/srv/projects"]));
  ok("fieldMarked", staged.dirty);
  ok("noSideScrollStaged", !staged.overflowX);
  await p.page.screenshot({ path: shotPath("2347fc", c as any, "2-staged") });
  await p.page.locator(".s-pending button", { hasText: c.lang === "en" ? "Discard" : "捨棄" }).first().click();
  await p.page.waitForTimeout(600);
  ok("discarded", (await p.page.locator("#project-roots .chip").count()) === 0 && (await p.page.locator(".s-pending").count()) === 0);
  ok("noPageErrors", errors.length === 0);
  results.push({ name, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? " " + failed.join(", ") : ""}${errors.length ? " errors=" + JSON.stringify(errors) : ""}`);
  await p.ctx.close();
}
console.log(results.some((r) => r.failed.length) ? "FAIL" : "PASS");
await fx.close();
process.exit(results.some((r) => r.failed.length) ? 1 : 0);
