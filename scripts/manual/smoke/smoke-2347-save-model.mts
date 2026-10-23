// #2347 PR 1 from defaults (fleet decision a78ebdc5): the Settings save model on a fresh profile. Desk light and dark,
// phone light: General with one field edited (tool progress) (the straight bar, the "N unsaved change(s)" bar with Save), an invalid
// value ("Fix 1 field(s) to save", Save waiting), and Discard. Checks: no Review button; the marker is a ::before bar of
// 3px with square ends (no border-left); Save disabled while invalid; nothing written before Save; Discard clears.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2347-save-model.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48850), instances: 2 });
fx.fm.getInstanceStatus = () => "running";
const results: Array<{ name: string; failed: string[] }> = [];
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const) {
  const name = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [];
  const ok = (k: string, v: boolean) => { if (!v) failed.push(k); };
  const p = await freshPage(fx, c);
  const writes: string[] = [];
  p.page.on("request", (r: any) => { if (r.method() !== "GET" && /\/api\/settings\//.test(r.url())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await mounted(p.page, 30000);
  await p.page.goto(new URL("/settings/general", p.page.url()).href);
  await p.page.locator("#g-tp").waitFor({ timeout: 15000 });
  const before = await p.page.inputValue("#g-tp"), pick = before === "verbose" ? "off" : "verbose";
  ok("noReviewButton", await p.page.locator("button", { hasText: /^(Review changes|檢查變更)$/ }).count() === 0);
  await p.page.selectOption("#g-tp", pick);
  const bar = p.page.locator(".s-pending");
  ok("barShown", await bar.waitFor({ timeout: 5000 }).then(() => true, () => false));
  const marker = await p.page.evaluate(`(() => { let n = document.querySelector("#g-tp"); while (n && !n.classList.contains("field")) n = n.parentElement;
    const b = getComputedStyle(n, "::before"); return { cls: n.className, w: b.width, content: b.content, radius: b.borderTopLeftRadius, bl: getComputedStyle(n).borderLeftWidth, tint: getComputedStyle(n).borderTopLeftRadius }; })()`) as any;
  ok("markerIsStraightBar", /s-dirty/.test(marker.cls) && marker.w === "3px" && marker.content !== "none" && marker.radius === "0px" && marker.bl === "0px" && marker.tint === "0px");
  await p.page.screenshot({ path: shotPath("2347", c as any, "1-edited") });
  await p.page.fill("#g-auto", "-3");
  await p.page.waitForTimeout(300);
  const barDump = await p.page.evaluate(`(() => { const b = document.querySelector(".s-pending"); if (!b) return "no bar"; const r = b.getBoundingClientRect();
    return JSON.stringify({ text: b.textContent, rect: [r.top, r.height, innerHeight], btns: [...b.querySelectorAll("button")].map((x) => [x.className, x.textContent, x.disabled]) }); })()`);
  ok("saveWaitsWhenInvalid", await bar.locator("button.btn-primary").isDisabled() && await bar.locator(".s-fix").isVisible());
  await p.page.screenshot({ path: shotPath("2347", c as any, "2-invalid") });
  ok("nothingWrittenBeforeSave", writes.length === 0);
  await bar.locator("button", { hasText: /^(Discard|捨棄)$/ }).click();
  await p.page.waitForTimeout(800);
  ok("discardClears", await p.page.locator(".s-pending").count() === 0 && (await p.page.inputValue("#g-tp")) === before);
  results.push({ name, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? " " + failed.join(", ") : ""} marker=${JSON.stringify(marker)} bar=${barDump}`);
  await p.ctx.close();
}
console.log(results.some((r) => r.failed.length) ? "FAIL" : "PASS");
await fx.close();
process.exit(results.some((r) => r.failed.length) ? 1 : 0);
