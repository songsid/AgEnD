/** Owned HTTPS, actual Hub HTTP/session/catalog/SQLite/UI; inert AD and member publication. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, loadavg } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";

const repo = process.env.REPO ?? process.cwd(), out = process.env.OUT!, mode = process.env.MODE ?? "current";
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "hub-group-label-3824-")); process.env.AGEND_HOME = home;
const hash = (value: any) => createHash("sha256").update(value).digest("hex");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const receipt: any = { mode, head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
  trackedDirty: git("status", "--porcelain", "--untracked-files=no"), inputs: {}, served: {}, cases: [], checks: [], errors: [],
  scope: "Actual baseline/candidate server and unchanged production UI over owned HTTPS. Inert AD and authenticated member publication; no live AD, Fleet, account, model or input. Fixture grant writes only; revoke dialogs cancelled." };
for (const path of ["src/hub/catalog.ts", "src/ui/panel-hub.js", "src/ui/hub-owner-strings.js", "src/ui/hub-owner.css", "tests/helpers/hub-s3b-rig.ts"])
  receipt.inputs[path] = hash(readFileSync(join(repo, path)));
receipt.harness = hash(readFileSync(new URL(import.meta.url)));
receipt.font = execFileSync("fc-match", ["sans:lang=zh-tw"], { encoding: "utf8" }).trim();
const check = (name: string, ok: unknown) => { receipt.checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); };
let rig: any, browser: any;
const server = createServer((q, p) => { if (!rig?.http.handle(q, p)) { p.writeHead(404); p.end(); } });
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "https://127.0.0.1:" + (server.address() as any).port;
  const { createBrowserCertificate } = await import(repo + "/src/hub/init/browser-certificate.ts");
  const tls = await createBrowserCertificate(home, origin);
  server.setSecureContext({ cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile) });
  const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts"); rig = await s3bRig({ webOrigin: origin });
  const owner = rig.addPerson("owner", "Avery · 研究者"), group = { realm: "corp", objectId: randomUUID() }, dn = "CN=Owners,DC=example,DC=test";
  Object.assign(rig.directory, { groupPolicy: "ad-direct-guid", resolvePolicyGroup: async (input: string) => input === dn
    ? { ok: true, group: { key: group, dn } } : { ok: false, reason: "not-found" },
    readPolicyGroups: async (person: any) => ({ kind: "complete", person, groups: [], observedAt: Date.now() }) });
  const { groupPolicyMigration, createHubGroupPolicyStore } = await import(repo + "/src/hub/group-policy/store.ts");
  groupPolicyMigration(rig.hubId, "corp", "directory-v1").up(rig.db);
  const policy = createHubGroupPolicyStore({ db: rig.db, hubId: rig.hubId, realm: "corp", generation: "directory-v1", directory: rig.directory,
    audit: { appendInTransaction() {} } as any, current: () => true });
  rig.httpDeps.grantDirectory = { policy: () => policy, binding: () => ({ kind: "ready" }) }; await rig.restartHttp();
  const link = rig.link(randomUUID(), owner), id = randomUUID();
  await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [{ id, fleetId: link.fleetId, owner,
    displayName: "研究助手 · Research", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link), link);
  const signedIn = await rig.signIn("owner"), created = await rig.call(signedIn, "POST", "/hub/v1/grants", { exposureId: id,
    exposureRevision: 1, days: 90, subject: { kind: "group", group, dn } }); check("fixture GUID grant created", created.status === 200);
  const grantBefore = rig.db.prepare("SELECT * FROM hub_grants WHERE id=?").get(created.json.grant.id);
  const expected = mode === "before" ? dn : "Owners";
  const pw = createRequire(process.env.PW_DIR + "/")("playwright-core");
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] }); receipt.browser = browser.version();
  for (const device of ["desktop", "phone"]) for (const theme of ["light", "dark"]) for (const lang of ["en", "zh-TW"]) {
    check("host load within10 before case", loadavg()[0]! <= 10);
    const tag = [mode, device, theme, lang].join("-"), context = await browser.newContext({ ignoreHTTPSErrors: true,
      viewport: device === "desktop" ? { width: 1366, height: 1000 } : { width: 390, height: 844 },
      isMobile: device === "phone", hasTouch: device === "phone", colorScheme: theme });
    try {
      await context.addInitScript('window.__name=fn=>fn;');
      await context.addInitScript(({ lang, theme }: any) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme);
        localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); }, { lang, theme });
      const page = await context.newPage(), assets: Promise<void>[] = [];
      page.on("pageerror", (e: any) => receipt.errors.push(String(e)));
      page.on("response", (response: any) => { const path = new URL(response.url()).pathname;
        if (/\.(js|css)$/.test(path)) assets.push((async () => { receipt.served[path] = hash(await response.body()); })()); });
      await page.goto(origin + "/ui/hub/exposures?agent=" + id);
      await page.fill("#hubLogin", "owner"); await page.fill("#hubPassword", "pw-owner");
      await page.locator(".hub-signin button[type=submit]").click();
      const row = page.locator(".hub-owner .hub-row").filter({ has: page.locator(".tag", { hasText: lang === "en" ? "AD group" : "AD 群組" }) });
      await row.waitFor(); check(tag + " readable name", await row.locator("strong").textContent() === expected);
      check(tag + " row menu names same group", (await row.locator("button[aria-haspopup=menu]").getAttribute("aria-label"))?.includes(expected));
      const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth,
        rows: [...document.querySelectorAll(".hub-owner .hub-row")].map(e => ({ text: e.textContent, ...e.getBoundingClientRect().toJSON() })) }));
      check(tag + " no horizontal overflow", geometry.overflow <= 1);
      if (mode !== "before") check(tag + " DN absent from visible page", !(await page.locator("body").innerText()).includes(dn));
      await page.screenshot({ path: join(out, tag + "-row.png"), fullPage: true });
      await row.locator("button[aria-haspopup=menu]").click();
      await page.getByRole("menuitem", { name: lang === "en" ? "Revoke…" : "撤銷…" }).click();
      const dialog = page.getByRole("dialog"); await dialog.waitFor();
      check(tag + " revoke confirmation names group", (await dialog.innerText()).includes(expected));
      if (device === "desktop") await page.screenshot({ path: join(out, tag + "-confirmation.png"), fullPage: true });
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
      await Promise.all(assets); receipt.cases.push({ tag, geometry });
    } finally { await context.close(); }
  }
  check("all8 cases ran", receipt.cases.length === 8);
  const view = await rig.call(signedIn, "GET", "/hub/v1/exposures");
  check("HTTP name matches UI", view.status === 200 && view.json.mine[0].grants[0].subjectName === expected);
  check("recorded DN and GUID preserved", view.json.mine[0].grants[0].subjectLabel === dn && view.json.mine[0].grants[0].subject.group.objectId === group.objectId);
  check("entire stored grant unchanged", JSON.stringify(rig.db.prepare("SELECT * FROM hub_grants WHERE id=?").get(created.json.grant.id)) === JSON.stringify(grantBefore));
  check("zero browser errors", receipt.errors.length === 0); receipt.status = "PASS";
} catch (e: any) { receipt.status = "FAIL"; receipt.error = e.stack; throw e; }
finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await rig?.close(); rmSync(home, { recursive: true, force: true }); receipt.cleaned = true;
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify({ status: receipt.status, cases: receipt.cases.length, checks: receipt.checks.length, out }));
