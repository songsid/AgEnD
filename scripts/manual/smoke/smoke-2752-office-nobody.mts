// #2752 from defaults (fleet decision a78ebdc5): an office for nobody (its style's NPCs only). A fresh fleet (no
// web-offices.json; six instances; one uploaded skin pack, the clinic fixture), fresh profiles with nothing seeded,
// signed in through the visible /signin, everything done through the visible UI.
// 1. An admin opens the Office, Edit offices → Add office, names it, picks the pack, Who is in it → Nobody (NPCs only),
//    Save: web-offices.json holds members ["team:"]; that office draws its scene with no one seated (no "nobody
//    matches" note), and the whole-fleet office still shows everyone.
// 2. Edit offices again: the office reads back as Nobody; → Everyone, Save: members [], everyone seated there.
// 3. → Picked, one instance ticked, Save: only that one; then → Nobody again, Save.
// 4. A second fresh profile (a read-only session) opens that office: nobody seated, without picking anything.
// Pictures: 1-nobody-office, 2-everyone, 3-picked, 4-second-profile.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2752-office-nobody.mts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2752-office-nobody";
const REPO = process.env.REPO!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48640), classic: false, instances: 6 });
const fm = fx.fm;
const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
const { fleetCookieName } = await import(REPO + "/src/web-cookie-names.ts");

