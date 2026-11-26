/** M-3818 capture. Owned real-web fixture only (the M-3366 rig); no Fleet/CLI starts, accounts or external services. */
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
const fx = await bootFixture({ port: Number(process.env.PORT ?? 24871), host: true, classic: false, roster: [
  { name: "general", backend: "claude-code", general: true, displayName: "General" },
  { name: "worker", backend: "codex", displayName: "Build helper", description: "Synthetic demonstration agent" },
] });
const result: Record<string, unknown> = {};
try {
  fx.fm.scheduleDeliveryOutboxPump = () => {};
  fx.fm.ensureDeliveryOutbox();
  const store = fx.fm.deliveryOutbox.contactAuthorizations;
  store.inheritOrigin("worker", { kind: "mixed", people: [
    { platform: "discord", adapterId: "demo", userId: "fake-owner", label: "Owner" },
    { platform: "discord", adapterId: "demo", userId: "fake-member", label: "Room member" }], receiptIds: ["fake-receipt"], chain: ["demo-room", "worker"] });
  // The host sign-in is the host operator, who manages every local agent. The "viewer" case is someone who sees this
  // page without managing the agent (in the product, a room admin on a room's page): the real server's answer, with only
  // canManage/canClear turned off and two synthetic managing admins named, so the page shows what that viewer sees.
  const real = fx.fm.contactPermissions.bind(fx.fm);
  let viewer = false;
  fx.fm.contactPermissions = (name: string, actor: unknown) => {
    const p = real(name, actor);
    return viewer ? { ...p, canManage: false, originState: { ...p.originState, canClear: false },
      eligibleApprovers: [{ platform: "discord", adapterId: "demo", userId: "fake-admin-1", label: "Admin One" }, { platform: "discord", adapterId: "demo", userId: "fake-admin-2", label: "Admin Two" }] } : p;
  };
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW")) for (const who of ["manager", "viewer"] as const) {
    viewer = who === "viewer";
    const { page, ctx, csp } = await fx.page(c, { host: true, path: "/ui/fleet/agent/worker?cat=permissions" });
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
    try {
      const origin = page.locator(".contact-origin"); await origin.waitFor();
      await origin.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(out, `${caseName(c)}-${who}.png`) });
      const button = await page.locator(".contact-origin-clear").count(), note = await page.locator(".contact-origin-who").count();
      assert.equal(button, viewer ? 0 : 1); assert.equal(note, viewer ? 1 : 0);
      const text = viewer ? await page.locator(".contact-origin-who").innerText() : null;
      if (viewer) assert.equal(text, c.lang === "en" ? "Only this agent's managing admins (Admin One, Admin Two) or the verified host operator can clear it."
        : "只有管理這個 Agent 的管理員（Admin One、Admin Two）或已驗證的主機操作者能清除。");
      const receipts = await page.locator(".contact-origin .note", { hasText: c.lang === "en" ? "retained receipt" : "筆來源紀錄" }).innerText();
      assert.equal(receipts, c.lang === "en" ? "1 retained receipt" : "保留 1 筆來源紀錄");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false); assert.deepEqual(await csp(), []); assert.deepEqual(errors, []);
      result[`${caseName(c)}-${who}`] = { clearButton: button, whoNote: text, receipts, overflow, pageErrors: errors, csp: await csp() };
    } finally { await ctx.close(); }
  }
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
} finally {
  clearInterval(fx.fm.replyObligationTimer);
  fx.fm.deliveryOutbox?.close();
  await fx.close();
}
