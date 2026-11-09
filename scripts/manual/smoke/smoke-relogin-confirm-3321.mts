// Ridge #3321 S01 (P1): Accounts → Claude Code (signed in) → "Sign in again" asked "Sign in again? Kiro will sign out its
// existing account first." On the shared fixture (the product's own web server, a scratch home, no fleet start), in a real
// browser: the sign-in dialog Accounts opens (openSignIn, the function its row button calls) for Claude Code, Codex and
// Kiro, each signed in. The sign-in endpoint answers a synthetic view (that CLI signed in) and every POST is refused, so
// no CLI is ever started; the question is answered No.
// - the question names that CLI; Claude Code and Codex: "the new sign-in replaces the account it uses now"; Kiro: "it signs
//   out its current account first" (only Kiro runs a logout first);
// - it is the dashboard's own confirmation (a picture of it), not the browser's (a native dialog is recorded by its text —
//   that is what LABEL=base shows);
// - No sends nothing; desk light en and phone dark zh-TW.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [LABEL=base|branch] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-relogin-confirm-3321.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-relogin-confirm-3321";
const LABEL = process.env.LABEL ?? "branch", BASE = LABEL === "base";
const r: Record<string, unknown> = { label: LABEL };
const fail: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => { r[n] = ok ? "PASS" : { FAIL: d ?? true }; if (!ok) fail.push(n); };
const WANT: Record<string, Record<string, string>> = {
  en: { "claude-code": "Sign in to Claude Code again? The new sign-in replaces the account it uses now.",
    codex: "Sign in to Codex again? The new sign-in replaces the account it uses now.",
    "kiro-cli": "Sign in to Kiro again? It signs out its current account first." },
  "zh-TW": { "claude-code": "要重新登入 Claude Code 嗎？新的登入會取代目前使用的帳號。",
    codex: "要重新登入 Codex 嗎？新的登入會取代目前使用的帳號。",
    "kiro-cli": "要重新登入 Kiro 嗎？會先登出目前的帳號。" },
};
const AGAIN: Record<string, string> = { en: "Sign in again", "zh-TW": "重新登入" };
const fx = await bootFixture({ port: 47390, instances: 4 });
try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) {
    for (const backend of ["claude-code", "codex", "kiro-cli"]) {
      const tag = `${caseName(c)}:${backend}`;
      const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      const posts: unknown[] = [];
      const view = { selected: [backend], pending: [], skipped: [], states: { [backend]: "valid" }, login: null, ready: true };
      await page.route(/\/ui\/browser-backend-signins(\?.*)?$/, async (route: any) => {
        if (route.request().method() !== "GET") { posts.push(route.request().postDataJSON?.() ?? route.request().postData()); return route.fulfill({ status: 409, contentType: "application/json", body: "{}" }); }
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(view) });
      });
      const native: string[] = [];
      page.on("dialog", async (d: any) => { native.push(d.message()); await d.dismiss(); });
      await page.waitForSelector(".s-section-layout", { timeout: 15000 });
      await page.evaluate(`import("/ui/js/backend-signin.js").then((m) => m.openSignIn({ backend: ${JSON.stringify(backend)} }))`);
      const again = page.locator(`button:text-is(${JSON.stringify(AGAIN[c.lang])})`).last();
      await again.waitFor({ timeout: 10000 });
      await again.click();
      await page.waitForTimeout(600);
      const inApp = await page.evaluate(`(() => { return [...document.querySelectorAll("dialog[open], [role=alertdialog], [role=dialog]")].map((d) => d.innerText.replace(/\\s+/g, " ").trim()).join(" | ").slice(0, 1200); })()`) as string;
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), `${LABEL}-${backend}`) });
      // Answer No in the page's own confirmation (when there is one).
      const no = page.locator(`dialog[open] button:text-is(${JSON.stringify(c.lang === "zh-TW" ? "取消" : "Cancel")})`).last();
      if (await no.count()) await no.click();
      await page.waitForTimeout(300);
      const starts = posts.filter((p: any) => p && p.operation === "start");
      const got = { native, inApp, starts, errs };
      if (BASE) r[tag] = got;
      else check(tag, native.length === 0 && inApp.includes(WANT[c.lang]![backend]!) && starts.length === 0 && errs.length === 0, got);
      await ctx.close();
    }
  }
  // SKEW (a tab kept across the upgrade), desk light en, Claude Code: the old backend-signin.js with the new renderer asks the
  // browser — with the corrected words; the new backend-signin.js with the old renderer still works (its old words, natively).
  if (!BASE) {
    const { execFileSync } = await import("node:child_process");
    const REPO = process.env.REPO!, OLD = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
    const old = (f: string) => execFileSync("git", ["-C", REPO, "show", `${OLD}:src/ui/${f}`], { encoding: "utf8", maxBuffer: 16 << 20 });
    for (const file of ["backend-signin.js", "structured-signin.js"]) {
      const c = matrix("desk-light-en")[0]!;
      const { ctx, page } = await fx.page(c, { path: "/settings/agents" });
      const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      let served = 0;
      await page.route(new RegExp(`/ui/js/${file.replace(".", "\\.")}(\\?.*)?$`), (route: any) => { served++; return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: old(file) }); });
      await page.route(/\/ui\/browser-backend-signins(\?.*)?$/, (route: any) => route.request().method() !== "GET" ? route.fulfill({ status: 409, contentType: "application/json", body: "{}" })
        : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ selected: ["claude-code"], pending: [], skipped: [], states: { "claude-code": "valid" }, login: null, ready: true }) }));
      const native: string[] = []; page.on("dialog", async (d: any) => { native.push(d.message()); await d.dismiss(); });
      await page.reload(); await page.waitForSelector(".s-section-layout", { timeout: 15000 });
      await page.evaluate(`import("/ui/js/backend-signin.js").then((m) => m.openSignIn({ backend: "claude-code" }))`);
      const again = page.locator(`button:text-is("Sign in again")`).last(); await again.waitFor({ timeout: 10000 }); await again.click(); await page.waitForTimeout(600);
      const inApp = await page.evaluate(`[...document.querySelectorAll("dialog[open]")].map((d) => d.innerText.replace(/\\s+/g, " ")).join(" | ")`) as string;
      await page.screenshot({ path: shotPath(SMOKE, "skew", `old-${file.replace(".js", "")}`) });
      const asked = native[0] ?? inApp;
      // Old backend-signin.js: the new renderer's corrected words, natively. Old renderer: its own (old) words — recorded, not a failure.
      const ok = served > 0 && errs.length === 0 && (file === "backend-signin.js" ? native[0] === WANT.en!["claude-code"] : asked.length > 0);
      check(`skew-old-${file}`, ok, { served, native, inApp: inApp.slice(0, 300), errs });
      await ctx.close();
    }
  }
} catch (e) { fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500); }
finally {
  writeFileSync(join(process.env.OUT ?? "/tmp/smoke-out", SMOKE, `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1)); console.log(fail.length ? `FAIL: ${fail.join(", ")}` : BASE ? "RECORDED" : "ALL PASS");
  await fx.close(); process.exit(fail.length ? 1 : 0);
}
