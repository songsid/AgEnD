import { publicRoster } from "../smoke-fixture/public-roster.mts";
// M-3293 (#4119, the light version) on the real app, from defaults (fleet decision a78ebdc5): Fleet → Org chart → Office
// (the whole fleet's own office, Cozy). A person is found on the canvas by the pointer (the canvas lights up over one).
//   desk: "Drag and pat" on by default; a mouse drag carries them (no card opens after the drop), they walk off the
//         drop point; their card's Pat and Feed show hearts and words. No request but a GET leaves the page meanwhile.
//         Tell (off by default, per agent): ticked, a pat is one POST /ui/office-tell, queued as "[Office] …" for the
//         agent's next message; unticked, nothing again.
//   desk, reduced motion: the toggle is off and locked; the card has no Pat or Feed.
//   phone: a long press (real touch events, CDP) picks them up and carries them; no card after the drop.
// Pictures per case in $OUT/smoke-office-play-m3293/.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [HP=19707] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-office-play-m3293.mts
// ui-gate: {"name": "Office drag and pat (local only)", "hp": 19707}
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-office-play-m3293";
const fx = await bootFixture({ roster: publicRoster(6), port: 0, oldPort: Number(process.env.HP ?? 49020), instances: 6, classic: false });
// The fixture opens no event log (no fleet start): Tell's queue is the real EventLog, in the scratch home.
if (!fx.fm.eventLog) { const { EventLog } = await import(`${process.env.REPO}/src/event-log.ts`); fx.fm.eventLog = new EventLog(`${fx.dir}/events-m3293.db`); }
const r: any = { cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const frame = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(document.querySelector(".oo-canvas").classList.contains("hot")))))`;
const hotAt = async (page: any, x: number, y: number) => { await page.mouse.move(x, y); return await page.evaluate(frame) as boolean; };
/** A point on the canvas over a person (desk: the pointer lights the canvas up), scanning from the middle out; or null. */
async function findPerson(page: any): Promise<{ x: number; y: number } | null> {
  const b = await page.locator(".oo-canvas").boundingBox();
  const pts: Array<[number, number]> = [];
  for (let y = b.y + 40; y < b.y + b.height - 30; y += 22) for (let x = b.x + 30; x < b.x + b.width - 30; x += 22) pts.push([x, y]);
  const mid = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  pts.sort((p, q) => Math.hypot(p[0] - mid.x, p[1] - mid.y) - Math.hypot(q[0] - mid.x, q[1] - mid.y));
  for (const [x, y] of pts) if (await hotAt(page, x, y)) return { x, y: y + 6 };
  return null;
}
/** Phone: a tap that opens a card is over a person (closed again). */
async function findPersonTouch(page: any): Promise<{ x: number; y: number } | null> {
  if (process.env.M3513_CAPTURE_ONLY === "1") {
    // Use the same real painted-person hit test first; confirm with an actual tap.
    const point = await findPerson(page);
    if (point) {
      await page.touchscreen.tap(point.x, point.y); await page.waitForTimeout(120);
      if (await page.locator(".oo-card").count()) { await page.locator(".oo-card-close").click(); await page.waitForTimeout(150); return point; }
    }
  }
  const b = await page.locator(".oo-canvas").boundingBox();
  for (let y = b.y + 60; y < b.y + b.height - 40; y += 26) for (let x = b.x + 30; x < b.x + b.width - 30; x += 26) {
    await page.touchscreen.tap(x, y); await page.waitForTimeout(120);
    if (await page.locator(".oo-card").count()) { await page.locator(".oo-card-close").click(); await page.waitForTimeout(150); return { x, y }; }
  }
  return null;
}
async function openOffice(page: any, base: string, lang: string) {
  await page.goto(`${base}/ui/fleet/org`);
  await page.locator(".oc-tools .seg-inline button", { hasText: lang === "en" ? "Office" : "辦公室" }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(2500);
}
const writes = (log: any[]) => log.filter((q) => q.method !== "GET");
const currentCapture = process.env.M3513_CAPTURE_ONLY === "1";
async function currentCard(page: any) {
  // Speech bubbles now have their own chat action; the accessible person target opens its card.
  const person = page.locator("button.oo-desk").first(); await person.focus(); await person.press("Enter");
  await page.locator(".oo-card").waitFor();
}


for (const c of [{ device: "desk", theme: "light", lang: "en", rm: false }, { device: "desk", theme: "dark", lang: "zh-TW", rm: false },
  { device: "desk", theme: "light", lang: "en", rm: true }, { device: "phone", theme: "light", lang: "en", rm: false }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}${c.rm ? "-reduced" : ""}`;
  if (process.env.M3513_CASE && process.env.M3513_CASE !== tag) continue;
  const res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c as any).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page, base } = p;
  const log: any[] = []; page.on("request", (q: any) => log.push({ method: q.method(), url: q.url().replace(/^https?:\/\/[^/]+/, "") }));
  try {
    ok(res, "mounted", await mounted(page, 30000));
    if (c.rm) await page.emulateMedia({ reducedMotion: "reduce" });
    await openOffice(page, base, c.lang);
    const box = page.locator(".oo-play input");
    // A phone keeps the Office's options in its ⋯ sheet; the desk shows them in the bar.
    if (c.device === "desk") ok(res, "toggle:shown", (await box.count()) === 1);
    if (c.rm) {
      ok(res, "reduced:toggle off and locked", !(await box.isChecked()) && (await box.isDisabled()));
      const at = await findPerson(page);
      ok(res, "reduced:person found", !!at);
      if (currentCapture) await currentCard(page);
      else if (at) { await page.mouse.click(at.x, at.y); await page.waitForTimeout(400); }
      ok(res, "reduced:card has no Pat/Feed", (await page.locator(".oo-card").count()) === 1 && (await page.locator(".oo-card-pat, .oo-card-feed").count()) === 0);
      await page.screenshot({ path: shotPath(SMOKE, tag, "1-card") });
    } else if (c.device === "desk") {
      ok(res, "toggle:on by default", await box.isChecked());
      const at = await findPerson(page);
      ok(res, "person found", !!at, at);
      if (!at) throw new Error("no person found on the canvas");
      await page.screenshot({ path: shotPath(SMOKE, tag, "1-before") });
      const n0 = log.length;
      const drop = { x: at.x + 170, y: at.y + 70 };
      const area = { x: drop.x - 24, y: drop.y - 60, width: 48, height: 72 };
      const empty = await page.screenshot({ clip: area });
      await page.mouse.move(at.x, at.y); await page.mouse.down();
      for (let i = 1; i <= 12; i++) { await page.mouse.move(at.x + (drop.x - at.x) * i / 12, at.y + (drop.y - at.y) * i / 12); await page.waitForTimeout(30); }
      await page.waitForTimeout(250);
      const carrying = await page.screenshot({ clip: area });
      ok(res, "carried: someone is drawn at the pointer (the spot differs from before the drag)", !empty.equals(carrying));
      await page.screenshot({ path: shotPath(SMOKE, tag, "2-carried") });
      await page.mouse.up(); await page.waitForTimeout(150);
      ok(res, "drop: no card opens", (await page.locator(".oo-card").count()) === 0);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: shotPath(SMOKE, tag, "3-walking-back") });
      let left = false;
      for (let i = 0; i < 30 && !left; i++) { await page.waitForTimeout(500); left = !(await hotAt(page, drop.x, drop.y)); }
      ok(res, "they walk off the drop point", left);
      await page.waitForTimeout(4000);
      await page.screenshot({ path: shotPath(SMOKE, tag, "4-back") });
      if (currentCapture) await currentCard(page);
      else { const again = await findPerson(page); if (again) { await page.mouse.click(again.x, again.y); await page.waitForTimeout(400); } }
      ok(res, "card: Pat and Feed", (await page.locator(".oo-card-pat").count()) === 1 && (await page.locator(".oo-card-feed").count()) === 1);
      await page.locator(".oo-card-pat").click(); await page.waitForTimeout(700);
      await page.screenshot({ path: shotPath(SMOKE, tag, "5-pat") });
      await page.locator(".oo-card-feed").click(); await page.waitForTimeout(700);
      await page.screenshot({ path: shotPath(SMOKE, tag, "6-feed") });
      const w = writes(log.slice(n0));
      ok(res, "local only: no request but a GET while dragging, patting and feeding", w.length === 0, w.slice(0, 5));
      // Tell (off by default, per agent): ticked, a pat is one POST /ui/office-tell, queued for the agent's next message.
      const who = (await page.locator(".oo-card-instance").innerText()).trim();
      ok(res, "tell: off by default", !(await page.locator(".oo-card-tell input").isChecked()));
      await page.locator(".oo-card-tell input").check(); await page.waitForTimeout(200);
      const n1 = log.length;
      await page.locator(".oo-card-pat").click(); await page.waitForTimeout(800);
      const told = writes(log.slice(n1));
      ok(res, "tell on: one POST /ui/office-tell per pat", told.length === 1 && told[0].url === "/ui/office-tell", told);
      const pending = fx.fm.eventLog?.pendingReactions(who)?.summary ?? null;
      ok(res, "tell on: queued as [Office] … patted your head (for the next message)", /\[Office\] .+ patted your head/.test(pending ?? ""), pending);
      await page.locator(".oo-card-tell input").uncheck(); await page.waitForTimeout(200);
      const n2 = log.length;
      await page.locator(".oo-card-feed").click(); await page.waitForTimeout(600);
      ok(res, "tell off again: nothing sent", writes(log.slice(n2)).length === 0);
      await page.locator(".oo-card-close").click().catch(() => {}); await page.waitForTimeout(150);
      await page.locator(".oo-card-pat").count();   // (closed)
      // A pat with the card closed: the hearts and the words over them (the card hid them above).
      if (currentCapture) { await currentCard(page); await page.locator(".oo-card-pat").click(); await page.locator(".oo-card-close").click(); await page.waitForTimeout(500); }
      else { const again2 = await findPerson(page); if (again2) { await page.mouse.click(again2.x, again2.y); await page.waitForTimeout(300); await page.locator(".oo-card-pat").click(); await page.locator(".oo-card-close").click(); await page.waitForTimeout(500); } }
      await page.screenshot({ path: shotPath(SMOKE, tag, "7-pat-words") });
      // Off: no Pat/Feed, and a drag pans (no one carried).
      await page.locator(".oo-card-close").click().catch(() => {});
      await box.click(); await page.waitForTimeout(300);
      ok(res, "toggle off: kept here", (await page.evaluate(`localStorage.getItem("agend_org_office_play")`)) === "0");
      if (currentCapture) await currentCard(page);
      else { const off = await findPerson(page); if (off) { await page.mouse.click(off.x, off.y); await page.waitForTimeout(400); } }
      ok(res, "toggle off: no Pat/Feed", (await page.locator(".oo-card-pat").count()) === 0);
      await box.click();   // back on, for the next case's defaults (each case is its own browser context anyway)
    } else {
      ok(res, "toggle:on by default (none stored)", (await page.evaluate(`localStorage.getItem("agend_org_office_play")`)) === null);
      const at = await findPersonTouch(page);
      ok(res, "person found (tap)", !!at, at);
      if (!at) throw new Error("no person found by tapping");
      const n0 = log.length;
      const cdp = await page.context().newCDPSession(page);
      const touch = (type: string, x: number, y: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
      await touch("touchStart", at.x, at.y); await page.waitForTimeout(700);           // a long press: held still
      for (let i = 1; i <= 10; i++) { await touch("touchMove", at.x + 12 * i, at.y + 6 * i); await page.waitForTimeout(40); }
      await page.waitForTimeout(200);
      await page.screenshot({ path: shotPath(SMOKE, tag, "1-long-press-carried") });
      await touch("touchEnd", 0, 0); await page.waitForTimeout(300);
      ok(res, "drop: no card opens", (await page.locator(".oo-card").count()) === 0);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: shotPath(SMOKE, tag, "2-walking-back") });
      ok(res, "local only: no request but a GET", writes(log.slice(n0)).length === 0, writes(log.slice(n0)).slice(0, 5));
    }
    ok(res, "noOverflow", !(await page.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)));
    ok(res, "noPageErrors", p.errors.length === 0, p.errors);
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await page.screenshot({ path: shotPath(SMOKE, tag, "error") }).catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, v.failed ?? []])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
