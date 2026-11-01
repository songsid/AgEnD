// #2910 D2: a web-only fleet's Notices (/ui/notices) — what General would have said. The fixture's fleet has no chat
// connection (web-only); its notices are the product's own (notifyFleetError, notifyInstanceTopic, the update notice),
// recorded through the real hooks. Signed in as the operator (`agend web --code`'s kind of session) through /signin.
// Cases: phone (390, touch) and desk, light and dark, zh-TW and en. Judged per case:
//  - the sidebar (desk) / the menu drawer (phone) has "Notices" with the unread count, on a web-only fleet only;
//  - the page lists them newest first, the unread ones tagged "New", each agent's notice with "Open chat";
//  - opening the page marks them read on the server (unread 0) and the sidebar count goes;
//  - a notice that arrives while the page is open shows at once (SSE), tagged as read only once seen;
//  - no horizontal overflow on a phone; no CSP violation; no page error.
// Control: the same fixture with a chat connection has no Notices entry.
//   PW_DIR=… REPO=… OUT=… FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2910-notices.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2910-notices";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48760), classic: false, instances: 12 });
const fm = fx.fm;
delete fm.notifyFleetError;                                   // the fixture silences it; the real one records a Notice here
const { t, setLocale } = await import(process.env.REPO + "/src/locale.ts");
const names = Object.keys(fm.fleetConfig.instances).filter((n: string) => !fm.fleetConfig.instances[n].general_topic);
const CASES = [
  { device: "phone", theme: "light", lang: "zh-TW" },
  { device: "phone", theme: "dark", lang: "en" },
  { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "desk", theme: "light", lang: "en" },
] as const;
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];

/** A few notices in the fleet's language, as the product words them. */
function seed(lang: "en" | "zh-TW", round: number) {
  setLocale(lang);
  fm.recordWebNotice("update", t("update.available_web_only", "v2.4.0", "v2.3.3"));
  fm.notifyInstanceTopic(names[0], t("inst.crashed_respawned", names[0]));
  fm.notifyFleetError(t("web.login_notice_web_only", "Chrome on macOS", "local", `a1b2c3d${round}`));
  fm.notifyInstanceTopic(names[1], `⏳ ${names[1]}: usage limit reached — resets at 18:00 (round ${round}).`);
}
const unread = () => fm.webNoticeStore().unread();