const results: Array<Record<string, unknown>> = [];
let failed = 0;
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 1200)}`);
}

const FIX = join(REPO, "tests", "fixtures", "office-skin-clinic");
const manifest = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8"));
const PACK = manifest.id as string;
const files = { "office_bg.png": readFileSync(join(FIX, "office_bg.png")).toString("base64"), "fox_idle.png": readFileSync(join(FIX, "fox_idle.png")).toString("base64") };
const added = fm.officeSkins.add({ manifest, files, name: "Clinic" }, "smoke");
if (!added.ok) throw new Error(`pack refused: ${JSON.stringify(added).slice(0, 200)}`);
const officesFile = join(fm.dataDir ?? fx.dir, "web-offices.json");
const onDisk = () => (existsSync(officesFile) ? JSON.parse(readFileSync(officesFile, "utf8")).offices : null);

async function openOffice(page: any, base: string) {
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  const direct = page.locator('a[href^="/ui/fleet"]');
  let clicked = false;
  for (let i = 0; i < await direct.count() && !clicked; i++) if (await direct.nth(i).isVisible()) { await direct.nth(i).click(); clicked = true; }
  if (!clicked) await page.locator('nav.tabs a[href^="/ui/fleet"]').first().click();
  await page.waitForURL(/\/ui\/fleet/, { timeout: 10000 });
  if (!/\/ui\/fleet\/org$/.test(new URL(page.url()).pathname)) await page.locator('.p-fleet a.seg-item[href="/ui/fleet/org"]').first().click();
  await page.waitForURL(`${base}/ui/fleet/org`, { timeout: 10000 });
  await page.locator(".oc-tools .seg-inline button", { hasText: "Office" }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await page.waitForTimeout(800);
}
const desks = (page: any) => page.locator(".oo-desk").count() as Promise<number>;
const empty = (page: any) => page.locator(".oo-empty").count() as Promise<number>;
async function showOffice(page: any, id: string) {
  await page.locator("select.oo-office").selectOption(id);
  await page.waitForTimeout(1500);
}
/** Edit offices on the office `id` (null: the last row): choose who, maybe tick one instance, Save; the PUT's status. */
async function edit(page: any, who: "everyone" | "picked" | "nobody", tick: string | null = null, add: { name: string } | null = null) {
  await page.locator(".oo-edit").click();
  await page.waitForSelector("#oeAdd", { timeout: 5000 });
  if (add) {
    await page.locator("#oeAdd").click();
    const row = page.locator(".oe-row").last();
    await row.locator(".oe-name").fill(add.name);
    await row.locator(".oe-style").selectOption(PACK);
  }
  const row = page.locator(".oe-row").last();
  const before = (await row.locator(".oe-members-btn").textContent())?.trim();
  if (!(await row.locator(".oe-who").count())) await row.locator(".oe-members-btn").click();
  const readBack = await row.locator(".oe-who input:checked").getAttribute("value");
  await row.locator(`.oe-who input[value="${who}"]`).check();
  if (tick) await row.locator(".oe-members label", { hasText: tick }).locator("input[type=checkbox]").check();
  const after = (await row.locator(".oe-members-btn").textContent())?.trim();
  const saved = page.waitForResponse((r: any) => new URL(r.url()).pathname === "/ui/offices" && r.request().method() === "PUT", { timeout: 10000 });
  await page.locator("#oeSave").click();
  const status = (await saved).status();
  await page.waitForTimeout(1500);
  return { before, readBack, after, status };
}

const C: MatrixCase = { device: "desk", theme: "light", lang: "en" };
const ALL = 6;

// ── 1. Add an office for nobody ──
const fileBefore = existsSync(officesFile);
const admin = await freshPage(fx, C);
await openOffice(admin.page, admin.base);
const wholeFirst = await desks(admin.page);
const e1 = await edit(admin.page, "nobody", null, { name: "Decor" });
const decor = (onDisk() ?? []).find((o: any) => o.name === "Decor");
await showOffice(admin.page, decor?.id ?? "");
const d1 = await desks(admin.page), n1 = await empty(admin.page);
await admin.page.screenshot({ path: shotPath(SMOKE, C, "1-nobody-office") });
const optionValues = await admin.page.locator("select.oo-office option").evaluateAll((os: any[]) => os.map((o) => o.value));
record("1 Add office → Nobody (NPCs only) → Save", {
  "no web-offices.json before": !fileBefore,
  "the whole-fleet office seats everyone first": wholeFirst === ALL,
  "a new office starts as Everyone": e1.readBack === "everyone",
  "the button says Nobody once chosen": e1.after === "Who is in it: Nobody (NPCs only)",
  "PUT answered 200": e1.status === 200,
  "stored as members [\"team:\"]": JSON.stringify(decor?.members) === '["team:"]',
  "in the pack's style": decor?.skin === PACK,
  "drawn with no one seated": d1 === 0,
  "no 'nobody matches' note": n1 === 0,
  "no page error": admin.errors.length === 0,
}, { wholeFirst, e1, decor, d1, n1, optionValues, errors: admin.errors });

// ── 2. Read back as Nobody; → Everyone ──
const e2 = await edit(admin.page, "everyone");
await showOffice(admin.page, decor.id);
const d2 = await desks(admin.page);
await admin.page.screenshot({ path: shotPath(SMOKE, C, "2-everyone") });
record("2 read back as Nobody; → Everyone → Save", {
  "the button read Nobody": e2.before === "Who is in it: Nobody (NPCs only)",
  "Nobody chosen when opened": e2.readBack === "nobody",
  "PUT answered 200": e2.status === 200,
  "stored as members []": JSON.stringify(onDisk().find((o: any) => o.id === decor.id).members) === "[]",
  "everyone seated": d2 === ALL,
}, { e2, d2 });

// ── 3. → Picked, one ticked; then → Nobody again ──
const first = fm.fleetConfig ? Object.keys(fm.fleetConfig.instances)[0] : "";
const e3 = await edit(admin.page, "picked", first);
await showOffice(admin.page, decor.id);
const d3 = await desks(admin.page);
const stored3 = onDisk().find((o: any) => o.id === decor.id).members;
await admin.page.screenshot({ path: shotPath(SMOKE, C, "3-picked") });
const chrome3 = { edit: await admin.page.locator(".oo-edit").count(), share: await admin.page.locator(".oo-share").count(), tier: await admin.page.evaluate("document.body.dataset.tier || ''") };
const e3b = await edit(admin.page, "nobody");
await showOffice(admin.page, decor.id);
const d3b = await desks(admin.page);
record("3 → Picked (one) → Save; → Nobody → Save", {
  "Everyone chosen when opened": e3.readBack === "everyone",
  "the button says 1 picked": e3.after === "Who is in it: 1 picked",
  "PUT answered 200": e3.status === 200,
  "Edit offices still offered": chrome3.edit === 1,
  "stored as that one": JSON.stringify(stored3) === JSON.stringify([first]),
  "one seated": d3 === 1,
  "Picked chosen when opened again": e3b.readBack === "picked",
  "stored as nobody again": JSON.stringify(onDisk().find((o: any) => o.id === decor.id).members) === '["team:"]',
  "no one seated": d3b === 0,
  "no page error": admin.errors.length === 0,
}, { first, e3, stored3, d3, chrome3, e3b, d3b });

// ── 4. A second fresh profile (read-only) ──
fm.initializeWebSessions();
const roSid = fm.webSessions.create({ tier: "read", surface: "local", label: "smoke read", tokenEpoch: tokenEpoch(fm.webToken) }).sessionId;
const roCtx = await fx.browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: "light", locale: "en-US" });
await roCtx.addCookies([{ name: fleetCookieName("agend_session", fm.webToken), value: roSid, url: fx.base, httpOnly: true, sameSite: "Strict" }]);
const ro = await roCtx.newPage();
const roErrors: string[] = [];
ro.on("pageerror", (e: any) => roErrors.push(String(e).slice(0, 200)));
await ro.goto(`${fx.base}/ui`);
await openOffice(ro, fx.base);
const roWhole = await desks(ro);
await showOffice(ro, decor.id);
const d4 = await desks(ro), n4 = await empty(ro);
await ro.screenshot({ path: shotPath(SMOKE, C, "4-second-profile") });
record("4 a second fresh profile", {
  "the whole-fleet office seats everyone": roWhole === ALL,
  "the office for nobody seats no one": d4 === 0,
  "no 'nobody matches' note": n4 === 0,
  "no edit offered (read-only)": (await ro.locator(".oo-edit").count()) === 0,
  "no page error": roErrors.length === 0,
}, { roWhole, d4, n4, errors: roErrors });

await roCtx.close();
await admin.ctx.close();
writeFileSync(shotPath(SMOKE, "result", "json").replace(/\.png$/, ".json"), JSON.stringify({ results, failed }, null, 1));
await fx.close();
console.log(failed ? `${failed} FAILED` : "all ok");
process.exit(failed ? 1 : 0);
