// M-3432 (#4255) on the real app: custom snacks, drag-to-feed, tap-to-arm, and placed-snack racing
// with a synthetic skin pack (zero real names or chat IDs).
//   desk (dark zh-TW): uploads synthetic pack with 3 snacks (Cookie, Pudding, Cake) + `eat` pose, verifies 44px tray
//         targets, drag-to-feed on Alpha, placed-snack race in Lounge between Beta & Gamma (winner eats, loser scatters),
//         tap-to-arm, and zero CSP/console/overflow errors.
//   desk (backwards compat): verifies packs without `snacks` (Cozy) render zero snack tray.
//   phone (390×844 dark zh-TW): verifies snack tray sits cleanly above zone pills with 44px targets and zero overflow.
//   desk reduced-motion (light en): verifies snack tray is absent when prefers-reduced-motion is enabled.
// Run:
//   PW_DIR=$HOME/.cache/contrast-tools REPO=<checkout> OUT=<dir> \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-office-snacks-m3432.mts
// ui-gate: {"name": "Office custom snacks, drag-to-feed and placed snacks (#4255)", "hp": 19732}
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, mounted, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-office-snacks-m3432";
const OUT_DIR = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT_DIR, { recursive: true });

const ROSTER = [
  { name: "bot-alpha", displayName: "Alpha", backend: "claude-code", team: "Studio", status: "running" as const, general: true },
  { name: "bot-beta", displayName: "Beta", backend: "codex", team: "Studio", status: "running" as const },
  { name: "bot-gamma", displayName: "Gamma", backend: "kiro-cli", team: "Studio", status: "running" as const },
  { name: "bot-delta", displayName: "Delta", backend: "claude-code", team: "Studio", status: "paused" as const },
];

const fx = await bootFixture({ port: Number(process.env.HP ?? 49041), roster: ROSTER, classic: false });
const fm = fx.fm;

const origUiStatus = fm.getUiStatus.bind(fm);
fm.getUiStatus = (...a: unknown[]) => {
  const s = origUiStatus(...a);
  if (s && Array.isArray(s.instances)) {
    for (const inst of s.instances) {
      if (inst.name === "bot-alpha") { inst.status = "running"; inst.execution_state = "working"; inst.state = "working"; }
      else if (inst.name === "bot-delta") { inst.status = "paused"; inst.execution_state = "idle"; inst.state = "paused"; }
      else { inst.status = "running"; inst.execution_state = "idle"; inst.state = "idle"; }
    }
  }
  return s;
};

