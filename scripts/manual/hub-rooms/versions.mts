/**
 * M-3137 browser acceptance: Fleet versions on the Hub (docs/design/hub-fleet-versions.md §2.2–2.4).
 * The real Hub listener (tests/helpers/hub-s3b-rig.ts) serves the workspace shell and its modules over HTTPS on loopback;
 * /hub/v1/* is the rooms fixture (tests/support/hub-rooms-fixture.ts), with the version fields M-3136 serves answered here:
 * the admin overview's Fleets (current, too old for rooms, needs update, unknown) and the signed-in person's own Fleets.
 *   admin.<case>.png    — Administration → Connected fleets: summary, filter, version / last connected / tag per row;
 *   filtered.<case>.png — the same with "Needs update" pressed;
 *   banner.<case>.png   — Chats home: "Your Fleet … runs an older AgEnD (…)";
 *   members.<case>.png  — a room's members panel: "Needs an AgEnD update · ask {owner}";
 *   rec.<case>.png      — M-3141: the Recommended AgEnD version card, nothing saved yet (Same as this Hub chosen);
 *   rec-preview.<case>.png — the same after Save: its effect, "{n} Fleets will be asked to update.", before it applies;
 *   updates.<case>.png  — M-3145: rows with Update / "Owner updates it" / a waiting request for an older version (Cancel,
 *                         Update to v{new} instead) / a rollback (Try again), and "Update {n} Fleets that allow it" above.
 * Cases: desktop/phone × light/dark × en/zh-TW (MATRIX=quick: desktop-en-light, phone-zh-TW-dark).
 *   PW_DIR=<playwright-core root> REPO=$PWD OUT=<dir> [MATRIX=full|quick] npx tsx scripts/manual/hub-rooms/versions.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const repo = resolve(process.env.REPO ?? "."), out = resolve(process.env.OUT ?? join(repo, ".artifacts/hub-versions"));
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

const NOW = Date.now(), DAY = 86_400_000, HOUR = 3_600_000;
const owner = (name: string, login: string) => ({ realm: "example", objectId: login, name, login });
const FLEETS = [
  { id: "f1", updatesAllowed: true, updateRequest: null, status: "active", label: "build-box", owner: owner("林小華", "lin"), version: "2.4.0-beta.3", runsAsService: true, versionReportedAt: NOW, connected: true, lastConnectedAt: NOW, versionState: "current" },
  { id: "f2", updatesAllowed: true, updateRequest: null, status: "active", label: "design-pc", owner: owner("陳主任", "chen"), version: "2.4.0-beta.1", runsAsService: true, versionReportedAt: NOW - 5 * HOUR, connected: false, lastConnectedAt: NOW - 5 * HOUR, versionState: "needs-update", recommendationNotifiedAt: NOW - 4 * HOUR },
  { id: "f3", updatesAllowed: false, updateRequest: null, status: "active", label: "old-laptop", owner: owner("吳小安", "wu"), version: "2.3.4", runsAsService: false, versionReportedAt: NOW - 3 * DAY, connected: false, lastConnectedAt: NOW - 3 * DAY, versionState: "too-old-rooms" },
  { id: "f4", updatesAllowed: true, updateRequest: { id: "rq4", fleetId: "f4", version: "2.4.0-beta.2", requestedBy: { name: "王經理" }, requestedAt: NOW - 2 * HOUR, expiresAt: NOW + 22 * HOUR, updatedAt: NOW - HOUR, startedAt: null, waitingSince: NOW - 2 * HOUR, state: "waiting" }, status: "active", label: "lab-server", owner: owner("王經理", "wang"), version: null, runsAsService: null, versionReportedAt: null, connected: false, lastConnectedAt: null, versionState: "unknown" },
  { id: "f5", status: "revoked", label: "retired-box", owner: owner("陳主任", "chen"), version: "2.2.0", runsAsService: null, versionReportedAt: null, connected: false, lastConnectedAt: NOW - 40 * DAY, versionState: "needs-update" },
];
// Phase 2 sets it; shown here so every state reads as the administrator will see it then (phase 1 sends null).
const RECOMMENDED = process.env.RECOMMENDED === "none" ? null : "2.4.0-beta.3";
// A fifth, behind, that rolled back last time (Try again), and one more that allows it (two qualify for "Update {n}").
FLEETS.splice(4, 0,
  { id: "f6", updatesAllowed: true, updateRequest: { id: "rq6", fleetId: "f6", version: "2.4.0-beta.3", requestedBy: { name: "王經理" }, requestedAt: NOW - 30 * HOUR, expiresAt: NOW, updatedAt: NOW - 26 * HOUR, startedAt: NOW - 27 * HOUR, waitingSince: null, state: "rolled-back", currentVersion: "2.4.0-beta.1" },
    status: "active", label: "qa-box", owner: owner("吳小安", "wu"), version: "2.4.0-beta.1", runsAsService: true, versionReportedAt: NOW - 26 * HOUR, connected: true, lastConnectedAt: NOW, versionState: "needs-update", recommendationNotifiedAt: NOW - 30 * HOUR } as any);
const MINE = [{ id: "f4", label: "lab-server", version: null, versionState: "unknown" }];

const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const receipt: any = { sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
const cases = (process.env.MATRIX ?? "full") === "quick"
  ? [["desktop", "en", "light"], ["phone", "zh-TW", "dark"]]
  : ["desktop", "phone"].flatMap(d => ["en", "zh-TW"].flatMap(l => ["light", "dark"].map(t => [d, l, t])));
const VIEW: Record<string, { width: number; height: number }> = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } };
const keep = (name: string) => receipt.pictures.push({ path: name, sha256: sha(readFileSync(join(out, name))) });

async function open([device, lang, theme]: string[], path: string) {
  const fx = createHubRoomsFixture({ features: ["rooms-v1"] });
  const ctx = await browser.newContext({ viewport: VIEW[device], colorScheme: theme, ignoreHTTPSErrors: true, locale: lang === "en" ? "en-US" : "zh-TW", isMobile: device === "phone", hasTouch: device === "phone" });
  await ctx.addInitScript((l: string) => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_lang", l); }, lang);
  await ctx.route("**/hub/v1/**", async (q: any) => {
    const req = q.request(), u = new URL(req.url()), p = u.pathname + u.search;
    if (u.pathname.endsWith("/events")) return q.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 600000\n\n" });
    if (u.pathname === "/hub/v1/admin/overview") return q.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fleets: FLEETS, pairings: [], recommendedVersion: RECOMMENDED, recommendationRevision: 3 }) });
    // M-3141 (M-3138's API): nothing saved yet; a preview of Same as this Hub; a save.
    if (u.pathname === "/hub/v1/admin/recommended-version" && req.method() === "GET") return q.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: "none", version: null, recommendedVersion: null, hubVersion: "2.4.0-beta.3", configured: false, revision: 0, setAt: null }) });
    if (u.pathname === "/hub/v1/admin/recommended-version/preview") return q.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ recommendedVersion: "2.4.0-beta.3", affected: 3, revision: 0 }) });
    if (u.pathname === "/hub/v1/me/fleets") return q.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fleets: MINE }) });
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
    // Administration → Connected fleets.
    let o = await open(c, "/ui/hub/admin");
    await o.pg.waitForSelector(".hub-fleet-summary", { timeout: 20000 }); await o.pg.waitForTimeout(400);
    const card = o.pg.locator(".hub-fleet-list");
    await card.scrollIntoViewIfNeeded();
    const tags = await o.pg.locator(".hub-fleet-list .hub-rows > [data-fleet] .hub-fleet-tag").allTextContents();
    const badges = await o.pg.locator(".hub-fleet-list .badge, .hub-fleet-list .nav-count").count();
    check(`${tag} admin: five active rows tagged in the server's states, no badge, no page error`, tags.length === 5 && badges === 0 && o.errors.length === 0, { tags, badges, errors: o.errors });
    await card.screenshot({ path: join(out, `admin.${tag}.png`) }); keep(`admin.${tag}.png`);
    await o.pg.locator(".hub-fleet-filter").click(); await o.pg.waitForTimeout(200);
    const shown = await o.pg.locator(".hub-fleet-list .hub-rows > [data-fleet]").evaluateAll((rs: Element[]) => rs.filter((x) => !x.closest("details")).map((x) => x.getAttribute("data-fleet")));
    check(`${tag} filtered: only the four that need an update`, JSON.stringify(shown) === JSON.stringify(["f2", "f3", "f4", "f6"]), { shown });
    await card.screenshot({ path: join(out, `filtered.${tag}.png`) }); keep(`filtered.${tag}.png`);
    // M-3145: the update part of each row, and the button above the list (the filter shows exactly the behind ones).
    const many = await o.pg.locator(".hub-fleet-update-all .btn").textContent().catch(() => null);
    const lines = await o.pg.locator(".hub-fleet-list .hub-rows > [data-fleet]").evaluateAll((rs: Element[]) => rs.filter((x) => !x.closest("details"))
      .map((x) => [x.getAttribute("data-fleet"), (x.querySelector(".hub-fleet-update")?.textContent || "").replace(/\s+/g, " ").trim()]));
    check(`${tag} updates: Update {2} above; Update / Owner updates it / waiting (older version) + Cancel + Update to v{new} instead / rolled back + Try again`, /2/.test(many ?? "") && lines.length === 4
      && /(Update|更新)$/.test(lines[0][1]) && /(Owner updates it|由擁有者自行更新)/.test(lines[1][1]) && /(Cancel|取消)/.test(lines[2][1]) && /(Update to v2\.4\.0-beta\.3 instead|改為更新到 v2\.4\.0-beta\.3)/.test(lines[2][1]) && /(Try again|再試一次)/.test(lines[3][1]), { many, lines });
    await o.pg.setViewportSize({ width: VIEW[c[0]].width, height: 2400 }); await o.pg.waitForTimeout(200);   // the whole card, not the window's part
    await card.screenshot({ path: join(out, `updates.${tag}.png`) }); keep(`updates.${tag}.png`);
    await o.pg.setViewportSize(VIEW[c[0]]);
    // M-3141: the card above the list — nothing checked on npm for opening the page; Save shows the effect first.
    const rec = o.pg.locator(".hub-rec-card");
    await rec.waitFor({ timeout: 10000 }); await rec.scrollIntoViewIfNeeded();
    const hubChosen = await o.pg.locator('.hub-rec-choices input[value="hub"]').isChecked();
    check(`${tag} rec: Same as this Hub chosen before anything is saved`, hubChosen, { hubChosen });
    await rec.screenshot({ path: join(out, `rec.${tag}.png`) }); keep(`rec.${tag}.png`);
    await rec.locator(".save-row .btn-primary").click();
    await o.pg.waitForSelector(".hub-rec-preview", { timeout: 10000 }); await o.pg.waitForTimeout(200);
    const effect = await o.pg.locator(".hub-rec-preview").textContent();
    check(`${tag} rec: Save first shows the effect`, /3/.test(effect ?? ""), { effect });
    await rec.screenshot({ path: join(out, `rec-preview.${tag}.png`) }); keep(`rec-preview.${tag}.png`);
    const notified = await o.pg.locator('[data-fleet="f2"] .hub-fleet-notified').textContent().catch(() => null);
    check(`${tag} rows: a notified Fleet says when`, /(Owner notified|已通知擁有者)/.test(notified ?? ""), { notified });
    await o.ctx.close();
    // Chats home: the banner.
    o = await open(c, "/ui/hub");
    await o.pg.waitForSelector(".hub-versions-banner", { timeout: 20000 }); await o.pg.waitForTimeout(300);
    const text = await o.pg.locator(".hub-versions-banner span").first().textContent();
    check(`${tag} banner: names the person's own Fleet (version unknown: no parenthesis)`, /lab-server/.test(text ?? "") && !/[（(]/.test(text ?? "") && o.errors.length === 0, { text, errors: o.errors });
    await o.pg.screenshot({ path: join(out, `banner.${tag}.png`) }); keep(`banner.${tag}.png`);
    await o.ctx.close();
    // A room's members panel: whom to ask.
    o = await open(c, "/ui/hub?room=room-weekly");
    if (c[0] === "phone") { await o.pg.waitForSelector(".hub-room-rail-toggle", { timeout: 20000 }); await o.pg.locator(".hub-room-rail-toggle").click(); }
    await o.pg.waitForSelector(".hub-member-agent", { timeout: 20000 });
    const more = o.pg.locator(".hub-room-members button", { hasText: /^…/ });
    if (await more.count()) await more.first().click();
    const ask = await o.pg.locator(".hub-member-agent", { hasText: "old-helper" }).locator(".hub-member-owner").textContent();
    check(`${tag} members: the agent that needs an update says whom to ask`, /林小華/.test(ask ?? "") && /(ask|請通知)/.test(ask ?? ""), { ask });
    const panel = c[0] === "phone" ? o.pg.locator(".hub-rail-sheet") : o.pg.locator(".hub-room-members");
    await o.pg.locator(".hub-member-agent", { hasText: "old-helper" }).scrollIntoViewIfNeeded();
    await panel.first().screenshot({ path: join(out, `members.${tag}.png`) }); keep(`members.${tag}.png`);
    await o.ctx.close();
  }
} finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  await browser.close(); server.close();
}
const failed = receipt.checks.filter((x: any) => !x.ok).length;
console.log(JSON.stringify({ pass: failed === 0, checks: receipt.checks.length, failed, pictures: receipt.pictures.length }));
process.exit(failed ? 1 : 0);
