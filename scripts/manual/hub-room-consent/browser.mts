/** C consent service + R HTTP/SQLite + U owner/sidebar mounts on an owned HTTPS listener; inert directory/transport. */
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { provisionHubIdentity } from "../../../src/hub/tls.js";
import { listenLoopback } from "../smoke-fixture/listen-loopback.mjs";
import { personKeyString } from "../../../src/hub/identity.js";
import { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } from "../../../src/hub/invitations.js";
import type { HubExposure } from "../../../src/hub/types.js";

const out = resolve(process.env.OUT ?? ".artifacts/room-invitations-track-c/browser"); mkdirSync(out, { recursive: true });
const server = createServer(), port = await listenLoopback(server), origin = `https://127.0.0.1:${port}`;
const keys = mkdtempSync(join(out, "keys-"));
const r = await s3bRig({ webOrigin: origin }), owner = r.addPerson("owner", "Agent owner"), reader = r.addPerson("reader", "Project member");
r.httpDeps.uow.atomic(tx => HUB_ROOM_INVITATIONS_MIGRATION.up(r.sql(tx)));
r.httpDeps.roomInvitations = createHubRoomInvitations; await r.restartHttp();
const admin = await r.signIn("admin"), actor = await r.signIn("owner"), fleetId = randomUUID(), link = r.link(fleetId, owner), exposures: HubExposure[] = [];
await provisionHubIdentity({ home: keys, memberOrigin: origin });
server.setSecureContext({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) });
server.on("request", (req, res) => {
  if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); }
});
const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
let browser: any;
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const receipt: any = { origin, sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope: "Owned HTTPS/SQLite real C consent/R HTTP with the public U owner/sidebar mounts. Fake directory/transport; no real agent, AD or input; no API response fixtures.",
  checks: [], pictures: [], requests: [], served: {}, geometry: [] };
