/** M-3189 rig, from real-server.mts: against real R HTTP/SQLite and A service plus C consent. Directory/worker are inert; no API response fixture. */
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
r.link(randomUUID(), alex);   // one connected Fleet, for the comparison card
await service.settings(); r.httpDeps.roomAssistant = service; r.httpDeps.assistantAdmin = service; await r.restartHttp();
const config = { enabled: true, backend: "claude-code", account: null, cap: 3, idleMinutes: 15 };
if ((await r.call(admin, "PUT", "/hub/v1/admin/assistant", config)).status !== 200) throw Error("assistant configure");
if ((await r.call(admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [personKeyString(alex)], teams: [] })).status !== 200) throw Error("creator setup");
const initial = await r.call(admin, "POST", "/hub/v1/rooms", { name: "HanGeneral", people: [personKeyString(alex)], assistant: true });
if (initial.status !== 200) throw Error("room seed");
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
const facts: Record<string, unknown> = {};
try {
  for (const [device, theme] of [["desktop", "light"], ["desktop", "dark"], ["phone", "light"], ["phone", "dark"]]) {
    const lang = "zh-TW", tag = `${device}-${theme}`;
    const context = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, locale: lang, colorScheme: theme, ignoreHTTPSErrors: true, hasTouch: device === "phone", isMobile: device === "phone" });
    const at = admin.cookie.indexOf("=");
    await context.addCookies([{ name: admin.cookie.slice(0, at), value: admin.cookie.slice(at + 1), url: origin, httpOnly: true, secure: true, sameSite: "Strict" }]);
    await context.addInitScript(({ lang, theme }) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); }, { lang, theme });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const p = await context.newPage();
    await p.goto(origin + "/ui/hub/admin?view=manage");
    try { await p.locator(".hub-admin-rooms-table").waitFor({ timeout: 15000 }); } catch (e) { await p.screenshot({ path: join(out, `${tag}-FAILED.png`) }); console.log((await p.locator("body").innerText()).slice(0, 800)); throw e; }
    await p.waitForTimeout(400);
    // The user's state: the row's ⋯ opened (its menu is what showed as the white block, inside the table's own scroll box).
    if (process.env.CLOSED !== "1") { await p.locator(".hub-admin-rooms-table tbody tr td:last-child button").first().click(); await p.locator(".hub-admin-rooms-table .menu-list, .menu-list.menu-anchored").first().waitFor(); await p.waitForTimeout(200); }
    const box = await p.evaluate(() => {
      const e = document.querySelector(".hub-admin-all-rooms") as HTMLElement, b = document.querySelector(".hub-admin-rooms-table tbody tr td:last-child button") as HTMLElement;
      const er = e.getBoundingClientRect(), br = b.getBoundingClientRect(), cs = getComputedStyle(e);
      return { overflowY: cs.overflowY, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, scrollWidth: e.scrollWidth, clientWidth: e.clientWidth,
        list: (() => { const l = document.querySelector(".menu-list") as HTMLElement | null; if (!l) return null; const lr = l.getBoundingClientRect();
          const top = l.matches(":popover-open"); return { topLayer: top, fullyVisible: top ? lr.top >= 0 && lr.bottom <= innerHeight && lr.left >= 0 && lr.right <= innerWidth : lr.top >= er.top - 0.5 && lr.bottom <= er.top + e.clientHeight + 0.5, h: Math.round(lr.height) }; })(),
        menuInside: br.top >= er.top - 0.5 && br.bottom <= er.top + e.clientHeight + 0.5 && br.left >= er.left - 0.5 && br.right <= er.left + e.clientWidth + 0.5 };
    });
    facts[tag] = box; console.log(tag, JSON.stringify(box));
    await p.locator(".hub-admin-all-rooms").scrollIntoViewIfNeeded();
    await p.screenshot({ path: join(out, `${tag}.png`), fullPage: true });
    await context.close();
  }
} finally {
  writeFileSync(join(out, "facts.json"), JSON.stringify(facts, null, 2)); await browser.close();
  await r.http.close(); await new Promise<void>(yes => server.close(() => yes())); await r.close(); await service.close(); rmSync(keys, { recursive: true, force: true });
}
