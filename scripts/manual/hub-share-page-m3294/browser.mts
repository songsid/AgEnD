/** Real Hub HTTPS/SQLite/audit and local sharing writer; inert company directory and in-process member transport. */
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../../../src/hub/group-policy/store.js";
import { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } from "../../../src/hub/invitations.js";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { createOwnedPki, trustOwnedBrowserCa } from "../hub-connector-4c/rig.mjs";
import { HubExposureStore, HUB_EXPOSURE_MIGRATION } from "../../../src/hub/member/exposures.js";
import { createHubMemberExposureApi } from "../../../src/hub/member/exposure-api.js";
import { HubMemberSharingJournal, HUB_MEMBER_SHARING_MIGRATION } from "../../../src/hub/member/sharing-journal.js";
import { HubMemberSharing } from "../../../src/hub/member/sharing.js";
import { sharingResult } from "../../../src/hub/member/sharing-result.js";
import { memberAgentCatalog, type MemberCatalogAgent } from "../../../src/hub/member/agent-catalog.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../../../src/hub/audit/index.js";
if (process.platform !== "linux" || !process.env.CHROME?.startsWith("/home/") || process.env.CHROME.includes("/mnt/")) throw Error("Owned headless Linux browser required");
if (Number(readFileSync("/proc/loadavg", "utf8").split(/\s+/)[0]) > 10) throw Error("Host load exceeds 10");
const out = resolve(process.env.OUT || ".artifacts/hub-share-page/browser"), stage = process.env.STAGE || "after";
mkdirSync(out, { recursive: true }); const scratch = mkdtempSync(join(out, "owned-")), home = join(scratch, "home"); mkdirSync(home, { recursive: true, mode: 0o700 });
const pki = createOwnedPki(join(scratch, "pki")); trustOwnedBrowserCa(pki, home, process.env.CERTUTIL!);
if (process.env.CJK_FONT) { const fonts = join(home, ".local/share/fonts"); mkdirSync(fonts, { recursive: true }); copyFileSync(process.env.CJK_FONT, join(fonts, "NotoSansCJKtc-Regular.otf")); }
const pw = createRequire(join(resolve(process.env.PW_DIR!), "package.json"))("playwright-core");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "WSL_INTEROP"]) delete env[key];
let r: Awaited<ReturnType<typeof s3bRig>> | undefined, browser: any, live = true, running = false, paused = false;
let timer: ReturnType<typeof setInterval> | undefined;
const legacy = new Map<string, Buffer>();
if (stage === "before") for (const file of ["panel-hub.js", "hub-client.js", "hub-chat-strings.js", "hub-group-strings.js", "hub-owner-strings.js", "hub-strings.js", "shared/app-shell.js"]) {
 const path = file.startsWith("shared/") ? "/assets/" + file.slice(7) : "/ui/js/" + file;
 legacy.set(path, execFileSync("git", ["show", `8c11d4d2:src/ui/${file}`]));
}
const server = createServer({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => {
 const path = new URL(req.url || "/", "https://hub.example.com").pathname;
 if (legacy.has(path)) { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" }); res.end(legacy.get(path)); return; }
 if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); }
});
const localDb = new Database(":memory:");
const checks: { key: string; ok: boolean }[] = [], failures: string[] = [], assets = new Map<string, string>();
const check = (key: string, ok: unknown) => { checks.push({ key, ok: !!ok }); if (!ok) throw Error(key); };
try {
 await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
 const origin = `https://hub.example.com:${(server.address() as { port: number }).port}`;
 r = await s3bRig({ webOrigin: origin, realAudit: true }); const hub = r;
 const owner = r.addPerson("owner", "Owner"), reader = r.addPerson("reader", "Reader"), fleetId = randomUUID(), homeId = randomUUID(), oldId = randomUUID();
 Object.defineProperty(r.directory, "groupPolicy", { value: "ad-direct-guid", configurable: true });
 r.directory.searchPolicyGroups = async () => ({ ok: true, truncated: false, groups: [] });
 r.directory.resolvePolicyGroup = async () => ({ ok: false, reason: "not-found" });
 r.directory.readPolicyGroups = async person => ({ kind: "complete", person, groups: [], observedAt: Date.now() });
 groupPolicyMigration(r.hubId, "corp", "owned-directory").up(r.db);
 const grantPolicy = createHubGroupPolicyStore({ db: r.db, hubId: r.hubId, realm: "corp", generation: "owned-directory", directory: r.directory, audit: { appendInTransaction() {} } as never, current: () => true, now: Date.now });
 r.httpDeps.grantDirectory = { policy: () => grantPolicy, binding: () => ({ kind: "ready" }) };
 r.directory.searchGrantPeople = async q => ({ ok: true, truncated: false, people: q.toLowerCase().includes("re") ? [{ person: reader, login: "reader", displayName: "Reader" }] : [] });
 r.httpDeps.groupHttp = { control: {} as never, welcome: async ctx => {
  await ctx.requirePerson(); if (!ctx.current()) throw Error("ended");
  return { ok: true, v: 1, mode: "enabled", chat: { state: "allow" }, publish: { state: "allow" }, connect: { state: "allow", maxFleets: 8, fleets: hub.store.read().fleets.filter(f => f.owner.objectId === owner.objectId).map(f => ({ id: f.id, label: f.label || null, generation: f.generation, status: "active" })) } };
 } };
 HUB_ROOM_INVITATIONS_MIGRATION.up(r.db);
 r.httpDeps.roomInvitations = (core, host) => createHubRoomInvitations(core, host);
 await r.restartHttp(); await r.signIn("reader");
 r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, state => {
  for (const [id, label] of [[fleetId, "Work laptop"], [homeId, "Home server"], [oldId, "Older Fleet"]]) state.fleets.push({ id: id!, label: label!, owner, generation: 1, credentialHash: "a".repeat(64), status: "active" });
 });
 const link = r.link(fleetId, owner, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", "exposure-request-v1", "fleet-info-v1"]); r.http.memberConnected!(link);
 const offline = r.link(homeId, owner, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", "exposure-request-v1", "fleet-info-v1"]); r.http.memberConnected!(offline);
 await r.http.receive(r.frame("agent.catalog", { enabled: true, requests: true, revision: "f".repeat(64), agents: [{ instance: "notes", displayName: "Home notes", description: "Personal research notes", avatar: null, kind: "agent" as const, general: false, shareable: true as const, exposure: null }] }, offline), offline); offline.alive = false;
 for (const current of [link, offline]) { const was = current.alive; current.alive = true; await r.http.receive(r.frame("fleet.info", { version: "2.4.0-beta.10", runsAsService: true }, current), current); current.alive = was; }
 const older = r.link(oldId, owner); r.http.memberConnected!(older);
 for (const m of [HUB_EXPOSURE_MIGRATION, HUB_MEMBER_SHARING_MIGRATION, HUB_AUDIT_MIGRATION]) m.up(localDb);
 let floor = 0, snapshotRevision = 0;
 const store = new HubExposureStore(localDb, { floor: { read: () => floor, raise: v => { floor = v; } }, audit: createHubAudit({ db: localDb, contentKey: randomBytes(32) }), views: new Map(), binding: () => ({ owner, fleetId }) }); store.initialize();
 const sources = [{ instance: "notes", displayName: "Notes", description: "Keeps project notes.", general: false, kind: "agent" }, { instance: "docs", displayName: "Documents", description: "Explains the project documents.", general: false, kind: "agent" }, { instance: "support", displayName: "Support", description: "Answers support questions.", general: false, kind: "classic-room" }, { instance: "general", displayName: "General", description: "", general: true, kind: "agent" }];
 const agents = (): MemberCatalogAgent[] => sources.map(s => { const x = store.list().find(x => x.agent === s.instance)?.committed?.exposure; return { ...s, kind: s.kind as "agent" | "classic-room", shareable: true, avatar: null, incarnation: "d".repeat(64), exposure: x ? { id: x.id, revision: x.revision, state: x.state } : null }; });
 const publish = async () => {
  await hub.http.receive(hub.frame("exposure.snapshot", { revision: ++snapshotRevision, exposures: store.list().flatMap(row => row.committed ? [row.committed.exposure] : []) }, link), link);
  await hub.http.receive(hub.frame("agent.catalog", memberAgentCatalog(true, agents(), true), link), link);
 };
 const api = createHubMemberExposureApi({ store, agents: () => sources.map(s => ({ name: s.instance, display: s.displayName })), afterCommit: async () => {}, readinessCandidate: c => ({ ok: true, policyDigest: c.exposure.policyDigest, exposureRevision: c.exposure.revision }) });
 const journal = new HubMemberSharingJournal({ db: localDb, binding: "owned-rig", owner, fleetId, agentToken: () => "d".repeat(64), current: () => live, now: Date.now });
 const domain = new HubMemberSharing({ journal, store, api, current: () => live, now: Date.now, enabled: () => true, agents, catalog: () => memberAgentCatalog(true, agents(), true), snapshot: publish, notice: async () => true });
 const bootstrap = randomUUID(), at = Date.now();
 await domain.apply(bootstrap, { by: owner, byName: "Owner", catalogRevision: memberAgentCatalog(true, agents(), true).revision, share: ["notes"], stop: [], createdAt: at, expiresAt: at + 600_000 });
 check("bootstrap actual local sharing writer", store.list().some(x => x.agent === "notes" && x.committed?.exposure.state === "published"));
 const handled = new Set<string>();
 timer = setInterval(() => { if (running || !live) return; running = true; void (async () => {
  for (const entry of hub.sent) {
   if (entry.fleetId !== fleetId || handled.has(entry.frame.requestId)) continue;
   if (entry.frame.type === "agent.catalog-refresh") { handled.add(entry.frame.requestId); await publish(); }
   if (entry.frame.type === "exposure.request" && !paused) {
    handled.add(entry.frame.requestId); const record = await domain.apply(entry.frame.requestId, entry.frame.payload);
    const ack = await hub.http.receive({ ...hub.frame("exposure.request-result", sharingResult(record), link), requestId: record.id }, link);
    if (ack?.type === "exposure.request-ack") journal.acknowledge(record.id);
   }
  }
 })().catch(() => failures.push("in-process member failed")).finally(() => { running = false; }); }, 20); timer.unref();
 browser = await pw.chromium.launch({ executablePath: process.env.CHROME, headless: true, env, args: ["--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP hub.example.com 127.0.0.1"] });
 for (const c of [{ tag: "desk-light-en", lang: "en", theme: "light", width: 1366, height: 900 }, { tag: "phone-dark-zh-TW", lang: "zh-TW", theme: "dark", width: 390, height: 844 }].filter(c => !process.env.CASES || process.env.CASES.split(",").includes(c.tag))) {
  if (process.env.RETAKE === "1" && c.width < 600) {
   const stops = store.list().flatMap(x => x.agent !== "notes" && x.committed?.exposure.state === "published" ? [x.committed.exposure.id] : []);
   if (stops.length) { const at = Date.now(); await domain.apply(randomUUID(), { by: owner, byName: "Owner", catalogRevision: memberAgentCatalog(true, agents(), true).revision, share: [], stop: stops, createdAt: at, expiresAt: at + 600_000 }); }
  }
  const context = await browser.newContext({ viewport: { width: c.width, height: c.height }, isMobile: c.width < 600, hasTouch: c.width < 600, ignoreHTTPSErrors: false });
  await context.addInitScript(({ lang, theme }: { lang: string; theme: string }) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); }, c);
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.name));
  page.on("response", async (response: any) => { const path = new URL(response.url()).pathname; if (response.status() === 200 && /^(\/assets\/|\/ui\/js\/)/.test(path)) try { assets.set(path, createHash("sha256").update(await response.body()).digest("hex")); } catch {} });
  try {
   await page.goto(origin + "/ui/hub/exposures"); await page.locator("#hubLogin").fill("owner"); await page.locator("#hubPassword").fill("pw-owner"); await page.locator(".hub-signin-form button[type=submit]").click();
   await page.locator(stage === "before" ? ".hub-shared" : "[data-my-agents] [data-share-agent]").first().waitFor();
   await page.evaluate(() => document.fonts.ready);
   if (stage === "before") { await page.screenshot({ path: join(out, c.tag + "-before.png") }); check(c.tag + ": old shared-only page", await page.locator("[data-share-agent]").count() === 0); continue; }
   check(c.tag + ": invitation service mounted without error", (await page.locator(".hub-owner").innerText()).includes(c.lang === "en" ? "Invitations could not be loaded" : "無法載入邀請") === false);
   check(c.tag + ": compact Fleet summary has no duplicate rows", await page.locator(".hub-my-fleets .hub-rows").count() === 0);
   const group = page.locator(".hub-agent-fleet").filter({ hasText: "Work laptop" }); await group.scrollIntoViewIfNeeded();
   check(c.tag + ": own grouped inventory", await page.locator(".hub-agent-fleet").count() === 3);
   check(c.tag + ": offline and old reasons", (await page.locator("[data-my-agents]").innerText()).includes(c.lang === "en" ? "Update this Fleet" : "請更新這個 Fleet"));
   check(c.tag + ": no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
   await page.screenshot({ path: join(out, c.tag + "-groups.png") });
   if (process.env.RETAKE === "1") {
    await group.locator('[data-share-agent="support"]').check();
    const disclosure = group.locator(".hub-classic-disclosure"); await disclosure.evaluate((el: HTMLElement) => el.scrollIntoView({ block: "center" }));
    const box = await disclosure.boundingBox(), bar = await page.locator(".hub-share-bar").boundingBox();
    check(c.tag + ": Classic disclosure scrolls above action bar", box && bar && box.y + box.height <= bar.y);
    await page.screenshot({ path: join(out, c.tag + "-draft.png") });
    await page.locator(".hub-share-bar .btn").last().click();
    await group.locator('[data-share-agent="notes"]').uncheck(); await page.locator(".hub-share-bar .btn-danger").click();
    await page.getByRole("button", { name: c.lang === "en" ? "Pause instead" : "改為暫停", exact: true }).waitFor();
    await page.screenshot({ path: join(out, c.tag + "-stop-confirm.png") });
    await page.getByRole("button", { name: c.lang === "en" ? "Cancel" : "取消", exact: true }).last().click();
    await page.locator(".hub-share-bar .btn").last().click();
    await group.locator("[data-share-all]").click(); await page.locator(".hub-share-bar .btn-primary").click();
    const common = page.getByRole("button", { name: c.lang === "en" ? "The same people for all 2" : "2 個都用同一份名單", exact: true }); await common.waitFor({ timeout: 15_000 });
    check(c.tag + ": common access is primary", (await common.getAttribute("class")).includes("btn-primary"));
    check(c.tag + ": access names use a plain list", await page.locator(".hub-share-access-item").count() === 2 && await page.locator(".hub-share-access-item.s-row").count() === 0);
    await page.screenshot({ path: join(out, c.tag + "-access.png") });
    check(c.tag + ": no page errors", errors.length === 0); continue;
   }
   if (c.width > 600) {
    await group.locator("[data-share-all]").click();
    check("select-all skips General", !await group.locator('[data-share-agent="general"]').isChecked());
    check("Classic tick and memory disclosure", await group.locator('[data-share-agent="support"]').isChecked() && (await group.innerText()).includes("one agent with one memory"));
    await page.locator(".hub-share-bar").scrollIntoViewIfNeeded(); await page.screenshot({ path: join(out, c.tag + "-draft.png") });
    paused = true; let dropped = false; const frozen: string[] = [];
    await page.route("**/hub/v1/me/agent-sharing", async (route: any) => { if (route.request().method() !== "POST") return route.continue(); frozen.push(route.request().postData()); let response; try { response = await route.fetch({ url: hub.base + "/hub/v1/me/agent-sharing" }); } catch { failures.push("owned fault-injection fetch failed"); await route.abort(); return; } if (!dropped) { dropped = true; await route.abort(); } else await route.fulfill({ response }); });
    await page.locator(".hub-share-bar .btn-primary").click(); await page.waitForFunction(() => document.querySelector("[data-my-agents]")?.textContent?.includes("Sharing…"));
    await page.reload(); await page.locator("[data-my-agents] > .field-row button").click();
    check("reload retries same frozen body and UUID", frozen.length >= 2 && new Set(frozen).size === 1);
    paused = false; await page.getByRole("button", { name: "The same people for all 2", exact: true }).waitFor({ timeout: 15_000 });
    check("actual Hub queue to local writer publishes both", store.list().filter(x => ["docs", "support"].includes(x.agent) && x.committed?.exposure.state === "published").length === 2);
    await page.screenshot({ path: join(out, c.tag + "-access.png") });
    await page.getByRole("button", { name: "The same people for all 2", exact: true }).click();
    await page.locator("[data-grant-picker] input[type=search]").fill("Re"); await page.locator(".hub-group-hits button").click();
    await page.getByRole("button", { name: "Allow", exact: true }).click(); await page.getByRole("button", { name: "Decide later", exact: true }).waitFor();
    check("same selection uses two current owned targets", hub.db.prepare("SELECT id FROM hub_grants WHERE state='active'").all().length === 2);
    await page.getByRole("button", { name: "Decide later", exact: true }).click();
    await group.locator('[data-share-agent="docs"]').uncheck(); await page.locator(".hub-share-bar .btn-danger").click(); await page.getByRole("button", { name: "Pause instead", exact: true }).waitFor();
    await page.screenshot({ path: join(out, c.tag + "-stop-confirm.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).last().click(); await page.locator(".hub-share-bar .btn").last().click();
   } else {
    await group.locator('[data-share-agent="general"]').check();
    check("phone General warning and explicit tick", (await group.innerText()).includes("可以管理這個 Fleet"));
    await page.locator(".hub-share-bar").scrollIntoViewIfNeeded();
    check("phone action tap target", await page.locator(".hub-share-bar .btn-primary").evaluate((el: HTMLElement) => el.getBoundingClientRect().height >= 44));
    await page.screenshot({ path: join(out, c.tag + "-draft.png") }); await page.locator(".hub-share-bar .btn").last().click();
   }
   check(c.tag + ": no page errors", errors.length === 0);
  } finally { await context.close(); }
 }
 check("no member delivery failures", failures.length === 0);
 writeFileSync(join(out, "receipt.json"), JSON.stringify({ stage, checks, servedAssets: [...assets].map(([path, sha256]) => ({ path, sha256 })), scope: "Actual owned Hub HTTPS/SQLite/real audit, real local sharing journal/writer; in-process transport and inert directory. Headless Linux, rig-only trusted CA. No live Hub/Fleet/AD/CLI/model or desktop windows." }, null, 2) + "\n");
 console.log(JSON.stringify({ stage, checks: checks.length, passed: checks.filter(x => x.ok).length }));
} finally { live = false; if (timer) clearInterval(timer); await browser?.close(); while (running) await new Promise(yes => setTimeout(yes, 10)); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await r?.close(); localDb.close(); rmSync(scratch, { recursive: true, force: true }); }
