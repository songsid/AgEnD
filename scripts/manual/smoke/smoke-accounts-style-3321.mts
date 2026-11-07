// Ridge #3321 (Settings style review), the Accounts items, in a real browser on the shared fixture (the product's own web
// server, a scratch home, no fleet start). GET /ui/accounts answers a synthetic view — the host's Claude Code (keep-alive on,
// its last try "couldn't reach the service") and a paired computer "Desk PC" — and every write is refused. Desk light zh-TW,
// phone dark zh-TW, desk light en:
//   S07 — the first read fails (503): the section keeps its heading and offers Retry; Retry reads it again and draws the list;
//   S08 — the disclosure and the section say host AND paired computers; the host's rows have their own "On this AgEnD host" head;
//   S10 — Keep sign-in alive is the shared switch (s-ui-toggle), as Hub membership;
//   S12 — Sign in again's dialog (the CLI's name in its title) does not repeat the setup page's heading or lead;
//   S15 — "will try again tomorrow";
//   no page error, no CSP report, no horizontal scroll.
// LABEL=base: the before pictures and measures only.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-accounts-style-3321.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-accounts-style-3321";
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const later = new Date(Date.now() + 60 * 86400_000).toISOString();
const used = { agents: [], classic: [], fleetDefault: false };
const VIEW = { clis: [{ backend: "claude-code", profiles: true, installed: true, fleetDefault: null, agents: [], rows: [
  { scope: { kind: "host" }, backend: "claude-code", profile: null, state: "usable", signIn: true, usedBy: { ...used, fleetDefault: true },
    keepAlive: { enabled: true, fallback: false, endsAt: later, lastAt: new Date().toISOString(), lastOutcome: "transient" } },
  { scope: { kind: "machine", id: "m1", name: "Desk PC", online: true }, backend: "claude-code", profile: "work", state: "usable", signIn: true, usedBy: used },
] }] };
const SIGNIN = { selected: ["claude-code"], pending: [], skipped: [], states: { "claude-code": "valid" }, login: null, ready: true };
const fx = await bootFixture({ port: 47470, instances: 4 });
try {
  for (const c of matrix("desk-light-zh-TW,phone-dark-zh-TW,desk-light-en")) {
    const cn = caseName(c), zh = c.lang === "zh-TW";
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/runtimes" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    let fails = 1;
    const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
    await page.route(/\/ui\/accounts(\?.*)?$/, (route: any) => route.request().method() !== "GET" ? route.fulfill(json({ error: "refused by the smoke" }, 409))
      : fails-- > 0 ? route.fulfill(json({ error: "unavailable" }, 503)) : route.fulfill(json(VIEW)));
    await page.route(/\/ui\/browser-backend-signins(\?.*)?$/, (route: any) => route.request().method() !== "GET" ? route.fulfill(json({}, 409)) : route.fulfill(json(SIGNIN)));
    await page.goto(`${fx.base}/settings/agents`);
    await page.waitForSelector(".s-ai-accounts", { timeout: 15000 });
    await page.evaluate(`document.querySelector("details.s-ai-accounts").open = true`);
    // (base: a failed read drew only a bare alert, no section)
    await page.waitForSelector(".s-accounts, .s-auth-body [role=alert]", { timeout: 10000 }); await page.waitForTimeout(600);
    // S07: the failed first read.
    const failed = await page.evaluate(`(() => { const s = document.querySelector(".s-accounts") || document.querySelector(".s-auth-body"); return { heading: document.querySelector(".s-accounts h3")?.textContent ?? "", retry: [...(s?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()), alert: document.querySelector(".s-auth-body [role=alert]")?.textContent.trim() ?? "" }; })()`) as any;
    await page.locator(".s-ai-accounts").screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-1-failed`) });
    let listed = false;
    const retry = page.locator(".s-accounts button", { hasText: zh ? "再試一次" : "Try again" });
    if (await retry.count()) { await retry.first().click(); listed = await page.waitForSelector(".s-account-card", { timeout: 10000 }).then(() => true, () => false); }
    else { await page.reload(); await page.waitForSelector(".s-ai-accounts"); await page.evaluate(`document.querySelector("details.s-ai-accounts").open = true`); await page.waitForSelector(".s-account-card", { timeout: 10000 }).catch(() => {}); }
    await page.waitForTimeout(600);
    // S08, S10, S15.
    const scope = await page.evaluate(`({ banner: document.querySelector(".s-auth-scope strong")?.textContent ?? "", hint: document.querySelector(".s-accounts .s-auth-section-head p")?.textContent ?? "",
      heads: [...document.querySelectorAll(".s-account-card .s-account-machine-head strong")].map((n) => n.textContent.trim()),
      keepAliveSwitch: !!document.querySelector(".s-account-keepalive input.s-ui-toggle"), keepAliveText: document.querySelector(".s-account-keepalive")?.innerText.replace(/\\s+/g, " ") ?? "" })`) as any;
    await page.locator(".s-ai-accounts").screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-2-accounts`) });
    // S12: Sign in again's dialog (the host default row's button).
    await page.locator('.s-account-rows .s-account-row button', { hasText: zh ? "重新登入" : "Sign in again" }).first().click();
    await page.waitForSelector("dialog[open]", { timeout: 10000 }); await page.waitForTimeout(800);
    const dialog = await page.evaluate(`(() => { const d = [...document.querySelectorAll("dialog[open]")].pop(); return { title: d.querySelector(".dlg-title")?.textContent.trim() ?? "", text: d.innerText.replace(/\\s+/g, " ") }; })()`) as any;
    await page.screenshot({ path: shotPath(SMOKE, cn, `${LABEL}-3-signin`) });
    const got = { failed, listed, scope, dialog, errs, csp: await csp(), pageX: await page.evaluate("document.documentElement.scrollWidth - innerWidth") };
    if (BASE) { r[cn] = got; await ctx.close(); continue; }
    check(cn, failed.heading === (zh ? "帳號" : "Accounts") && failed.retry.length === 1 && listed
      && scope.banner.includes(zh ? "已配對電腦" : "paired computers") && scope.hint.includes(zh ? "已配對電腦" : "paired computers")
      && scope.heads[0] === (zh ? "在這台 AgEnD 主機上" : "On this AgEnD host") && scope.heads.some((h: string) => h.includes("Desk PC"))
      && scope.keepAliveSwitch && scope.keepAliveText.includes(zh ? "明天會再試" : "will try again tomorrow")
      && !dialog.text.includes(zh ? "登入你的 AI 後端" : "Sign in your AI backends") && dialog.title.includes("Claude Code")
      && errs.length === 0 && (got.csp as string[]).length === 0 && got.pageX <= 0, got);
    await ctx.close();
  }
  // SKEW (a tab kept across the upgrade), desk light en: the OLD /assets with these modules, and this shell with the OLD
  // changed Accounts modules. The Accounts section still draws its cards, with no error.
  if (!BASE) {
    const { execFileSync } = await import("node:child_process");
    const REPO = process.env.REPO!, OLD = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
    const old = (f: string) => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD}:src/ui/${f}`], { encoding: "utf8", maxBuffer: 64 << 20 }); } catch { return null; } };
    const MODS = ["accounts-view.js", "accounts-keepalive.js", "settings-outside.js", "structured-signin.js", "backend-signin.js", "settings-layout.js"];
    for (const way of ["old-shell", "old-modules"]) {
      const c = matrix("desk-light-en")[0]!;
      const { ctx, page } = await fx.page(c, { path: "/settings/runtimes" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      const served = new Set<string>();
      const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
      await page.route(/\/ui\/accounts(\?.*)?$/, (route: any) => route.request().method() !== "GET" ? route.fulfill(json({}, 409)) : route.fulfill(json(VIEW)));
      if (way === "old-shell") await page.route("**/assets/**", (route: any) => { const f = new URL(route.request().url()).pathname.replace(/^\/assets\//, ""); const body = old(`shared/${f}`);
        if (body === null) return route.continue(); served.add(f); return route.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body }); });
      else await page.route(/\/ui\/js\/([a-z0-9-]+\.js)(\?.*)?$/, (route: any) => { const f = /\/ui\/js\/([a-z0-9-]+\.js)/.exec(route.request().url())![1]!;
        if (!MODS.includes(f)) return route.continue(); served.add(f); return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old(f)! }); });
      await page.goto(`${fx.base}/settings/agents`); await page.waitForSelector(".s-ai-accounts", { timeout: 15000 });
      await page.evaluate(`document.querySelector("details.s-ai-accounts").open = true`);
      const drawn = await page.waitForSelector(".s-account-card", { timeout: 10000 }).then(() => true, () => false);
      await page.waitForTimeout(500); await page.locator(".s-ai-accounts").screenshot({ path: shotPath(SMOKE, `skew-${way}`, `${LABEL}-accounts`) });
      check(`skew-${way}`, drawn && served.size > 0 && errs.length === 0, { drawn, served: [...served], errs });
      await ctx.close();
    }
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE), { recursive: true });
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
