/**
 * M-3127 C browser acceptance: the Hub's Ctrl K search and the sidebar-foot filter (docs/design/hub-rooms-reactions-polls-search.md §C;
 * web-claude: the Fleet's sidebar — its filter box at the foot, Ctrl K the search dialog).
 * The real Hub listener (tests/helpers/hub-s3b-rig.ts) serves the workspace shell and its modules over HTTPS on loopback;
 * every /hub/v1/* call is answered by the rooms fixture (tests/support/hub-rooms-fixture.ts) — no fleet, CLI or account.
 * Cases: desktop-en-light, desktop-zh-TW-dark, phone-zh-TW-light, phone-en-dark:
 *   hub-sidebar   — (desktop) the room list with its filter at the sidebar's foot; typing an owner's name filters it;
 *   search-dialog — Ctrl K: names, then the messages with 「風險」/"風險" grouped by room, the words marked;
 *   search-jump   — Enter: the room opens at the message (flashed); the address then loses `m`;
 *   search-skew   — BASE_REF's hub-client.js (a tab whose client predates search): the dialog opens with names, no page error.
 * The Fleet's own sidebar for comparison: scripts/manual/hub-rooms/fleet-sidebar.mts.
 * Writes PNGs and receipt.json (sourceHead, baseRef, inputs' digests, every check, every PNG's sha256) to OUT.
 *   PW_DIR=<playwright-core root> REPO=$PWD OUT=<dir> [BASE_REF=origin/release/2.3.5-alpha] npx tsx scripts/manual/hub-rooms/search.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const repo = resolve(process.env.REPO ?? "."), out = resolve(process.env.OUT ?? join(repo, ".artifacts/hub-rooms-search"));
const base = process.env.BASE_REF ?? "origin/release/2.3.5-alpha";
mkdirSync(out, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-c", "gc.auto=0", "-C", repo, ...a], { encoding: "utf8" }).trim();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { createHubRoomsFixture, FIXTURE_ME } = await import(repo + "/tests/support/hub-rooms-fixture.ts");

const keys = mkdtempSync(join(out, ".keys-")), port = 49600 + Math.floor(Math.random() * 200), origin = `https://127.0.0.1:${port}`;
const r = await s3bRig({ webOrigin: origin });
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>(done => server.listen(port, "127.0.0.1", done));

const SKEW_FILES: Record<string, string> = { "**/ui/js/hub-client.js": "src/ui/hub-client.js" };
const baseOf = (path: string) => git("show", `${base}:${path}`);
const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const INPUTS = ["src/ui/hub-room-thread.js", "src/ui/hub-room-search.js", "src/ui/panel-hub.js", "src/ui/hub-room-strings.js", "src/ui/hub-client.js", "src/ui/shared/hub-rooms-u2.css", "tests/support/hub-rooms-fixture.ts"];
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), baseRef: git("rev-parse", base), dirty: git("status", "--porcelain", "--", "src", "tests").split("\n").filter(Boolean),
  inputs: [...Object.values(SKEW_FILES).map(p => ({ path: p, base: sha(baseOf(p)) })), ...INPUTS.map(p => ({ path: p, sha256: sha(readFileSync(join(repo, p))) }))], checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const cases = [["desktop", "en", "light"], ["desktop", "zh-TW", "dark"], ["phone", "zh-TW", "light"], ["phone", "en", "dark"]];
const VIEW: Record<string, { width: number; height: number }> = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } };

async function open(variant: "after" | "skew", [device, lang, theme]: string[]) {
  const fx = createHubRoomsFixture();
  const ctx = await browser.newContext({ viewport: VIEW[device], colorScheme: theme, ignoreHTTPSErrors: true, locale: lang === "en" ? "en-US" : "zh-TW", isMobile: device === "phone", hasTouch: device === "phone" });
  await ctx.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); });
  await ctx.route("**/hub/v1/**", async (q: any) => {
    const req = q.request(), u = new URL(req.url()), path = u.pathname + u.search;
    if (u.pathname.endsWith("/events")) return q.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 600000\n\n" });
    const raw = req.postData(), answer = fx.handle({ method: req.method(), path, headers: req.headers(), body: raw ? JSON.parse(raw) : undefined });
    return q.fulfill({ status: answer?.status ?? 200, contentType: "application/json", body: JSON.stringify(answer?.body ?? {}) });
  });
  if (variant === "skew") for (const [glob, path] of Object.entries(SKEW_FILES)) await ctx.route(glob, (q: any) => q.fulfill({ status: 200, contentType: "text/javascript", body: baseOf(path) }));
  const p = await ctx.newPage(), errors: string[] = [];
  p.on("pageerror", (e: Error) => errors.push(e.message));
  p.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  if (lang !== "en") await p.addInitScript(() => localStorage.setItem("agend_lang", "zh-TW"));
  // Another room open (研發例會): a hit in 研一主管週會 is a jump across rooms.
  await p.goto(`${origin}/ui/hub?room=room-rd`);
  await p.waitForSelector(".hub-room-page .thread .msg", { timeout: 15000 });
  await p.waitForTimeout(500);
  return { ctx, p, errors };
}
const shotPage = async (p: any, name: string) => { const file = join(out, name); await p.screenshot({ path: file }); receipt.pictures.push({ path: name, sha256: sha(readFileSync(file)) }); };
const shotEl = async (p: any, sel: string, name: string) => { const file = join(out, name); await p.locator(sel).first().screenshot({ path: file }); receipt.pictures.push({ path: name, sha256: sha(readFileSync(file)) }); };
const ctrlK = (p: any) => p.keyboard.press("Control+k");

