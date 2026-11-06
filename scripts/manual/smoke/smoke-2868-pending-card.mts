// #2868: the pending-change card on the realistic fixture — each way a held change can be confirmed, as Settings shows it
// (inline, under the operation). The views are set in the page's store as the server would answer them; this browser's
// authorization (GET /ui/authorization) is answered per case. Desktop light (en) and phone dark (zh-TW).
// VARIANTS=before runs the same cases on a checkout without #2868 (only host_cli and chat exist there).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2868-pending-card.mts
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.VARIANTS === "before" ? "smoke-2868-pending-card-before" : "smoke-2868-pending-card";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48440) });
const ID = "0123456789abcdef0123456789abcdef";
const base = { id: ID, state: "pending", section: "access", requested_at: Date.now(), requested_by: "Chrome on Windows", expires_at: Date.now() + 300_000,
  remaining_ms: 287_000, source: "web_session", summary: ["web.verified_authority.max_session_hours: 48 → 72"], can_withdraw: true, outcome: null };
const NOT = { state: "none", reason: "not_authorized" }, VERIFIED = { state: "verified", until: Date.now() + 36 * 3600_000 };
const cases = process.env.VARIANTS === "before"
  ? [{ name: "1-host-cli", view: { ...base, confirmation: { kind: "host_cli", code: ID } }, auth: NOT },
     { name: "2-chat", view: { ...base, confirmation: { kind: "chat" } }, auth: NOT }]
  : [{ name: "1-posting-unverified", view: { ...base, confirmation: { kind: "posting", code: ID } }, auth: NOT },
     { name: "2-chat-unverified", view: { ...base, confirmation: { kind: "chat", code: ID, where: [{ platform: "discord", connection: "discord" }] } }, auth: NOT },
     { name: "3-chat-verified-apply-now", view: { ...base, can_self_confirm: true, confirmation: { kind: "chat", code: ID, where: [{ platform: "telegram", connection: "telegram" }] } }, auth: VERIFIED },
     { name: "4-host-only", view: { ...base, confirmation: { kind: "host_cli", code: ID } }, auth: NOT },
     { name: "5-advanced-open", view: { ...base, confirmation: { kind: "chat", code: ID, where: [{ platform: "discord", connection: "team-b" }] } }, auth: VERIFIED, open: true }];
const results: any = { browser: fx.browser.version(), cases: {} };
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  for (const k of cases) {
    const { ctx, page, csp } = await fx.page(c as any, {});
    await page.route("**/ui/authorization", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(k.auth) }));
    await page.route(`**/api/settings/pending/${ID}`, (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(k.view) }));
    await page.goto(`${fx.base}/settings/access`); await page.waitForTimeout(800);
    // The card as settings-confirm.js follows a request (track(): what a save's 202 starts), labelled as Settings does.
    await page.evaluate(async (v: any) => { const m: any = await import("/ui/js/settings-confirm.js" as string); m.track(v, "Access & security"); }, k.view);
    await page.waitForTimeout(900);
    if ((k as any).open) await page.evaluate(() => { const d = document.querySelector(".pending-host") as HTMLDetailsElement | null; if (d) d.open = true; });
    const card = await page.$(".pending-card");
    const text = card ? await card.evaluate((e: any) => e.innerText) : null;
    if (card) await card.screenshot({ path: shotPath(SMOKE, `${c.device}-${c.theme}-${c.lang}`, k.name) });
    results.cases[`${c.device}-${c.lang}-${k.name}`] = { text, overflowX: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), csp: await csp() };
    await ctx.close();
  }
}
console.log(JSON.stringify(results, null, 1));
await fx.close(); process.exit(0);
