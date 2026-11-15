/** Actual Fleet UI, with display DTOs from the owned TLS/WSS integration; no updater or agent launch. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { bootFixture, caseName, matrix } from "../smoke-fixture/index.mts";

const out = process.env.OUT!, repo = process.env.REPO!;
if (!out || !repo || !process.env.M3172_DATA) throw Error("OUT, REPO and M3172_DATA are required");
mkdirSync(out, { recursive: true });
const data = JSON.parse(readFileSync(process.env.M3172_DATA, "utf8"));
const { WebNotices } = await import(repo + "/src/web-notices.ts");
const fx = await bootFixture({ port: Number(process.env.HP ?? 48642), instances: 4, classic: false, host: true });
const fm = fx.fm as any, checks: Record<string, boolean> = {}, served = new Map<string, string>();
fm.runningAgendVersion = () => "2.4.0-beta.3";
fm.launchInstalledUpdate = async () => { throw Error("No update may launch in the name capture"); };
fm.updateCheckState = { offer: null, checkedAt: Date.now(), failed: false };
fm.rawFleetConfig = { ...fm.rawFleetConfig, hub_member: { enabled: true } }; // Read-only fixture projection; no Hub runtime is mounted.
let writes = 0;
try {
  for (const phase of ["baseline", "candidate"]) for (const c of matrix()) {
    const value = data[phase], prefix = `${phase}-${caseName(c)}`;
    fm.hubMemberPairingApi = { view: () => ({ ...value.pairing, link: "online" }), boundHub: () => ({ hubId: value.pairing.hub.hubId, binding: value.pairing.binding }), notices: () => [] };
    fm.hubUpdates = { consent: () => ({ on: false, available: true }), setConsent: () => { writes++; throw Error("Consent must remain untouched"); }, view: () => ({ id: value.notice.requestId, version: value.notice.version, state: "waiting" }) };
    fm.hubRecommendationRead = () => value.advice;
    fm.webNotices = new WebNotices(join(fx.dir, prefix + "-notices.json"), fm.logger);
    fm.recordHubUpdateNotice(value.notice);
    const errors: string[] = [];
    const { ctx, page, csp } = await fx.page(c, { path: "/settings/hub", host: true });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("response", async (response: any) => {
      const path = new URL(response.url()).pathname;
      if (!/\.(js|css)$/.test(path)) return;
      try { served.set(path, createHash("sha256").update(await response.body()).digest("hex")); } catch { /* a navigation may retire an unused read */ }
    });
    try {
      await page.waitForSelector(".hub-update-consent", { timeout: 15_000 });
      const expected = value.pairing.hub.name || value.pairing.hub.memberOrigin;
      checks[prefix + ":consent"] = (await page.locator(".hub-update-consent").innerText()).includes(expected);
      await page.locator(".hub-update-consent").scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(out, prefix + "-consent.png") });
      await page.locator("#hubUpdateConsent").click();
      await page.waitForSelector("dialog[open]", { timeout: 5_000 });
      checks[prefix + ":confirm"] = (await page.locator("dialog[open]").innerText()).includes(expected);
      await page.screenshot({ path: join(out, prefix + "-confirm.png") });
      await page.locator("[data-confirm=no]").click();
      await page.goto(fx.base + "/ui/notices");
      await page.waitForSelector(".p-notices .n-item.notice", { timeout: 15_000 });
      await page.waitForSelector(".update-line", { timeout: 10_000 });
      checks[prefix + ":notice"] = (await page.locator(".p-notices").innerText()).includes(value.notice.hubName);
      checks[prefix + ":banner"] = (await page.locator(".update-line").innerText()).includes(value.advice.hubName);
      await page.screenshot({ path: join(out, prefix + "-notice-banner.png") });
      checks[prefix + ":errors"] = errors.length === 0 && (await csp()).length === 0;
    } catch (error) {
      writeFileSync(join(out, prefix + "-failure.txt"), await page.locator("body").innerText());
      await page.screenshot({ path: join(out, prefix + "-failure.png") }); throw error;
    } finally { await ctx.close(); }
  }
  checks["consent-writes"] = writes === 0;
} finally { await fx.close(); }
const receipt = { checks, servedAssets: [...served].map(([path, sha256]) => ({ path, sha256 })) };
writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
console.log(JSON.stringify({ checks: Object.keys(checks).length, failed }));
if (failed.length) process.exitCode = 1;
