// #2661: the Office's level badges and profile card in a real browser. The shared fixture (no fleet start), the host's
// levels stubbed (the scratch home has no usage store) with one instance per tier, one pinned title in a pack.
// For each case: open Fleet → Org chart → Office (Cozy), Enter on a desk-list entry opens the card beside the person
// (desk: 320 px wide, inside the stage; phone: a bottom sheet), its rows and buttons; Esc closes it; Find in office
// zooms in; the card's Chat opens the chat. Pictures: <case>-card.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf MATRIX=quick \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2661-office-card.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath, labelOf } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2661-office-card";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48661), classic: false, instances: 8 });
const fm = fx.fm as any;
const names = Object.keys(fm.fleetConfig.instances) as string[];
const LEVELS = [3, 12, 27, 40, 50, 120, 1500, 0];
const levels = Object.fromEntries(names.map((n, i) => {
  const level = LEVELS[i % LEVELS.length]!;
  return [n, { level, workTokens: level * level * 100_000 + 4321, estimated: i === 2, today: { workTokens: 12_345, requests: 45 }, firstSeen: "2026-09-01" }];
}));
fm.officeLevels = async () => levels;

const results: Array<Record<string, unknown>> = [];
let failed = 0;
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 900)}`);
}

async function openOffice(page: any, base: string, c: any) {
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  await page.goto(`${base}/ui/fleet/org`);
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  await page.locator(".oc-tools .seg-inline button", { hasText: labelOf(c, { en: "Office", zh: "辦公室" }) }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await page.waitForTimeout(1500);
}

for (const c of matrix(process.env.MATRIX ?? "quick")) {
  const { page, base, errors } = await freshPage(fx, c);
  await openOffice(page, base, c);
  const who = names[4]!;                                                  // Lv 50: Master, gold
  const desk = page.locator(`.oo-desk[data-name="${who}"]`);
  await desk.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".oo-card", { timeout: 5000 });
  await page.waitForTimeout(400);
  const box = await page.locator(".oo-card").boundingBox();
  const stage = await page.locator(".oo-stage").boundingBox();
  const sheet = await page.locator(".oo-card.sheet").count();
  const card = await page.locator(".oo-card").evaluate((el: any) => ({
    state: el.querySelector(".oo-card-state")?.textContent, xp: el.querySelector(".oo-card-xp")?.textContent, badge: el.querySelector(".oo-badge")?.textContent,
    badgeTier: el.querySelector(".oo-badge")?.className, rows: [...el.querySelectorAll(".oo-card-rows dt")].map((d: any) => d.textContent),
    instanceH: el.querySelector(".oo-card-instance")?.getBoundingClientRect().height, buttons: [...el.querySelectorAll(".oo-card-actions button")].map((b: any) => b.textContent),
    avatarPainted: (() => { const cv = el.querySelector("canvas"); const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; })(),
  }));
  await page.screenshot({ path: shotPath(SMOKE, c, "card") });
  const phone = c.device === "phone";
  record(`${caseName(c)} Enter on a desk opens the card`, {
    "a card": !!box,
    ...(phone ? { "a bottom sheet": sheet === 1, "just above the tab bar": !!box && Math.abs(box.y + box.height - ((await page.locator("nav.tabs").boundingBox())?.y ?? -99)) < 2 }
      : { "320 px wide": !!box && Math.round(box.width) === 320, "inside the stage": !!box && !!stage && box.x >= stage.x && box.x + box.width <= stage.x + stage.width + 1 }),
    "the title in the state line": /·/.test(card.state ?? ""),
    "Lv 50 and its tokens": (card.xp ?? "").includes("Lv 50"),
    "two XP lines and a bar": !!(await page.locator(".oo-card-bar").count()),
    "badge 50, gold tier": card.badge === "50" && /tier-4/.test(card.badgeTier ?? ""),
    "five rows": card.rows.length === 5,
    "the instance name one line": (card.instanceH ?? 99) <= 18.5,
    "Find and Chat": card.buttons.length === 2,
    "the avatar drawn": card.avatarPainted,
  }, { card, box, stage });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const closed = (await page.locator(".oo-card").count()) === 0;
  await desk.focus(); await page.keyboard.press("Enter"); await page.waitForSelector(".oo-card");
  const before = await page.locator(".oo-zoom-pct").textContent();
  await page.locator(".oo-card-find").click(); await page.waitForTimeout(500);
  const after = await page.locator(".oo-zoom-pct").textContent();
  await page.screenshot({ path: shotPath(SMOKE, c, "found") });
  await page.locator(".oo-card-chat").click();
  await page.waitForURL(/\/ui\/chat\//, { timeout: 5000 }).catch(() => {});
  record(`${caseName(c)} Esc closes; Find zooms in; Chat opens the chat`, {
    "Esc closed it": closed,
    "Find changed the zoom": before !== after,
    "Chat opened the chat": new URL(page.url()).pathname === `/ui/chat/${who}`,
    "no page error": errors.length === 0,
  }, { before, after, url: page.url(), errors });
  await page.context().close();
}

console.log(JSON.stringify({ smoke: SMOKE, failed, results: results.length }));
await fx.close();
process.exit(failed ? 1 : 0);
