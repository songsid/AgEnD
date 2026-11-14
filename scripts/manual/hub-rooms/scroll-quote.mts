/**
 * M-3126 pictures: a long room pages older messages on scroll, a quote jumps to an off-page original, and a room ask
 * shows the Fleet ! / ⊘ ticks. Fixture-backed Hub HTTPS on loopback; no fleet, CLI or account.
 *   PW_DIR=<playwright-core root> REPO=$PWD OUT=<dir> [CHROME=<chromium>] npx tsx scripts/manual/hub-rooms/scroll-quote.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const repo = resolve(process.env.REPO ?? "."), out = resolve(process.env.OUT ?? join(repo, "docs/screenshots/hub-rooms-m3126"));
mkdirSync(out, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-c", "gc.auto=0", "-C", repo, ...a], { encoding: "utf8" }).trim();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { createHubRoomsFixture } = await import(repo + "/tests/support/hub-rooms-fixture.ts");

const keys = mkdtempSync(join(tmpdir(), "agend-m3126-keys-")), port = 49500 + Math.floor(Math.random() * 200), origin = `https://127.0.0.1:${port}`;
const r = await s3bRig({ webOrigin: origin });
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));

function seed(fx: ReturnType<typeof createHubRoomsFixture>) {
  const weekly = fx.rooms.find((x) => x.id === "room-weekly")!;
  const me = weekly.members.find((m) => m.id === fx.me.id)!;
  const helper = weekly.members.find((m) => m.name === "project-helper")!;
  const t0 = weekly.messages[0]!.at - 80 * 60_000;
  for (let i = 79; i >= 0; i--) weekly.messages.unshift({
    id: `hist-${String(i).padStart(3, "0")}`, roomId: "room-weekly", at: t0 + i * 60_000,
    author: { kind: "person", id: "person-chen", name: "陳主任" }, text: `history ${i}`, mentions: [],
  });
  weekly.messages.push(
    { id: "quote-old", roomId: "room-weekly", at: Date.now(), author: { kind: "person", id: me.id, name: me.name }, text: "about that first note", mentions: [], replyTo: "hist-000" },
    { id: "ask-fail", roomId: "room-weekly", at: Date.now() + 1, author: { kind: "person", id: me.id, name: me.name }, text: "@project-helper ping", mentions: ["exp-01"],
      ask: { total: 1, answered: 0, working: 0, later: 0, failed: 1, reason: "expired" } },
    { id: "ans-fail", roomId: "room-weekly", at: Date.now() + 2, author: { kind: "agent", id: helper.id, name: helper.name, owner: helper.owner },
      text: "", mentions: [], answerTo: "ask-fail", replyTo: "ask-fail", stage: "not-answered" },
    { id: "ask-block", roomId: "room-weekly", at: Date.now() + 3, author: { kind: "person", id: me.id, name: me.name }, text: "@report-bot later", mentions: ["exp-10"],
      ask: { total: 1, answered: 0, working: 0, later: 0, blocked: 1, reason: "retired" } },
  );
}

const pw = createRequire(resolve(process.env.PW_DIR || join(repo, "node_modules/playwright-core"), "package.json"))("playwright-core");
const launch: Record<string, unknown> = { args: ["--no-sandbox"] };
if (process.env.CHROME) launch.executablePath = process.env.CHROME;
const browser = await pw.chromium.launch(launch);
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").split("\n").filter(Boolean),
  inputs: ["src/ui/hub-room-thread.js", "src/ui/panel-hub.js", "src/ui/hub-room-strings.js"].map((p) => ({ path: p, sha256: sha(readFileSync(join(repo, p))) })),
  checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
const cases = [["desktop", "en", "light"], ["phone", "zh-TW", "dark"]];
const VIEW: Record<string, { width: number; height: number }> = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } };

try {
  for (const [device, lang, theme] of cases) {
    const tag = `${device}-${lang}-${theme}`;
    const fx = createHubRoomsFixture({ features: ["rooms-v1"] }); seed(fx);
    const ctx = await browser.newContext({ viewport: VIEW[device], colorScheme: theme, ignoreHTTPSErrors: true, locale: lang === "en" ? "en-US" : "zh-TW", isMobile: device === "phone", hasTouch: device === "phone" });
    await ctx.addInitScript(({ language, theme: th }: { language: string; theme: string }) => {
      localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1");
      localStorage.setItem("agend_lang", language); localStorage.setItem("agend_theme", th);
    }, { language: lang, theme });
    await ctx.route("**/hub/v1/**", async (q: any) => {
      const req = q.request(), u = new URL(req.url()), path = u.pathname + u.search;
      if (u.pathname.endsWith("/events")) return q.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 600000\n\n" });
      const raw = req.postData(), answer = fx.handle({ method: req.method(), path, headers: req.headers(), body: raw ? JSON.parse(raw) : undefined });
      return q.fulfill({ status: answer?.status ?? 200, contentType: "application/json", body: JSON.stringify(answer?.body ?? {}) });
    });
    const p = await ctx.newPage(), errors: string[] = [];
    p.on("pageerror", (e: Error) => errors.push(e.message));
    await p.goto(`${origin}/ui/hub?room=room-weekly`);
    await p.waitForFunction(() => document.querySelectorAll(".hub-room-page .thread .msg").length > 3, undefined, { timeout: 20000 });
    const ticks = await p.evaluate(() => ({
      failed: !!document.querySelector(".hub-room-page .tick-failed"),
      blocked: !!document.querySelector(".hub-room-page .tick-cancelled"),
      quote: [...document.querySelectorAll(".hub-room-page .msg-quote")].some((el) => /about that first note/.test(el.closest(".msg")?.textContent || "")),
    }));
    check(`${tag} failed and blocked ticks, quote chip of an off-page original`, ticks.failed && ticks.blocked && ticks.quote && errors.length === 0, { ticks, errors });
    await p.screenshot({ path: join(out, `ticks.${tag}.png`) });
    receipt.pictures.push({ path: `ticks.${tag}.png`, sha256: sha(readFileSync(join(out, `ticks.${tag}.png`))) });
    const oldestDrawn = () => p.evaluate(() => [...document.querySelectorAll(".hub-room-page .thread .msg .md")].some((el) => (el.textContent || "").trim() === "history 0"));
    for (let i = 0; i < 12 && !await oldestDrawn(); i++) {
      await p.locator(".hub-scroller").evaluate((el: HTMLElement) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
      await p.waitForTimeout(400);
    }
    const loaded = await oldestDrawn();
    check(`${tag} scroll-up loaded the oldest history row`, loaded && errors.length === 0, { loaded, errors });
    await p.evaluate(() => {
      const el = [...document.querySelectorAll(".hub-room-page .thread .msg .md")].find((n) => (n.textContent || "").trim() === "history 0");
      el?.closest(".msg")?.scrollIntoView({ block: "start" });
    });
    await p.waitForTimeout(200);
    await p.screenshot({ path: join(out, `older.${tag}.png`) });
    receipt.pictures.push({ path: `older.${tag}.png`, sha256: sha(readFileSync(join(out, `older.${tag}.png`))) });
    const quote = p.locator(".hub-room-page .msg", { hasText: "about that first note" }).locator(".msg-quote");
    if (await quote.count()) { await quote.first().click(); }
    const flashed = await p.waitForFunction(() => [...document.querySelectorAll(".hub-room-page .thread .msg.flash")].some((el) => /history 0/.test(el.textContent || "")), undefined, { timeout: 8000 }).then(() => true).catch(() => false);
    check(`${tag} quote click jumps to the original`, flashed, { flashed, loaded });
    await p.screenshot({ path: join(out, `jump.${tag}.png`) });
    receipt.pictures.push({ path: `jump.${tag}.png`, sha256: sha(readFileSync(join(out, `jump.${tag}.png`))) });
    await ctx.close();
  }
} finally {
  await browser.close(); server.close(); await r.close?.();
  rmSync(keys, { recursive: true, force: true });
}
writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
const failed = receipt.checks.filter((c: any) => !c.ok);
if (failed.length) { console.error(JSON.stringify(failed, null, 2)); process.exit(1); }
console.log(JSON.stringify({ pictures: receipt.pictures.length, checks: receipt.checks.length, out }, null, 2));
