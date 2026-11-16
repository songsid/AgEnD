// M-3254 (the user, 11-16): a phone held sideways gets the phone layout — a coarse pointer in a window at most 500 px tall
// (and at most 1023 px wide: a tablet's keyboard never flips it), at any width under that: the ☰ drawer, phone headers,
// the phone's sizes. The user's iPhone sideways (956 × 440, touch), light and dark, zh-TW; a desk (1366 × 900, mouse) and a
// tablet sideways (1180 × 820, touch) stay as they are. Shots and measurements per case:
//   1-fleet, 2-drawer (☰ tapped), 3-chat, 4-chat-keyboard (the window as short as an on-screen keyboard leaves it, the
//   composer focused), 5-office, 6-hub, 7-settings.
// LABEL=before|after names the shots.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] [CASES=…] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-phone-landscape-m3254.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, seedChat, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "phone-landscape-m3254", LABEL = process.env.LABEL ?? "after";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48936), instances: 12, classic: false });
const names = fx.instances.map((i: any) => i.name);
await seedChat(fx, [names[1]], 24);
const ALL = [
  { id: "landscape-light", theme: "light", view: { width: 956, height: 440 }, touch: true, phone: true },
  { id: "landscape-dark", theme: "dark", view: { width: 956, height: 440 }, touch: true, phone: true },
  { id: "desk-light", theme: "light", view: { width: 1366, height: 900 }, touch: false, phone: false },
  { id: "tablet-light", theme: "light", view: { width: 1180, height: 820 }, touch: true, phone: false },
] as const;
const want = (process.env.CASES ?? "").split(",").filter(Boolean);
const r: any = { label: LABEL, cases: {} };
const LAYOUT = `(() => { const side = document.querySelector("#sidebar"), sb = side ? side.getBoundingClientRect() : null;
  const open = document.querySelector("#sbOpen"), ob = open ? open.getBoundingClientRect() : null;
  const head = document.querySelector("main .panel-head, .panel-head"), hb = head ? head.getBoundingClientRect() : null;
  const vis = (b) => !!b && b.width > 0 && b.height > 0 && b.right > 0 && b.left < innerWidth;
  return { innerWidth, innerHeight, sidebarShown: vis(sb) && getComputedStyle(side).visibility !== "hidden" ? Math.round(Math.min(sb.right, innerWidth) - Math.max(0, sb.left)) : 0,
    menuButton: vis(ob) && getComputedStyle(open).display !== "none", headerH: hb ? Math.round(hb.height) : null,
    drawerOpen: !!document.querySelector(".shell.sb-open"), pageScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`;
const COMPOSER = `(() => { const c = document.querySelector("#msgIn"), b = c ? c.getBoundingClientRect() : null;
  const send = document.querySelector(".composer .btn-send, .composer button[type=submit], .send-btn"), sb = send ? send.getBoundingClientRect() : null;
  return { innerHeight, composer: b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) } : null, inView: !!b && b.top >= 0 && b.bottom <= innerHeight + 0.5,
    sendInView: !!sb && sb.bottom <= innerHeight + 0.5 && sb.top >= 0, focused: document.activeElement === c }; })()`;
for (const c of ALL.filter((x) => !want.length || want.includes(x.id))) {
  const res: any = (r.cases[c.id] = {});
  const p = await freshPage(fx, { device: c.touch ? "phone" : "desk", theme: c.theme, lang: "zh-TW" } as any)
    .catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page, base } = p;
  const shot = (n: string) => page.screenshot({ path: shotPath(SMOKE, c.id, `${LABEL}-${n}`) });
  const go = async (path: string) => { await page.goto(base + path); await mounted(page, 30000); await page.waitForTimeout(900); };
  try {
    await page.setViewportSize(c.view);
    res.media = await page.evaluate(`({ coarse: matchMedia("(pointer: coarse)").matches, phoneQ: matchMedia("(max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)").matches })`);
    await go("/ui/fleet");
    res.fleet = await page.evaluate(LAYOUT); await shot("1-fleet");
    if (res.fleet.menuButton) {
      await page.locator("#sbOpen").first().tap(); await page.waitForTimeout(700);
      res.drawer = await page.evaluate(LAYOUT); await shot("2-drawer");
      await page.evaluate(`document.querySelector(".shell")?.classList.remove("sb-open")`);
    }
    await go(`/ui/chat/${encodeURIComponent(names[1])}`); await page.waitForSelector("#msgIn", { timeout: 20000 }); await page.waitForTimeout(800);
    res.chat = { ...(await page.evaluate(LAYOUT)), ...(await page.evaluate(COMPOSER)) }; await shot("3-chat");
    if (c.phone) {
      // An on-screen keyboard sideways leaves about 200 px (interactive-widget=resizes-content: the window itself shrinks).
      await page.locator("#msgIn").tap(); await page.setViewportSize({ width: c.view.width, height: 200 }); await page.waitForTimeout(800);
      await page.locator("#msgIn").fill("在橫向的手機上打字");
      res.keyboard = { ...(await page.evaluate(LAYOUT)), ...(await page.evaluate(COMPOSER)) }; await shot("4-chat-keyboard");
      await page.setViewportSize(c.view); await page.waitForTimeout(500);
    }
    await page.evaluate(`localStorage.setItem("agend_org_mode", "office")`);
    await go("/ui/fleet/org"); await page.waitForSelector(".oo-canvas", { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(900);
    res.office = { ...(await page.evaluate(LAYOUT)), stageTop: await page.evaluate(`Math.round(document.querySelector(".oo-stage")?.getBoundingClientRect().top ?? -1)`) }; await shot("5-office");
    await go("/settings/hub");   // the Hub page this fixture has (no Hub joined: its setup)
    res.hub = await page.evaluate(LAYOUT); await shot("6-hub");
    await go("/settings");
    res.settings = await page.evaluate(LAYOUT); await shot("7-settings");
    res.errors = p.errors;
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
}
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1));
await fx.close(); process.exit(0);
