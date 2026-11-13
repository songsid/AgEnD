// Two Hub UI gaps Lumen found while writing the hub skill (#3773), in a real Chrome. Run with REPO at the change (AFTER=1,
// judged) and at its base (pictures only).
//   1. Fleet Settings → Hub, an uncertain held company join: the message and the card's buttons. The shared fixture
//      (in-process FleetManager, scratch home, loopback; no Hub contacted); the company-join read is routed to answer one
//      held attempt whose result is unknown, as a lost redeem reply leaves it.
//   2. The Hub's Administration page, the Let colleagues join card: a way to the full group-permissions editor. A REAL Hub
//      web listener (the s3b rig behind node:https, scratch DB, fake directory); the session's features and the
//      company-join / group-policy reads are routed so the card draws as on a Hub with both on.
//   PW_DIR=… REPO=<checkout> OUT=<dir> [AFTER=1] [MATRIX=…] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-ui-gaps.mts
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = join(process.env.OUT!, "hub-ui-gaps"), PW = process.env.PW_DIR!, AFTER = process.env.AFTER === "1";
mkdirSync(OUT, { recursive: true });
const r: Record<string, unknown> = {}, fail: string[] = [];
const CASES = (process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW").split(",").map((s) => {
  const [device, theme, ...lang] = s.split("-"); return { device: device as "desk" | "phone", theme: theme as "light" | "dark", lang: lang.join("-") as "en" | "zh-TW" };
});
const tagOf = (c: (typeof CASES)[number]) => `${c.device}-${c.theme}-${c.lang}`;

// ── 1. the Fleet's uncertain held attempt ──
{
  const { bootFixture } = await import(REPO + "/scripts/manual/smoke-fixture/index.mts");
  const fx: any = await bootFixture({ port: Number(process.env.HP ?? 54970), instances: 1, classic: false });
  for (const name of ["startInstance", "startInstanceUnattended", "restartInstance", "restartFleet", "stopInstance"]) fx.fm[name] = async () => { throw Error("Refused lifecycle " + name); };
  const held = { operationId: "6e2c1a0b-9e8f-4a7b-8c6d-5e4f3a2b1c0d", handoffId: null, state: "held", reason: "uncertain", hubOrigin: "https://synthetic-hub.example.test",
    expiresAt: Date.now() + 300000, issued: false, outcomeKnown: false, fleetId: null, waiting: null };
  try {
    for (const c of CASES) {
      const tag = tagOf(c), en = c.lang === "en";
      const { ctx, page } = await fx.page(c, { path: "/settings/hub" });
      await ctx.route("**/*", (route: any) => { const u = new URL(route.request().url()); if (u.origin !== fx.base) return route.abort();
        if (u.pathname === "/api/hub/member/company-join" && route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, bound: false, operation: held, display: null }) });
        return route.continue(); });
      await page.reload();
      await page.waitForSelector(".s-company-join [role=status] .btn", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(600);
      const facts = await page.evaluate(`(() => { const card = [...document.querySelectorAll(".s-company-join [role=status]")].pop();
        return { text: card ? card.innerText.replace(/\\s+/g, " ").trim() : "", buttons: card ? [...card.querySelectorAll("button, a.btn")].map((b) => b.textContent.trim()) : [] }; })()`);
      const card = page.locator(".s-company-join").first();
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await card.screenshot({ path: join(OUT, `${tag}-1-uncertain-held.png`) }).catch(() => page.screenshot({ path: join(OUT, `${tag}-1-uncertain-held.png`) }));
      r[`${tag}-1`] = facts;
      if (AFTER) {
        const label = en ? "Check again" : "再次檢查";
        const ok = facts.text.includes(en ? "Choose Check again" : "請按「再次檢查」") && facts.buttons.includes(label) && !/Check this connection|檢查這次連接/.test(facts.text);
        if (!ok) fail.push(`${tag}-1: ${JSON.stringify(facts)}`);
      }
      await ctx.close();
    }
  } catch (e) { fail.push("fleet " + String((e as Error).stack ?? e).slice(0, 800)); }
  finally { await fx.close(); }
}

