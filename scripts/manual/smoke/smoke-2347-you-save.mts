// #2347 PR "You" group: Preferences and Look save with Settings' bar, on a fresh profile — desk light and dark (zh-TW),
// phone light. Preferences: the theme flips the page at once, the bar counts "Your preferences", nothing is sent before
// Save; Discard puts the theme back; Save sends one /ui/prefs write. Colours off (Look) and "follow reduced motion"
// (Preferences, since the #2382 regroup) are two unsaved changes across a tab change; Discard puts both back.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2347-you-save.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
const results: Array<{ name: string; failed: string[] }> = [];
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const) {
  // Save writes the host's prefs, and each case starts from a proven default store: one fixture per case.
  const fx = await bootFixture({ port: Number(process.env.HP ?? 48852) + results.length, instances: 2 });
  fx.fm.getInstanceStatus = () => "running";
  const name = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [];
  const ok = (k: string, v: boolean) => { if (!v) failed.push(k); };
  const p = await freshPage(fx, c);
  const prefWrites: string[] = [];
  p.page.on("request", (r: any) => { if (r.method() === "POST" && /\/ui\/prefs$/.test(r.url())) prefWrites.push(r.postData() ?? ""); });
  await mounted(p.page, 30000);
  // In-app to a section (a reload would put a held choice back): on a phone (§7) a section is shown alone, so "‹ Settings"
  // goes back to the list of sections first.
  const section = async (href: string) => {
    const back = p.page.locator(".p-settings .s-back");
    if (await back.isVisible().catch(() => false)) { await back.click(); await p.page.waitForTimeout(400); }
    await p.page.locator(`.s-nav a[href="${href}"]`).click();
  };
  await p.page.goto(new URL("/settings/preferences", p.page.url()).href);
  const sel = p.page.locator(".s-synced select").first();
  await sel.waitFor({ timeout: 15000 });
  const shown = () => p.page.evaluate(`document.documentElement.getAttribute("data-theme") || "system"`) as Promise<string>;
  const before = await shown();
  const want = c.theme === "dark" ? "light" : "dark";
  await sel.selectOption(want);
  const bar = p.page.locator(".s-pending");
  ok("barShown", await bar.waitFor({ timeout: 5000 }).then(() => true, () => false));
  ok("themeAtOnce", (await shown()) === want);
  await p.page.waitForTimeout(600);
  ok("nothingSentBeforeSave", prefWrites.length === 0);
  await p.page.screenshot({ path: shotPath("2347y", c as any, "1-theme") });
  await bar.locator("button", { hasText: /^(Discard|捨棄)$/ }).click();
  await p.page.waitForTimeout(600);
  ok("discardPutsBack", (await shown()) === before && (await p.page.locator(".s-pending").count()) === 0 && prefWrites.length === 0);
  await sel.selectOption(want);
  await bar.locator("button.btn-primary").click();
  await p.page.waitForTimeout(1200);
  ok("saveSendsOne", prefWrites.length === 1 && /"theme":"/.test(prefWrites[0]) && (await p.page.locator(".s-pending").count()) === 0);
  await p.page.goto(new URL("/settings/look", p.page.url()).href);
  await p.page.locator(".s-colors-off").waitFor({ timeout: 15000 });
  await p.page.locator(".s-colors-off").check();
  // In-app to Preferences (a reload would put a held choice back): the motion switch lives there since #2382.
  await section("/settings/preferences");
  const motion = p.page.locator("#fx-follow-reduced-motion");
  await motion.waitFor({ timeout: 15000 });
  const motionBefore = await motion.isChecked();
  await motion.click();
  ok("twoChanges", /2/.test(await bar.textContent({ timeout: 5000 }).catch(() => "") ?? ""));
  await p.page.screenshot({ path: shotPath("2347y", c as any, "2-appearance") });
  await bar.locator("button", { hasText: /^(Discard|捨棄)$/ }).click();
  await p.page.waitForTimeout(600);
  const motionBack = (await motion.isChecked()) === motionBefore && (await p.page.locator(".s-pending").count()) === 0;
  await section("/settings/look");
  await p.page.locator(".s-colors-off").waitFor({ timeout: 15000 });
  ok("bothDiscarded", motionBack && !(await p.page.locator(".s-colors-off").isChecked()));
  results.push({ name, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? " " + failed.join(", ") : ""}`);
  await p.ctx.close();
  await fx.close();
}
console.log(results.some((r) => r.failed.length) ? "FAIL" : "PASS");
process.exit(results.some((r) => r.failed.length) ? 1 : 0);
