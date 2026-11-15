/** M-3190 rig (from real-server.mts): the Hub's 對話 and 我分享的 Agent for three people — a first-time member, a member with Fleets
 * and a room, and an administrator on a fresh Hub — on real R HTTP/SQLite over loopback (no account), desktop and phone, light and
 * dark. The pilot's Hub has quick pairing and company join on: the browser adds those features (and group-policy-v1) to the real
 * session answer and serves the welcome projection, so the pages draw as on that Hub. TAG=today|after names the pictures.
 *   PW_DIR=<checkout> OUT=<dir> TAG=after [PERSONAS=first,member,admin] [CASES=desktop-light,…] npx tsx scripts/manual/hub-rooms/m3190-shot.mts */
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

const repo = process.cwd(), out = resolve(process.env.OUT ?? ".artifacts/rooms-integration/browser");
mkdirSync(out, { recursive: true });
const keys = mkdtempSync(join(out, "keys-")), port = 49700 + Math.floor(Math.random() * 200), origin = `https://127.0.0.1:${port}`;
const r = await s3bRig({ webOrigin: origin }), alex = r.addPerson("alex", "Alex"), unseen = r.addPerson("new-person", "Never signed in"), group = randomUUID();
const bo = r.addPerson("bo", "Bo Wu"), olivia = r.addPerson("olivia", "林小華");
const admin = await r.signIn("admin"), actor = await r.signIn("alex"), boS = await r.signIn("bo"), oliviaS = await r.signIn("olivia");
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
const fa = randomUUID(), fb = randomUUID(); r.link(fa, alex, 1, ["welcome-caps-v1"]); r.link(fb, alex, 1, ["welcome-caps-v1"]);
await service.settings(); r.httpDeps.roomAssistant = service; r.httpDeps.assistantAdmin = service; await r.restartHttp();
const config = { enabled: true, backend: "claude-code", account: null, cap: 3, idleMinutes: 15 };
if ((await r.call(admin, "PUT", "/hub/v1/admin/assistant", config)).status !== 200) throw Error("assistant configure");
if ((await r.call(admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [personKeyString(alex)], teams: [] })).status !== 200) throw Error("creator setup");
const initial = await r.call(actor, "POST", "/hub/v1/rooms", { name: "HanGeneral", people: [], assistant: true });   // Alex's own room: the admin is not in it (a fresh Hub for them)
if (initial.status !== 200) throw Error("room seed");
{ const fleetO = randomUUID(), linkO = r.link(fleetO, olivia), xid = randomUUID();
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: xid, fleetId: fleetO, owner: olivia, displayName: "規格審查員", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, linkO) as never, linkO);
  const g = await r.call(oliviaS, "POST", "/hub/v1/grants", { exposureId: xid, exposureRevision: 1, login: "alex", days: 7 }); if (g.status !== 200) throw Error("grant " + g.status); }
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) }, (req, res) => {
  if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); }
});
await new Promise<void>(yes => server.listen(port, "127.0.0.1", yes));
const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core"), browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

// M-3189: Administration → 所有房間 next to Connected fleets on the real Hub shell (real R HTTP/SQLite, loopback, no account), for
// before/after pictures and the table's scroll box. One room (the user's case), desktop and phone, light and dark.
//   PW_DIR=<checkout> OUT=<dir> npx tsx scripts/manual/hub-rooms/admin-rooms-shot.mts

const W = (fleets: any[]) => ({ ok: true, v: 1, mode: "enabled", chat: { state: "allow", reason: "group" }, publish: { state: "allow", reason: "group" }, connect: { state: "allow", reason: "group", maxFleets: 8, fleets } });
const PILOT_FLEETS = [{ id: "f-alex", label: "Alex", status: "active", generation: 1 }, { id: "f-mine", label: "我的 Fleet", status: "active", generation: 1 }];
const PERSONAS: Record<string, { who: any; fleets: any[]; views: string[] }> = {
  first: { who: boS, fleets: [], views: ["chats"] },
  member: { who: actor, fleets: PILOT_FLEETS, views: ["chats", "new", "mine", "mine-menu"] },
  admin: { who: admin, fleets: [], views: ["chats"] },
};
const TAG = process.env.TAG ?? "today";
try {
  const only = process.env.PERSONAS ? process.env.PERSONAS.split(",") : Object.keys(PERSONAS);
  const cases = (process.env.CASES ?? "desktop-light,desktop-dark,phone-light,phone-dark").split(",");
  for (const persona of only) for (const c of cases) {
    const P = PERSONAS[persona]!, [device, theme] = c.split("-"), lang = "zh-TW";
    const context = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, locale: lang, colorScheme: theme, ignoreHTTPSErrors: true, hasTouch: device === "phone", isMobile: device === "phone" });
    const at = P.who.cookie.indexOf("=");
    await context.addCookies([{ name: P.who.cookie.slice(0, at), value: P.who.cookie.slice(at + 1), url: origin, httpOnly: true, secure: true, sameSite: "Strict" }]);
    await context.addInitScript(({ lang, theme }) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1");
      new MutationObserver((_m, o) => { if (document.body) { document.body.dataset.hubName = "RD1 AgEnD Hub"; o.disconnect(); } }).observe(document.documentElement, { childList: true }); }, { lang, theme });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.route(origin + "/hub/v1/session", async (route: any) => { const res = await route.fetch(); const j = await res.json();
      if (Array.isArray(j.features)) j.features.push("group-policy-v1", "quick-pairing-v1", "company-join-v1"); await route.fulfill({ response: res, json: j }); });
    await context.route(origin + "/hub/v1/me/welcome", (route: any) => route.fulfill({ json: W(P.fleets) }));
    await context.route(origin + "/hub/v1/join/metadata", (route: any) => route.fulfill({ json: { ok: true, features: ["company-join-v1"] } }));
    if (persona === "admin") await context.route(origin + "/hub/v1/admin/overview", async (route: any) => { const res = await route.fetch(); const j = await res.json(); j.fleets = []; await route.fulfill({ response: res, json: j }); });
    const p = await context.newPage();
    for (const view of P.views) {
      const path = view === "new" ? "/ui/hub?view=new" : view.startsWith("mine") ? "/ui/hub/exposures" : "/ui/hub";
      await p.goto(origin + path); await p.waitForTimeout(2500);
      if (view === "mine-menu") { const b = p.locator(".hub-fleet-menu button, .hub-welcome-fleets .btn-danger").first(); if (await b.count()) { await b.click(); await p.waitForTimeout(400); } }
      if (device === "phone" && TAG === "today" && view === "chats") await p.locator(".hub-welcome-page, .hub-launch").first().evaluate((e: Element) => e.scrollIntoView({ block: "start" })).catch(() => {});
      const name = `${TAG}-${persona}-${view}-${device}-${theme}.png`;
      await p.screenshot({ path: join(out, name) });
      console.log(name, p.url().replace(origin, ""));
    }
    await context.close();
  }
} finally {
  await browser.close();
  await r.http.close(); await new Promise<void>(yes => server.close(() => yes())); await r.close(); await service.close(); rmSync(keys, { recursive: true, force: true });
}
