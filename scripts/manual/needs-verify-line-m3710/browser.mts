/**
 * M-3710 real-app captures (owned web fixture; no Fleet/CLI starts, accounts or external services). Two contact requests
 * are held (lead → worker). A browser signed in as a chat account that has not authorized it:
 *   1. on this computer (localhost) — Needs you says "2 contact requests need a verified browser" with Authorize this browser;
 *   2. the same browser once the account confirmed (authorizeWebSession, as the DM's Confirm does) — the requests themselves,
 *      with Approve once / Decline, and no line;
 *   3. over a real public link (FleetManager's PublicWebLink + gateway; the tunnel stubbed) — the line there too.
 * Stubbed, the Discord side only: the account is a Fleet admin of a "demo" Discord connection the agents are on.
 *   CHROME=<linux chromium> PW_DIR=<playwright-core> REPO=<checkout> OUT=<dir> npx tsx scripts/manual/needs-verify-line-m3710/browser.mts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, demoAccount, freshPage, matrix, mounted, openPublicLink } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!;
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const fx = await bootFixture({ port: 0, classic: false, roster: [
  { name: "general", backend: "claude-code", general: true, displayName: "General" },
  { name: "lead", backend: "claude-code", displayName: "Example lead", description: "Synthetic demonstration agent" },
  { name: "worker", backend: "codex", displayName: "Example worker", description: "Synthetic demonstration agent" },
] });
let link: Awaited<ReturnType<typeof openPublicLink>> | null = null;
try {
  const fm = fx.fm;
  fm.scheduleDeliveryOutboxPump = () => {};
  fm.ensureDeliveryOutbox();
  // The Discord side, stubbed: one "demo" connection the agents are on; its Fleet admins are the accounts this script signs in as.
  const admins = new Set<string>();
  const demo = { id: "demo", type: "discord", getBotUserId: () => "demo-bot" };
  fm.adapters.set("demo", demo);
  fm.contactAdapter = () => demo;
  fm.adminListOf = () => [...admins];
  fm.adminGate = (userId: string) => (admins.has(userId) ? "ok" : "denied");
  const store = fm.deliveryOutbox.contactAuthorizations;
  for (const n of [1, 2]) store.hold({ operationId: `fake-op-${n}`, source: "lead", target: "worker", sourceGeneration: fm.contactGeneration("lead"),
    targetGeneration: fm.contactGeneration("worker"), verb: "send_to_instance", origin: { kind: "unknown", people: [], receiptIds: [], chain: ["lead"] },
    message: n === 1 ? "Please run the release checklist. · 請跑發版檢查清單。" : "Summarise yesterday's incidents. · 整理昨天的事件。",
    correlationId: `fake-correlation-${n}`, resultRecipient: "lead", payload: { content: "synthetic" } });
  link = await openPublicLink(fx);
  admins.add(link.owner.userId);
  const cases = matrix(process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW");
  for (const c of cases) {
    const tag = caseName(c), zh = c.lang === "zh-TW";
    const shot = async (page: any, name: string, el?: any) => {
      await page.waitForTimeout(400);
      const path = `m3710-${tag}-${name}.png`;
      await page.screenshot({ path: join(OUT, path) });
      receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
      void el;
    };
    const title = zh ? "有 2 個聯絡申請需要已驗證的瀏覽器" : "2 contact requests need a verified browser";
    // #4447 capture check: the header counts the line as its 2 requests, as it does once they replace it.
    const waiting = zh ? "2 件待處理" : "2 waiting";
    // 1–2. On this computer, as a chat account that has not authorized this browser; then after its Confirm.
    {
      const account = demoAccount(); admins.add(account.userId);
      const { page, ctx, errors } = await freshPage(fx, c, { account, path: "/ui/needs" });
      try {
        check(`${tag}: the app mounted`, await mounted(page));
        const line = page.locator(".contact-verify-need"); await line.waitFor({ timeout: 15000 });
        check(`${tag}: localhost, unverified — the line with the count`, (await line.locator(".n-title").innerText()).trim() === title, await line.innerText());
        const said = await line.innerText();
        check(`${tag}: localhost — Authorize this browser offered`, /Authorize this browser|授權這個瀏覽器/.test(said), said);
        // #4447 review: on a phone the Authorize button is a full touch target (44px).
        if (c.device === "phone") { const box = await line.locator(".webauth-chip button").first().boundingBox(); check(`${tag}: Authorize is a 44px tap target`, !!box && box.height >= 44 && box.width >= 44, box); }
        check(`${tag}: no request named before verifying`, !/Example lead|Example worker|release checklist|發版/.test(await page.locator(".p-needs").innerText()));
        check(`${tag}: localhost — the header counts the line as 2`, new RegExp(waiting).test(await page.locator(".p-needs").innerText()));
        await shot(page, "1-local-unverified");
        let record: any = null;
        fm.webSessions.list(undefined, (r: any) => { if (r.owner?.userId === account.userId) record = r; return false; });
        check(`${tag}: the account confirms (as the DM's Confirm)`, fm.authorizeWebSession(record, "loopback", false).ok === true);
        await page.reload(); await page.locator(".contact-need[data-reason=contact_request] .contact-decide").nth(1).waitFor({ timeout: 15000 });
        const body = await page.locator(".p-needs").innerText();
        check(`${tag}: verified — the requests with Approve once, and no line`, (await page.locator(".contact-verify-need").count()) === 0
          && (await page.locator(".contact-need[data-reason=contact_request]").count()) === 2 && /Approve once|核准這一次/.test(body), body.slice(0, 400));
        // #4447 capture check: the first request's actions both in view (a phone's 844px cut Decline off).
        const decide = page.locator(".contact-need[data-reason=contact_request] .contact-decide-controls").first();
        await decide.evaluate((el: Element) => el.scrollIntoView({ block: "center" }));
        const inView = await decide.evaluate((el: Element) => [el, ...el.querySelectorAll("button")].every((b) => { const q = b.getBoundingClientRect(); return q.top >= 0 && q.bottom <= innerHeight; }));
        check(`${tag}: verified — Approve once and Decline both in view`, inView);
        check(`${tag}: verified — the header still counts 2`, new RegExp(waiting).test(await page.locator(".p-needs").innerText()));
        await shot(page, "2-local-verified");
        check(`${tag}: no page errors (localhost)`, errors.length === 0, errors);
      } finally { await ctx.close(); }
    }
    // 3. Over the public link, as the link's owner (signed in there, not authorized).
    {
      const { page, ctx, errors } = await link.publicPage(c, { path: "/ui/needs" });
      try {
        const line = page.locator(".contact-verify-need"); await line.waitFor({ timeout: 20000 });
        check(`${tag}: public link, unverified — the line with the count`, (await line.locator(".n-title").innerText()).trim() === title, await line.innerText());
        check(`${tag}: public link — no request named`, !/Example lead|Example worker|release checklist|發版/.test(await page.locator(".p-needs").innerText()));
        receipt[`linkChip-${tag}`] = (await line.locator(".webauth-chip").innerText().catch(() => "")).trim();
        // The page looks the same as on this computer (a headless shot has no address bar): where it was, recorded.
        check(`${tag}: frame 3 is on the public link`, new URL(page.url()).origin === `https://${link.host}`, page.url());
        receipt[`linkPage-${tag}`] = page.url();
        check(`${tag}: public link — the header counts the line as 2`, new RegExp(waiting).test(await page.locator(".p-needs").innerText()));
        await shot(page, "3-link-unverified");
        check(`${tag}: no page errors (link)`, errors.length === 0, errors);
      } finally { await ctx.close(); }
    }
  }
} finally {
  await link?.close().catch(() => {});
  clearInterval(fx.fm.replyObligationTimer);
  fx.fm.deliveryOutbox?.close();
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}
