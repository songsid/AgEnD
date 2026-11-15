/**
 * M-3162 browser acceptance: Administration's tabs and its Overview (Lumen's mockup; API M-3161). The real Hub listener
 * (tests/helpers/hub-s3b-rig.ts) serves the workspace shell and its modules over HTTPS on loopback; /hub/v1/* is the rooms
 * fixture (tests/support/hub-rooms-fixture.ts) with admin-dashboard-v1 advertised, and GET /hub/v1/admin/dashboard answered
 * here with sample counts (or, EMPTY=1 style, a Hub nobody has joined).
 *   overview.<case>.png — Administration → Overview, the whole page;
 *   empty.<case>.png    — a Hub nobody has joined: one line and Let colleagues join, the Fleets still shown;
 *   manage.<case>.png   — "See Connected Fleets" → Manage, the Connected fleets card in view.
 * Cases: desktop/phone × light/dark × en/zh-TW (MATRIX=quick: desktop-en-light, phone-zh-TW-dark). Checks per case: the tabs
 * (Overview current), no horizontal overflow on a phone, every section drawn, the privacy line, no token or cost word, no
 * page error; the empty state; the link lands on Manage with Connected fleets in view.
 *   PW_DIR=<playwright-core root> REPO=$PWD OUT=<dir> [MATRIX=full|quick] npx tsx scripts/manual/hub-rooms/overview.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const repo = resolve(process.env.REPO ?? "."), out = resolve(process.env.OUT ?? join(repo, ".artifacts/hub-overview"));
mkdirSync(out, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-c", "gc.auto=0", "-C", repo, ...a], { encoding: "utf8" }).trim();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { createHubRoomsFixture } = await import(repo + "/tests/support/hub-rooms-fixture.ts");

const keys = mkdtempSync(join(out, ".keys-")), port = 49600 + Math.floor(Math.random() * 200), origin = `https://127.0.0.1:${port}`;
const r = await s3bRig({ webOrigin: origin });
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>(done => server.listen(port, "127.0.0.1", done));

const DAYS = (() => { const out: string[] = []; for (let k = 6; k >= 0; k--) { const d = new Date(Date.now() - k * 86_400_000); out.push(d.toISOString().slice(0, 10)); } return out; })();
const SAMPLE = {
  generatedAt: Date.now(), range: "7d", timeZone: "UTC", start: 0, end: Date.now(),
  people: { total: 41, activeToday: 23, active7d: 34, joined7d: 4, signedInNow: 9 },
  questions: { asked: 412, perDay: DAYS.map((date, i) => ({ date, count: [71, 64, 83, 77, 52, 7, 58][i] })), answerTime: { medianMs: 42_000, p90Ms: 192_000, samples: 380 },
    waiting: 3, longestWaitMs: 96_000, notAnswered: { total: 9, reasons: { offline: 4, timedOut: 3, permissionEnded: 1, stoppedOrRefused: 1, unknown: 0 } } },
  topAgents: [
    { id: "a1", name: "build-agent", ownerName: "林小華", questions: 96, medianMs: 31_000, notAnswered: 1 },
    { id: "a2", name: "project-helper", ownerName: "林小華", questions: 81, medianMs: 44_000, notAnswered: 3 },
    { id: "a3", name: "docs-bot", ownerName: "張文", questions: 62, medianMs: 28_000, notAnswered: 0 },
    { id: "a4", name: "release-notes", ownerName: "王經理", questions: 47, medianMs: 73_000, notAnswered: 4 },
    { id: "a5", name: "qa-runner", ownerName: "吳小安", questions: 38, medianMs: null, notAnswered: 1 }],
  sharedAgents: 23,
  fleets: { total: 18, connected: 12, needsUpdate: 3, tooOldRooms: 1, unknownVersion: 1, recommendedVersion: "2.4.0-beta.2" },
  rooms: { total: 14, active: 9, created7d: 2, messages: 1204, byAuthor: { people: 610, agents: 540, assistant: 54 }, agentQuestions: 287, chainsStopped: 2 },
};
const EMPTY = { ...SAMPLE, people: { total: 0, activeToday: 0, active7d: 0, joined7d: 0, signedInNow: 0 }, topAgents: [], sharedAgents: 0,
  questions: { ...SAMPLE.questions, asked: 0, perDay: DAYS.map((date) => ({ date, count: 0 })) }, fleets: { total: 2, connected: 1, needsUpdate: 0, tooOldRooms: 0, unknownVersion: 0, recommendedVersion: null } };
const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
const cases = (process.env.MATRIX ?? "full") === "quick"
  ? [["desktop", "en", "light"], ["phone", "zh-TW", "dark"]]
  : ["desktop", "phone"].flatMap(d => ["en", "zh-TW"].flatMap(l => ["light", "dark"].map(t => [d, l, t])));
const VIEW: Record<string, { width: number; height: number }> = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } };
const keep = (name: string) => receipt.pictures.push({ path: name, sha256: sha(readFileSync(join(out, name))) });

async function open([device, lang, theme]: string[], path: string, dash: unknown = SAMPLE) {
  const fx = createHubRoomsFixture({ features: ["rooms-v1", "admin-dashboard-v1"] });
  const ctx = await browser.newContext({ viewport: VIEW[device], colorScheme: theme, ignoreHTTPSErrors: true, locale: lang === "en" ? "en-US" : "zh-TW", isMobile: device === "phone", hasTouch: device === "phone" });
  await ctx.addInitScript((l: string) => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_lang", l); }, lang);
  await ctx.route("**/hub/v1/**", async (q: any) => {
    const req = q.request(), u = new URL(req.url()), p = u.pathname + u.search;
    if (u.pathname.endsWith("/events")) return q.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 600000\n\n" });
    if (u.pathname === "/hub/v1/admin/dashboard") return q.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...(dash as object), range: u.searchParams.get("range") ?? "7d" }) });
    if (u.pathname === "/hub/v1/admin/overview") return q.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fleets: [], pairings: [] }) });
    // M-3141 (M-3138's API): nothing saved yet; a preview of Same as this Hub; a save.
    if (u.pathname === "/hub/v1/admin/recommended-version" && req.method() === "GET") return q.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: "none", version: null, recommendedVersion: null, hubVersion: "2.4.0-beta.3", configured: false, revision: 0, setAt: null }) });
    if (u.pathname === "/hub/v1/admin/recommended-version/preview") return q.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ recommendedVersion: "2.4.0-beta.3", affected: 3, revision: 0 }) });
    if (u.pathname === "/hub/v1/me/fleets") return q.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fleets: [] }) });
    const raw = req.postData(), answer = fx.handle({ method: req.method(), path: p, headers: req.headers(), body: raw ? JSON.parse(raw) : undefined });
    return q.fulfill({ status: answer?.status ?? 200, contentType: "application/json", body: JSON.stringify(answer?.body ?? {}) });
  });
  const pg = await ctx.newPage(), errors: string[] = [];
  pg.on("pageerror", (e: Error) => errors.push(e.message));
  await pg.goto(`${origin}${path}`);
  return { ctx, pg, errors };
}


try {
  for (const c of cases) {
    const tag = c.join("-");
    let o = await open(c, "/ui/hub/admin");
    await o.pg.waitForSelector(".hub-ov .hub-ov-bars", { timeout: 20000 }); await o.pg.waitForTimeout(500);
    const tabs = await o.pg.locator(".hub-admin-tab").evaluateAll((as: Element[]) => as.map((a) => [a.textContent, a.getAttribute("aria-current") === "page"]));
    const text = (await o.pg.locator(".hub-ov").textContent()) ?? "";
    const wide = await o.pg.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    const sections = await o.pg.locator(".hub-ov-section > h3").count();
    check(`${tag} overview: Overview current, 4 sections, the privacy line, no token/cost, no overflow, no page error`,
      JSON.stringify(tabs[0]) === JSON.stringify([c[1] === "en" ? "Overview" : "總覽", true]) && sections === 4 && /(Counts only|這裡只有數字)/.test(text)
      && !/token|cost|費用/i.test(text) && !wide && o.errors.length === 0, { tabs, sections, wide, errors: o.errors });
    await o.pg.setViewportSize({ width: VIEW[c[0]].width, height: 3200 }); await o.pg.waitForTimeout(300);
    // The tabs and the Overview themselves (the tall viewport is only so it all lays out; the page ends where the content does).
    const end = await o.pg.evaluate(() => { const h = document.querySelector(".panel-body")!.getBoundingClientRect(), c = document.querySelector(".hub-admin-ov-col")!.getBoundingClientRect(); return [Math.round(h.top), Math.round(c.bottom)]; });
    await o.pg.screenshot({ path: join(out, `overview.${tag}.png`), clip: { x: 0, y: end[0]!, width: VIEW[c[0]].width, height: end[1]! - end[0]! + 16 } }); keep(`overview.${tag}.png`);
    await o.pg.setViewportSize(VIEW[c[0]]); await o.pg.waitForTimeout(200);
    // See Connected Fleets → Manage, that card in view.
    await o.pg.locator(".hub-ov-link").click();
    await o.pg.waitForSelector("#hub-admin-fleets", { timeout: 15000 }); await o.pg.waitForTimeout(600);
    const landed = await o.pg.evaluate(() => { const r = document.querySelector("#hub-admin-fleets")!.getBoundingClientRect(); return [location.search, r.top < innerHeight && r.bottom > 0]; });
    check(`${tag} link: Manage, Connected fleets in view`, landed[0] === "?view=manage" && landed[1] === true, { landed });
    await o.pg.screenshot({ path: join(out, `manage.${tag}.png`) }); keep(`manage.${tag}.png`);
    await o.ctx.close();
    // A Hub nobody has joined.
    o = await open(c, "/ui/hub/admin", EMPTY);
    await o.pg.waitForSelector(".hub-ov-empty", { timeout: 20000 }); await o.pg.waitForTimeout(300);
    const emptyText = (await o.pg.locator(".hub-ov").textContent()) ?? "";
    check(`${tag} empty: the line, the button, the Fleets; no questions`, /(Nobody has joined yet|還沒有人加入)/.test(emptyText) && (await o.pg.locator(".hub-ov-empty .btn-primary").count()) === 1
      && /(Connected now|目前已連接)/.test(emptyText) && !/(Questions per day|每天的提問數)/.test(emptyText), { emptyText: emptyText.slice(0, 200) });
    await o.pg.screenshot({ path: join(out, `empty.${tag}.png`) }); keep(`empty.${tag}.png`);
    await o.ctx.close();
  }
} finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  await browser.close(); server.close();
}
const failed = receipt.checks.filter((x: any) => !x.ok).length;
console.log(JSON.stringify({ pass: failed === 0, checks: receipt.checks.length, failed, pictures: receipt.pictures.length }));
process.exit(failed ? 1 : 0);
