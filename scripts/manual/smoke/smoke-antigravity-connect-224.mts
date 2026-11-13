// AGEND-224: Settings → Accounts for Antigravity, before and after the web connection (agy acp --login, named accounts, Disconnect, Keep connection alive, a Windows computer).
// The product's own web server (a scratch home, no fleet start); GET /ui/accounts answers what THIS tree's own `buildAccountsView` makes from the same input (so the same script runs on the
// base and on the branch and each shows what it really draws: the base has no Connect for Antigravity, only "Connect from chat"), and every write is refused except the connect dialog's start.
// 8 cases by default (desk/phone × light/dark × en/zh-TW); MATRIX=quick for two.
//   PW_DIR=<dir with playwright-core> OUT=<dir> LABEL=before|after FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-antigravity-connect-224.mts
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";
import { buildAccountsView } from "../../../src/accounts-view.js";
import { hostFacts } from "../../../src/cli-registry.js";

const SMOKE = "smoke-antigravity-connect-224";
const LABEL = process.env.LABEL ?? "after";
const HOUR = 3_600_000;
const built = !!hostFacts("antigravity", "structuredSignIn");           // does this tree know how to connect Antigravity from the dashboard?
const usage = new Map([["antigravity\0", { groups: [
  { pool: { label: "Gemini" }, windows: [{ kind: "session", percent: 11, windowMs: 5 * HOUR }, { kind: "weekly", percent: 16, windowMs: 168 * HOUR }] },
  { pool: { label: "Claude & others", labelI18n: { key: "usage.metric.agy_claude_others" } }, windows: [{ kind: "session", percent: 0, windowMs: 5 * HOUR }, { kind: "weekly", percent: 39, windowMs: 168 * HOUR }] },
] }]]) as never;
const input: any = {
  targets: [
    { backend: "antigravity", state: "usable", signIn: built, ...(built ? {} : { hostCommand: "agy" }), ...(built ? { identity: { maskedEmail: "pe***@example.com" } } : {}) },
    ...(built ? [{ backend: "antigravity", profile: "work", state: "usable", signIn: true, identity: { maskedEmail: "wo***@example.com" } }, { backend: "antigravity", profile: "spare", state: "not_signed_in", signIn: true }] : []),
  ],
  diskProfiles: new Map(built ? [["antigravity", [{ profile: "work", state: "usable", signIn: true }, { profile: "spare", state: "not_signed_in", signIn: true }]]] : []),
  agents: [{ name: "dev", backend: "antigravity", profile: built ? "work" : null }], classic: [], fleetDefaults: new Map(),
  ...(built ? { usage } : {}), keepAlive: new Map(built ? [["antigravity\0work", { enabled: true, lastAt: "2026-11-12T06:55:00.000Z", expiresAt: "2026-11-12T07:55:00.000Z", lastOutcome: "refreshed" }]] : []),
  machines: built ? [{ id: "m1", name: "Desk PC", online: true, defaultProfile: undefined, agents: [], profiles: [], defaultLogin: undefined, defaultLogins: { antigravity: { loggedIn: false, accounts: true, agents: [] } },
    profilesByCli: { antigravity: [{ name: "home", loggedIn: true, created: true, identity: { maskedEmail: "ho***@example.com" } }] }, agentsByCli: { antigravity: [] } }] : [],
  versions: new Map([["antigravity", "1.5.5"]]),
};
const VIEW = buildAccountsView({ ...input, ...(built ? {} : { machines: [] }) } as never);
const SIGNIN = { selected: ["antigravity"], pending: ["antigravity"], skipped: [], states: { antigravity: "invalid" }, login: null, ready: false };
const LINK = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=fixture&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=fixture";
const RUNNING = { ...SIGNIN, login: { id: "run1", backend: "antigravity", phase: "code", revision: 2, mine: true, canAct: true, url: LINK }, started: "run1" };

const fx = await bootFixture({ port: 47490, instances: 4 });
const out: Record<string, unknown> = {};
try {
  for (const c of matrix()) {
    const cn = caseName(c);
    const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
    let started = false;
    await page.route(/\/ui\/accounts(\?.*)?$/, (route: any) => route.request().method() !== "GET" ? route.fulfill(json({ error: "refused by the smoke" }, 409)) : route.fulfill(json(VIEW)));
    await page.route(/\/ui\/browser-backend-signins(\?.*)?$/, (route: any) => {
      const req = route.request();
      if (req.method() === "GET") return route.fulfill(json(started ? RUNNING : SIGNIN));
      started = true; return route.fulfill(json(RUNNING));
    });
    await page.goto(`${fx.base}/settings/agents`);
    await page.waitForSelector(".s-ai-accounts", { timeout: 15000 });
    await page.evaluate(`document.querySelector("details.s-ai-accounts").open = true`);
    await page.waitForSelector('.s-account-card[data-backend="antigravity"]', { timeout: 10000 }); await page.waitForTimeout(600);
    const card = page.locator('.s-account-card[data-backend="antigravity"]');
    // The card is taller than the page's scrolling area: a tall viewport (same width) shows all of it, as a person who scrolls would see it.
    const vp = page.viewportSize(); await page.setViewportSize({ width: vp.width, height: 2600 }); await page.waitForTimeout(400);
    await card.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-card`) });
    const buttons = await page.evaluate(`[...document.querySelectorAll('.s-account-card[data-backend="antigravity"] .s-account-row')].map((row) => [row.dataset.account ?? "", [...row.querySelectorAll("button, summary")].map((b) => b.textContent.replace(/\\s+/g, " ").trim()).filter(Boolean)])`);
    await page.setViewportSize(vp); await page.waitForTimeout(300);
    let dialog: unknown = null;
    if (built) {
      await page.evaluate(`document.querySelector('.s-account-card[data-backend="antigravity"] .s-account-row .s-actions .btn-primary, .s-account-card[data-backend="antigravity"] .s-account-row .s-actions button')?.click()`);
      await page.waitForSelector("dialog", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
      // The dialog's own Connect account: the link and the code box (the server answers a start with a run that is waiting for the code).
      await page.evaluate(`[...document.querySelectorAll("dialog button")].find((b) => /^(Connect account|連接帳號)$/.test(b.textContent.trim()))?.click()`);
      await page.waitForSelector("dialog input", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      dialog = await page.evaluate(`(document.querySelector("dialog")?.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 300)`);
      await (page.locator("dialog").first()).screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-dialog`) }).catch(() => {});
    }
    out[cn] = { buttons, dialog, errs, pageX: await page.evaluate("document.documentElement.scrollWidth - innerWidth") };
    await ctx.close();
  }
} finally { await fx.close(); }
console.log(JSON.stringify(out, null, 1));