/** Generate a crisp synthetic pixel-art skin pack with 3 snacks + eating animation (zero external art, zero real names). */
async function buildSyntheticSnackPack(browser: any) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(`(() => {
      const toB64 = (cv) => cv.toDataURL("image/png").split(",")[1];
      const mk = (w, h) => {
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        return { cv, ctx };
      };

      // 1. 1280×720 warm pixel-art studio background (16:9), generous Lounge headroom so bubbles stay well inside Lounge.
      const bg = mk(1280, 720);
      const b = bg.ctx;
      b.fillStyle = "#1c2029"; b.fillRect(0, 0, 1280, 720);
      const zone = (x, y, w, h, f1, f2, border, label) => {
        b.fillStyle = f1; b.fillRect(x, y, w, h);
        b.fillStyle = f2;
        for (let ty = y; ty < y + h; ty += 32) {
          for (let tx = x + (((ty - y) / 32) % 2) * 32; tx < x + w; tx += 64) {
            b.fillRect(tx, ty, Math.min(32, x + w - tx), Math.min(32, y + h - ty));
          }
        }
        b.strokeStyle = border; b.lineWidth = 3; b.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
        b.fillStyle = "#e2e8f0"; b.font = "600 18px system-ui, sans-serif"; b.fillText(label, x + 16, y + 30);
      };
      zone(50, 90, 550, 440, "#242a38", "#202633", "#3b465c", "Work");
      zone(640, 90, 590, 350, "#23302b", "#1f2b26", "#375447", "Lounge");
      zone(640, 470, 280, 200, "#35262a", "#302125", "#5c3b44", "Help");
      zone(950, 470, 280, 200, "#2b2638", "#262133", "#493e63", "Nap");
      // Desk table in Work
      b.fillStyle = "#8a5a30"; b.fillRect(220, 340, 160, 22);
      b.fillStyle = "#5c3b1f"; b.fillRect(230, 362, 12, 24); b.fillRect(358, 362, 12, 24);
      // Coffee table in Lounge (below walking lane y=340)
      b.fillStyle = "#7c5534"; b.fillRect(880, 395, 80, 22);
      // Beanbag in Nap
      b.fillStyle = "#6d4c82"; b.fillRect(1055, 580, 72, 26);

      const files = { "bg.png": toB64(bg.cv) };

      const drawChibi = (ctx, ox, opts) => {
        const { coat, hair, accent, bob = 0, step = 0, eat = false, sleep = false, work = false, frame = 0 } = opts;
        const x = ox + 14, y = 14 + bob;
        // Shadow
        ctx.fillStyle = "rgba(0,0,0,0.28)"; ctx.fillRect(x + 6, 70, 24, 5);
        // Legs
        ctx.fillStyle = "#1e293b";
        ctx.fillRect(x + 10 - step, y + 48, 6, 10);
        ctx.fillRect(x + 20 + step, y + 48, 6, 10);
        // Coat
        ctx.fillStyle = coat; ctx.fillRect(x + 6, y + 28, 24, 22);
        ctx.fillStyle = accent; ctx.fillRect(x + 14, y + 28, 8, 10);
        // Arms
        ctx.fillStyle = coat;
        if (eat) {
          const lift = frame % 2 ? -6 : -2;
          ctx.fillRect(x + 2, y + 30 + lift, 6, 12);
          ctx.fillRect(x + 28, y + 30 + lift, 6, 12);
        } else if (work) {
          ctx.fillRect(x + 2, y + 32 + (frame % 2), 6, 10);
          ctx.fillRect(x + 28, y + 32 + ((frame + 1) % 2), 6, 10);
        } else {
          ctx.fillRect(x + 2, y + 30, 5, 14);
          ctx.fillRect(x + 29, y + 30, 5, 14);
        }
        // Head
        ctx.fillStyle = hair; ctx.fillRect(x + 6, y + 2, 24, 12);
        ctx.fillStyle = "#f5d0b5"; ctx.fillRect(x + 8, y + 10, 20, 18);
        ctx.fillStyle = hair; ctx.fillRect(x + 6, y + 10, 3, 10); ctx.fillRect(x + 27, y + 10, 3, 10);
        // Face
        ctx.fillStyle = "#1e1b24";
        if (sleep) {
          ctx.fillRect(x + 11, y + 18, 4, 2); ctx.fillRect(x + 21, y + 18, 4, 2);
        } else if (eat) {
          // Happy ^_^ eyes and munching mouth
          ctx.fillRect(x + 11, y + 16, 4, 2); ctx.fillRect(x + 21, y + 16, 4, 2);
          ctx.fillStyle = "#e11d48";
          ctx.fillRect(x + 15, y + 21, 6, frame % 2 ? 4 : 2);
          // Warm cheeks
          ctx.fillStyle = "rgba(244,114,182,0.55)";
          ctx.fillRect(x + 9, y + 20, 3, 2); ctx.fillRect(x + 24, y + 20, 3, 2);
        } else {
          ctx.fillRect(x + 12, y + 16, 3, 4); ctx.fillRect(x + 21, y + 16, 3, 4);
        }
      };

      const mkStrip = (frames, drawFn) => {
        const s = mk(frames * 64, 80);
        for (let f = 0; f < frames; f++) drawFn(s.ctx, f * 64, f);
        return toB64(s.cv);
      };

      const makeSet = (prefix, coat, hair, accent) => {
        files[prefix + "_idle.png"] = mkStrip(4, (c, ox, f) => drawChibi(c, ox, { coat, hair, accent, bob: f >= 2 ? -1 : 0, frame: f }));
        files[prefix + "_work.png"] = mkStrip(4, (c, ox, f) => drawChibi(c, ox, { coat, hair, accent, work: true, bob: f % 2 ? -1 : 0, frame: f }));
        files[prefix + "_walk.png"] = mkStrip(4, (c, ox, f) => drawChibi(c, ox, { coat, hair, accent, bob: f % 2 ? -2 : 0, step: f % 2 ? 3 : -2, frame: f }));
        files[prefix + "_eat.png"] = mkStrip(8, (c, ox, f) => {
          drawChibi(c, ox, { coat, hair, accent, eat: true, bob: f % 2 ? -3 : 0, frame: f });
          // Sparkle over head while eating
          c.fillStyle = "#fde047";
          c.fillRect(ox + 10 + (f % 3) * 18, 8 + (f % 2) * 3, 4, 4);
        });
        files[prefix + "_nap.png"] = mkStrip(3, (c, ox, f) => {
          drawChibi(c, ox, { coat, hair, accent, sleep: true, bob: f === 1 ? 1 : 0, frame: f });
          c.fillStyle = "#e2e8f0"; c.font = "700 10px system-ui";
          c.fillText("Z".repeat(f + 1), ox + 44, 18 - f * 3);
        });
        return {
          idle: { src: prefix + "_idle.png", frames: 4, w: 64, h: 80, fps: 4, dw: 88, dh: 110, ax: 32, ay: 74 },
          working: { src: prefix + "_work.png", frames: 4, w: 64, h: 80, fps: 6, dw: 88, dh: 110, ax: 32, ay: 74 },
          walk: { src: prefix + "_walk.png", frames: 4, w: 64, h: 80, fps: 8, dw: 88, dh: 110, ax: 32, ay: 74 },
          eat: { src: prefix + "_eat.png", frames: 8, w: 64, h: 80, fps: 6, once: true, dw: 88, dh: 110, ax: 32, ay: 74 },
          paused: { src: prefix + "_nap.png", frames: 3, w: 64, h: 80, fps: 2, dw: 88, dh: 110, ax: 32, ay: 74 },
        };
      };

      const defSet = makeSet("def", "#3b82f6", "#27272a", "#93c5fd");
      const betaSet = makeSet("beta", "#10b981", "#451a03", "#a7f3d0");
      const gammaSet = makeSet("gamma", "#a855f7", "#312e81", "#e9d5ff");

      // 3 distinct pixel snacks (24×24) + animated eat crumbs (4 frames × 24×24).
      const mkCookie = () => {
        const s = mk(24, 24), c = s.ctx;
        c.fillStyle = "#b45309"; c.fillRect(4, 4, 16, 16);
        c.fillStyle = "#d97706"; c.fillRect(6, 5, 12, 14); c.fillRect(5, 6, 14, 12);
        c.fillStyle = "#f59e0b"; c.fillRect(7, 6, 10, 10);
        c.fillStyle = "#451a03";
        c.fillRect(8, 8, 3, 3); c.fillRect(14, 9, 3, 3); c.fillRect(10, 14, 3, 3); c.fillRect(15, 14, 2, 2);
        return toB64(s.cv);
      };
      const mkPudding = () => {
        const s = mk(24, 24), c = s.ctx;
        c.fillStyle = "#e2e8f0"; c.fillRect(3, 18, 18, 4);
        c.fillStyle = "#fbbf24"; c.fillRect(5, 9, 14, 10); c.fillRect(7, 6, 10, 4);
        c.fillStyle = "#92400e"; c.fillRect(6, 5, 12, 5); c.fillRect(7, 4, 10, 3);
        c.fillStyle = "#fef3c7"; c.fillRect(8, 11, 3, 5);
        return toB64(s.cv);
      };
      const mkCake = () => {
        const s = mk(24, 24), c = s.ctx;
        c.fillStyle = "#f8fafc"; c.fillRect(3, 18, 18, 3);
        c.fillStyle = "#fde68a"; c.fillRect(5, 10, 14, 9);
        c.fillStyle = "#f43f5e"; c.fillRect(5, 13, 14, 2);
        c.fillStyle = "#ffffff"; c.fillRect(4, 8, 16, 4);
        c.fillStyle = "#e11d48"; c.fillRect(10, 4, 4, 4);
        c.fillStyle = "#22c55e"; c.fillRect(13, 3, 3, 2);
        return toB64(s.cv);
      };
      const mkCrumbs = (col1, col2) => {
        const s = mk(4 * 24, 24), c = s.ctx;
        for (let f = 0; f < 4; f++) {
          const ox = f * 24;
          const sz = Math.max(2, 10 - f * 2);
          c.fillStyle = col1;
          c.fillRect(ox + 12 - Math.floor(sz / 2), 14 - Math.floor(sz / 2), sz, sz);
          c.fillStyle = col2;
          c.fillRect(ox + 5 + f * 2, 16 - f * 3, 3, 3);
          c.fillRect(ox + 16 - f, 15 - f * 2, 3, 3);
        }
        return toB64(s.cv);
      };
      files["snacks/cookie.png"] = mkCookie();
      files["snacks/cookie_eat.png"] = mkCrumbs("#d97706", "#451a03");
      files["snacks/pudding.png"] = mkPudding();
      files["snacks/pudding_eat.png"] = mkCrumbs("#fbbf24", "#92400e");
      files["snacks/cake.png"] = mkCake();
      files["snacks/cake_eat.png"] = mkCrumbs("#f43f5e", "#fde68a");

      const manifest = {
        format: 1,
        id: "synth-snacks",
        scale: 1,
        matte: "#1c2029",
        background: "bg.png",
        areas: {
          desks: { rect: [50, 90, 550, 440], seats: [[300, 340], [180, 340], [440, 340]] },
          lounge: { rect: [640, 90, 590, 350], seats: [[740, 340], [1100, 340], [920, 405]] },
          alert: { rect: [640, 470, 280, 200], seats: [[780, 590]] },
          nap: { rect: [950, 470, 280, 200], seats: [[1090, 590]] },
        },
        waypoints: [
          { id: "l-left", x: 740, y: 340 },
          { id: "l-right", x: 1100, y: 340 },
          { id: "hall", x: 620, y: 340 },
          { id: "w-mid", x: 300, y: 340 },
        ],
        edges: [
          ["l-left", "l-right"], ["l-left", "hall"], ["hall", "w-mid"],
        ],
        stateZones: { working: "desks", idle: "lounge", needs: "alert", crashed: "alert", stuck: "alert", paused: "nap", stopped: "nap", default: "lounge" },
        characters: { default: defSet, betaSet, gammaSet },
        byInstance: { "bot-beta": "betaSet", "bot-gamma": "gammaSet" },
        snacks: [
          {
            id: "cookie",
            label: { en: "Cookie", "zh-TW": "餅乾" },
            sprite: { src: "snacks/cookie.png", frames: 1, w: 24, h: 24, dw: 32, dh: 32, ax: 12, ay: 20 },
            eat: { src: "snacks/cookie_eat.png", frames: 4, w: 24, h: 24, fps: 4, once: true, dw: 30, dh: 30, ax: 12, ay: 24 },
            radius: 340,
          },
          {
            id: "pudding",
            label: { en: "Pudding", "zh-TW": "布丁" },
            sprite: { src: "snacks/pudding.png", frames: 1, w: 24, h: 24, dw: 32, dh: 32, ax: 12, ay: 20 },
            eat: { src: "snacks/pudding_eat.png", frames: 4, w: 24, h: 24, fps: 4, once: true, dw: 30, dh: 30, ax: 12, ay: 24 },
            radius: 340,
          },
          {
            id: "cake",
            label: { en: "Cake", "zh-TW": "蛋糕" },
            sprite: { src: "snacks/cake.png", frames: 1, w: 24, h: 24, dw: 32, dh: 32, ax: 12, ay: 20 },
            eat: { src: "snacks/cake_eat.png", frames: 4, w: 24, h: 24, fps: 4, once: true, dw: 30, dh: 30, ax: 12, ay: 24 },
            radius: 340,
          },
        ],
      };
      return { manifest, files };
    })()`);
  } finally {
    await page.close();
  }
}

