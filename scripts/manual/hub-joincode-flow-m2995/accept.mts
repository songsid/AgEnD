/** Light source-shell evidence for M-2995. Real Hub HTTP/assets/session + routed company-join DTOs.
 * One Chromium, serial contexts; no FleetManager, CLI, AD, Docker or capacity campaign.
 * REPO=<source checkout> OUT=<owned dir> PW_DIR=<playwright project> [PHASE=before|after] [SKEW_REPO=<old checkout>]
 */
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { listenLoopback } from "../smoke-fixture/listen-loopback.mts";
const REPO = resolve(process.env.REPO ?? process.cwd()), OUT = resolve(process.env.OUT ?? ".artifacts/m2995/browser");
const BEFORE = process.env.PHASE === "before", SKEW = process.env.SKEW_REPO ? resolve(process.env.SKEW_REPO) : null;
mkdirSync(OUT, { recursive: true });
const ID = "11111111-1111-4111-8111-111111111111", NOW = Date.now();
const POLICY = { realm: "corp", generation: "gen-1", revision: 1, state: "enabled", denies: [], groups: [{
  group: { realm: "corp", objectId: "22222222-2222-4222-8222-222222222222" }, dn: "CN=Design,DC=example,DC=test", allow: ["ask_agents", "publish_agents", "pair_fleet"], maxFleets: 1 }] };
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const server = createServer(), keys = mkdtempSync(join(OUT, ".keys-")); chmodSync(keys, 0o700);
let rig: any, browser: any;
const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [], images: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); if (!ok) throw Error(name); };
const production = ["src/hub/enrolment-code.ts", "src/hub/http/compose.ts", "src/hub/join/service.ts", "src/ui/hub-client.js", "src/ui/hub-enrolment-code.js", "src/ui/hub-enrolment-code-strings.js", "src/ui/hub-joincode-flow-strings.js", "src/ui/hub-join-approval.js", "src/ui/hub-company-join-strings.js", "src/ui/hub-company-join.js", "src/ui/panel-hub.js", "src/ui/shared/app.css"];
writeFileSync(join(OUT, "PRODUCTION_SHA256SUMS"), production.flatMap(file => { try { return [createHash("sha256").update(readFileSync(join(REPO, file))).digest("hex") + "  " + file]; } catch { if (BEFORE && file.endsWith("hub-joincode-flow-strings.js")) return []; throw Error("source missing: " + file); } }).join("\n") + "\n");
const receipt: any = { sourceDirty: execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: REPO, encoding: "utf8" }).trim().length > 0, productBinding: "PRODUCTION_SHA256SUMS", phase: BEFORE ? "before" : "after", source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(),
  skew: SKEW, boundary: "Production Hub HTTP shell/assets/Preact/Dialog and real dummy-directory sign-in; company-join/code/queue API DTOs are browser-routed fixtures. No directory, real Fleet, capacity, packaged-runtime or Docker claim." };