const check = (name: string, ok: unknown) => { receipt.checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); };
try {
  browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
  for (const device of ["desktop", "phone"]) for (const lang of ["en", "zh-TW"]) for (const theme of ["light", "dark"]) {
    const tag = `${device}-${lang}-${theme}`, id = randomUUID(), errors: string[] = [];
    if (process.env.CASE && process.env.CASE !== tag) continue;
    exposures.push({ id, fleetId, owner, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
    await r.http.receive(r.frame("exposure.snapshot", { revision: exposures.length, exposures }, link) as never, link);
    const room = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Project room", people: [personKeyString(reader)] }); check(tag + " room created", room.status === 200);
    const roomId = room.json.room.id, invitation = await r.call(admin, "POST", `/hub/v1/rooms/${roomId}/invitations`, { agents: [id] }); check(tag + " real invitation created", invitation.status === 200);
    const context = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, locale: lang, colorScheme: theme,
      ignoreHTTPSErrors: true, isMobile: device === "phone", hasTouch: device === "phone" });
    const split = actor.cookie.indexOf("="); await context.addCookies([{ name: actor.cookie.slice(0, split), value: actor.cookie.slice(split + 1), url: origin, httpOnly: true, secure: true, sameSite: "Strict" }]);
    await context.addInitScript(({ lang, theme }) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); }, { lang, theme });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.on("pageerror", (e: Error) => errors.push(e.message));
    const responseWork: Promise<void>[] = [];
    page.on("response", (response: any) => {
      const url = new URL(response.url()), path = url.pathname;
      if (path.startsWith("/hub/v1/")) receipt.requests.push({ method: response.request().method(), path: path + url.search, status: response.status() });
      if (path.startsWith("/assets/") || path.startsWith("/ui/js/")) responseWork.push(response.body().then((body: Buffer) => { receipt.served[path] = sha(body); }).catch(() => {}));
    });
    const shot = async (name: string) => { const file = `${tag}-${name}.png`; await page.screenshot({ path: join(out, file), fullPage: true }); receipt.pictures.push({ path: file, sha256: sha(readFileSync(join(out, file))) }); };
    const open = () => page.goto(`${origin}/ui/hub?view=invitations`);
    await page.goto(`${origin}/ui/hub/exposures`); await page.locator(".hub-invitation").waitFor();
    check(tag + " owner list mount", await page.locator(".p-hub .hub-invitation").count() === 1);
    await page.locator("#sidebar button.hub-invitations-row").waitFor({ state: "attached" });
    check(tag + " sidebar invitation mount", await page.locator("#sidebar button.hub-invitations-row").count() === 1);
    await open(); await page.locator(".hub-invitation").waitFor();
    check(tag + " participant disclosure", (await page.locator(".hub-invitation").innerText()).includes(lang === "en" ? "2 people" : "2 個人"));
    await page.waitForFunction(() => !!document.querySelector<HTMLLinkElement>('link[data-hub-rooms-u2-css="1"]')?.sheet);
    const sizes = await page.locator(".hub-invitation button").evaluateAll((buttons: HTMLElement[]) => buttons.map(b => b.getBoundingClientRect().height));
    receipt.geometry.push({ tag, buttonHeights: sizes }); await shot("pending");
    check(tag + " touch targets", device !== "phone" || sizes.every((h: number) => h >= 44));
    await page.getByRole("button", { name: lang === "en" ? "Agree" : "同意", exact: true }).click();
    await page.locator(".hub-invitation").waitFor({ state: "detached" });
    await page.goto(`${origin}/ui/hub/exposures?agent=${id}`); await page.locator(".hub-agent-rooms li").waitFor();
    check(tag + " accepted in SQLite", !!r.db.prepare("SELECT 1 FROM hub_room_members WHERE kind='agent' AND room_id=? AND subject=? AND owner_at_join=?").get(roomId, id, personKeyString(owner)));
    check(tag + " owner not made room person", !r.db.prepare("SELECT 1 FROM hub_room_members WHERE kind='person' AND room_id=? AND subject=?").get(roomId, personKeyString(owner)));
    check(tag + " owner cannot read room history", (await r.call(actor, "GET", `/hub/v1/rooms/${roomId}`)).status === 403);
    const leaveSizes = await page.locator(".hub-agent-rooms button").evaluateAll((buttons: HTMLElement[]) => buttons.map(b => b.getBoundingClientRect().height));
    receipt.geometry.push({ tag, leaveButtonHeights: leaveSizes }); await shot("accepted");
    check(tag + " leave touch target", device !== "phone" || leaveSizes.every((h: number) => h >= 44));
    await page.locator(".hub-agent-rooms button").click(); await page.locator(".hub-agent-rooms").waitFor({ state: "detached" });
    check(tag + " owner leave saved", !r.db.prepare("SELECT 1 FROM hub_room_members WHERE kind='agent' AND room_id=? AND subject=?").get(roomId, id));
    const again = await r.call(admin, "POST", `/hub/v1/rooms/${roomId}/invitations`, { agents: [id] }); check(tag + " manager can invite again", again.status === 200);
    await open(); await page.locator(".hub-invitation").waitFor(); await page.getByRole("button", { name: lang === "en" ? "Decline" : "不要", exact: true }).click(); await page.locator(".hub-invitation").waitFor({ state: "detached" });
    check(tag + " decline saved", (r.db.prepare("SELECT state FROM hub_room_invitations WHERE id=?").get(again.json.invited[0].id) as { state: string }).state === "declined");
    check(tag + " no page errors", errors.length === 0); check(tag + " no overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await Promise.all(responseWork); await context.close();
  }
} catch (error) { receipt.checks.push({ name: "run completed", ok: false, error: String(error) }); }
finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await r.close(); rmSync(keys, { recursive: true, force: true });
  receipt.cleanup = { browserClosed: !!browser, listenerClosed: !server.listening, keysRemoved: !existsSync(keys) };
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify({ checks: receipt.checks.length, failed: receipt.checks.filter((x: any) => !x.ok).length, pictures: receipt.pictures.length }));
process.exitCode = receipt.checks.some((x: any) => !x.ok) ? 1 : 0;