try {
  for (const c of cases) {
    const tag = c.join("-"), [device] = c;
    {
      const { ctx, p, errors } = await open("after", c);
      if (device === "desktop") {
        const foot = p.locator("#sidebar .hub-side-rooms .v-filter input");
        const atFoot = await p.evaluate(() => { const list = document.querySelector("#sidebar .hub-side-rooms .side-section"), f = document.querySelector("#sidebar .hub-side-rooms .v-filter");
          return !!list && !!f && f.getBoundingClientRect().top >= list.getBoundingClientRect().bottom - 1 && !document.querySelector("#sidebar .hub-side-filter"); });
        await foot.fill("吳小安"); await p.waitForTimeout(200);
        const names = await p.locator("#sidebar .hub-side-rooms .inst-name").allTextContents();
        check(`${tag} sidebar: the filter sits at the sidebar's foot (none at the list's head); an owner's name filters to report-bot`, atFoot && names.join("|") === "report-bot", { atFoot, names });
        await shotEl(p, "#sidebar", `hub-sidebar.${tag}.png`);
        await foot.press("Escape"); await p.waitForTimeout(150);
        check(`${tag} sidebar: Esc clears the filter`, (await p.locator("#sidebar .hub-side-rooms .inst-name").count()) >= 6, {});
      }
      await ctrlK(p); await p.waitForSelector(".hub-search-dlg[open]", { timeout: 5000 });
      await p.locator(".hub-search-dlg .search-input").fill("風險");
      await p.waitForSelector(".hub-search-dlg .search-row .search-snippet mark", { timeout: 5000 }); await p.waitForTimeout(300);
      const groups = await p.locator(".hub-search-dlg .search-group-head span:first-child").allTextContents();
      const marked = await p.locator(".hub-search-dlg .search-row .search-snippet mark").first().textContent();
      check(`${tag} dialog: Ctrl K opens it; the messages with the words, grouped by room, the words marked; no page error`,
        groups[0] === "研一主管週會" && marked === "風險" && errors.length === 0, { groups, marked, errors });
      await shotPage(p, `search-dialog.${tag}.png`);
      await p.keyboard.press("Enter");
      await p.waitForSelector(".hub-room-page .thread .msg.flash", { timeout: 8000 }).catch(() => {});
      const flashed = await p.locator(".hub-room-page .thread .msg.flash").count();
      await shotPage(p, `search-jump.${tag}.png`);
      await p.waitForTimeout(400);
      const search = await p.evaluate(() => location.search);
      check(`${tag} jump: Enter opens the room at the message (flashed); then the address loses m; no page error`,
        flashed === 1 && search === "?room=room-weekly" && errors.length === 0, { flashed, search, errors });
      await ctx.close();
    }
    {
      const { ctx, p, errors } = await open("skew", c);
      await ctrlK(p); await p.waitForSelector(".hub-search-dlg[open]", { timeout: 5000 }).catch(() => {});
      await p.locator(".hub-search-dlg .search-input").fill("研發"); await p.waitForTimeout(500);
      const rows = await p.locator(".hub-search-dlg .search-row").count();
      check(`${tag} skew: with BASE_REF's hub-client.js the dialog opens and finds names; no page error`, rows >= 1 && errors.length === 0, { rows, errors });
      await shotPage(p, `search-skew.${tag}.png`);
      await ctx.close();
    }
  }
} finally {
  receipt.passed = receipt.checks.every((x: any) => x.ok);
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  await browser.close(); server.close(); await r.close();
}
console.log(receipt.passed ? "ALL PASS" : "SOME FAILED");
process.exit(receipt.passed ? 0 : 1);
