// #2399 from defaults (fleet decision a78ebdc5): the Office view and its editor. Each case is a fresh profile with
// nothing seeded, signed in through the visible /signin, reaching Fleet → Org chart → Office through visible
// navigation. Demo names only (a small fleet: General, one team, two on their own).
// Per case (desk light en, desk dark zh-TW on a LAN origin, phone light zh-TW, phone dark en; reduced motion on the
// phone):
// - admin: the Office draws and offers "Edit offices"; the editor starts empty; Add office, name it, Studio, tick the
//   team, Save → the toast, the dialog closed, the office in the switcher and in the host's store; picked in the
//   switcher, it draws exactly the team;
// - conflict: the editor open in this tab while a second tab of the same person saves a rename through its own editor;
//   Save here → the "changed meanwhile" message, the other tab's list shown and editable again, nothing overwritten
//   (the store holds the other tab's name);
// - blocked: a read-only session (tier read) and the public link see the Office and no "Edit offices", and their PUT
//   writes nothing (read-only: 403; the public link's gateway has no PUT route for it: 404); a guest session cannot
//   reach Fleet or GET /ui/offices (401 with guest sign-in off, the default).
// - no console error, no CSP violation, no horizontal overflow; no real fleet name in any visible text.
// - an accepted far-out custom layout (a seat at 10000, 10000) paints (run with PW_DPR=3 for the review's case).
// - #2431 polish: after a 409 the draft is kept and the person chooses (desk: keep mine and save; phone: load theirs);
//   an office of an unknown style says so; the guest gets a page in its browser's language, not the gate's JSON.
// Pictures: <case>-1-office, -2-editor-new, -3-saved, -4-conflict, -4a-loaded-theirs (phone), -4b-far-seat, -4c-unknown-style, -5-read-only, -6-public-link, -7-guest.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [ONLY=desk-light-en,…] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2399-office.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type FreshPage, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2399-office";
const REPO = process.env.REPO!;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48580), classic: false });
const fm = fx.fm;
const dir = fm.dataDir ?? fx.dir;
const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
const { fleetCookieName } = await import(REPO + "/src/web-cookie-names.ts");

