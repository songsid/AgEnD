// AGEND-223: the version line of the Antigravity and Grok cards when the CLI's version could not be read vs when it was.
// GET /ui/accounts answers a synthetic view (the product's own web server, a scratch home, no fleet start); every write is refused.
//   Antigravity — "unknown" (latest-unaudited CLI): used to read "? is installed …", now "could not be read …".
//   Grok        — the version the daemon now reads inside a container: "1.0.77 is installed …".
// 8 cases by default (desk/phone × light/dark × en/zh-TW); MATRIX=quick for two.
//   PW_DIR=<dir with playwright-core> OUT=<dir> [LABEL=before|after] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-cli-version-line-223.mts
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-cli-version-line-223";
const LABEL = process.env.LABEL ?? "after";
const used = { agents: [], classic: [], fleetDefault: true };
const host = (backend: string, extra: Record<string, unknown>) => ({ scope: { kind: "host" }, backend, profile: null, state: "usable", signIn: true, usedBy: used, ...extra });
const VIEW = { clis: [
  { backend: "antigravity", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [host("antigravity", { cliUpdate: { state: "unknown", installed: null, audited: "1.5.3", button: false, latest: true, via: "dashboard" } })] },
  { backend: "grok", profiles: false, installed: true, fleetDefault: null, agents: [], rows: [host("grok", { version: "1.0.77", cliUpdate: { state: "current", installed: "1.0.77", audited: "1.0.77", button: false, latest: false, via: "dashboard" } })] },
] };
const SIGNIN = { selected: ["antigravity", "grok"], pending: [], skipped: [], states: { antigravity: "valid", grok: "valid" }, login: null, ready: true };
const fx = await bootFixture({ port: 47480, instances: 4 });
const out: Record<string, unknown> = {};
try {
  for (const c of matrix()) {
    const cn = caseName(c);
    const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
    await page.route(/\/ui\/accounts(\?.*)?$/, (route: any) => route.request().method() !== "GET" ? route.fulfill(json({ error: "refused by the smoke" }, 409)) : route.fulfill(json(VIEW)));
    await page.route(/\/ui\/browser-backend-signins(\?.*)?$/, (route: any) => route.request().method() !== "GET" ? route.fulfill(json({}, 409)) : route.fulfill(json(SIGNIN)));
    await page.goto(`${fx.base}/settings/agents`);
    await page.waitForSelector(".s-ai-accounts", { timeout: 15000 });
    await page.evaluate(`document.querySelector("details.s-ai-accounts").open = true`);
    await page.waitForSelector(".s-account-card", { timeout: 10000 }); await page.waitForTimeout(600);
    const lines = await page.evaluate(`Object.fromEntries([...document.querySelectorAll(".s-account-card")].map((card) => [card.dataset.backend, card.querySelector(".s-account-version")?.textContent.replace(/\\s+/g, " ").trim() ?? null]))`);
    await page.locator(".s-ai-accounts").screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-cards`) });
    out[cn] = { lines, errs, pageX: await page.evaluate("document.documentElement.scrollWidth - innerWidth") };
    await ctx.close();
  }
} finally { await fx.close(); }
console.log(JSON.stringify(out, null, 1));
