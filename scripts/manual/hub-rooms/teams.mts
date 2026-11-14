/** Two Team journeys against real HTTP/session/SQLite and shared UI; directory and agent input are inert. */
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { provisionHubIdentity } from "../../../src/hub/tls.js";
import { personKeyString } from "../../../src/hub/identity.js";
import { createHubTeams, HUB_TEAMS_MIGRATION, HUB_TEAM_GRANTS_MIGRATION } from "../../../src/hub/teams/index.js";
import { listenLoopback } from "../smoke-fixture/listen-loopback.mjs";

const out = resolve(process.env.OUT ?? ".artifacts/rooms-integration/teams/browser"); mkdirSync(out, { recursive: true });
const server = createServer(), port = await listenLoopback(server), origin = `https://127.0.0.1:${port}`;
const keys = mkdtempSync(join(out, "keys-")), rig = await s3bRig({ webOrigin: origin }); let browser: any;
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const receipt: any = { sourceHead: execFileSync("git", ["-c", "gc.auto=0", "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope: "Two shared-UI Team journeys using actual R HTTP/session/SQLite and C Team provider. No API response fixture. Directory facts and agent input are inert; production migration/mount checked separately by hub-compose.",
  checks: [], pictures: [], requests: [], assets: [] };
const check = (name: string, value: unknown) => { receipt.checks.push({ name, ok: !!value }); console.log(`${value ? "PASS" : "FAIL"} ${name}`); if (!value) throw Error(name); };
try {
  const alex = rig.addPerson("alex", "Alex"), sam = rig.addPerson("sam", "Sam"), riley = rig.addPerson("riley", "Riley");
  const department = randomUUID(), people = [{ key: alex, login: "alex", name: "Alex" }, { key: sam, login: "sam", name: "Sam" }, { key: riley, login: "riley", name: "Riley" }];
  const eligible = rig.directory.checkEligibility.bind(rig.directory);
  Object.assign(rig.directory, { groupPolicy: "ad-direct-guid" });
  rig.directory.checkEligibility = async key => { const answer = await eligible(key), found = people.find(p => personKeyString(p.key) === personKeyString(key));
    return answer.eligible && found ? { ...answer, person: { ...answer.person, displayName: found.name, department: "Engineering" } } : answer; };
  rig.directory.checkPolicyGroup = async key => ({ ok: true, group: { key, dn: "CN=Engineering,DC=example,DC=test" } });
  rig.directory.searchPolicyGroups = async () => ({ ok: true, groups: [{ objectId: department, cn: "Engineering", dn: "CN=Engineering,DC=example,DC=test" }], truncated: false });
  rig.directory.searchGrantPeople = async prefix => ({ ok: true, people: people.filter(p => p.name.toLowerCase().startsWith(prefix.toLowerCase())).map(p => ({ person: p.key, displayName: p.name, login: p.login })), truncated: false });
  rig.httpDeps.uow.atomic(tx => { HUB_TEAMS_MIGRATION.up(rig.sql(tx)); HUB_TEAM_GRANTS_MIGRATION.up(rig.sql(tx)); });
  rig.httpDeps.teams = createHubTeams; await rig.restartHttp();
  const admin = await rig.signIn("admin"), lead = await rig.signIn("alex"), member = await rig.signIn("sam");
  await provisionHubIdentity({ home: keys, memberOrigin: origin });
  server.setSecureContext({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) });
  server.on("request", (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
  const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
  browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
  for (const [device, lang, theme] of [["desktop", "en", "light"], ["phone", "zh-TW", "dark"]]) {
    const tag = `${device}-${lang}-${theme}`, en = lang === "en", name = `Launch ${tag}`, errors: string[] = [], responses: Promise<void>[] = [];
    const context = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 1000 }, locale: lang,
      colorScheme: theme, ignoreHTTPSErrors: true, isMobile: device === "phone", hasTouch: device === "phone" });
    const cookie = async (auth: typeof admin) => { const at = auth.cookie.indexOf("="); await context.addCookies([{ name: auth.cookie.slice(0, at), value: auth.cookie.slice(at + 1), url: origin, secure: true, httpOnly: true }]); };
    await cookie(admin);
    await context.addInitScript(({ lang, theme }) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); }, { lang, theme });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("response", (response: any) => { const url = new URL(response.url());
      if (url.pathname.startsWith("/hub/v1/")) receipt.requests.push({ tag, method: response.request().method(), path: url.pathname + url.search, status: response.status() });
      if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/ui/js/")) responses.push(response.body().then((value: Buffer) => receipt.assets.push({ path: url.pathname, sha256: digest(value) })).catch(() => {})); });
    const shot = async (suffix: string) => { const path = `${tag}-${suffix}.png`; await page.screenshot({ path: join(out, path), fullPage: true }); receipt.pictures.push({ path, sha256: digest(readFileSync(join(out, path))) }); };
    const choose = async (query: string) => { await page.locator(".hub-team-search input").fill(query); await page.locator(".hub-team-search").getByRole("button", { name: en ? "Search" : "搜尋", exact: true }).click();
      await page.locator(".hub-team-hits li").waitFor(); await page.locator(".hub-team-hits button").first().click(); };
    const save = async (method: string, path: string) => { const done = page.waitForResponse((response: any) => response.request().method() === method && new URL(response.url()).pathname === path);
      await page.locator(".hub-team-editor").getByRole("button", { name: en ? "Save" : "儲存", exact: true }).click(); const response = await done; check(tag + " " + method + " Team save", response.ok()); return response.json(); };
    await page.goto(origin + "/ui/hub/admin?view=teams"); await page.getByRole("button", { name: en ? "New team" : "新增團隊", exact: true }).click();
    await page.locator("[data-team-name]").fill(name); await choose("En");
    await page.getByRole("button", { name: en ? "Choose a lead" : "選擇負責人", exact: true }).click(); await choose("Alex");
    await page.getByRole("button", { name: en ? "Add member" : "加入成員", exact: true }).click(); await choose("Sam");
    const made = await save("POST", "/hub/v1/teams"), teamId = made.team.id;
    await page.locator(".hub-team-editor tbody tr").first().waitFor();
    check(tag + " fresh Team CSS", await page.locator('link[data-hub-teams-css="1"]').evaluate((link: HTMLLinkElement) => !!link.sheet));
    check(tag + " server roster has selected lead and member", JSON.stringify([...made.team.members].sort()) === JSON.stringify([personKeyString(alex), personKeyString(sam)].sort()));
    check(tag + " page fits", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await shot("admin-roster");
    await rig.call(admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [], teams: [teamId] });
    const exposureId = randomUUID(), link = rig.link(randomUUID(), rig.admin);
    await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId: link.fleetId, owner: rig.admin, displayName: "Project helper", revision: 1,
      state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
    const grant = await rig.call(admin, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, days: 1, subject: { kind: "team", teamId } }); check(tag + " Team grant created", grant.status === 200);
    const group = await rig.call(admin, "POST", "/hub/v1/rooms", { name, teams: [teamId], agents: [exposureId] }); check(tag + " Team snapshot room created", group.status === 200);
    const roomPath = `/hub/v1/rooms/${group.json.room.id}`;
    // A visual-only repair can revisit just the deletion panel without repeating
    // the completed roster/grant/creator acceptance sequence.
    if (process.env.DELETE_PREVIEW_ONLY === "1") {
      // Match the completed journey: reopen detail after grants/room creation,
      // so the preview includes the current impact rather than the create reply.
      await page.goto(origin + "/ui/hub/admin?view=teams");
      await page.getByRole("button", { name: en ? `Edit ${name}` : `編輯 ${name}`, exact: true }).click();
      await page.getByRole("button", { name: en ? "Remove Sam" : "移除 Sam", exact: true }).waitFor();
      await page.getByRole("button", { name: en ? "Delete team" : "刪除團隊", exact: true }).click();
      const panel = page.locator(".hub-team-delete"); await panel.waitFor(); await panel.scrollIntoViewIfNeeded();
      await shot("delete-impact"); await Promise.all(responses); await context.close(); continue;
    }
    await rig.call(admin, "POST", roomPath + "/messages", { text: "Welcome to the team", mentions: [], idempotencyKey: randomUUID() });
    const canAsk = async () => (await rig.call(member, "GET", roomPath)).json.members.find((m: any) => m.id === exposureId).canAsk;
    check(tag + " current Team member can ask directly", await canAsk());
    await cookie(lead); await page.goto(origin + "/ui/hub?view=teams"); await page.getByRole("button", { name: en ? `Edit ${name}` : `編輯 ${name}`, exact: true }).click();
    await page.locator(".hub-team-editor tbody tr").first().waitFor();
    check(tag + " lead has roster controls only", await page.locator("[data-team-name]").count() === 0 && await page.getByRole("button", { name: en ? "Delete team" : "刪除團隊", exact: true }).count() === 0);
    await page.getByRole("button", { name: en ? "Add member" : "加入成員", exact: true }).click(); await choose("Riley"); await save("PATCH", `/hub/v1/teams/${teamId}`);
    check(tag + " lead search and save reach actual provider", (await rig.call(lead, "GET", `/hub/v1/teams/${teamId}`)).json.team.members.includes(personKeyString(riley)));
    check(tag + " added roster member is not silently added to the existing room", !(await rig.call(lead, "GET", roomPath)).json.members.some((m: any) => m.name === "Riley"));
    await shot("lead-roster");
    const labels = await page.locator(".hub-team-editor tbody td:first-child strong").allTextContents();
    check(tag + " member names survive a roster save", labels.includes("Sam") && labels.includes("Riley"));
    await page.getByRole("button", { name: en ? "Remove Sam" : "移除 Sam", exact: true }).click(); await save("PATCH", `/hub/v1/teams/${teamId}`);
    check(tag + " removed roster member loses direct ask", !await canAsk());
    check(tag + " removed roster member keeps room snapshot", (await rig.call(member, "GET", roomPath)).status === 200);
    if (device === "phone") { await page.locator("#sbOpen").click(); await page.waitForFunction(() => { const r = document.getElementById("sidebar")?.getBoundingClientRect(); return !!r && r.left >= -0.5; });
      check(tag + " My teams is present without a session person key", await page.locator('.side-nav a[href="/ui/hub?view=teams"]').isVisible()); await shot("lead-navigation"); }
    await cookie(member); await page.goto(origin + `/ui/hub?room=${group.json.room.id}`); await page.locator(".hub-room-page").waitFor();
    check(tag + " other person has a bubble", await page.locator(".msg-person").count() > 0);
    if (device === "phone") check(tag + " room has a back link", await page.locator("a.hub-back:visible").getAttribute("href") === "/ui/hub"); await shot("snapshot-room");
    await cookie(admin); await page.goto(origin + "/ui/hub/admin?view=teams"); await page.getByRole("button", { name: en ? `Edit ${name}` : `編輯 ${name}`, exact: true }).click();
    await page.getByRole("button", { name: en ? "Delete team" : "刪除團隊", exact: true }).click(); await page.locator(".hub-team-delete").waitFor(); await page.locator(".hub-team-delete").scrollIntoViewIfNeeded(); await shot("delete-impact");
    const deleted = page.waitForResponse((response: any) => response.request().method() === "DELETE" && new URL(response.url()).pathname === `/hub/v1/teams/${teamId}`);
    await page.locator(".hub-team-delete").getByRole("button", { name: en ? "Delete team" : "刪除團隊", exact: true }).click(); check(tag + " Team deleted through UI", (await deleted).ok());
    check(tag + " deleting Team ends creator rights", !(await rig.call(lead, "GET", "/hub/v1/rooms?v=2")).json.me.canCreateRooms);
    check(tag + " deleting Team keeps existing room", (await rig.call(member, "GET", roomPath)).status === 200);
    check(tag + " grant history retained", !!rig.db.prepare("SELECT 1 FROM hub_grants WHERE id=? AND state='active'").get(grant.json.grant.id));
    check(tag + " no browser errors", errors.length === 0); await Promise.all(responses); await context.close();
  }
  receipt.complete = true;
} catch (error) {
  receipt.complete = false; receipt.error = { name: (error as Error).name, message: (error as Error).message }; throw error;
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rig.close(); rmSync(keys, { recursive: true, force: true });
  receipt.cleaned = { browser: true, listener: true, sqlite: true, keys: true }; writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
}
console.log(JSON.stringify({ checks: receipt.checks.length, png: receipt.pictures.length }));
