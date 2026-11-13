/** Shared U1/U2 UI against real R HTTP/SQLite and A service. Directory/worker are inert; no API response fixture. */
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
  host: { start: async () => ({ ask: async () => { workerCalls++; return { text: "Owned assistant answer" }; }, stop: async () => {} }) },
  store: { load: async () => null, save: async () => {} },
  backends: () => [{ id: "claude-code", name: "Claude", accounts: [{ id: null, name: "Default", state: "signed-in" }] }],
});
await service.settings(); r.httpDeps.roomAssistant = service; r.httpDeps.assistantAdmin = service; await r.restartHttp();
const config = { enabled: true, backend: "claude-code", account: null, cap: 3, idleMinutes: 15 };
if ((await r.call(admin, "PUT", "/hub/v1/admin/assistant", config)).status !== 200) throw Error("assistant configure");
if ((await r.call(admin, "PUT", "/hub/v1/admin/rooms/creators", { people: [personKeyString(alex)], teams: [] })).status !== 200) throw Error("creator setup");
const initial = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Pilot weekly", people: [personKeyString(alex)], assistant: true });
if (initial.status !== 200) throw Error("room seed");
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const mount = `import {html,render} from '/assets/app-html.js';import{setLang}from'/assets/app-i18n.js';import{ConfirmHost}from'/assets/ui-confirm.js';import{createHubWebClient}from'/ui/js/hub-client.js';import{NewRoomDialog}from'/ui/js/hub-room-new.js';const q=new URLSearchParams(location.search);setLang(q.get('lang')||'en',{store:false});const client=createHubWebClient();await client.session();render(html\`<\${NewRoomDialog} client=\${client} onOpenRoom=\${id=>location.assign('/ui/hub?room='+id)}/><\${ConfirmHost}/ >\`,document.getElementById('app'));`;
const pageHtml = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/tokens.css"><link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/assets/hub.css"></head><body><div id="app"></div><script type="module" src="/__rooms/mount.js"></script></body></html>';
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) }, (req, res) => {
  const path = new URL(req.url ?? "/", origin).pathname;
  if (path === "/__rooms/new") { res.writeHead(200, { "content-type": "text/html" }); return res.end(pageHtml); }
  if (path === "/__rooms/mount.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(mount); }
  if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); }
});
await new Promise<void>(yes => server.listen(port, "127.0.0.1", yes));
const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core"), browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const receipt: any = { sourceHead: execFileSync("git", ["-c", "gc.auto=0", "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), scope: "Real R HTTP/SQLite + A service/runner + shared U1/U2 browser components; inert directory and physical worker; NewRoom mounted in a component harness until U shell mount lands", checks: [], pictures: [], requests: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
try {
  for (const [device, lang, theme] of [["desktop", "en", "light"], ["phone", "zh-TW", "dark"]]) {
    const tag = `${device}-${lang}-${theme}`, errors: string[] = [], context = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, locale: lang, colorScheme: theme, ignoreHTTPSErrors: true, hasTouch: device === "phone", isMobile: device === "phone" });
    const at = actor.cookie.indexOf("=");
    await context.addCookies([{ name: actor.cookie.slice(0, at), value: actor.cookie.slice(at + 1), url: origin, httpOnly: true, secure: true, sameSite: "Strict" }]);
    await context.addInitScript(({ lang, theme }) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); }, { lang, theme });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const p = await context.newPage(); p.on("pageerror", (e: Error) => errors.push(e.message));
    p.on("response", (response: any) => { const u = new URL(response.url()); if (u.pathname.startsWith("/hub/v1/")) receipt.requests.push({ method: response.request().method(), path: u.pathname + u.search, status: response.status() }); });
    const shot = async (name: string) => { const path = `${tag}-${name}.png`; await p.screenshot({ path: join(out, path), fullPage: true }); receipt.pictures.push({ path, sha256: sha(readFileSync(join(out, path))) }); };
    await p.goto(origin + "/ui/hub"); await p.getByText("Pilot weekly", { exact: true }).first().waitFor();
    check(tag + " list reads real room and private assistant", (await p.locator("body").innerText()).includes(lang === "en" ? "Hub assistant" : "Hub 助理")); await shot("list");
    await p.goto(origin + "/__rooms/new?lang=" + lang); await p.locator("#hubRoomName").fill("Browser room " + tag);
    await p.locator("#hubRoomPeople").fill("Pilot"); await p.getByRole("option").filter({ hasText: "Pilot direct group" }).click();
    await p.locator(".hub-room-tags").filter({ hasText: "Pilot direct group" }).waitFor();
    check(tag + " complete direct group preview shows count", /Pilot direct group.*1/.test(await p.locator(".hub-room-tags").allTextContents().then((s: string[]) => s.join(" "))));
    await p.locator("#hubRoomAssistant").check(); await shot("new-group");
    await p.getByRole("button", { name: lang === "en" ? "Create" : "建立", exact: true }).click();
    await p.waitForURL("**/ui/hub?room=*"); await p.locator(".hub-room-page").waitFor();
    const id = new URL(p.url()).searchParams.get("room")!, detail = await r.call(actor, "GET", `/hub/v1/rooms/${id}`);
    check(tag + " create persists complete group and never-signed-in state", detail.json.members.some((m: any) => m.kind === "person" && m.signedIn === false));
    await p.locator(".hub-room-composer textarea").fill("Browser human message " + tag); await p.locator(".hub-room-composer textarea").press("Enter");
    await p.getByText("Browser human message " + tag, { exact: true }).first().waitFor(); await shot("thread");
    check(tag + " human message uses actual SQL", (await r.call(actor, "GET", `/hub/v1/rooms/${id}/messages`)).text.includes("Browser human message " + tag));
    const list = await r.call(actor, "GET", "/hub/v1/rooms?v=2"), assistant = list.json.rooms.find((room: any) => room.assistant);
    await p.goto(origin + "/ui/hub?room=" + assistant.id); await p.locator(".hub-room-composer textarea").fill("Browser plain assistant request " + tag); await p.locator(".hub-room-composer textarea").press("Enter");
    await p.getByText("Owned assistant answer", { exact: true }).first().waitFor();
    check(tag + " plain private ask reaches actual A service", workerCalls > 0);
    check(tag + " assistant label follows viewer language", lang !== "zh-TW" || !(await p.locator("body").innerText()).includes("Hub assistant")); await shot("assistant");
    check(tag + " no page errors", errors.length === 0, errors);
    check(tag + " no horizontal document overflow", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await context.close();
  }
} catch (error) { check("run completed", false, String(error)); }
finally {
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2)); await browser.close();
  await r.http.close(); await new Promise<void>(yes => server.close(() => yes())); await r.close(); await service.close(); rmSync(keys, { recursive: true, force: true });
}
console.log(JSON.stringify({ checks: receipt.checks.length, failed: receipt.checks.filter((x: any) => !x.ok).length, pictures: receipt.pictures.length }));
process.exitCode = receipt.checks.some((x: any) => !x.ok) ? 1 : 0;
