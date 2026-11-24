/** Real Hub HTTP/SQLite/UI, synthetic directory/member; headless, loopback-only. No live Fleet, CLI or model. */
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { personKeyString } from "../../../src/hub/identity.js";
import { createOwnedPki } from "../hub-connector-4c/rig.mjs";
import { createHubRoomInvitations, HUB_ROOM_INVITATIONS_MIGRATION } from "../../../src/hub/invitations.js";

if (!process.env.CHROME?.startsWith("/home/") || !process.env.CJK_FONT || !process.env.PW_DIR) throw Error("Supply Linux Chrome, CJK font and Playwright");
const out = resolve(process.env.OUT!), stage = process.env.STAGE === "before" ? "before" : "after";
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, ".owned-")), home = join(scratch, "home");
mkdirSync(join(home, ".local/share/fonts"), { recursive: true }); copyFileSync(process.env.CJK_FONT, join(home, ".local/share/fonts/Chinese.ttf"));
const pki = createOwnedPki(join(scratch, "pki")), pw = createRequire(join(resolve(process.env.PW_DIR), "package.json"))("playwright-core");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
for (const k of ["DISPLAY", "WAYLAND_DISPLAY", "WSL_INTEROP"]) delete env[k];
let r: Awaited<ReturnType<typeof s3bRig>> | undefined, browser: any;
const errors: string[] = [], checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: unknown) => { checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); };
const server = createServer({ key: readFileSync(pki.key), cert: readFileSync(pki.cert) }, (req, res) => { if (!r?.http.handle(req, res)) { res.writeHead(404); res.end(); } });
try {
  await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  r = await s3bRig({ webOrigin: origin, realAudit: true });
  HUB_ROOM_INVITATIONS_MIGRATION.up(r.db); r.httpDeps.roomInvitations = (core, host) => createHubRoomInvitations(core, host); await r.restartHttp();
  const asker = r.addPerson("example-asker", "Example colleague"), owner = r.admin, fleetId = randomUUID(), exposureId = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture", result: "completed" }, s => {
    s.fleets.push({ id: fleetId, owner, generation: 1, credentialHash: "a".repeat(64), status: "active", label: "Example Fleet" });
  });
  const link = r.link(fleetId, owner, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", "exposure-request-v1", "agent-catalog-lapse-v1"]);
  r.http.memberConnected!(link);
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId, owner, displayName: "Notes",
    revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const o = await r.signIn("admin"), a = await r.signIn("example-asker");
  const group = await r.call(o, "POST", "/hub/v1/rooms", { name: "Planning", people: [personKeyString(asker)] });
  check("group created", group.status === 200); const groupId = group.json.room.id;
  check("agent joined", (await r.call(o, "POST", `/hub/v1/rooms/${groupId}/members`, { kind: "agent", id: exposureId })).status === 200);
  const grant = await r.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "example-asker", days: 7 });
  check("grant created", grant.status === 200);
  const direct = await r.call(a, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.json.grant.id });
  check("direct created", direct.status === 200); const directId = direct.json.room.id;
  await r.http.receive(r.frame("agent.catalog", { enabled: true, requests: true, revision: "c".repeat(64), agents: [{ instance: "notes", displayName: "Notes",
    description: "Summarizes public notes", avatar: null, kind: "agent", general: false, shareable: true,
    exposure: { id: exposureId, revision: 1, state: "published", lapsed: true } }] }, link) as never, link);
  for (const [kind, id] of [["group", groupId], ["direct", directId]]) check(`${kind} question accepted`, (await r.call(a, "POST", `/hub/v1/rooms/${id}/messages`, {
    text: "Please summarize the next steps.", mentions: kind === "group" ? [exposureId] : [], idempotencyKey: randomUUID(),
  })).status === 200);
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME, headless: true, env, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-component-update"] });
  for (const device of ["desk", "phone"]) for (const theme of ["light", "dark"]) for (const lang of ["en", "zh-TW"]) {
    const tag = `${device}-${theme}-${lang}`, ctx = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: theme, ignoreHTTPSErrors: true });
    await ctx.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(lang)});localStorage.setItem('agend_theme',${JSON.stringify(theme)});localStorage.setItem('agend_tour_done','1');` });
    await ctx.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await ctx.newPage(); page.setDefaultTimeout(15_000); page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.goto(origin + `/ui/hub?room=${groupId}`);
      await page.fill("#hubLogin", "example-asker"); await page.fill("#hubPassword", "pw-example-asker"); await page.locator(".hub-signin button[type=submit]").click();
      for (const [kind, id] of [["group", groupId], ["direct", directId]]) {
        await page.goto(origin + `/ui/hub?room=${id}`);
        await page.getByText("Please summarize the next steps.", { exact: true }).first().waitFor().catch(async (e: unknown) => {
          await page.screenshot({path: join(out, "debug.png")}); writeFileSync(join(out, "debug.txt"), await page.locator("body").innerText()); throw e;
        });
        if (stage === "after") await page.getByText(lang === "en" ? /owner.*shares? it again/ : /擁有者需要重新分享/).first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(out, `${stage}-${tag}-${kind}.png`) });
        check(`${stage}/${tag}/${kind} no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    } finally { await ctx.close(); }
  }
  check("no page errors", errors.length === 0);
  writeFileSync(join(out, `receipt-${stage}.json`), JSON.stringify({ stage, checks, errors }, null, 2));
  console.log(JSON.stringify({ stage, checks: checks.length }));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await r?.close(); rmSync(scratch, { recursive: true, force: true }); }
