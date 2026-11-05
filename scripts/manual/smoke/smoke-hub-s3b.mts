// AgEnD Hub P1 S3b (S-52): the Hub workspace in a real browser, on a REAL Hub web listener: createHubHttp's handle()
// behind node:https on 127.0.0.1 (a throwaway self-signed key from S1's provisionHubIdentity, under OUT). S5's DB, audit
// and content are the agreed fakes (tests/helpers/hub-s3b-rig.ts); the directory is a fake (three people). No fleet runs.
// The member side is driven in-process through S3's own receive() (as S1's HubServer would), so a question is sent,
// leased and answered.
// - Hub-only boot: the page asks the Hub for nothing but /hub/v1/*, /assets/*, its own three /ui/js modules and its
//   pages — no fleet endpoint (/auth, /api, /ui/prefs, /ui/themes, /ui/notices, the stream) — and no CSP report or page error.
// - sign-in (a refusal, then in), Ask (granted agent → room → question → its stage → the answer after one paced poll),
//   My exposures (grants, a pairing to confirm), Administration (only for the administrator: a code, approval, fleets).
// - the stale-tab skew (rule 3): the old shell (every long-lived /assets file from OLD_REF) with this branch's lazy Hub
//   modules: the Hub page still signs in and lists what is granted.
// Desk/en and phone/zh-TW, dark; screenshots under OUT/hub-s3b.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [OLD_REF=origin/release/2.3.5-alpha] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-s3b.mts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = process.env.OUT!, PW = process.env.PW_DIR!;
const OLD_REF = process.env.OLD_REF ?? "origin/release/2.3.5-alpha";
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const r: Record<string, unknown> = { oldRef: OLD_REF };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const shot = (name: string) => { const d = join(OUT, "hub-s3b"); mkdirSync(d, { recursive: true }); return join(d, `${name}.png`); };
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };

// The rig gives the services, configured for this HTTPS origin; this smoke puts the SAME handle() behind node:https.
const port = 48700 + Math.floor(Math.random() * 200), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin });
const http = rig.http;
mkdirSync(OUT, { recursive: true });
const keys = mkdtempSync(join(OUT, "hub-s3b-keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!http.handle(req, res)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); } });
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

// The world: olivia's fleet publishes "Sales numbers"; alex is granted; admin administers.
const olivia = rig.addPerson("olivia", "Olivia Chen"), alex = rig.addPerson("alex", "Alex Lin");
const fleetId = randomUUID(), link = rig.link(fleetId, olivia), exposureId = randomUUID();
await http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId, owner: olivia, displayName: "Sales numbers", revision: 1,
  state: "published", dataViewId: "sales-q3", allowedTools: ["read_sheet"], policyDigest: "b".repeat(64) }] }, link) as never, link);
void alex;

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const CASES = [{ device: "desk", lang: "en", viewport: { width: 1280, height: 860 } }, { device: "phone", lang: "zh-TW", viewport: { width: 390, height: 844 } }] as const;
const ALLOWED = /^\/(hub\/v1\/|assets\/|ui\/js\/(panel-hub|hub-client|hub-strings)\.js|ui\/hub|favicon)/;