// ── 2. the Hub's Administration card ──
{
  const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
  const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
  const port = 49200 + Math.floor(Math.random() * 90), origin = `https://127.0.0.1:${port}`;
  const rig = await s3bRig({ webOrigin: origin });
  const keys = mkdtempSync(join(OUT, "keys-")); chmodSync(keys, 0o700);
  await provisionHubIdentity({ home: keys, memberOrigin: origin });
  const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
    (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end("not found"); } });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const pw = createRequire(PW + "/")("playwright-core");
  const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
  const VIEW = { desk: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } } as const;
  try {
    await rig.signIn("admin");
    for (const c of CASES) {
      const tag = tagOf(c), en = c.lang === "en";
      const ctx = await browser.newContext({ viewport: VIEW[c.device], colorScheme: c.theme, locale: en ? "en-US" : "zh-TW", ignoreHTTPSErrors: true,
        isMobile: c.device === "phone", hasTouch: c.device === "phone", deviceScaleFactor: 2 });
      await ctx.addInitScript({ content: `try { localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); localStorage.setItem("agend_tour_done", "1"); } catch {}` });
      const page = await ctx.newPage(); const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
      await page.route((u: URL) => u.pathname === "/hub/v1/session", async (route: any) => {
        const res = await route.fetch(); const body = await res.json().catch(() => ({}));
        if (body && body.signedIn) body.features = [...new Set([...(body.features || []), "company-join-v1", "group-policy-v1"])];
        return route.fulfill({ response: res, json: body });
      });
      await page.route((u: URL) => u.pathname === "/hub/v1/admin/company-join", (route: any) => route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, enabled: true, revision: 4, companyLink: origin + "/join-info#hub=ZXhhY3Q" }) }));
      await page.route((u: URL) => u.pathname === "/hub/v1/admin/group-policy", (route: any) => route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, groupPolicyV1: true, supported: true, binding: "ready", policy: { realm: "example", generation: "g1", revision: 3, state: "enabled", groups: [], denies: [] }, paused: [] }) }) : route.continue());
      await page.goto(origin + "/ui/hub/admin");
      await page.waitForSelector("#hubLogin", { timeout: 10000 }); await page.fill("#hubLogin", "admin"); await page.fill("#hubPassword", "pw-admin");
      await page.click(".hub-signin button[type=submit]");
      await page.waitForSelector(".hub-join-card", { timeout: 15000 }); await page.waitForTimeout(800);
      const facts = await page.evaluate(`(() => { const a = document.querySelector('.hub-join-card .hub-join-groups-link a');
        return { link: a ? { text: a.textContent.trim(), href: a.getAttribute("href"), visible: !!(a.offsetWidth || a.offsetHeight) } : null }; })()`);
      const step2 = page.locator('.hub-join-card li[data-step="2"]');
      await step2.scrollIntoViewIfNeeded().catch(() => {});
      await page.locator(".hub-join-card").screenshot({ path: join(OUT, `${tag}-2-join-card.png`) });
      let opened = false;
      if (facts.link) { await page.click(".hub-join-card .hub-join-groups-link a"); await page.waitForTimeout(800); opened = (await page.evaluate("location.pathname + location.search")) === "/ui/hub/admin?view=groups";
        await page.screenshot({ path: join(OUT, `${tag}-3-editor.png`) }); }
      r[`${tag}-2`] = { ...facts, opened, errs };
      if (AFTER && !(facts.link && facts.link.visible && facts.link.text === (en ? "All group permissions" : "所有群組權限") && opened && errs.length === 0)) fail.push(`${tag}-2: ${JSON.stringify({ facts, opened, errs })}`);
      await ctx.close();
    }
  } catch (e) { fail.push("hub " + String((e as Error).stack ?? e).slice(0, 800)); }
  finally { await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rig.close(); rmSync(keys, { recursive: true, force: true }); }
}

writeFileSync(join(OUT, "result.json"), JSON.stringify({ r, fail }, null, 1));
console.log(JSON.stringify(r, null, 1));
console.log(fail.length ? `FAIL\n${fail.join("\n")}` : AFTER ? "ALL PASS" : "captured (before: not judged)");
process.exit(fail.length ? 1 : 0);
