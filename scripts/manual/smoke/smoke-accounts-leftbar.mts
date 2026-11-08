// The user's report on #3367 (「右半部又出現左側圓倒角顏色 設計錯誤」): Settings → Agents → Accounts boxes drew their state colour as
// a border-left curving into the row's rounded corners. The house style (#2330/#2332/#2489) is the shared straight left bar
// (`.lbar`). A real browser on the shared fixture (the product's own web server, a scratch home, no fleet start); the accounts
// list (`/ui/accounts`) is answered in the page with fixture data covering every state — signed in, not signed in, not known
// (unknown / not installed / too old) — and a paired computer's tray. Per case (desktop/phone × light/dark):
//   - no account row has a border-left; each has the straight bar (`::before`, 3px, square) in its state's colour;
//   - pictures of the Accounts block (OUT/<smoke>/<case>-<label>-accounts.png).
//   LABEL=base serves accounts-view.js and accounts.css from OLD_REF (the before pictures).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx tsx scripts/manual/smoke/smoke-accounts-leftbar.mts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-accounts-leftbar";
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const OLD = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const old = (f: string) => execFileSync("git", ["-C", process.env.REPO!, "show", `${OLD}:${f}`], { encoding: "utf8", maxBuffer: 16 << 20 });
const used = (agents: string[] = [], fleetDefault = false) => ({ agents, classic: [], fleetDefault });
const machine = { kind: "machine", id: "m1", name: "Desk PC", online: true };
const VIEW = { clis: [
  { backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [{ name: "dev", profile: "work" }, { name: "ops", profile: null }],
    rows: [
      { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, identity: { maskedEmail: "ab***@example.com", plan: "max" }, usedBy: used(["ops"], true), usage: { percent: 37, windowMs: 604800000 } },
      { scope: { kind: "host" }, backend: "claude-code", profile: "personal", state: "not_signed_in", signIn: true, usedBy: used() },
      { scope: { kind: "host" }, backend: "claude-code", profile: "lab", state: "unknown", signIn: true, usedBy: used() },
      { scope: machine, backend: "claude-code", profile: "work", state: "usable", signIn: true, identity: { maskedEmail: "cd***@example.com", plan: "team" }, usedBy: used(["dev"]) },
      { scope: machine, backend: "claude-code", profile: "spare", state: "not_signed_in", signIn: true, usedBy: used() },
    ] },
] };
const fx = await bootFixture({ port: 47610, instances: 4 });
const js = (body: string, type = "text/javascript") => ({ status: 200, contentType: `${type}; charset=utf-8`, body });
try {
  for (const c of matrix("desk-light-en,desk-dark-zh-TW,phone-light-zh-TW,phone-dark-en")) {
    const cn = caseName(c);
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/agents" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    if (BASE) {
      await page.route(/\/accounts-view\.js(\?.*)?$/, (route: any) => route.fulfill(js(old("src/ui/accounts-view.js"))));
      await page.route(/\/assets\/accounts\.css(\?.*)?$/, (route: any) => route.fulfill(js(old("src/ui/shared/accounts.css"), "text/css")));
    }
    await page.route(/\/ui\/accounts(\?.*)?$/, (route: any) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(VIEW) }));
    await page.goto(`${fx.base}/settings/agents`);
    await page.waitForSelector(".s-account-row", { state: "attached", timeout: 20000 });
    // The Accounts block may sit in a closed drawer: open every one, as a person reading it would.
    await page.evaluate(() => { document.querySelectorAll(".p-settings details").forEach((d) => { (d as HTMLDetailsElement).open = true; }); });
    await page.waitForTimeout(800);
    const rows = await page.evaluate(() => [...document.querySelectorAll(".s-account-row")].map((el) => {
      const s = getComputedStyle(el), b = getComputedStyle(el, "::before");
      return { account: el.getAttribute("data-account"), lbar: el.classList.contains("lbar"), borderLeft: s.borderLeftWidth + " " + s.borderLeftStyle,
        radius: s.borderTopLeftRadius, bar: b.content !== "none" ? { width: b.width, radius: b.borderTopLeftRadius, color: b.backgroundColor } : null };
    }));
    const block = page.locator(".s-account-card").first();
    await block.scrollIntoViewIfNeeded();
    await block.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-accounts`) });
    const cspNow = await csp();
    if (BASE) { r[cn] = { rows, errs }; await ctx.close(); continue; }
    const colours = new Set(rows.map((x) => x.bar?.color));
    check(cn, rows.length === 5 && rows.every((x) => x.lbar && x.borderLeft.startsWith("0px") && x.bar && x.bar.width === "3px" && x.bar.radius === "0px")
      && colours.size === 3 && errs.length === 0 && cspNow.length === 0, { rows, colours: [...colours], errs, csp: cspNow });
    await ctx.close();
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE), { recursive: true });
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1).slice(0, 3000)); console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