async function open(c: (typeof CASES)[number], path: string, route?: (page: any) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: c.viewport, colorScheme: "dark", locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", ignoreHTTPSErrors: true,
    isMobile: c.device === "phone", hasTouch: c.device === "phone", deviceScaleFactor: 1 });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); localStorage.setItem("agend_tour_done", "1"); } catch {}
    window.__csp = []; document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || "")));` });
  const page = await ctx.newPage();
  const errs: string[] = [], foreign: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  page.on("request", (q: any) => { const u = new URL(q.url()); if (u.origin === origin && !ALLOWED.test(u.pathname)) foreign.push(u.pathname); });
  if (route) await route(page);
  await page.goto(origin + path); await page.waitForTimeout(1200);
  return { ctx, page, errs, foreign, csp: () => page.evaluate("window.__csp || []") as Promise<string[]> };
}
async function signIn(page: any, login: string, password = `pw-${login}`) {
  await page.waitForSelector("#hubLogin", { timeout: 10000 });
  await page.fill("#hubLogin", login); await page.fill("#hubPassword", password);
  await page.click(".hub-signin button[type=submit]");
}
const drawer = async (o: any, c: (typeof CASES)[number]) => { if (c.device === "phone") { await o.page.evaluate(`import("/assets/app-shell.js").then((m) => m.openDrawer())`); await o.page.waitForTimeout(500); } };

try {
  // The administrator's grant precondition: olivia and alex have signed in once (the Hub knows them).
  for (const login of ["olivia", "alex"]) await rig.signIn(login);
  const o0 = await rig.signIn("olivia");
  await rig.call(o0, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "alex", days: 7 });

  for (const c of CASES) {
    const tag = `${c.device}-${c.lang}`;
    // ── sign-in, then Ask ──
    const a = await open(c, "/ui/hub");
    await signIn(a.page, "alex", "wrong");
    await a.page.waitForSelector(".hub-signin .err"); await a.page.screenshot({ path: shot(`${tag}-1-signin-refused`) });
    const refused = await a.page.evaluate(`document.querySelector(".hub-signin .err").textContent`);
    await signIn(a.page, "alex");
    await a.page.waitForSelector(".hub-ask .hub-item", { timeout: 10000 });
    await a.page.screenshot({ path: shot(`${tag}-2-ask`) });
    await a.page.click(".hub-ask .hub-item button");
    await a.page.waitForSelector("#hubQuestion");
    const question = c.lang === "en" ? "What were Q3 sales?" : "第三季營收是多少？";
    await a.page.fill("#hubQuestion", question); await a.page.click(".hub-compose button[type=submit]");
    await a.page.waitForSelector(".hub-stage");
    const waiting = await a.page.evaluate(`document.querySelector(".hub-stage").textContent`);
    await a.page.screenshot({ path: shot(`${tag}-3-asked`) });
    // The member (on a current link, so the Hub sent the question at once): a release lease, then the answer.
    const sentQ = () => rig.sent.map((x: any) => x.frame).find((f: any) => f.type === "question" && f.payload.text === question);
    for (let i = 0; i < 50 && !sentQ(); i++) await new Promise((res) => setTimeout(res, 50));
    const q = sentQ() as any;
    const messageId = q?.payload?.identity?.messageId, answer = c.lang === "en" ? "Q3 sales were 42 million." : "第三季營收是 4,200 萬。", answerId = randomUUID();
    const lease = await http.receive(rig.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest: sha(answer) } }, link) as never, link) as any;
    await http.receive(rig.frame("answer", { messageId, answerId, text: answer, contentDigest: sha(answer), releaseLease: lease.payload.lease }, link) as never, link);
    // One paced poll (10 s): the room's history (an earlier case's turn too) gains this answer.
    // (Polled from here: a string waitForFunction is an eval the page's CSP refuses.)
    for (let i = 0; i < 60; i++) {
      if (await a.page.evaluate(`[...document.querySelectorAll(".hub-a")].some((x) => x.textContent === ${JSON.stringify(answer)})`)) break;
      await a.page.waitForTimeout(250);
    }
    const shown = await a.page.evaluate(`[...document.querySelectorAll(".hub-a")].map((x) => x.textContent).pop() || null`);
    await a.page.screenshot({ path: shot(`${tag}-4-answered`) });
    await drawer(a, c); await a.page.screenshot({ path: shot(`${tag}-5-sidebar`) });
    const side = await a.page.evaluate(`({ brand: document.querySelector(".hub-brand")?.textContent, session: document.querySelector(".hub-session")?.textContent, tabs: !!document.querySelector("nav.tabs") })`);
    check(`${tag}-ask`, !!refused && q?.type === "question" && shown === answer && waiting.length > 0 && side.session?.includes("Alex") && !side.tabs
      && a.errs.length === 0 && a.foreign.length === 0 && (await a.csp()).length === 0, { refused, waiting, shown, side, errs: a.errs, foreign: a.foreign, csp: await a.csp() });
    await a.ctx.close();

    // ── My exposures (the owner): the grant, and a pairing request to confirm ──
    const ad0 = await rig.signIn("admin");
    const offer = await rig.call(ad0, "POST", "/hub/v1/admin/pairings", { login: "olivia" });
    const pending = rig.pairing.pair({ code: offer.json.code });
    const m = await open(c, "/ui/hub/exposures");
    await signIn(m.page, "olivia");
    await m.page.waitForSelector(".hub-exposure-card", { timeout: 10000 });
    await m.page.waitForSelector(".hub-pairings", { timeout: 10000 });
    await m.page.screenshot({ path: shot(`${tag}-6-exposures`), fullPage: true });
    const mine = await m.page.evaluate(`({ grants: [...document.querySelectorAll(".hub-exposure-card .hub-item strong")].map((x) => x.textContent), fps: [...document.querySelectorAll(".hub-pairings .hub-fp-groups")].map((x) => x.textContent) })`);
    check(`${tag}-exposures`, mine.grants.includes("Alex Lin") && mine.fps.every((f: string) => f.split(" ").length === 8)
      && mine.fps.some((f: string) => String(pending.fingerprint).startsWith(f.replace(/ /g, "")))
      && m.errs.length === 0 && m.foreign.length === 0 && (await m.csp()).length === 0, { mine, errs: m.errs, foreign: m.foreign });
    // Administration as the owner: not hers.
    await m.page.goto(origin + "/ui/hub/admin"); await m.page.waitForSelector(".hub-empty", { timeout: 10000 });
    const notAdmin = await m.page.evaluate(`document.querySelector(".hub-empty").textContent`);
    check(`${tag}-admin-refused`, notAdmin.length > 0, notAdmin);
    await m.ctx.close();

    // ── Administration (the administrator) ──
    const d = await open(c, "/ui/hub/admin");
    await signIn(d.page, "admin");
    await d.page.waitForSelector(".hub-admin", { timeout: 10000 });
    await d.page.fill(".hub-admin form input", "alex"); await d.page.click(".hub-admin form button[type=submit]");
    await d.page.waitForSelector(".hub-code");
    await d.page.screenshot({ path: shot(`${tag}-7-admin`), fullPage: true });
    const code = await d.page.evaluate(`document.querySelector(".hub-code").textContent`);
    check(`${tag}-admin`, /^[a-f0-9]{12}$/.test(code) && d.errs.length === 0 && d.foreign.length === 0 && (await d.csp()).length === 0, { code, errs: d.errs, foreign: d.foreign });
    await d.ctx.close();
  }

  // ── the stale-tab skew: the old shell with this branch's lazy Hub modules ──
  const oldShell = async (page: any) => {
    await page.route("**/assets/**", (route: any) => {
      const file = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
      if (file === "hub.css") return route.continue();
      const body = old(`shared/${file}`);
      return body === null ? route.continue() : route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
    });
  };
  {
    const s = await open(CASES[0], "/ui/hub", oldShell);
    await signIn(s.page, "alex");
    const ok = await s.page.waitForSelector(".hub-ask .hub-item", { timeout: 10000 }).then(() => true, () => false);
    await s.page.screenshot({ path: shot("skew-old-shell-new-lazy") });
    // The old shell still boots the fleet's stream and panels (it predates the Hub-only boot): those requests fail at
    // the Hub (404), recorded here as what an old tab does; the Hub page itself works.
    check("skew-old-shell-new-lazy", ok && s.errs.length === 0, { ok, errs: s.errs, foreignRequests: s.foreign.slice(0, 12) });
    await s.ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(join(OUT, "hub-s3b", "result.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rig.close();
  rmSync(keys, { recursive: true, force: true });
  process.exit(fail.length ? 1 : 0);
}
