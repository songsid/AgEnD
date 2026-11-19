/** Owned real-web fixture only; no Fleet/CLI starts, accounts or external services. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
if (process.platform !== "linux" || !process.env.CHROME?.includes("chrome-linux")) throw Error("Use a Linux Chromium binary in WSL");
const pw = createRequire(process.env.PW_DIR + "/")("playwright-core");
const launch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = (options: object) => launch({ ...options, headless: true });
const out = process.env.OUT ?? join(process.cwd(), ".artifacts", "captures"); mkdirSync(out, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.PORT ?? 24861), host: true, classic: false, roster: [
  { name: "general", backend: "claude-code", general: true, displayName: "General" },
  { name: "worker", backend: "codex", displayName: "Build helper", description: "Synthetic demonstration agent" },
] });
const result: Record<string, unknown> = {};
try {
  fx.fm.scheduleDeliveryOutboxPump = () => {};
  fx.fm.ensureDeliveryOutbox();
  const store = fx.fm.deliveryOutbox.contactAuthorizations;
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW")) {
    store.inheritOrigin("worker", { kind: "unknown", people: [{ platform: "discord", adapterId: "demo", userId: "fake-member", label: "Room member" }],
      receiptIds: ["fake-receipt"], chain: ["room", "worker"] });
    const { page, ctx, csp } = await fx.page(c, { host: true, path: "/ui/fleet/agent/worker?cat=permissions" });
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
    try {
      const origin = page.locator(".contact-origin"); await origin.waitFor();
      await origin.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(out, `${caseName(c)}-before.png`) });
      await page.locator(".contact-origin-clear").click();
      const dialog = page.locator("dialog[open]"); await dialog.waitFor();
      assert.match(await dialog.innerText(), c.lang === "en" ? /Earlier text is not erased/ : /先前文字不會刪除/);
      await page.screenshot({ path: join(out, `${caseName(c)}-confirm.png`) });
      await dialog.locator('[data-confirm="yes"]').click();
      await page.waitForFunction(() => document.querySelector(".contact-origin-people")?.textContent?.includes("operator"));
      await origin.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(out, `${caseName(c)}-after.png`) });
      assert.equal(store.origin("worker").kind, "human");
      assert.equal(store.origin("worker").people[0].userId, "operator");
      assert.match(await page.locator(".contact-origin-last").innerText(), /Operator/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false); assert.deepEqual(await csp(), []); assert.deepEqual(errors, []);
      result[caseName(c)] = { cleared: true, audit: true, overflow: false, pageErrors: errors, csp: await csp() };
    } finally { await ctx.close(); }
  }
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
} finally {
  clearInterval(fx.fm.replyObligationTimer);
  fx.fm.deliveryOutbox?.close();
  await fx.close();
}
