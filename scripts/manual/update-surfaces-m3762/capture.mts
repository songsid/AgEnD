/**
 * M-3762 inventory: today's AgEnD update surfaces on the web, from the real app (owned web fixture; no Fleet/CLI starts,
 * accounts, npm or external services). `/ui/update` is answered with each state the page draws (the server's own shape,
 * web-api.ts handleWebUpdate); nothing is installed.
 *   1 the offer line (banner) · 2 its confirmation · 3 Settings → Advanced → Version and update · 4 an update running ·
 *   5 a failed one · 6 a finished one · 7 a Hub's recommendation · 8 a read-only (non-admin) session sees no offer
 * Desk light en and phone dark zh-TW.
 *   CHROME=<chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/update-surfaces-m3762/capture.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, matrix, mounted } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [], seen: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const shot = async (page: any, name: string) => {
  await page.waitForTimeout(500);
  const path = `m3762-${name}.png`;
  await page.screenshot({ path: join(OUT, path) });
  receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
};

const fx = await bootFixture({ port: 0, classic: false, host: true, roster: [
  { name: "general", general: true, backend: "claude-code", displayName: "General", status: "running" },
  { name: "example-agent", backend: "codex", displayName: "Example helper", status: "running" },
] });
const CURRENT = "2.4.0-beta.24", NEXT = "2.4.0-beta.25", now = Date.now();
const OFFER = { version: NEXT, channel: "beta", installable: true };
const STATES: Record<string, any> = {
  offer: { offer: OFFER, progress: null, hubRecommendation: null },
  running: { offer: OFFER, progress: { stage: "downloading", started_at: now - 12_000, version: NEXT, web: true }, hubRecommendation: null },
  failed: { offer: OFFER, progress: { stage: "failed", failed_stage: "downloading", cause: "network", started_at: now - 60_000, version: NEXT, web: true }, hubRecommendation: null },
  complete: { offer: null, progress: { stage: "complete", started_at: now - 120_000, version: NEXT, web: true }, hubRecommendation: null },
  hub: { offer: null, progress: null, hubRecommendation: { hubId: "hub-example", hubName: "Example Hub", version: NEXT, revision: 3, setAt: now - 3_600_000, receivedAt: now - 3_600_000 } },
};
const body = (state: string, admin = true) => (admin
  ? { admin: true, current: state === "complete" ? NEXT : CURRENT, checked_at: now - 3_600_000, check_failed: false, now: Date.now(), ...STATES[state] }
  : { admin: false, current: CURRENT });
const lineText = async (page: any) => page.evaluate(`[...document.querySelectorAll(".update-line")].map((e) => e.innerText.replace(/\\s+/g, " ").trim())`);

try {
  for (const c of matrix("desk-light-en,phone-dark-zh-TW")) {
    const tag = caseName(c), zh = c.lang === "zh-TW";
    let state = "offer";
    const { page, ctx } = await fx.page(c, { path: "/ui/fleet" });
    await ctx.route("**/ui/update", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body(state)) }));
    await ctx.route("**/ui/update/start", (r: any) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "capture: never started" }) }));
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.goto(fx.base + "/ui/fleet"); check(`${tag}: mounted`, await mounted(page, 30000));
      for (const s of ["offer", "running", "failed", "complete", "hub"]) {
        state = s;
        await page.reload(); await mounted(page, 30000);
        await page.waitForSelector(".update-line", { timeout: 15000 }).catch(() => {});
        const seen = await lineText(page);
        receipt.seen[`${tag}-${s}`] = seen;
        check(`${tag} ${s}: the update line shows`, seen.length > 0, seen);
        await shot(page, `${tag}-${s === "offer" ? 1 : s === "running" ? 4 : s === "failed" ? 5 : s === "complete" ? 6 : 7}-${s}`);
        if (s === "offer") {
          await page.locator(".update-line .btn-primary").first().click();
          await page.waitForSelector("dialog.dlg[open]", { timeout: 10000 });
          receipt.seen[`${tag}-confirm`] = await page.evaluate(`document.querySelector("dialog.dlg[open]")?.innerText.replace(/\\s+/g, " ").trim()`);
          await shot(page, `${tag}-2-confirm`);
          await page.keyboard.press("Escape");
          await page.goto(fx.base + "/ui/settings/advanced"); await mounted(page, 30000);
          await page.waitForSelector("#settings-update", { timeout: 15000 });
          await page.evaluate(`document.querySelector("#settings-update")?.scrollIntoView({ block: "start" })`);
          receipt.seen[`${tag}-settings`] = await page.evaluate(`document.querySelector("#settings-update")?.innerText.replace(/\\s+/g, " ").trim()`);
          check(`${tag}: Settings → Version and update`, !!receipt.seen[`${tag}-settings`], null);
          await shot(page, `${tag}-3-settings`);
          await page.goto(fx.base + "/ui/fleet");
        }
      }
      check(`${tag}: no page errors`, errors.length === 0, errors);
    } finally { await ctx.close(); }
    // A read-only session: no offer, only the stale-tab reload line when its tab is old.
    const ro = await fx.page(c, { path: "/ui/fleet" });
    await ro.ctx.route("**/ui/update", (r: any) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body("offer", false)) }));
    try {
      await ro.page.goto(fx.base + "/ui/fleet"); await mounted(ro.page, 30000); await ro.page.waitForTimeout(1500);
      const seen = await lineText(ro.page);
      receipt.seen[`${tag}-readonly`] = seen;
      check(`${tag} read-only: no offer line`, seen.length === 0, seen);
      await shot(ro.page, `${tag}-8-readonly`);
    } finally { await ro.ctx.close(); }
    void zh;
  }
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}
