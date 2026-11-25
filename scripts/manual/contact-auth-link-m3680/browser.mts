/**
 * M-3680 real-app captures (owned web fixture; no Fleet/CLI starts, accounts or external services): a held agent-to-agent
 * request on Fleet › Authorizations (授權) and in Needs you, the target agent's Permissions tab with the retained origin
 * and its Clear button, and — with no verified administrator behind the session — what both pages say now.
 * The public link's own refusal (a 404 at the gateway) is proven in tests/contact-auth-public-link-m3680.test.ts.
 *   CHROME=<linux chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/contact-auth-link-m3680/browser.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const fx = await bootFixture({ port: 0, host: true, classic: false, roster: [
  { name: "general", backend: "claude-code", general: true, displayName: "General" },
  { name: "lead", backend: "claude-code", displayName: "Example lead", description: "Synthetic demonstration agent" },
  { name: "worker", backend: "codex", displayName: "Example worker", description: "Synthetic demonstration agent" },
] });
try {
  fx.fm.scheduleDeliveryOutboxPump = () => {};
  fx.fm.ensureDeliveryOutbox();
  const store = fx.fm.deliveryOutbox.contactAuthorizations;
  const origin = { kind: "unknown" as const, people: [{ platform: "discord" as const, adapterId: "demo", userId: "fake-member", label: "Room member" }], receiptIds: ["fake-receipt"], chain: ["room", "lead"] };
  store.inheritOrigin("lead", origin);
  const held = store.hold({ operationId: "fake-op", source: "lead", target: "worker", sourceGeneration: fx.fm.contactGeneration("lead"), targetGeneration: fx.fm.contactGeneration("worker"),
    verb: "send_to_instance", origin, message: "Please run the release checklist. · 請跑發版檢查清單。", correlationId: "fake-correlation", resultRecipient: "lead",
    payload: { content: "Please run the release checklist." } });
  receipt.ticket = held.id.slice(0, 9);
  const realActor = fx.fm.contactActor.bind(fx.fm);
  for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW")) {
    const tag = caseName(c);
    const shot = async (page: any, name: string) => { await page.waitForTimeout(400); const path = `m3680-${tag}-${name}.png`; await page.screenshot({ path: join(OUT, path) }); receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") }); };
    fx.fm.contactActor = realActor;
    // 1. Fleet › Authorizations: the held request, with Approve once / Decline.
    {
      const { page, ctx, csp } = await fx.page(c, { host: true, path: "/ui/fleet/authorizations" });
      const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
      try {
        const card = page.locator(".contact-auth-page .contact-ticket").first(); await card.waitFor({ timeout: 15000 });
        const said = await card.innerText();
        check(`${tag}: Authorizations lists the held request with its decision buttons`, /lead|Example lead/.test(said) && /worker|Example worker/.test(said) && /Approve|核准/.test(said), said.slice(0, 200));
        check(`${tag}: no "couldn't load"`, !/Couldn't load permissions|無法載入權限/.test(await page.locator("body").innerText()));
        await shot(page, "1-authorizations");
        // 2. Needs you: the same request, approvable there.
        await page.goto(new URL("/ui/needs", page.url()).href).catch(() => {});
        await page.waitForTimeout(1500);
        const needs = await page.locator("body").innerText();
        check(`${tag}: Needs you lists it`, /Contact|聯絡/.test(needs) && /Approve|核准/.test(needs), needs.slice(0, 300));
        await shot(page, "2-needs-you");
        // 3. The target agent's Permissions tab: the source's retained origin is on the source's tab — Clear lives there.
        await page.goto(new URL("/ui/fleet/agent/lead?cat=permissions", page.url()).href);
        const originBox = page.locator(".contact-origin"); await originBox.waitFor({ timeout: 15000 }); await originBox.scrollIntoViewIfNeeded();
        check(`${tag}: the Permissions tab shows the retained origin and Clear`, await page.locator(".contact-origin-clear").count() === 1);
        await shot(page, "3-permissions");
        check(`${tag}: no page errors or CSP reports`, errors.length === 0 && (await csp()).length === 0, { errors, csp: await csp() });
      } finally { await ctx.close(); }
    }
    // 4. No verified administrator behind the session (an unauthorized browser over a link): both pages say where to verify.
    fx.fm.contactActor = () => null;
    {
      const { page, ctx } = await fx.page(c, { host: true, path: "/ui/fleet/authorizations" });
      try {
        await page.locator(".contact-verify").first().waitFor({ timeout: 15000 });
        const said = await page.locator(".contact-verify").first().innerText();
        check(`${tag}: Authorizations says to verify in Sign-in status`, /Sign-in status|登入狀態/.test(said), said);
        await shot(page, "4-verify-authorizations");
        await page.goto(new URL("/ui/fleet/agent/worker?cat=permissions", page.url()).href);
        await page.locator(".contact-verify").first().waitFor({ timeout: 15000 });
        check(`${tag}: the Permissions tab says the same`, /Sign-in status|登入狀態/.test(await page.locator(".contact-verify").first().innerText()));
        await shot(page, "5-verify-permissions");
      } finally { await ctx.close(); }
    }
  }
} finally {
  clearInterval(fx.fm.replyObligationTimer);
  fx.fm.deliveryOutbox?.close();
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}
