// C9/#3336: actual Hub UI + production AD driver against ONLY the owned fake LDAPS rig.
// AGEND_HUB_RIG_ENV=<private rig.env> PW_DIR=<node_modules with playwright> OUT=<screens> \
// PLAYWRIGHT_BROWSERS_PATH=<private browser cache> npx tsx scripts/manual/smoke/smoke-hub-pair-owner-3336.mts
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Client } from "ldapts";
import { createHubDirectory } from "../../../src/hub/directory/index.js";
import { guidBytesToString } from "../../../src/hub/directory/profiles.js";
import { personKeyString } from "../../../src/hub/identity.js";
import { makeTestCerts } from "../../../tests/support/hub-init-fixtures.js";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";

const env = Object.fromEntries(readFileSync(process.env.AGEND_HUB_RIG_ENV!, "utf8").split("\n").filter(Boolean).map(line => {
  const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)];
}));
const url = new URL(env.AGEND_HUB_RIG_LDAPS_URL!);
assert.equal(env.AGEND_HUB_RIG, "1"); assert.equal(url.protocol, "ldaps:");
assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname)); assert.equal(env.AGEND_HUB_RIG_BASE_DN, "dc=example,dc=test");
const out = process.env.OUT!; assert.ok(out); mkdirSync(out, { recursive: true });
const ca = readFileSync(env.AGEND_HUB_RIG_CA!, "utf8"), certs = makeTestCerts();
const ldap = new Client({ url: url.href, tlsOptions: { ca, rejectUnauthorized: true }, timeout: 5000, connectTimeout: 5000 });
const directory = createHubDirectory({ realm: "demo", url: url.href, caPem: ca, baseDn: env.AGEND_HUB_RIG_BASE_DN,
  bindDn: env.AGEND_HUB_RIG_BIND_DN, profile: "ad" }, { bindPassword: env.AGEND_HUB_RIG_BIND_PASSWORD! });
let rig: Awaited<ReturnType<typeof s3bRig>> | undefined, browser: any, web: ReturnType<typeof createServer> | undefined;
const ownedDns: string[] = [], results: unknown[] = [];
try {
  await ldap.bind(env.AGEND_HUB_RIG_ADMIN_DN!, env.AGEND_HUB_RIG_ADMIN_PASSWORD!);
  const add = async (login: string, display: string) => {
    const dn = `cn=${randomUUID()},ou=people,dc=example,dc=test`, guid = randomBytes(16);
    await ldap.add(dn, { objectClass: ["inetOrgPerson", "fakeAdUser"], cn: display, sn: "Example", displayName: display,
      sAMAccountName: login, userAccountControl: "512", objectGUID: guid as unknown as string, userPassword: `pw-${login}` });
    ownedDns.push(dn); return { realm: "demo", objectId: guidBytesToString(guid)! };
  };
  const administrator = await add("hub-admin", "Hub Admin"), owner = await add("olivia", "Olivia Example");
  web = createServer({ cert: readFileSync(certs.cert), key: readFileSync(certs.key) }, (req, res) => {
    if (!rig?.http.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => web!.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${(web.address() as { port: number }).port}`;
  const pw = createRequire(process.env.PW_DIR! + "/")("playwright");
  browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
  for (const c of [{ lang: "en", size: "desktop", viewport: { width: 1366, height: 900 } },
    { lang: "zh-TW", size: "phone", viewport: { width: 390, height: 844 } }]) {
    rig = await s3bRig({ webOrigin: origin, directory, administrator });
    const context = await browser.newContext({ viewport: c.viewport, locale: c.lang === "en" ? "en-US" : "zh-TW", ignoreHTTPSErrors: true });
    try {
      await context.addInitScript((lang: string) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_tour_done", "1"); }, c.lang);
      await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage(), errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      await page.goto(origin + "/ui/hub/admin"); await page.locator("#hubLogin").fill("hub-admin");
      await page.locator("#hubPassword").fill("pw-hub-admin"); await page.locator(".hub-signin button[type=submit]").click();
      await page.locator(".hub-step-form input").waitFor();
      assert.equal(rig.db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(personKeyString(owner)), undefined);
      await page.locator(".hub-step-form input").fill("olivia"); await page.locator(".hub-step-form button[type=submit]").click();
      await page.locator(".hub-code").waitFor();
      const code = (await page.locator(".hub-code").innerText()).trim(); assert.match(code, /^[a-f0-9]{12}$/);
      assert.equal(rig.db.prepare("SELECT 1 FROM hub_people WHERE person=?").get(personKeyString(owner)), undefined);
      assert.deepEqual(rig.db.prepare("SELECT COUNT(*) n FROM hub_grants").get(), { n: 0 });
      assert.deepEqual(rig.store.read().pairings.at(-1)?.owner, owner); assert.deepEqual(errors, []);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); assert.equal(overflow, false);
      const png = join(out, `c9-directory-owner-${c.lang}-${c.size}.png`); await page.screenshot({ path: png, fullPage: true });
      results.push({ lang: c.lang, size: c.size, png, beforeFirstSignIn: true, codeCreated: true, grantsCreated: false, overflow, errors });
    } finally { await context.close(); await rig.close(); rig = undefined; }
  }
  writeFileSync(join(out, "result.json"), JSON.stringify({ browser: await browser.version(), results }, null, 2));
  console.log(JSON.stringify({ pass: results.length, screenshots: results.map((r: any) => r.png) }));
} finally {
  await browser?.close(); web?.closeAllConnections(); if (web) await new Promise<void>(resolve => web!.close(() => resolve()));
  await rig?.close(); await directory.close();
  for (const dn of ownedDns) await ldap.del(dn).catch(() => {}); await ldap.unbind().catch(() => {});
  rmSync(certs.dir, { recursive: true, force: true });
}