const pack = await buildSyntheticSnackPack(fx.browser);
const added = fm.officeSkins.add(pack, "smoke");
if (!added.ok) throw new Error(`Synthetic snack pack refused: ${JSON.stringify(added)}`);
const setStyle = fm.officeStore.setAutoSkin("synth-snacks");
if (!setStyle.ok) throw new Error(`setAutoSkin failed: ${JSON.stringify(setStyle)}`);
console.log("Synthetic snack pack uploaded:", added.pack);

const report: Record<string, any> = { pack: added.pack, cases: {} };

async function openOffice(page: any, base: string, lang: string) {
  await page.goto(`${base}/ui/fleet/org`);
  await page.locator(".oc-tools .seg-inline button", { hasText: lang === "en" ? "Office" : "辦公室" }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await page.waitForTimeout(2000);
}

/** Convert logical 1280×720 coordinates into page CSS client coordinates using the office's live view transform. */
async function logicalToClient(page: any, lx: number, ly: number): Promise<{ x: number; y: number }> {
  return page.evaluate(`(() => {
    const cv = document.querySelector(".oo-canvas");
    const r = cv.getBoundingClientRect();
    const mv = document.querySelector(".oo-mini-view");
    let k = Number(mv?.getAttribute("data-k"));
    let ox = Number(mv?.getAttribute("data-x"));
    let oy = Number(mv?.getAttribute("data-y"));
    if (!Number.isFinite(k) || k <= 0) {
      k = Math.min(r.width / 1280, r.height / 720);
      ox = (r.width - 1280 * k) / 2;
      oy = (r.height - 720 * k) / 2;
    }
    return { x: r.left + ox + ${lx} * k, y: r.top + oy + ${ly} * k };
  })()`);
}

try {
  // 1. Desktop dark zh-TW: tray, drag-to-feed, placed snack race + claim + scatter, tap-to-arm, and backwards-compat check.
  {
    const c = { device: "desk" as const, theme: "dark" as const, lang: "zh-TW" as const };
    const recordVideo = process.env.RECORD_VIDEO === "1";
    let ctx: any, page: any, csp: (() => Promise<string[]>) | null = null;
    if (recordVideo) {
      const stale = Object.keys(fm.webPrefs.read("operator").values ?? {}).map((k) => [k, null] as [string, null]);
      fm.webPrefs.write("operator", new Map<string, unknown>([...stale, ["theme", c.theme], ["lang", c.lang]]));
      const { tokenEpoch } = await import(`${process.env.REPO}/src/web-session.ts`);
      fm.initializeWebSessions();
      const loginCode = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken) }).display;
      ctx = await fx.browser.newContext({
        viewport: VIEWPORTS.desk, deviceScaleFactor: 1, colorScheme: c.theme, locale: "zh-TW",
        recordVideo: { dir: OUT_DIR, size: VIEWPORTS.desk },
      });
      await ctx.addInitScript({ content: `localStorage.setItem("agend_tour_done","1");localStorage.setItem("agend_firstrun_dismissed","1");localStorage.setItem("agend_usage_rail","0");localStorage.setItem("agend_lang","zh-TW");` });
      page = await ctx.newPage();
      await page.goto(`${fx.base}/signin`); await page.waitForSelector("#code");
      await page.locator("#code").evaluate((el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.form!.requestSubmit(); }, loginCode);
      await page.waitForURL(`${fx.base}/ui`);
    } else {
      const p = await fx.page(c);
      ctx = p.ctx; page = p.page; csp = p.csp;
    }
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(String(e)));

    await mounted(page, 30000);
    await openOffice(page, fx.base, c.lang);
    await page.waitForSelector(".oo-snacks .oo-snack", { timeout: 10000 });
    await page.waitForTimeout(400);

    // Check tray geometry (3 buttons, each >= 44x44, zero horizontal overflow).
    const trayCheck = await page.evaluate(`(() => {
      const btns = [...document.querySelectorAll(".oo-snacks .oo-snack")];
      const sizes = btns.map((b) => { const r = b.getBoundingClientRect(); return { id: b.getAttribute("data-snack"), w: Math.round(r.width), h: Math.round(r.height) }; });
      const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
      return { count: btns.length, sizes, allTap44: sizes.every((s) => s.w >= 44 && s.h >= 44), overflow };
    })()`);
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "1-tray") });

    // A. Drag Cookie onto Alpha (seated at [300, 340], body center around y=300).
    const cookieBox = await page.locator('.oo-snack[data-snack="cookie"]').boundingBox();
    const alphaPt = await logicalToClient(page, 300, 305);
    await page.mouse.move(cookieBox.x + cookieBox.width / 2, cookieBox.y + cookieBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(alphaPt.x, alphaPt.y, { steps: 14 });
    await page.waitForTimeout(180);
    const feedHint = await page.locator(".oo-snack-hint").textContent().catch(() => "");
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "2-drag-feed") });
    await page.mouse.up();
    // Move pointer off Alpha so hover tooltip does not obscure Alpha's eating pose and feed bubble.
    const awayPt = await logicalToClient(page, 120, 160);
    await page.mouse.move(awayPt.x, awayPt.y);
    await page.waitForTimeout(450);
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "3-eating-direct") });
    await page.waitForTimeout(900);

    // B. Drag Pudding onto empty Lounge floor (920, 280) above the walking lane between Beta (740, 340) and Gamma (1100, 340).
    const puddingBox = await page.locator('.oo-snack[data-snack="pudding"]').boundingBox();
    const floorPt = await logicalToClient(page, 920, 280);
    await page.mouse.move(puddingBox.x + puddingBox.width / 2, puddingBox.y + puddingBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(floorPt.x, floorPt.y, { steps: 14 });
    await page.waitForTimeout(180);
    const placeHint = await page.locator(".oo-snack-hint").textContent({ timeout: 3000 }).catch(() => "");
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "4a-drag-place") });
    await page.mouse.up();
    await page.mouse.move(awayPt.x, awayPt.y);
    // Capture mid-race (Beta & Gamma walking toward Pudding on floor)
    await page.waitForTimeout(380);
    const raceShot = await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "4-placed-race") });
    // Wait for winner to claim & eat while loser scatters with "被搶先了！"
    await page.waitForTimeout(780);
    const claimShot = await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "5-claimed-scatter") });
    const raceChanged = !raceShot.equals(claimShot);

    // C. Tap-to-arm Cake, then click empty Lounge floor to place & disarm.
    await page.locator('.oo-snack[data-snack="cake"]').click();
    const armedTrue = await page.locator('.oo-snack[data-snack="cake"]').getAttribute("aria-pressed");
    const floor2 = await logicalToClient(page, 920, 360);
    await page.mouse.click(floor2.x, floor2.y);
    await page.waitForTimeout(250);
    const armedAfter = await page.locator('.oo-snack[data-snack="cake"]').getAttribute("aria-pressed");
    if (recordVideo) await page.waitForTimeout(1600);

    // D. Backwards-compat: switch style to Cozy (no `snacks`) -> tray disappears.
    await page.locator(".oo-bar select").nth(1).selectOption("cozy");
    await page.waitForTimeout(500);
    const cozyTrayCount = await page.locator(".oo-snacks").count();
    // Restore synthetic snack pack for remaining cases.
    await page.locator(".oo-bar select").nth(1).selectOption("synth-snacks");
    await page.waitForTimeout(300);

    const videoPath = recordVideo ? await page.video()?.path() : null;
    const cspViolations = csp ? await csp() : [];
    await ctx.close();
    report.cases["desk-dark-zh-TW"] = {
      ok: errors.length === 0 && cspViolations.length === 0 && trayCheck.count === 3 && trayCheck.allTap44 && !trayCheck.overflow
        && feedHint.includes("Alpha") && placeHint === "放在這裡" && raceChanged
        && armedTrue === "true" && armedAfter === "false" && cozyTrayCount === 0,
      errors, cspViolations, trayCheck, feedHint, placeHint, raceChanged, armedTrue, armedAfter, cozyTrayCount,
      ...(videoPath ? { videoPath } : {}),
    };
  }

  // 2. Phone (390×844) dark zh-TW — snack tray sits above zone pills, 44px targets, zero overflow.
  {
    const c = { device: "phone" as const, theme: "dark" as const, lang: "zh-TW" as const };
    const { ctx, page, csp } = await fx.page(c);
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    await openOffice(page, fx.base, c.lang);
    await page.waitForSelector(".oo-snacks .oo-snack", { timeout: 10000 });
    await page.waitForTimeout(400);

    const phoneCheck = await page.evaluate(`(() => {
      const tray = document.querySelector(".oo-snacks");
      const pills = document.querySelector(".oo-zone-pills");
      const btns = [...document.querySelectorAll(".oo-snacks .oo-snack")];
      const tr = tray.getBoundingClientRect();
      const pr = pills ? pills.getBoundingClientRect() : null;
      const sizes = btns.map((b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      return {
        count: btns.length,
        allTap44: sizes.every((s) => s.w >= 44 && s.h >= 44),
        abovePills: !pr || tr.bottom <= pr.top + 1,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        trayBottom: Math.round(tr.bottom),
        pillsTop: pr ? Math.round(pr.top) : null,
      };
    })()`);
    // Tap-to-arm cookie on phone
    await page.locator('.oo-snack[data-snack="cookie"]').click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: shotPath(SMOKE, "phone-dark-zh-TW", "1-tray") });

    const cspViolations = await csp();
    await ctx.close();
    report.cases["phone-dark-zh-TW"] = {
      ok: errors.length === 0 && cspViolations.length === 0 && phoneCheck.count === 3 && phoneCheck.allTap44 && phoneCheck.abovePills && !phoneCheck.overflow,
      errors, cspViolations, phoneCheck,
    };
  }

  // 3. Desktop reduced-motion (light en) — tray must not appear.
  {
    const c = { device: "desk" as const, theme: "light" as const, lang: "en" as const };
    const { ctx, page, csp } = await fx.page(c);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mounted(page, 30000);
    await openOffice(page, fx.base, c.lang);
    const reducedTrayCount = await page.locator(".oo-snacks").count();
    const cspViolations = await csp();
    await ctx.close();
    report.cases["desk-light-en-reduced"] = {
      ok: reducedTrayCount === 0 && cspViolations.length === 0,
      reducedTrayCount, cspViolations,
    };
  }
} finally {
  await fx.close();
}

writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (Object.values(report.cases).some((c: any) => !c.ok)) process.exit(1);
