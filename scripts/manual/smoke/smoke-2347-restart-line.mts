// #2347 restart flow: the app-wide "N saved change(s) take effect after AgEnD restarts" line on a fresh profile — desk
// light and dark (zh-TW), phone light — in Fleet and in Settings. Checks: the line shows with its keys, Restart now and
// Later; its bar is the shared straight ::before bar (3px, square, no border-left); Later hides it; nothing is posted.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2347-restart-line.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48851), instances: 2 });
fx.fm.getInstanceStatus = () => "running";
(fx.fm as any).settingsRestartPending = () => ({ keys: ["defaults.locale", "channels"], job_id: "job-smoke" });
const results: Array<{ name: string; failed: string[] }> = [];
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const) {
  const name = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [];
  const ok = (k: string, v: boolean) => { if (!v) failed.push(k); };
  const p = await freshPage(fx, c);
  const posts: string[] = [];
  p.page.on("request", (r: any) => { if (r.method() === "POST" && /restart-fleet/.test(r.url())) posts.push(r.url()); });
  await mounted(p.page, 30000);
  const line = p.page.locator(".restart-line");
  ok("lineShown", await line.waitFor({ timeout: 10000 }).then(() => true, () => false));
  ok("keysShown", /defaults\.locale, channels/.test(await line.textContent() ?? ""));
  ok("twoButtons", await line.locator("button").count() === 2);
  const bar = await p.page.evaluate(`(() => { const n = document.querySelector(".restart-line"); const b = getComputedStyle(n, "::before");
    return { w: b.width, content: b.content, radius: b.borderTopLeftRadius, bl: getComputedStyle(n).borderLeftWidth, r: getComputedStyle(n).borderTopLeftRadius }; })()`) as any;
  ok("straightBar", bar.w === "3px" && bar.content !== "none" && bar.radius === "0px" && bar.bl === "0px" && bar.r === "0px");
  await p.page.screenshot({ path: shotPath("2347r", c as any, "1-fleet") });
  await p.page.goto(new URL("/settings/general", p.page.url()).href);
  ok("lineInSettings", await line.waitFor({ timeout: 10000 }).then(() => true, () => false));
  await p.page.screenshot({ path: shotPath("2347r", c as any, "2-settings") });
  await line.locator("button").last().click();
  await p.page.waitForTimeout(400);
  ok("laterHides", await p.page.locator(".restart-line").count() === 0);
  ok("nothingPosted", posts.length === 0);
  results.push({ name, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? " " + failed.join(", ") : ""} bar=${JSON.stringify(bar)}`);
  await p.ctx.close();
}
console.log(results.some((r) => r.failed.length) ? "FAIL" : "PASS");
await fx.close();
process.exit(results.some((r) => r.failed.length) ? 1 : 0);