for (const [i, c] of CASES.entries()) {
  const failed: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
  seed(c.lang, i);
  const p = await freshPage(fx, c as any, { account: "operator" });
  await mounted(p.page, 30000);
  await p.page.waitForTimeout(500);
  const before = unread();                                      // the sign-in just now is one too (web.login_notice_web_only)
  const phone = c.device === "phone";
  const label = c.lang === "zh-TW" ? "通知" : "Notices";
  // The entry and its count: the sidebar on a desk, the menu drawer on a phone.
  if (phone) { await p.page.locator(".tabs").waitFor(); await p.page.locator("#sbOpen").tap(); await p.page.waitForTimeout(400); }
  const entry = p.page.locator(`.side-nav a[href="/ui/notices"]`);
  await entry.waitFor({ timeout: 10000 }).catch(() => {});
  const count = (await entry.locator(".nav-count").textContent().catch(() => null))?.trim();
  need((await entry.count()) === 1 && (await entry.textContent())?.includes(label) === true, `entry "${label}" in the ${phone ? "drawer" : "sidebar"}`);
  need(count === String(before), `count ${count} = unread ${before}`);
  await p.page.screenshot({ path: shotPath(SMOKE, c as any, "1-nav"), ...(phone ? {} : { clip: { x: 0, y: 0, width: 320, height: 420 } }) });
  // The page.
  if (phone) await entry.tap(); else await entry.click();
  await p.page.waitForSelector(".p-notices .n-item.notice", { timeout: 10000 });
  await p.page.waitForTimeout(500);
  const rows = await p.page.locator(".p-notices .n-item.notice").count();
  const tagged = await p.page.locator(".p-notices .n-item.notice.unread").count();
  need(rows === fm.webNoticeStore().view().items.length, `rows ${rows}`);
  need(tagged === before, `"New" on ${tagged} = ${before}`);
  need(unread() === 0, `marked read on the server (unread ${unread()})`);
  need((await p.page.locator(".side-nav a[href='/ui/notices'] .nav-count").count()) === 0, "the sidebar count went");
  need((await p.page.locator(".p-notices .n-item.notice >> text=" + (c.lang === "zh-TW" ? "開啟聊天" : "Open chat")).count()) >= 2, "Open chat on agents' notices");
  const texts = await p.page.locator(".p-notices .n-item.notice .notice-text").allTextContents();
  need(/sign-in|登入/.test(texts[0] ?? "") && (texts[1] ?? "").includes(`round ${i}`) && texts[1]!.includes(names[1]), `newest first: ${(texts[0] ?? "").slice(0, 40)} / ${(texts[1] ?? "").slice(0, 40)}`);
  if (phone) need(await p.page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "no horizontal overflow");
  await p.page.screenshot({ path: shotPath(SMOKE, c as any, "2-page"), fullPage: false });
  // One arriving while it is open.
  fm.notifyFleetError(c.lang === "zh-TW" ? `⚠️ 排程 nightly-${i} 沒有執行：agent 離線。` : `⚠️ Schedule nightly-${i} did not run: its agent is offline.`);
  await p.page.waitForFunction(`document.querySelectorAll(".p-notices .n-item.notice").length === ${rows + 1}`, null, { timeout: 10000 }).catch(() => {});
  need((await p.page.locator(".p-notices .n-item.notice").count()) === rows + 1, "a new one shows live");
  await p.page.waitForTimeout(800);
  need(unread() === 0, "…and is read once seen");
  await p.page.screenshot({ path: shotPath(SMOKE, c as any, "3-live") });
  need(p.errors.length === 0, `no page error or CSP violation (console errors): ${p.errors.slice(0, 2).join(" / ")}`);
  results.push({ name: `${c.device}-${c.theme}-${c.lang}`, ok: !failed.length, failed });
  await p.ctx.close();
}

// #2925 review P2-2: a page whose stream never connects (it polls /ui/poll every 5 s): a notice recorded while it is open reaches its sidebar count
// through the status frame's newest id, not only at the next visit.
{
  const p = await freshPage(fx, CASES[3] as any, { account: "operator", beforeNavigate: async (ctx: any) => { await ctx.route("**/ui/events", (r: any) => r.abort()); } });
  await mounted(p.page, 30000);
  await p.page.waitForTimeout(1500);
  const read = async () => Number((await p.page.locator(`.side-nav a[href="/ui/notices"] .nav-count`).textContent().catch(() => "0")) ?? 0);
  const before = await read();
  fm.notifyFleetError("⚠️ A notice while this page only polls.");
  let after = before;
  for (let i = 0; i < 30 && after === before; i++) { await p.page.waitForTimeout(500); after = await read(); }
  const polling = true;                                              // its stream never connects (aborted): it polls /ui/poll
  results.push({ name: "polling page (stream down)", ok: polling && after === before + 1, failed: polling && after === before + 1 ? [] : [`count ${before} → ${after} (polling ${polling})`] });
  await p.page.screenshot({ path: shotPath(SMOKE, "desk-light-en-polling", "count") , clip: { x: 0, y: 0, width: 320, height: 420 } });
  await p.ctx.close();
}

// Control: a chat connection — no Notices entry.
fm.fleetConfig.channels = [{ id: "demo", type: "discord", bot_token_env: "DEMO_BOT_TOKEN", access: { mode: "locked", allowed_users: [] } }];
{
  const p = await freshPage(fx, CASES[3] as any, { account: "operator" });
  await mounted(p.page, 30000);
  await p.page.waitForTimeout(1500);
  const n = await p.page.locator(`.side-nav a[href="/ui/notices"]`).count();
  results.push({ name: "control: chat fleet", ok: n === 0, failed: n ? ["a Notices entry on a chat fleet"] : [] });
  await p.ctx.close();
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
await fx.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
