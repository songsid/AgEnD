/** S-118 on the merged code-only core: real Chrome -> owned HTTP listener -> real FleetManager/POST handler.
 * Synthetic Telegram configuration and authenticator stores only; no adapter/fleet/CLI starts.
 * The gateway leg binds the production request context on a second owned listener; it is NOT a tunnel test.
 */
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { bootFixture, caseName, matrix, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";
const REPO = process.env.REPO!, OUT = process.env.OUT!;
const { base32Encode, base32Decode, hotp, totpStep, adminKey, WEB_REMOTE_ACCESS_FILE } = await import(REPO + "/src/web-remote-access.ts");
const checks: Record<string, unknown> = {}, images: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { checks[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) throw Error(name); };
const fx = await bootFixture({ port: 47980, instances: 2, classic: false, host: true });
const { handleAuthRequest } = await import(REPO + "/src/auth-api.ts");
const { bindGatewayRequest } = await import(REPO + "/src/web-request-context.ts");
const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
const fm = fx.fm as any;
const keys = [adminKey("s118", "100"), adminKey("s118", "200")];
let clock = Date.now(); // Fixed input for searching each real current-step collision; server/browser clocks remain real.
const code = (secret: string, offset = 0) => hotp(base32Decode(secret)!, totpStep(clock) + offset);
const secretOf = (i: number) => base32Encode(Buffer.from(`s118-collide-${i}`.padEnd(20, "#").slice(0, 20)));
function collision(): [string, string] {
  const seen = new Map<string, string>();
  for (let i = 0; i < 20000; i++) {
    const secret = secretOf(i), value = code(secret), other = seen.get(value);
    if (other && other !== secret && code(other, 1) !== code(secret, 1)) return [other, secret];
    seen.set(value, secret);
  }
  throw Error("no synthetic HMAC collision found");
}
const secrets = collision(), notices: string[] = [];
fm.notifyFleetError = (text: string) => { notices.push(text); return true; };
fm.fleetConfig.channels = [{ id: "s118", type: "telegram", mode: "topic", group_id: "-100118", access: { mode: "locked", allowed_users: ["100", "200"] } }];
fm.fleetConfig.web.verified_authority = { enabled: true };
// Display the connected-chat recovery copy without connecting to a platform.
fm.adapterState.set("s118", { status: "connected" });
function reset() {
  fm.webRemoteAccessState?.close();
  const rec = (secret: string) => ({ secret, enrolledAt: 1, lastStep: 0 });
  writeFileSync(join(fx.dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, admins: Object.fromEntries(keys.map((k, i) => [k, rec(secrets[i]!)])), outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  fm.webRemoteAccessState = null;
  fm.fleetConfig.channels[0].access.allowed_users = ["100", "200"];
  fm.fleetConfig.web.verified_authority = { enabled: true };
  notices.length = 0;
}
const saved = () => JSON.parse(readFileSync(join(fx.dir, WEB_REMOTE_ACCESS_FILE), "utf8"));
const sessionCount = () => fm.webSessions.list(undefined, () => true).length;
const wrong = () => { for (let i = 0; i < 100; i++) { const v = String(i).padStart(6, "0"); if (!secrets.some(s => [-2, -1, 0, 1, 2].some(o => code(s, o) === v))) return v; } throw Error("no wrong code"); };
async function screenshot(page: any, name: string) {
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((_, reject) => setTimeout(() => reject(Error("font readiness timeout")), 5000))]));
  const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, account: !!document.querySelector("#account"),
    button: document.querySelector("#go")!.getBoundingClientRect().height, input: document.querySelector("#code")!.getBoundingClientRect().height,
    text: [document.querySelector("#msg")!.textContent, document.querySelector("#authHint")!.textContent] }));
  check(`${name}:geometry`, !geometry.account && geometry.scroll <= geometry.width && geometry.button >= 44 && geometry.input >= 44);
  const path = shotPath("signin-s118-chat", name, "view"); await page.screenshot({ path, fullPage: true }); images.push(path);
  return geometry.text;
}
// A separate, owned HTTP ingress binds the same trusted metadata as the gateway, never a request header.
const gatewayOrigin = "http://127.0.0.1:47982";
let gatewayCurrent = true;
const gateway = createServer((req, res) => {
  bindGatewayRequest(req, { surface: "gateway", exposureId: "s118-owned", expectedOrigin: gatewayOrigin, isCurrent: () => gatewayCurrent });
  if (!handleAuthRequest(req, res, new URL(req.url!, gatewayOrigin), fm)) { res.writeHead(404); res.end(); }
});
try {
  await new Promise<void>((resolve, reject) => { gateway.once("error", reject); gateway.listen(47982, "127.0.0.1", resolve); });
  fm.publicWebLink = { openSignin: () => ({ exposureId: "s118-owned", url: gatewayOrigin + "/signin" }), whenClosed: async () => {}, close: async () => {}, endOf: () => null };
  check("fixture-is-chat-not-web-only", fm.isWebOnlyFleet() === false && fm.adminGate("100", "s118") === "ok" && fm.adminGate("200", "s118") === "ok");
  check("two-distinct-secrets-really-match", secrets[0] !== secrets[1] && code(secrets[0]!) === code(secrets[1]!));
  for (const c of matrix()) {
    const cn = caseName(c); reset(); console.log("chat case", cn);
    const ctx = await fx.browser.newContext({ viewport: VIEWPORTS[c.device], colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", isMobile: c.device === "phone", hasTouch: c.device === "phone" });
    ctx.setDefaultTimeout(10000);
    const page = await ctx.newPage(), errors: string[] = [];
    await ctx.addInitScript({ content: `localStorage.setItem('agend_lang',${JSON.stringify(c.lang)}); window.__name=v=>v; window.__csp=[]; document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));` });
    page.on("pageerror", (e: any) => { errors.push(String(e)); console.log("page error", String(e)); });
    page.on("response", (r: any) => { if (r.url().endsWith("/auth/totp")) console.log("totp response", r.status()); });
    const posts: any[] = [];
    page.on("request", (r: any) => { if (r.method() === "POST" && r.url().endsWith("/auth/totp")) posts.push(r.postDataJSON()); });
    await page.goto(fx.base + "/signin/authenticator"); await page.waitForSelector("#form:not([hidden])");
    const before = sessionCount();
    let response = page.waitForResponse((r: any) => r.url().endsWith("/auth/totp") && r.request().method() === "POST");
    await page.fill("#code", wrong()); const ordinary = await response;
    await page.waitForFunction(() => !!document.querySelector("#authHint")?.textContent, null, { timeout: 10000 }).catch(async e => { console.log("form error", await page.locator("#msg").textContent()); throw e; });
    const ordinaryText = await screenshot(page, `${cn}-chat-wrong`);
    reset();
    response = page.waitForResponse((r: any) => r.url().endsWith("/auth/totp") && r.request().method() === "POST");
    await page.fill("#code", code(secrets[0]!)); const collided = await response;
    await page.waitForFunction(() => !!document.querySelector("#authHint")?.textContent, null, { timeout: 10000 }).catch(async e => { console.log("form error", await page.locator("#msg").textContent()); throw e; });
    const collisionText = await screenshot(page, `${cn}-chat-collision`), state = saved();
    check(`${cn}:collision-is-ordinary-401`, ordinary.status() === 401 && collided.status() === 401 && JSON.stringify(collisionText) === JSON.stringify(ordinaryText));
    check(`${cn}:collision-no-session-step-or-notice`, sessionCount() === before && keys.every(k => state.admins[k].lastStep === 0) && state.signin.wrong === 1 && notices.length === 0);
    check(`${cn}:no-special-wait-or-retry-loop`, await page.locator("#go").isEnabled());
    // The next-step code is inside the core's accepted skew window and uniquely signs in as its own admin.

    response = page.waitForResponse((r: any) => r.url().endsWith("/auth/totp") && r.request().method() === "POST");
    await page.fill("#code", code(secrets[0]!, 1)); const accepted = await response;
    await page.waitForURL(/\/ui$/, { timeout: 10000 });
    const cookies = await ctx.cookies(fx.base); let own = false;
    for (const cookie of cookies) { const rec = fm.webSessions.authenticate(cookie.value, tokenEpoch(fm.webToken), { touch: false, surface: "local" }); if (rec?.owner?.adapterId === "s118" && rec.owner.userId === "100") own = true; }
    check(`${cn}:next-code-correct-admin-session`, accepted.status() === 200 && own && (await page.request.get(fx.base + "/auth/session")).status() === 200 && notices.length === 1);
    check(`${cn}:only-code-sent`, posts.length === 3 && posts.every(p => Object.keys(p).join() === "code"));
    check(`${cn}:no-script-or-csp-error`, errors.length === 0 && (await page.evaluate(() => (window as any).__csp)).length === 0);
    await ctx.close();
    // Find another actual collision for the new time step before the next matrix case.
    clock = Date.now(); secrets.splice(0, 2, ...collision());
  }
  // HTTP body equality is checked through the same owned production listener, separately from Chrome's visible status/copy.
  reset();
  const directPost = (value: string) => fetch(fx.base + "/auth/totp", { method: "POST", headers: { Origin: fx.base, "Content-Type": "application/json" }, body: JSON.stringify({ code: value }) });
  const wrongHttp = await directPost(wrong()), wrongBody = await wrongHttp.json(); reset();
  const collisionHttp = await directPost(code(secrets[0]!)), collisionBody = await collisionHttp.json();
  check("real-http-collision-body-equals-wrong", wrongHttp.status === 401 && collisionHttp.status === 401 && JSON.stringify(wrongBody) === JSON.stringify({ error: "wrong_code" }) && JSON.stringify(collisionBody) === JSON.stringify(wrongBody));
  const post = async (value: string, extra: Record<string, string> = {}) => fetch(gatewayOrigin + "/auth/totp", { method: "POST", headers: { Origin: gatewayOrigin, "Content-Type": "application/json", ...extra }, body: JSON.stringify({ code: value }) });
  clock = Date.now(); secrets.splice(0, 2, ...collision()); reset();
  const publicOk = await post(code(secrets[0]!, 1));
  check("gateway-bound-real-route-chat-200", publicOk.status === 200);
  reset(); fm.fleetConfig.web.verified_authority = { enabled: true, loopback_only: true };
  check("gateway-loopback-only-404", (await post(code(secrets[0]!))).status === 404);
  reset(); gatewayCurrent = false;
  const retiredCount = sessionCount();
  check("gateway-retired-403-before-body", (await post(code(secrets[0]!))).status === 403 && sessionCount() === retiredCount && !saved().signin); gatewayCurrent = true;
  reset(); fm.fleetConfig.channels[0].access.allowed_users = ["200"];
  check("demoted-owner-refused", (await post(code(secrets[0]!, 1))).status === 401);
  reset();
  const csrf = await post(code(secrets[0]!), { Origin: "https://other.example.test" });
  check("cross-origin-refused", csrf.status === 403);
  // Browser-local limit, through the real chat handler; actual Chrome already proved its presentation in the full UI matrix.
  const ctx = await fx.browser.newContext(), page = await ctx.newPage();
  await page.goto(fx.base + "/signin"); await page.waitForSelector("#form:not([hidden])");
  for (let i = 0; i < 5; i++) {
    const response = page.waitForResponse((r: any) => r.url().endsWith("/auth/totp") && r.request().method() === "POST");
    if (i === 0) await page.fill("#code", wrong()); else await page.click("#go");
    const r = await response;
    if (i === 4) check("chat-browser-429-with-wait", r.status() === 429 && Number(r.headers()["retry-after"]) > 0);
    await page.waitForTimeout(60);
  }
  await page.waitForFunction(() => (document.querySelector("#go") as HTMLButtonElement).disabled);
  await screenshot(page, "chat-en-browser-paused"); await ctx.close();
} finally {
  await new Promise<void>(resolve => { gateway.closeAllConnections(); gateway.close(() => resolve()); });
  const files = ["src/auth-api.ts", "src/fleet-manager.ts", "src/web-remote-access.ts", "src/ui/signin.html", "src/ui/shared/signin.js", "scripts/manual/smoke/smoke-signin-chat-s118.mts"];
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "chat-result.json"), JSON.stringify({ chrome: fx.browser.version(), checks, images, scope: "Real Chrome and production HTTP/core with synthetic chat admins and searched HMAC collisions; real clocks and current-step collision search; gateway context injected on owned ingress, no tunnel or platform adapter. No real accounts/CLI/fleet start.", sourceFiles: files, sourceManifest: "CHAT_PRODUCTION_SHA256SUMS" }, null, 2));
  writeFileSync(join(OUT, "CHAT_PRODUCTION_SHA256SUMS"), files.map(p => createHash("sha256").update(readFileSync(join(REPO, p))).digest("hex") + "  " + p).join("\n") + "\n");
  await fx.close();
}
console.log(JSON.stringify({ checks: Object.keys(checks).length, images: images.length }));
