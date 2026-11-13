/** Shared U1/U2 UI against real R HTTP/SQLite and A service plus C consent. Directory/worker are inert; no API response fixture. */
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { provisionHubIdentity } from "../../../src/hub/tls.js";
import { personKeyString } from "../../../src/hub/identity.js";
import { createHubDirectoryAdmission } from "../../../src/hub/directory/admission.js";
import { RoomAssistantService } from "../../../src/hub/assistant/service.js";
import { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } from "../../../src/hub/invitations.js";
import type { HubExposure } from "../../../src/hub/types.js";

const repo = process.cwd(), out = resolve(process.env.OUT ?? ".artifacts/rooms-integration/browser");
mkdirSync(out, { recursive: true });
const keys = mkdtempSync(join(out, "keys-")), port = 49700 + Math.floor(Math.random() * 200), origin = `https://127.0.0.1:${port}`;
const r = await s3bRig({ webOrigin: origin }), alex = r.addPerson("alex", "Alex"), unseen = r.addPerson("new-person", "Never signed in"), group = randomUUID();
const admin = await r.signIn("admin"), actor = await r.signIn("alex");
r.httpDeps.directoryReads = createHubDirectoryAdmission(() => true);
r.directory.searchGrantPeople = async () => ({ ok: true, people: [], truncated: false });
r.directory.searchPolicyGroups = async () => ({ ok: true, groups: [{ objectId: group, cn: "Pilot direct group", dn: "CN=Pilot,DC=test" }], truncated: false });
r.directory.roomGroupMembers = async key => ({ ok: true, group: { key, name: "Pilot direct group" }, people: [{ key: unseen, login: "new-person", displayName: "Never signed in", dn: "private", groups: [] }] });
let workerCalls = 0;
const service = new RoomAssistantService({
  host: { start: async () => ({ ask: async input => { workerCalls++; return { text: "Owned assistant answer: " + input.text }; }, stop: async () => {} }) },
  store: { load: async () => null, save: async () => {} },
  backends: () => [{ id: "claude-code", name: "Claude", accounts: [{ id: null, name: "Default", state: "signed-in" }] }],
});
r.httpDeps.uow.atomic(tx => HUB_ROOM_INVITATIONS_MIGRATION.up(r.sql(tx)));
r.httpDeps.roomInvitations = createHubRoomInvitations;
const consentFleet = randomUUID(), consentLink = r.link(consentFleet, alex), exposures: HubExposure[] = [];
await service.settings(); r.httpDeps.roomAssistant = service; r.httpDeps.assistantAdmin = service; await r.restartHttp();
const config = { enabled: true, backend: "claude-code", account: null, cap: 3, idleMinutes: 15 };
if ((await r.call(admin, "PUT", "/hub/v1/admin/assistant", config)).status !== 200) throw Error("assistant configure");
if ((await r.call(admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [personKeyString(alex)], teams: [] })).status !== 200) throw Error("creator setup");
const initial = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Pilot weekly", people: [personKeyString(alex)], assistant: true });
if (initial.status !== 200) throw Error("room seed");
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) }, (req, res) => {
  if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); }
});
await new Promise<void>(yes => server.listen(port, "127.0.0.1", yes));
const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core"), browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const receipt: any = { sourceHead: execFileSync("git", ["-c", "gc.auto=0", "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), scope: "Real R HTTP/SQLite + A service/runner + shared U1/U2 browser components; inert directory and physical worker; all list/new-room/thread/settings/admin views mounted by the actual Hub shell; C consent service/migration are injected at the real HTTP boundary; Teams remain uncomposed; production factory registration is checked separately by hub-compose tests", checks: [], pictures: [], requests: [], served: {} };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
try {
  for (const [device, lang, theme] of [["desktop", "en", "light"], ["phone", "zh-TW", "dark"]]) {
    const tag = `${device}-${lang}-${theme}`, errors: string[] = [], context = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, locale: lang, colorScheme: theme, ignoreHTTPSErrors: true, hasTouch: device === "phone", isMobile: device === "phone" });
    const at = actor.cookie.indexOf("=");
    await context.addCookies([{ name: actor.cookie.slice(0, at), value: actor.cookie.slice(at + 1), url: origin, httpOnly: true, secure: true, sameSite: "Strict" }]);
    await context.addInitScript(({ lang, theme }) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); }, { lang, theme });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const p = await context.newPage(); p.on("pageerror", (e: Error) => errors.push(e.message));
    const responses: Promise<void>[] = [];
    p.on("response", (response: any) => {
      const u = new URL(response.url());
      if (u.pathname.startsWith("/hub/v1/")) receipt.requests.push({ method: response.request().method(), path: u.pathname + u.search, status: response.status() });
      if (u.pathname.startsWith("/assets/") || u.pathname.startsWith("/ui/js/")) responses.push(response.body().then((body: Buffer) => { receipt.served[u.pathname] = sha(body); }).catch(() => {}));
    });
    const shot = async (name: string) => { const path = `${tag}-${name}.png`; await p.screenshot({ path: join(out, path), fullPage: true }); receipt.pictures.push({ path, sha256: sha(readFileSync(join(out, path))) }); };
    await p.goto(origin + "/ui/hub"); await p.locator(".inst-name:visible").filter({ hasText: "Pilot weekly" }).first().waitFor();
    check(tag + " list reads real room and private assistant", (await p.locator("body").innerText()).includes(lang === "en" ? "Hub assistant" : "Hub 助理")); await shot("list");
    if (!await p.locator(".hub-new-room").isVisible()) await p.locator("#sbOpen").click();
    await p.locator(".hub-new-room:visible").click(); await p.locator("#hubRoomName").fill("Browser room " + tag);
    check(tag + " New room opens from the actual sidebar", !p.url().includes("/__rooms/"));
    await p.locator("#hubRoomPeople").fill("Pilot"); await p.getByRole("option").filter({ hasText: "Pilot direct group" }).click();
    await p.locator(".hub-room-tags").filter({ hasText: "Pilot direct group" }).waitFor();
    const chip = await p.locator(".hub-room-tags").allTextContents().then((s: string[]) => s.join(" "));
    check(tag + " complete direct group preview shows singular count", /Pilot direct group.*1/.test(chip) && (lang !== "en" || /1 person(?!s)/.test(chip)));
    await p.locator("#hubRoomAssistant").check(); await shot("new-group");
    await p.getByRole("button", { name: lang === "en" ? "Create" : "建立", exact: true }).click();
    await p.waitForURL("**/ui/hub?room=*"); await p.locator(".hub-room-page").waitFor();
    const id = new URL(p.url()).searchParams.get("room")!, detail = await r.call(actor, "GET", `/hub/v1/rooms/${id}`);
    check(tag + " create persists complete group and never-signed-in state", detail.json.members.some((m: any) => m.kind === "person" && m.signedIn === false));
    await p.locator(".hub-room-composer textarea").fill("Browser human message " + tag); await p.locator(".hub-room-composer #sendBtn").click();
    await p.getByText("Browser human message " + tag, { exact: true }).first().waitFor();
    const systemLine = p.locator(".status-line").filter({ hasText: lang === "en" ? "Alex created this room." : "Alex 建立了這個房間。" });
    await systemLine.waitFor(); check(tag + " system sentence follows viewer language without message actions", await systemLine.locator(".msg-tools").count() === 0);
    check(tag + " members toggle uses a shared SVG icon", await p.locator(".hub-room-rail-toggle svg").count() === 1); await shot("thread");
    check(tag + " human message uses actual SQL", (await r.call(actor, "GET", `/hub/v1/rooms/${id}/messages`)).text.includes("Browser human message " + tag));
    await p.locator(".hub-room-settings-open").click(); await p.locator("#hubRoomSettingsName").waitFor();
    check(tag + " room settings is mounted by the actual shell", await p.locator(".hub-room-settings").count() === 1);
    const nameBox = await p.locator("#hubRoomSettingsName").boundingBox(), saveBox = await p.locator(".hub-room-name-row .btn").boundingBox();
    check(tag + " Name Save button aligns with the input", !!nameBox && !!saveBox && Math.abs(nameBox.y - saveBox.y) <= 2 && Math.abs(nameBox.height - saveBox.height) <= 2);
    const renamed = "Saved room " + tag;
    await p.locator("#hubRoomSettingsName").fill(renamed);
    const saved = p.waitForResponse((res: any) => res.request().method() === "PATCH" && new URL(res.url()).pathname === `/hub/v1/rooms/${id}`);
    await p.locator(".hub-room-settings").getByRole("button", { name: lang === "en" ? "Save" : "儲存", exact: true }).click(); await saved;
    check(tag + " settings rename persists through actual HTTP", (await r.call(actor, "GET", `/hub/v1/rooms/${id}`)).json.room.name === renamed);
    const toggled = p.waitForResponse((res: any) => res.request().method() === "PATCH" && new URL(res.url()).pathname === `/hub/v1/rooms/${id}`);
    await p.locator("#hubRoomAllMention").uncheck(); await toggled;
    check(tag + " settings all-mention switch persists through actual HTTP", (await r.call(actor, "GET", `/hub/v1/rooms/${id}`)).json.settings.allMention === false);
    await shot("settings"); await p.locator(".hub-room-settings .dlg-x").click();
    const mention = lang === "en" ? "@Room assistant" : "@房間助理", groupAsk = mention + " Group assistant request " + tag;
    await p.locator(".hub-room-composer textarea").fill(groupAsk); await p.locator(".hub-room-composer #sendBtn").click();
    await p.getByText("Owned assistant answer: " + groupAsk, { exact: true }).first().waitFor();
    check(tag + " localized room assistant mention reaches actual A service", workerCalls > 0);
    const list = await r.call(actor, "GET", "/hub/v1/rooms?v=2"), assistant = list.json.rooms.find((room: any) => room.assistant);
    await p.goto(origin + "/ui/hub?room=" + assistant.id); await p.locator(".hub-room-composer textarea").waitFor();
    const directPrompt = lang === "en" ? "Ask the Hub assistant" : "問 Hub 助理";
    // ComposerInput draws its placeholder in .composer-ph and exposes it through aria-label; its native placeholder is one space.
    await p.waitForFunction((expected: string) => document.querySelector(".hub-room-composer textarea")?.getAttribute("aria-label") === expected, directPrompt, { timeout: 5_000 });
    check(tag + " private assistant composer uses its direct prompt", (await p.locator(".hub-room-composer textarea").getAttribute("aria-label")) === directPrompt && (await p.locator(".hub-room-composer .composer-ph").innerText()) === directPrompt);
    await p.locator(".hub-room-composer textarea").fill("Browser plain assistant request " + tag); await p.locator(".hub-room-composer #sendBtn").click();
    await p.getByText("Owned assistant answer: Browser plain assistant request " + tag, { exact: true }).first().waitFor();
    check(tag + " plain private ask reaches actual A service", workerCalls > 0);
    check(tag + " assistant label follows viewer language", lang !== "zh-TW" || !(await p.locator("body").innerText()).includes("Hub assistant")); await shot("assistant");
    const exposureId = randomUUID();
    exposures.push({ id: exposureId, fleetId: consentFleet, owner: alex, displayName: "Notes " + tag, revision: 1,
      state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
    await r.http.receive(r.frame("exposure.snapshot", { revision: exposures.length, exposures }, consentLink) as never, consentLink);
    const consentRoom = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Consent room " + tag, people: [personKeyString(unseen)] });
    check(tag + " consent room created", consentRoom.status === 200);
    const consentRoomId = consentRoom.json.room.id;
    const invite = await r.call(admin, "POST", `/hub/v1/rooms/${consentRoomId}/invitations`, { agents: [exposureId] });
    check(tag + " C invitation created by actual HTTP", invite.status === 200);
    await p.goto(origin + "/ui/hub?view=invitations"); await p.locator(".hub-invitation").waitFor();
    check(tag + " actual owner page discloses the room and people count", (await p.locator(".hub-invitation").innerText()).includes("Consent room " + tag)
      && (await p.locator(".hub-invitation").innerText()).includes(lang === "en" ? "2 people" : "2 個人"));
    const invitationTitle = lang === "en" ? "Invitations" : "邀請";
    check(tag + " invitation page has one plural title", (await p.locator(".p-hub-invitations .panel-title h1").innerText()) === invitationTitle
      && await p.locator(".p-hub-invitations .hub-invitations h3").count() === 0);
    check(tag + " invitation explains the recent room context", (await p.locator(".hub-invitation").innerText()).includes(lang === "en"
      ? "When @-ed, it reads the room's recent messages." : "被 @ 時，它會讀到房間最近的訊息。"));
    await shot("consent-pending");
    const invitationNav = p.locator('#sidebar .side-nav a.side-row[href="/ui/hub?view=invitations"]');
    if (!await invitationNav.isVisible()) await p.locator("#sbOpen").click();
    const navBox = await invitationNav.boundingBox(), firstNav = await p.locator("#sidebar .side-nav a.side-row").first().boundingBox();
    check(tag + " invitation is a normal nav row with count badge", (await invitationNav.locator(".grow").innerText()) === invitationTitle
      && (await invitationNav.locator(".nav-count").innerText()) === "1" && !!navBox && !!firstNav && Math.abs(navBox.height - firstNav.height) <= 2
      && await p.locator("#sidebar .hub-invitations-row").count() === 0);
    await shot("consent-nav"); await invitationNav.click();

    await p.getByRole("button", { name: lang === "en" ? "Agree" : "同意", exact: true }).click();
    await p.locator(".hub-invitation").waitFor({ state: "detached" });
    await p.goto(origin + "/ui/hub/exposures?agent=" + exposureId); await p.locator(".hub-agent-rooms li").waitFor();
    check(tag + " owner acceptance persisted exact agent membership", !!r.db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=?").get(consentRoomId, exposureId));
    check(tag + " consent did not add owner as person", !r.db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='person' AND subject=?").get(consentRoomId, personKeyString(alex)));
    check(tag + " owner room list names the accepted room", (await p.locator(".hub-agent-rooms").innerText()).includes("Consent room " + tag));
    const roomLead = lang === "en" ? "No one may ask it one-to-one yet · in 1 room" : "還沒有人可以一對一提問 · 在 1 個房間裡";
    await p.waitForFunction((text: string) => document.querySelector(".s-page-lead")?.textContent === text, roomLead);
    check(tag + " owner lead distinguishes one-to-one from room reach", (await p.locator(".s-page-lead").innerText()) === roomLead);
    check(tag + " Who may ask explains room reach", (await p.locator(".hub-rooms-can-ask").innerText()) === (lang === "en"
      ? "People in its rooms can @ it there. See In these rooms." : "房間裡的人可以在房間裡 @ 它，見「在這些房間裡」。"));
    check(tag + " agent rooms sit directly after Who may ask", await p.evaluate(() => document.querySelector(".hub-rooms-can-ask")?.closest("section")?.nextElementSibling === document.querySelector(".hub-agent-rooms")));
    check(tag + " owner count comes from the section's single real read", receipt.requests.filter((r: any) => r.method === "GET" && r.path === `/hub/v1/exposures/${exposureId}/rooms`).length === 1);

    await shot("consent-accepted");
    await p.locator(".hub-agent-rooms button").click(); await p.locator(".hub-agent-rooms").waitFor({ state: "detached" });
    check(tag + " owner removal persisted through actual route", !r.db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=?").get(consentRoomId, exposureId));
    const noRoomLead = lang === "en" ? "No one may ask yet" : "還沒有人可以提問";
    await p.waitForFunction((text: string) => document.querySelector(".s-page-lead")?.textContent === text, noRoomLead);
    check(tag + " owner lead follows zero rooms after Leave", (await p.locator(".s-page-lead").innerText()) === noRoomLead
      && await p.locator(".hub-rooms-can-ask").count() === 0);

    const reinvited = await r.call(admin, "POST", `/hub/v1/rooms/${consentRoomId}/invitations`, { agents: [exposureId] });
    check(tag + " manager can invite again after owner removal", reinvited.status === 200);
    await p.goto(origin + "/ui/hub?view=invitations"); await p.locator(".hub-invitation").waitFor();
    await p.getByRole("button", { name: lang === "en" ? "Decline" : "不要", exact: true }).click();
    await p.locator(".hub-invitation").waitFor({ state: "detached" });
    check(tag + " decline persisted without re-adding agent", (r.db.prepare("SELECT state FROM hub_room_invitations WHERE id=?").get(reinvited.json.invited[0].id) as { state: string }).state === "declined"
      && !r.db.prepare("SELECT 1 FROM hub_room_members WHERE room_id=? AND kind='agent' AND subject=?").get(consentRoomId, exposureId));
    check(tag + " no page errors", errors.length === 0, errors);
    check(tag + " no horizontal document overflow", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const adminAt = admin.cookie.indexOf("="); await context.clearCookies();
    await context.addCookies([{ name: admin.cookie.slice(0, adminAt), value: admin.cookie.slice(adminAt + 1), url: origin, httpOnly: true, secure: true, sameSite: "Strict" }]);
    await p.goto(origin + "/ui/hub/admin"); await p.locator("#hubRoomCreators").waitFor();
    check(tag + " admin room card uses named creator projection", (await p.locator(".hub-admin-creators").innerText()).includes("Alex"));
    check(tag + " admin room table contains actual created room", (await p.locator(".hub-admin-rooms-table").innerText()).includes(renamed));
    const assistantCard = p.getByRole("heading", { name: lang === "en" ? "Room assistant" : "房間助理", exact: true }).locator("..");
    await assistantCard.getByRole("combobox", { name: lang === "en" ? "Backend" : "後端", exact: true }).waitFor();
    check(tag + " signed-in assistant account omits sign-in instructions", (await assistantCard.locator(".s-group .note").first().innerText()) === (lang === "en" ? "Signed in." : "已登入"));
    check(tag + " admin cards keep rooms-assistant-fleets-pairing order", await assistantCard.evaluate((card: Element) => {
      const nodes = [document.querySelector(".hub-admin-rooms"), card, document.querySelector(".hub-fleet-list"), document.querySelector("#hubOwnerLogin")?.closest("section.card")];
      return nodes.every((node, i) => !!node && (i === 0 || !!(nodes[i - 1]!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)));
    })); await shot("admin");
    check(tag + " admin view has no horizontal document overflow", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (device === "phone") {
      const tableViewport = p.locator(".hub-admin-all-rooms"); await tableViewport.scrollIntoViewIfNeeded();
      await tableViewport.evaluate((el: HTMLElement) => { el.scrollLeft = el.scrollWidth; });
      const rowMenu = p.locator(".hub-admin-rooms-table tbody tr").first().locator("td").last().getByRole("button");
      const box = await rowMenu.boundingBox(); await rowMenu.click(); await p.getByRole("menuitem").first().waitFor();
      check(tag + " internal room-table scroll exposes row actions", !!box && box.x >= 0 && box.x + box.width <= 391 && await p.getByRole("menuitem").count() >= 2);
      await shot("admin-table-actions"); await p.keyboard.press("Escape"); await tableViewport.evaluate((el: HTMLElement) => { el.scrollLeft = 0; });
      await assistantCard.locator(".s-group .note").first().scrollIntoViewIfNeeded(); await shot("admin-account");
    }
    await p.locator(".hub-fleet-list").scrollIntoViewIfNeeded(); await shot("admin-tail");
    await Promise.all(responses); await context.close();
  }
} catch (error) { check("run completed", false, String(error)); }
finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2)); await browser.close();
  await r.http.close(); await new Promise<void>(yes => server.close(() => yes())); await r.close(); await service.close(); rmSync(keys, { recursive: true, force: true });
}
console.log(JSON.stringify({ checks: receipt.checks.length, failed: receipt.checks.filter((x: any) => !x.ok).length, pictures: receipt.pictures.length }));
process.exitCode = receipt.checks.some((x: any) => !x.ok) ? 1 : 0;