// ── The fleet: demo names only ──
const TEAM = "Design studio";
const MEMBERS = ["studio-layout", "studio-copy", "studio-review"];
const names = ["general", ...MEMBERS, "release-notes-drafter", "nightly-benchmarks"];
fm.fleetConfig.instances = Object.fromEntries(names.map((name, i) => [name, { working_directory: dir, backend: ["claude-code", "codex", "kiro-cli"][i % 3], ...(name === "general" ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = { [TEAM]: { members: MEMBERS } };
fm.getInstanceStatus = () => "running";
const REAL = /agend-|t15\d{6}|web-claude|\bsol\b|\bfable\b|qa-1|rd1-|awp-|doupo-|研一官網-t|鬥破|己把鳩/;

const results: Array<Record<string, unknown>> = [];
let failed = 0;
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 1500)}`);
}
const zh = (c: MatrixCase) => c.lang === "zh-TW";
const W = {
  edit: (c: MatrixCase) => (zh(c) ? "編輯辦公室" : "Edit offices"),
  saved: (c: MatrixCase) => (zh(c) ? "辦公室已儲存。" : "Offices saved."),
  changed: (c: MatrixCase) => (zh(c) ? "有人在這期間修改了辦公室" : "Someone changed the offices meanwhile"),
  office: (c: MatrixCase) => (zh(c) ? "辦公室" : "Office"),
  unknownStyle: (c: MatrixCase) => (zh(c) ? "以辦公桌顯示" : "drawn as Desks"),
  guestEnded: (c: MatrixCase) => (zh(c) ? "目前沒有分享給你的聊天" : "No chats are shared with you"),
};

// ── Visible navigation ──
async function openOffice(page: any, c: MatrixCase, base: string) {
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  const direct = page.locator('a[href^="/ui/fleet"]');
  let clicked = false;
  for (let i = 0; i < await direct.count() && !clicked; i++) if (await direct.nth(i).isVisible()) { await direct.nth(i).click(); clicked = true; }
  if (!clicked) await page.locator('nav.tabs a[href^="/ui/fleet"]').first().click();
  await page.waitForURL(/\/ui\/fleet/, { timeout: 10000 });
  if (!/\/ui\/fleet\/org$/.test(new URL(page.url()).pathname)) await page.locator('.p-fleet a.seg-item[href="/ui/fleet/org"]').first().click();
  await page.waitForURL(`${base}/ui/fleet/org`, { timeout: 10000 });
  await page.locator(".oc-tools .seg-inline button", { hasText: W.office(c) }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await page.waitForTimeout(600);
}
/** The Office reached by a page signed in some other way (a session cookie): visible navigation from /ui. */
async function openOfficeAt(page: any, c: MatrixCase, base: string) {
  await page.goto(`${base}/ui`);
  await openOffice(page, c, base);
}
const visibleText = (page: any) => page.evaluate("document.body.innerText") as Promise<string>;
const overflow = (page: any) => page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth") as Promise<boolean>;
const csp = (page: any) => page.evaluate("window.__smokeCsp || []") as Promise<string[]>;
const watchCsp = (ctx: any) => ctx.addInitScript({ content: `window.__smokeCsp = []; document.addEventListener("securitypolicyviolation", e => window.__smokeCsp.push(e.violatedDirective + " " + (e.blockedURI || "")));` });
/** A PUT from the page itself (its own cookie and CSRF wrapper are not used: the host must refuse it on the session). */
const put = (page: any, body: unknown) => page.evaluate(async (b: unknown) => {
  const r = await fetch("/ui/offices", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return r.status;
}, body) as Promise<number>;
const get = (page: any) => page.evaluate(async () => (await fetch("/ui/offices")).status) as Promise<number>;

/** A session of `tier` in a fresh context (nothing seeded), its cookie set as the browser would hold it. */
async function sessionPage(c: MatrixCase, tier: "read" | "guest") {
  fm.initializeWebSessions();
  const owner = { adapterId: "demo", userId: tier === "guest" ? "900000000000000801" : "900000000000000802" };
  const sid = fm.webSessions.create({ tier, surface: "local", label: `smoke ${tier}`, tokenEpoch: tokenEpoch(fm.webToken), ...(tier === "guest" ? { owner } : {}) }).sessionId;
  const ctx = await fx.browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, colorScheme: c.theme,
    locale: zh(c) ? "zh-TW" : "en-US", isMobile: c.device === "phone", hasTouch: c.device === "phone", reducedMotion: c.device === "phone" ? "reduce" : "no-preference" });
  await watchCsp(ctx);
  await ctx.addCookies([{ name: fleetCookieName("agend_session", fm.webToken), value: sid, url: fx.base, httpOnly: true, sameSite: "Strict" }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
  return { ctx, page, errors };
}

const ONLY = process.env.ONLY?.split(",");
const CASES: Array<MatrixCase & { lan?: boolean }> = [
  { device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW", lan: true },
  { device: "phone", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "en" },
];
const link = await openPublicLink(fx);

for (const k of CASES) {
  const c: MatrixCase = { device: k.device, theme: k.theme, lang: k.lang };
  const name = `${k.device}-${k.theme}-${k.lang}`;
  if (ONLY && !ONLY.includes(name)) continue;
  fm.officeStore.replace([], fm.officeStore.list().rev);               // each case starts with no offices kept
  const p: FreshPage = await freshPage(fx, c, { reducedMotion: k.device === "phone", ...(k.lan ? { origin: "lan" as const } : {}), beforeNavigate: watchCsp });
  const ck: Record<string, boolean> = {};
  const texts: string[] = [];
  await openOffice(p.page, c, p.base);
  const navEnd = p.errors.length;

  // ── Admin: Edit offices, add one, save ──
  const edit = p.page.locator(".oo-edit");
  ck.editOffered = await edit.isVisible() && (await edit.innerText()).trim() === W.edit(c);
  await p.page.screenshot({ path: shotPath(SMOKE, name, "1-office") });
  await edit.click();
  await p.page.waitForSelector("#oeAdd", { timeout: 5000 });
  ck.startsEmpty = await p.page.locator("#oeNone").isVisible();
  await p.page.locator("#oeAdd").click();
  const row = p.page.locator(".oe-row").first();
  const officeName = zh(c) ? `設計工作室 ${k.device}` : `Design floor ${k.device}`;
  await row.locator(".oe-name").fill(officeName);
  await row.locator(".oe-style").selectOption("studio");
  await row.locator(".oe-members .oe-group").first().locator("label", { hasText: TEAM }).locator("input").check();
  await p.page.screenshot({ path: shotPath(SMOKE, name, "2-editor-new") });
  texts.push(await visibleText(p.page));
  await p.page.locator("#oeSave").click();
  ck.toast = await p.page.getByText(W.saved(c)).first().isVisible({ timeout: 5000 }).catch(() => false) || await p.page.getByText(W.saved(c)).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  ck.dialogClosed = await p.page.locator("#oeSave").waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
  const stored = fm.officeStore.list();
  ck.stored = stored.offices.length === 1 && stored.offices[0].name === officeName && stored.offices[0].skin === "studio" && stored.offices[0].members.includes(`team:${TEAM}`);
  ck.inSwitcher = await p.page.waitForFunction((n: string) => [...document.querySelectorAll(".oo-bar select option")].some((o) => o.textContent?.trim() === n), officeName, { timeout: 5000 }).then(() => true, () => false);
  // Saving does not switch offices: the person picks the new one in the switcher, and it draws its team.
  const switcher = p.page.locator(".oo-bar select").first();
  if (ck.inSwitcher) await switcher.selectOption({ label: officeName });
  await p.page.waitForTimeout(600);
  const drawn = await p.page.$$eval(".oo-desk[data-name]", (d) => d.map((x) => x.getAttribute("data-name")));
  ck.newOfficeDraws = drawn.length === MEMBERS.length && MEMBERS.every((m) => drawn.includes(m));
  await p.page.screenshot({ path: shotPath(SMOKE, name, "3-saved") });

  // ── Conflict: this tab's editor open while another tab of the same person saves ──
  await p.page.locator(".oo-edit").click();
  await p.page.waitForSelector(".oe-row .oe-name", { timeout: 5000 });
  await p.page.locator(".oe-row .oe-name").first().fill(`${officeName} (this tab)`);
  const other = await p.ctx.newPage();
  await other.goto(`${p.base}/ui`);
  await openOffice(other, c, p.base);
  await other.locator(".oo-edit").click();
  await other.waitForSelector(".oe-row .oe-name", { timeout: 5000 });
  const otherName = `${officeName} (other tab)`;
  await other.locator(".oe-row .oe-name").first().fill(otherName);
  await other.locator("#oeSave").click();
  ck.otherSaved = await other.locator("#oeSave").waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false) && fm.officeStore.list().offices[0]?.name === otherName;
  await other.close();
  await p.page.bringToFront();
  await p.page.locator("#oeSave").click();
  const msg = p.page.locator(".oe-msg");
  ck.conflictMessage = await msg.waitFor({ timeout: 5000 }).then(() => true, () => false) && (await msg.innerText()).includes(W.changed(c));
  ck.notOverwritten = fm.officeStore.list().offices[0]?.name === otherName;
  // #2431: the draft is kept, and the person chooses — Save waits for the choice.
  ck.conflictKeepsDraft = (await p.page.locator(".oe-row .oe-name").first().inputValue()) === `${officeName} (this tab)`;
  ck.saveWaitsForChoice = await p.page.locator("#oeSave").isDisabled() && await p.page.locator("#oeKeepMine").isVisible() && await p.page.locator("#oeLoadTheirs").isVisible();
  ck.editableAgain = await p.page.waitForFunction(() => !document.querySelector("fieldset.oe-form")?.hasAttribute("disabled"), null, { timeout: 5000 }).then(() => true, () => false);
  await p.page.screenshot({ path: shotPath(SMOKE, name, "4-conflict") });
  texts.push(await visibleText(p.page));
  if (k.device === "desk") {
    // Keep my edits: Save then replaces the other tab's, knowingly.
    await p.page.locator("#oeKeepMine").click();
    await p.page.locator("#oeSave").click();
    ck.choiceTaken = await p.page.locator("#oeSave").waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false) && fm.officeStore.list().offices[0]?.name === `${officeName} (this tab)`;
  } else {
    // Load theirs: the other tab's list, nothing saved.
    await p.page.locator("#oeLoadTheirs").click();
    ck.choiceTaken = (await p.page.locator(".oe-row .oe-name").first().inputValue()) === otherName && fm.officeStore.list().offices[0]?.name === otherName;
    await p.page.screenshot({ path: shotPath(SMOKE, name, "4a-loaded-theirs") });
    await p.page.keyboard.press("Escape");
    await p.page.locator("#oeSave").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  }
  ck.noOverflow = !(await overflow(p.page));
  // #2431 review: an accepted far-out custom layout (a seat at 10000, 10000) still paints — at PW_DPR=3 the bitmap would
  // be 30216 × 30264, which Chromium hands back blank. Picked in the switcher; a pixel read back from the canvas.
  const far = { id: "far", name: "Far seat", skin: "pixel", members: [MEMBERS[0]], layout: { seats: [{ id: "s", x: 10000, y: 10000 }], waypoints: [], edges: [] } };
  const kept = fm.officeStore.list();
  ck.farStored = fm.officeStore.replace([...kept.offices, far], kept.rev).ok === true;
  await p.page.reload(); await p.page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await p.page.locator(".oo-bar select").first().selectOption({ label: far.name });
  await p.page.waitForTimeout(800);
  const farPaint = await p.page.evaluate(() => {
    const cv = document.querySelector(".oo-canvas") as HTMLCanvasElement;
    const a = cv.getContext("2d")!.getImageData(2, 2, 1, 1).data[3];
    return { w: cv.width, h: cv.height, cssW: cv.clientWidth, alpha: a, dpr: devicePixelRatio };
  });
  ck.farPaints = farPaint.alpha > 0 && farPaint.cssW > 10000;
  await p.page.screenshot({ path: shotPath(SMOKE, name, "4b-far-seat") });
  // #2431: an office whose stored style this page does not know says so (drawn as Desks).
  const odd = { id: "odd", name: "Odd style", skin: "neon-arcade", members: [MEMBERS[1]] };
  const now = fm.officeStore.list();
  fm.officeStore.replace([...now.offices, odd], now.rev);
  await p.page.reload(); await p.page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await p.page.locator(".oo-bar select").first().selectOption({ label: odd.name });
  ck.unknownStyleSaid = await p.page.locator(".oo-note", { hasText: "neon-arcade" }).isVisible({ timeout: 5000 }).catch(() => false)
    && (await p.page.locator(".oo-note", { hasText: "neon-arcade" }).innerText()).includes(W.unknownStyle(c));
  await p.page.screenshot({ path: shotPath(SMOKE, name, "4c-unknown-style") });
  // The conflict's own 409 is logged by the browser as a failed resource: expected, kept apart, never dropped.
  const conflict409 = (e: string) => /status of 409/.test(e) && /\/ui\/offices$/.test(e);
  const expected409 = p.errors.slice(navEnd).filter(conflict409);
  ck.noErrors = p.errors.slice(navEnd).filter((e) => !conflict409(e)).length === 0 && expected409.length === 1;
  ck.noCsp = (await csp(p.page)).length === 0;
  const adminErrors = p.errors.slice(navEnd).filter((e) => !conflict409(e));
  await p.ctx.close();

  // ── Blocked: a read-only session ──
  const ro = await sessionPage(c, "read");
  await openOfficeAt(ro.page, c, fx.base);
  ck.readOnlyNoEdit = await ro.page.locator(".oo-canvas").isVisible() && (await ro.page.locator(".oo-edit").count()) === 0;
  ck.readOnlyPutRefused = (await put(ro.page, { offices: [], rev: fm.officeStore.list().rev })) === 403;
  ck.readOnlyNoErrors = ro.errors.length === 0 && (await csp(ro.page)).length === 0;
  await ro.page.screenshot({ path: shotPath(SMOKE, name, "5-read-only") });
  texts.push(await visibleText(ro.page));
  await ro.ctx.close();

  // ── Blocked: the public link (an admin session, over the gateway) ──
  const pub = await link.publicPage(c, { reducedMotion: k.device === "phone", beforeNavigate: watchCsp });
  await openOffice(pub.page, c, pub.base);
  const pubNav = pub.errors.length;
  ck.publicNoEdit = await pub.page.locator(".oo-canvas").isVisible() && (await pub.page.locator(".oo-edit").count()) === 0;
  const publicPut = await put(pub.page, { offices: [], rev: fm.officeStore.list().rev });
  // The gateway has no PUT route for it (404) — or the route refuses (403): either way nothing is written.
  ck.publicPutRefused = (publicPut === 403 || publicPut === 404) && fm.officeStore.list().offices.length === 3;
  const probe = (e: string) => new RegExp(`status of ${publicPut} .*\\/ui\\/offices$`).test(e);   // the probe's own refusal, logged
  const publicErrors = [...pub.errors.slice(pubNav).filter((e, i, a) => !(probe(e) && a.findIndex(probe) === i)), ...(await csp(pub.page))];
  ck.publicNoErrors = publicErrors.length === 0;
  await pub.page.screenshot({ path: shotPath(SMOKE, name, "6-public-link") });
  texts.push(await visibleText(pub.page));
  await pub.ctx.close();

  // ── Blocked: a guest session ──
  const guest = await sessionPage(c, "guest");
  await guest.page.goto(`${fx.base}/ui/fleet/org`);
  await guest.page.waitForTimeout(1500);
  const guestGet = await get(guest.page);
  ck.guestNoOffices = guestGet === 401 || guestGet === 403;
  ck.guestNoOffice = (await guest.page.locator(".oo-canvas").count()) === 0 && (await guest.page.locator(".oo-edit").count()) === 0;
  // #2431: a page in the browser's language, not the gate's JSON (this fixture's guest has no chat shared: "ended").
  const guestText = await visibleText(guest.page);
  ck.guestPage = guestText.includes(W.guestEnded(c)) && !/guest_scope_empty|"error"/.test(guestText);
  await guest.page.screenshot({ path: shotPath(SMOKE, name, "7-guest") });
  texts.push(await visibleText(guest.page));
  await guest.ctx.close();

  const real = texts.flatMap((t) => t.split("\n")).filter((l) => REAL.test(l));
  ck.demoNamesOnly = real.length === 0;
  record(name, ck, { farPaint, origin: p.base, stored: fm.officeStore.list().offices.map((o: any) => o.name), guestGet, publicPut, publicErrors, expected409, adminErrors, real: real.slice(0, 5) });
}

await link.close();
writeFileSync(shotPath(SMOKE, "results", "x").replace(/[^/]+$/, "results.json"), JSON.stringify(results, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} ${results.length} cases`);
await fx.close();
process.exit(failed ? 1 : 0);
