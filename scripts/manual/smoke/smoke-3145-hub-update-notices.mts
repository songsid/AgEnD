// M-3145 (docs/design/hub-fleet-versions.md §4.4; M-3144 #3963): an owner's Notices about an update their Hub's
// administrator asked for, on the real Fleet dashboard. The fixture's web-only fleet records five update notices through
// the real hook; the page's read of GET /ui/notices/list is given each one's `hubUpdate` (the shape #3963 records), so
// this runs before and after the receiver lands. The Fleet's request routes and the update start are answered here
// (nothing is ever installed). Signed in as the operator (an admin). Judged per case:
//  - each notice says, in the owner's words, who asked and what happened (waiting, expired, rolled back, cancelled, done);
//  - waiting has Update now + Cancel update; expired Update now; rolled back See the full log; the others no button;
//  - Update now rereads the request, asks naming its version and who asked, and starts it by id (hubRequestId, no version);
//  - Cancel update posts {} to that request's cancel and says so;
//  - no horizontal overflow on a phone; no page error.
//   PW_DIR=… REPO=… OUT=… [MATRIX=full|quick] scripts/manual/smoke/run.sh smoke-3145-hub-update-notices.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-3145-hub-update-notices";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48780), classic: false, instances: 4 });
const fm = fx.fm;
const STATES = ["done", "cancelled", "rolled-back", "expired", "waiting"] as const;   // recorded oldest first: waiting on top
const ID: Record<string, string> = Object.fromEntries(STATES.map((s, i) => [s, `0b9f2a64-1c3d-4e5f-8a9b-0c1d2e3f4a5${i}`]));
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];

for (const [round, c] of matrix().entries()) {
  const failed: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) failed.push(what); };
  const zh = c.lang === "zh-TW", hub = zh ? "總部 Hub" : "Team Hub", who = zh ? "王經理" : "Ada";
  for (const s of STATES) fm.recordWebNotice("update", `HU:${s}:${round}`);
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const p = await freshPage(fx, c, { account: "operator", path: "/ui/notices", beforeNavigate: async (ctx: any) => {
    await ctx.route("**/ui/notices/list", async (r: any) => {
      const answer = await r.fetch(), body = await answer.json();
      for (const n of body.items ?? []) {
        const m = /^HU:([a-z-]+):\d+$/.exec(n.text ?? "");
        if (m) n.hubUpdate = { requestId: ID[m[1]], hubName: hub, requestedBy: who, version: "2.4.0", state: m[1], ...(m[1] === "rolled-back" ? { currentVersion: "2.3.9" } : {}) };
      }
      await r.fulfill({ response: answer, json: body });
    });
    await ctx.route("**/api/settings/hub/fleet-updates/**", async (r: any) => {
      const q = r.request(), path = new URL(q.url()).pathname, body = q.postData() ? JSON.parse(q.postData()) : null;
      calls.push({ method: q.method(), path, body });
      const id = path.split("/")[5];
      await r.fulfill({ json: { id, version: "2.4.0", requestedAt: 1, expiresAt: 2, state: path.endsWith("/cancel") ? "cancelled" : "waiting" } });
    });
    await ctx.route("**/ui/update/start", async (r: any) => {
      const q = r.request();
      calls.push({ method: q.method(), path: "/ui/update/start", body: JSON.parse(q.postData() || "null") });
      await r.fulfill({ status: 202, json: { started: true } });
    });
  } });
  const errors: string[] = [];
  p.page.on("pageerror", (e: Error) => errors.push(e.message));
  await mounted(p.page, 30000);
  await p.page.waitForSelector(".p-notices .n-item.notice", { timeout: 15000 });
  await p.page.waitForTimeout(800);
  const item = (s: string) => p.page.locator(".p-notices .n-item.notice", { hasText: zh ? { waiting: "要求把這個 Fleet", expired: "沒有開始", "rolled-back": "沒有成功", cancelled: "已取消更新", done: "已依" }[s]! : { waiting: "asked to update this Fleet", expired: "did not start", "rolled-back": "did not work", cancelled: "Update cancelled", done: "is updated to" }[s]! });
  const buttons = async (s: string) => (await item(s).first().locator(".n-actions button").allTextContents()).map((x) => x.trim());
  const want: Record<string, string[]> = zh
    ? { waiting: ["立即更新", "取消更新"], expired: ["立即更新"], "rolled-back": ["看完整紀錄"], cancelled: [], done: [] }
    : { waiting: ["Update now", "Cancel update"], expired: ["Update now"], "rolled-back": ["See the full log"], cancelled: [], done: [] };
  for (const s of STATES) {
    const got = await buttons(s), n = await item(s).count();
    need(n >= 1, `${s}: its notice in the owner's words`);
    need(JSON.stringify(got) === JSON.stringify(want[s]), `${s}: buttons ${JSON.stringify(got)} (want ${JSON.stringify(want[s])})`);
  }
  need(((await item("waiting").first().textContent()) ?? "").includes(who) && ((await item("waiting").first().textContent()) ?? "").includes(hub), "waiting names who asked and the Hub");
  const wide = await p.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  need(!wide, "no horizontal overflow");
  await p.page.screenshot({ path: shotPath(SMOKE, c, "1-notices"), fullPage: true });
  // Update now: the question names the version and who asked; yes starts it by the request's id.
  await item("waiting").first().locator(".n-actions button").first().click();
  const dialog = p.page.locator("[data-confirm=yes]");
  await dialog.waitFor({ timeout: 10000 });
  const question = (await p.page.locator(".confirm-text").allTextContents()).join(" ");
  need(question.includes("2.4.0") && question.includes(who) && question.includes(hub), `the question names v2.4.0, ${who} and ${hub}: ${question}`);
  await p.page.screenshot({ path: shotPath(SMOKE, c, "2-update-now") });
  await dialog.click();
  for (let i = 0; i < 20 && !calls.some((x) => x.path === "/ui/update/start"); i++) await p.page.waitForTimeout(250);
  const start = calls.find((x) => x.path === "/ui/update/start");
  need(calls[0]?.method === "GET" && calls[0]?.path === `/api/settings/hub/fleet-updates/${ID.waiting}`, `reread first: ${JSON.stringify(calls[0])}`);
  need(JSON.stringify(start?.body) === JSON.stringify({ confirm: "update-agend", hubRequestId: ID.waiting }), `started by id: ${JSON.stringify(start?.body)}`);
  // Cancel update.
  await item("waiting").first().locator(".n-actions button").nth(1).click();
  for (let i = 0; i < 20 && !calls.some((x) => x.path.endsWith("/cancel")); i++) await p.page.waitForTimeout(250);
  const cancel = calls.find((x) => x.path.endsWith("/cancel"));
  need(cancel?.method === "POST" && cancel.path === `/api/settings/hub/fleet-updates/${ID.waiting}/cancel` && JSON.stringify(cancel.body) === "{}", `cancel: ${JSON.stringify(cancel)}`);
  const said = zh ? "已取消更新。" : "Update cancelled.";   // after "Update started." (toasts stack, newest last)
  const toast = await p.page.locator(".toast", { hasText: said }).first().waitFor({ timeout: 5000 }).then(() => said, async () => (await p.page.locator(".toast").allTextContents()).join(" | "));
  need(toast === said, `cancel said: ${toast}`);
  need(errors.length === 0, `page errors: ${errors.join(" | ")}`);
  results.push({ name: caseName(c), ok: failed.length === 0, failed });
  await p.ctx.close();
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
await fx.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