try {
  const port = await listenLoopback(server), origin = `https://127.0.0.1:${port}`;
  await provisionHubIdentity({ home: keys, memberOrigin: origin });
  server.setSecureContext({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) });
  const control = { async read(ctx: any) { await ctx.requireAdmin(); return { ok: true, supported: true, groupPolicyV1: true, binding: "ready", policy: POLICY, paused: [] }; } };
  const welcome = async (ctx: any) => { await ctx.requirePerson(); return { ok: true, v: 1, mode: "enabled", chat: { state: "allow", reason: "group" }, publish: { state: "allow", reason: "group" }, connect: { state: "allow", reason: "group", maxFleets: 1, fleets: [] } }; };
  rig = await s3bRig({ webOrigin: origin, groupHttp: { control, welcome } });
  server.on("request", (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
  const pw = createRequire(resolve(process.env.PW_DIR ?? REPO) + "/")("playwright-core");
  browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
  receipt.browser = browser.version(); receipt.playwright = createRequire(resolve(process.env.PW_DIR ?? REPO) + "/")("playwright-core/package.json").version;
  for (const device of ["desk", "phone"]) for (const lang of ["en", "zh-TW"]) {
    const phone = device === "phone", theme = phone ? "dark" : "light", tag = `${device}-${theme}-${lang}`;
    const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 },
      isMobile: phone, hasTouch: phone, colorScheme: theme, locale: lang === "en" ? "en-US" : "zh-TW", ignoreHTTPSErrors: true });
    await ctx.addInitScript({ content: `window.__name = f => f; localStorage.setItem("agend_lang",${JSON.stringify(lang)}); localStorage.setItem("agend_theme",${JSON.stringify(theme)}); localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1"); window.__csp=[];document.addEventListener("securitypolicyviolation",e=>window.__csp.push(e.violatedDirective));` });
    await ctx.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
    let mode = "live", ended = false, revokes = 0, approvals = 0;
    const names = lang === "en" ? ["Design laptop", "QA laptop", "Support laptop"] : ["設計組筆電", "測試組筆電", "客服組筆電"];
    const code = (n: number, state = "live") => ({ id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, code: state === "live" ? `2345-ABC${n + 1}` : null,
      state, uses: 2, maxUses: 30, inFlight: state === "live" ? 3 : 0, inFlightLabels: state === "live" ? names : [], createdAt: NOW - n * 1000, expiresAt: NOW + 3600000, scope: { kind: "directory" }, perPersonFleets: 1, recent: [] });
    const rows = () => mode === "live-limit" ? Array.from({ length: 8 }, (_, i) => code(i + 1)) : mode === "hourly-code-limit" ? Array.from({ length: 10 }, (_, i) => code(i + 1, i ? "revoked" : "live")) : [code(1, ended ? "revoked" : "live")];
    await ctx.route(/\/hub\/v1\/session$/, async (route: any) => {
      const res = await route.fetch(), data = await res.json();
      if (data.signedIn) data.features = [...new Set([...(data.features ?? []), "company-join-v1", "enrolment-code-v1"])];
      await route.fulfill({ response: res, json: data });
    });
    await ctx.route(/\/hub\/v1\/admin\/company-join$/, (route: any) => route.fulfill({ json: { enabled: true, revision: 1 } }));
    await ctx.route(/\/hub\/v1\/join\/metadata$/, (route: any) => route.fulfill({ json: { features: ["company-join-v1", "enrolment-code-v1"] } }));
    await ctx.route(/\/hub\/v1\/admin\/enrolment-codes(?:\/[^/]+\/revoke)?$/, (route: any) => {
      if (route.request().url().endsWith("/revoke")) { revokes++; ended = true; return route.fulfill({ json: { ok: true } }); }
      if (route.request().method() === "GET") return route.fulfill({ json: { codes: rows() } });
      return route.fulfill({ status: 429, json: { code: "backpressure", ...(!BEFORE ? { reason: mode === "live-limit" ? "live-code-limit" : "hourly-code-limit" } : {}) } });
    });
    await ctx.route(/\/hub\/v1\/join\/browser\?/, (route: any) => route.fulfill({ json: { requestId: ID, state: mode === "terminal" ? "ended" : "pending",
      reason: mode === "terminal" ? BEFORE ? "authority" : "code-ended" : null, issued: false, label: names[0], fleetOrigin: "https://fleet.example.test", outerDeadline: Date.now() + 60000 } }));
    await ctx.route(/\/hub\/v1\/join\/approve$/, (route: any) => { approvals++; return route.fulfill({ status: 429, json: { code: "backpressure" } }); });
    if (SKEW) {
      for (const name of ["hub-enrolment-code-strings.js", "hub-join-approval.js"]) await ctx.route("**/ui/js/" + name, (route: any) => route.fulfill({ contentType: "application/javascript", body: readFileSync(join(SKEW, "src/ui", name), "utf8") }));
      for (const name of ["app-shell.js", "app.css", "tokens.css"]) await ctx.route("**/assets/" + name, (route: any) => route.fulfill({ contentType: name.endsWith("css") ? "text/css" : "application/javascript", body: readFileSync(join(SKEW, "src/ui/shared", name), "utf8") }));
    }
    const page = await ctx.newPage(), errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
    const shot = async (name: string) => {
      await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(100);
      const file = `${tag}-${name}.png`; await page.screenshot({ path: join(OUT, file) }); images.push(file);
      const shape = await page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, csp: (window as any).__csp,
        small: [...document.querySelectorAll("dialog button")].filter(e => { const b = e.getBoundingClientRect();return b.width > 0 && b.height > 0 && (b.height < 43 || b.width < 43); }).map(e => ({ text: e.textContent, close: e.classList.contains("dlg-x"), width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height })) }));
      check(`${tag}:${name}:no-overflow`, shape.x <= 0, shape); check(`${tag}:${name}:csp`, !shape.csp.length, shape.csp);
      if (phone) {
        // Held CSS retains the shared Dialog's historical 36px close icon; new action buttons must still meet --tap.
        const small = SKEW ? shape.small.filter((e: any) => !e.close) : shape.small;
        check(`${tag}:${name}:dialog-tap${SKEW ? "-actions-held-css" : ""}`, !small.length, shape.small);
      }
    };
    const signIn = async () => { await page.goto(origin + "/ui/hub"); await page.fill("#hubLogin", "admin"); await page.fill("#hubPassword", "pw-admin"); await page.click(".hub-signin button[type=submit]"); await page.waitForSelector("#sidebar .side-foot", { state: "attached" }); };
    const manager = async () => { await page.goto(origin + "/ui/hub/admin"); await page.waitForSelector("[data-enrolment-codes]");
      const start = page.locator("[data-enrolment-codes] > .n-actions button"); await start.scrollIntoViewIfNeeded(); await start.waitFor({ state: "visible" }); await page.waitForFunction(() => !(document.querySelector("[data-enrolment-codes] > .n-actions button") as HTMLButtonElement)?.disabled); };
    const create = lang === "en" ? "Create join code" : "建立加入碼", end = lang === "en" ? "End this code now" : "立即停用這組碼";
    await signIn();
    for (const limit of BEFORE ? ["live-limit"] : ["live-limit", "hourly-code-limit"]) {
      mode = limit; ended = false; await manager(); await page.getByRole("button", { name: create, exact: true }).click();
      await page.locator("dialog").getByRole("button", { name: create, exact: true }).click();
      await page.locator("dialog").waitFor({ state: "detached" }); await page.locator("[data-enrolment-codes]").getByRole("alert").waitFor();
      await shot(limit); if (!BEFORE) check(`${tag}:${limit}:copy`, (await page.locator("[data-enrolment-codes]").innerText()).includes(limit === "live-limit" ? "8" : "10"));
    }
    mode = "live"; ended = false; await manager(); await page.getByRole("button", { name: end, exact: true }).click();
    if (!BEFORE) {
      await page.locator("dialog").waitFor(); check(`${tag}:confirm:no-write`, revokes === 0);
      check(`${tag}:confirm:names`, (await page.locator("dialog").innerText()).includes(names[0])); await shot("end-confirm");
      await page.locator("dialog").getByRole("button", { name: lang === "en" ? "Cancel" : "取消", exact: true }).click(); check(`${tag}:cancel:no-write`, revokes === 0);
      await page.getByRole("button", { name: end, exact: true }).click(); await page.locator("dialog").getByRole("button", { name: end, exact: true }).click();
      await page.locator("dialog").waitFor({ state: "detached" }); check(`${tag}:end:one-write`, revokes === 1);
      await page.getByText(lang === "en" ? "The code has ended. Fleets already connected are unchanged." : "加入碼已停用，已連接的 Fleet 不受影響。", { exact: true }).waitFor();
    } else await page.waitForFunction(() => !document.querySelector("[data-enrolment-codes] code"));
    await shot("end-result");
    mode = "terminal"; await page.goto(origin + "/ui/hub?join=" + ID); await page.getByRole("status").filter({ hasText: lang === "en" ? BEFORE ? "Local authorization" : "This join code" : BEFORE ? "本機授權" : "加入碼已失效" }).waitFor(); await shot("code-ended");
    mode = "queue"; approvals = 0; await page.goto(origin + "/ui/hub?join=" + ID); await page.getByRole("button", { name: lang === "en" ? "Connect as Hub Admin" : "以 Hub Admin 的身分連接", exact: true }).click();
    await page.getByRole("status").filter({ hasText: lang === "en" ? "queue" : "排隊" }).waitFor(); await shot("queue-first");
    if (!BEFORE && !SKEW) { await page.getByText(lang === "en" ? "Waiting in the queue… Retry 2 of 8." : "正在排隊…第 2 次重試，共 8 次。", { exact: true }).waitFor({ timeout: 10000 }); await shot("queue-second"); }
    check(`${tag}:no-page-errors`, !errors.length, errors); await ctx.close();
  }
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rig?.close(); rmSync(keys, { recursive: true, force: true });
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify({ ...receipt, checks, images, cleanup: "owned browser/listener/rig/keys closed in finally" }, null, 2) + "\n");
}
check("pictures-produced", images.length > 0); console.log(JSON.stringify({ source: receipt.source, phase: receipt.phase, skew: !!SKEW, checks: checks.length, images: images.length }));
