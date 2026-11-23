/**
 * M-3543: the Fleet's Settings → Hub list with a lapsed shared agent ("…changed since you shared it" and Share again) on the
 * real dashboard over the smoke fixture. The member's two reads (pairing, exposures) are answered with fixture data shaped
 * as the member API returns them; nothing else is stubbed. No CLI, tmux, Hub or account.
 *
 *   PW_DIR=<dir with node_modules/playwright-core> OUT=<dir> [MATRIX=…] npx tsx scripts/manual/hub-share-lapse-m3543/fleet-settings.mts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: 0, instances: 4, classic: false });
try {
  fx.fm.fleetConfig.hub_member = { ...(fx.fm.fleetConfig.hub_member ?? {}), enabled: true };
  const pairing = { state: "paired", binding: "fixture-binding", link: "online",
    hub: { hubId: "11111111-2222-4333-8444-555555555555", name: "Example Hub", webOrigin: "https://hub.example.test", memberOrigin: "https://hub.example.test:8443", fingerprint: { digest: "ab".repeat(32) } } };
  const row = (agent: string, display: string, extra: Record<string, unknown>) => ({ agent, display, exposureId: "aaaaaaaa-1111-4222-8333-44444444444" + agent.length,
    revision: 1, state: "published", contactLimit: true, contactLimitNotice: false, policy: { dataView: "agent", tools: [] }, choices: { dataViews: [{ id: "agent", label: display }], tools: [] }, pending: null, ...extra });
  const exposures = [row("mira", "Mira", { enforceable: true, reason: "share_lapsed" }), row("notes", "Notes", { enforceable: true })];
  mkdirSync(join(process.env.OUT ?? "/tmp/smoke-out", "hub-share-lapse-m3543"), { recursive: true });
  for (const c of matrix()) {
    const { ctx, page } = await fx.page(c, { path: "/settings/hub" });
    try {
      await ctx.route("**/api/settings/hub/membership**", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, connectionCardV1: true, pairing }) }));
      await ctx.route("**/api/hub/member/pairing**", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pairing }) }));
      await ctx.route("**/api/hub/member/exposures", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ exposures }) }));
      await page.reload();
      await page.locator(".hub-exposure-list").waitFor({ timeout: 15000 });
      await page.locator(".hub-exposure-republish").scrollIntoViewIfNeeded(); await page.waitForTimeout(400);
      await page.screenshot({ path: shotPath("hub-share-lapse-m3543", c, "fleet-settings") });
      console.log(caseName(c), JSON.stringify(await page.locator(".hub-exposure-republish").innerText()));
    } finally { await ctx.close(); }
  }
} finally { await fx.close(); }
