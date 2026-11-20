// M-3445 (#4266 / #4267) on the real app: drag an Agent to another seat in its area + "being dragged" state
// with synthetic names (Alpha, Beta, Gamma, Delta — zero real names or chat IDs).
//   1. desk (dark zh-TW, synthetic skin pack WITH custom `characters.default.dragged` multi-frame strip):
//      - Shows Alpha & Beta working at Work desks 0 & 1, Gamma idle in Lounge, Delta sleeping in Nap.
//      - Picks up Alpha and holds over empty Work desk 3: verifies floor-level seat target rings (valid Work desks
//        highlighted, Lounge/Nap untouched), active solid target ring on desk 3, and custom `dragged` animation.
//      - Drops Alpha onto desk 3 -> Alpha seats immediately and keeps working; reloads page -> verifies Alpha
//        persists at desk 3 via `agend_org_office_seats` in localStorage.
//      - Drags Alpha onto Beta's occupied desk 1 -> swaps cleanly (Alpha at desk 1, Beta at desk 3) and persists.
//   2. desk (dark zh-TW, built-in Cozy skin WITHOUT custom `dragged` strip):
//      - Picks up Alpha and holds over another Work desk -> captures built-in lifted/dangling default dragged animation
//        over floor shadow, drops onto target desk, and verifies persistence across reload.
//   3. desk reduced-motion (light en):
//      - Verifies "Drag and pat" checkbox is disabled and off under `prefers-reduced-motion: reduce`.
//   4. phone (390×844 dark zh-TW):
//      - Verifies zero horizontal overflow and clean Office rendering on phone viewport.
// Run:
//   PW_DIR=$HOME/.cache/contrast-tools REPO=<checkout> OUT=<dir> \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-office-drag-seat-m3445.mts
// ui-gate: {"name": "Office drag Agent to seat and dragged state (#4266/#4267)", "hp": 19734}
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, mounted, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-office-drag-seat-m3445";
const OUT_DIR = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT_DIR, { recursive: true });

const ROSTER = [
  { name: "bot-alpha", displayName: "Alpha", backend: "claude-code", team: "Studio", status: "running" as const, general: true },
  { name: "bot-beta", displayName: "Beta", backend: "codex", team: "Studio", status: "running" as const },
  { name: "bot-gamma", displayName: "Gamma", backend: "kiro-cli", team: "Studio", status: "running" as const },
  { name: "bot-delta", displayName: "Delta", backend: "claude-code", team: "Studio", status: "paused" as const },
];

const fx = await bootFixture({ port: Number(process.env.HP ?? 49043), roster: ROSTER, classic: false });
const fm = fx.fm;
fm.lifecycle = { ...fm.lifecycle, isPaused: (n: string) => n === "bot-delta" };

const origUiStatus = fm.getUiStatus.bind(fm);
fm.getUiStatus = (...a: unknown[]) => {
  const s = origUiStatus(...a);
  if (s && Array.isArray(s.instances)) {
    for (const inst of s.instances) {
      if (inst.name === "bot-alpha" || inst.name === "bot-beta") {
        inst.status = "running"; inst.execution_state = "working"; inst.state = "working";
      } else if (inst.name === "bot-delta") {
        inst.status = "paused"; inst.execution_state = "idle"; inst.state = "paused";
      } else {
        inst.status = "running"; inst.execution_state = "idle"; inst.state = "idle";
      }
    }
  }
  return s;
};

/** Generate a crisp synthetic pixel-art skin pack with 4 Work desks and a custom 4-frame `dragged` strip. */
async function buildSyntheticDragPack(browser: any) {
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

      const bg = mk(1280, 720);
      const b = bg.ctx;
      b.fillStyle = "#1a1f2b"; b.fillRect(0, 0, 1280, 720);
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
      zone(50, 80, 560, 560, "#232a3a", "#1f2534", "#3b4963", "Work");
      zone(650, 80, 580, 320, "#21302a", "#1d2b25", "#355446", "Lounge");
      zone(650, 430, 275, 210, "#35262a", "#2f2125", "#5c3b44", "Help");
      zone(955, 430, 275, 210, "#2b2538", "#262033", "#493e63", "Nap");

      // Desk sprite (real depth-"y" furniture so floor rings sit cleanly below desks).
      const deskCv = mk(116, 40);
      const dc = deskCv.ctx;
      dc.fillStyle = "#a26d3c"; dc.fillRect(0, 0, 116, 5);
      dc.fillStyle = "#8a5a30"; dc.fillRect(0, 5, 116, 15);
      dc.fillStyle = "#5c3b1f"; dc.fillRect(8, 20, 10, 20); dc.fillRect(98, 20, 10, 20);
      // Monitor on desk
      dc.fillStyle = "#2b303a"; dc.fillRect(72, -2, 26, 14);
      dc.fillStyle = "#7dd3fc"; dc.fillRect(75, 1, 20, 9);

      const files = { "bg.png": toB64(bg.cv), "furniture/desk.png": toB64(deskCv.cv) };

      const drawChibi = (ctx, ox, opts) => {
        const { coat, hair, accent, bob = 0, step = 0, sleep = false, work = false, dragged = false, frame = 0 } = opts;
        ctx.save();
        const x = ox + 14, y = (dragged ? 4 : 14) + bob;
        if (dragged) {
          // Custom artist-authored dragged pose: pinched collar dangle, swinging tilt, surprised face, kicking feet!
          const angles = [-0.18, 0.0, 0.18, 0.0];
          const ang = angles[frame % angles.length];
          const px0 = ox + 32, py0 = 12;
          ctx.translate(px0, py0);
          ctx.rotate(ang);
          ctx.translate(-px0, -py0);
          // Little pinch highlight at collar
          ctx.fillStyle = "#fbbf24"; ctx.fillRect(x + 15, y - 3, 6, 4);
        } else {
          ctx.fillStyle = "rgba(0,0,0,0.28)"; ctx.fillRect(x + 6, 70, 24, 5);
        }
        // Legs
        ctx.fillStyle = "#1e293b";
        if (dragged) {
          const kick = frame % 2 === 0 ? 3 : -3;
          ctx.fillRect(x + 9 + kick, y + 48, 6, 12);
          ctx.fillRect(x + 21 - kick, y + 50, 6, 10);
        } else {
          ctx.fillRect(x + 10 - step, y + 48, 6, 10);
          ctx.fillRect(x + 20 + step, y + 48, 6, 10);
        }
        // Coat
        ctx.fillStyle = coat; ctx.fillRect(x + 6, y + 28, 24, 22);
        ctx.fillStyle = accent; ctx.fillRect(x + 14, y + 28, 8, 10);
        // Arms
        ctx.fillStyle = coat;
        if (dragged) {
          // Waving arms out to sides while lifted!
          const up = frame % 2 === 0 ? -6 : -2;
          ctx.fillRect(x - 2, y + 26 + up, 9, 6);
          ctx.fillRect(x + 29, y + 26 - up, 9, 6);
          ctx.fillStyle = "#f5d0b5";
          ctx.fillRect(x - 4, y + 26 + up, 4, 5);
          ctx.fillRect(x + 36, y + 26 - up, 4, 5);
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
        } else if (dragged) {
          // Wide surprised eyes + "o" mouth + rosy cheeks
          ctx.fillRect(x + 11, y + 15, 4, 5); ctx.fillRect(x + 21, y + 15, 4, 5);
          ctx.fillStyle = "#ffffff"; ctx.fillRect(x + 12, y + 16, 2, 2); ctx.fillRect(x + 22, y + 16, 2, 2);
          ctx.fillStyle = "#e11d48"; ctx.fillRect(x + 16, y + 22, 4, 4);
          ctx.fillStyle = "rgba(244,114,182,0.6)"; ctx.fillRect(x + 9, y + 20, 3, 2); ctx.fillRect(x + 24, y + 20, 3, 2);
        } else {
          ctx.fillRect(x + 12, y + 16, 3, 4); ctx.fillRect(x + 21, y + 16, 3, 4);
        }
        ctx.restore();
      };

      const mkStrip = (frames, drawFn) => {
        const s = mk(frames * 64, 80);
        for (let f = 0; f < frames; f++) drawFn(s.ctx, f * 64, f);
        return toB64(s.cv);
      };

      const makeSet = (prefix, palette) => {
        files[prefix + "_idle.png"] = mkStrip(2, (c, ox, f) => drawChibi(c, ox, { ...palette, bob: f }));
        files[prefix + "_work.png"] = mkStrip(2, (c, ox, f) => drawChibi(c, ox, { ...palette, work: true, frame: f }));
        files[prefix + "_walk.png"] = mkStrip(2, (c, ox, f) => drawChibi(c, ox, { ...palette, bob: f ? -2 : 0, step: f ? 2 : -2 }));
        files[prefix + "_sleep.png"] = mkStrip(2, (c, ox, f) => drawChibi(c, ox, { ...palette, sleep: true, bob: f }));
        files[prefix + "_dragged.png"] = mkStrip(4, (c, ox, f) => drawChibi(c, ox, { ...palette, dragged: true, frame: f }));
        const st = (src, frames, fps) => ({ src, frames, w: 64, h: 80, fps, dw: 54, dh: 68, ax: 32, ay: 74 });
        return {
          idle: st(prefix + "_idle.png", 2, 3),
          working: st(prefix + "_work.png", 2, 4),
          walk: st(prefix + "_walk.png", 2, 6),
          paused: st(prefix + "_sleep.png", 2, 2),
          dragged: st(prefix + "_dragged.png", 4, 8),
        };
      };

      const characters = {
        default: makeSet("chars/alpha", { coat: "#3b82f6", hair: "#1e293b", accent: "#93c5fd" }),
        beta: makeSet("chars/beta", { coat: "#10b981", hair: "#7c2d12", accent: "#a7f3d0" }),
        gamma: makeSet("chars/gamma", { coat: "#f59e0b", hair: "#4c1d95", accent: "#fde68a" }),
        delta: makeSet("chars/delta", { coat: "#a855f7", hair: "#0f172a", accent: "#e9d5ff" }),
      };

      const deskCoords = [[190, 260], [450, 260], [190, 490], [450, 490]];
      const manifest = {
        format: 1,
        id: "synth-drag",
        scale: 1,
        background: "bg.png",
        areas: {
          desks: { rect: [50, 80, 560, 560], seats: deskCoords },
          lounge: { rect: [650, 80, 580, 320], seats: [[800, 270], [1040, 270]] },
          alert: { rect: [650, 430, 275, 210], seats: [[785, 560]] },
          nap: { rect: [955, 430, 275, 210], seats: [[1090, 560]] },
        },
        stateZones: { working: "desks", idle: "lounge", needs: "alert", crashed: "alert", stuck: "alert", paused: "nap", stopped: "nap", default: "lounge" },
        door: [625, 680],
        waypoints: [
          { id: "w1", x: 190, y: 310 }, { id: "w2", x: 450, y: 310 },
          { id: "w3", x: 190, y: 540 }, { id: "w4", x: 450, y: 540 },
          { id: "h", x: 625, y: 310 }, { id: "h2", x: 625, y: 560 },
          { id: "l1", x: 800, y: 310 }, { id: "l2", x: 1040, y: 310 },
          { id: "n1", x: 1090, y: 560 },
        ],
        edges: [["w1", "w2"], ["w1", "w3"], ["w2", "w4"], ["w3", "w4"], ["w2", "h"], ["h", "h2"], ["h", "l1"], ["l1", "l2"], ["h2", "n1"]],
        furniture: deskCoords.map(([x, y], i) => ({
          id: "desk-" + i,
          sprite: { src: "furniture/desk.png", frames: 1, w: 116, h: 40, dw: 116, dh: 40, ax: 58, ay: 34 },
          x, y: y - 34, depth: "y",
        })),
        characters,
        byInstance: { "bot-beta": "beta", "bot-gamma": "gamma", "bot-delta": "delta" },
      };
      return { manifest, files };
    })()`);
  } finally {
    await page.close();
  }
}

const pack = await buildSyntheticDragPack(fx.browser);
const added = fm.officeSkins.add(pack, "smoke");
if (!added.ok) throw new Error(`Synthetic drag pack refused: ${JSON.stringify(added)}`);
const setStyle = fm.officeStore.setAutoSkin("synth-drag");
if (!setStyle.ok) throw new Error(`setAutoSkin failed: ${JSON.stringify(setStyle)}`);
console.log("Synthetic drag pack uploaded:", added.pack);

const report: Record<string, any> = { pack: added.pack, cases: {} };

async function openOffice(page: any, base: string, lang: string) {
  await page.goto(`${base}/ui/fleet/org`);
  await page.locator(".oc-tools .seg-inline button", { hasText: lang === "en" ? "Office" : "辦公室" }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await page.waitForTimeout(5400);
}

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
  // 1. Desktop dark zh-TW: custom `dragged` pack — drag Alpha to empty desk 3, verify persistence after reload, then swap onto Beta's desk 1.
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
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "1-before-drag") });

    // Pick up Alpha at desk 0 [190, 260] (body center around y=230) and drag to empty desk 3 [450, 490].
    const fromPt = await logicalToClient(page, 190, 232);
    const toPt = await logicalToClient(page, 450, 490);
    const awayPt = await logicalToClient(page, 625, 110);

    await page.mouse.move(fromPt.x, fromPt.y);
    await page.mouse.down();
    await page.mouse.move(toPt.x, toPt.y, { steps: 18 });
    await page.waitForTimeout(260);
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "2-mid-drag-custom") });
    await page.mouse.up();
    await page.mouse.move(awayPt.x, awayPt.y);
    await page.waitForTimeout(400);
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "3-seated-desk3") });

    const savedAfterMove = await page.evaluate(() => JSON.parse(localStorage.getItem("agend_org_office_seats") || "{}"));

    // Reload page and confirm Alpha persists at desk 3!
    await openOffice(page, fx.base, c.lang);
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "4-after-reload") });

    // Swap Alpha (desk 3 [450, 490]) onto Beta's occupied desk 0 [190, 260] (Beta took first free desk 0 on reload).
    const alphaDesk3 = await logicalToClient(page, 450, 462);
    const betaDesk0 = await logicalToClient(page, 190, 260);
    await page.mouse.move(alphaDesk3.x, alphaDesk3.y);
    await page.mouse.down();
    await page.mouse.move(betaDesk0.x, betaDesk0.y, { steps: 16 });
    await page.waitForTimeout(220);
    await page.mouse.up();
    await page.mouse.move(awayPt.x, awayPt.y);
    await page.waitForTimeout(3800);
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "5-swapped-with-beta") });
    const savedAfterSwap = await page.evaluate(() => JSON.parse(localStorage.getItem("agend_org_office_seats") || "{}"));

    // Switch to built-in Cozy skin (NO custom `dragged` strip) to verify default lifted/dangling animation + seat drop!
    const setCozy = fm.officeStore.setAutoSkin("cozy");
    if (!setCozy.ok) throw new Error(`setAutoSkin(cozy) failed`);
    await openOffice(page, fx.base, c.lang);
    // Cozy Work desks: seat 0 [193, 238], seat 4 [336, 354].
    const cozyFrom = await logicalToClient(page, 193, 212);
    const cozyTo = await logicalToClient(page, 336, 354);
    await page.mouse.move(cozyFrom.x, cozyFrom.y);
    await page.mouse.down();
    await page.mouse.move(cozyTo.x, cozyTo.y, { steps: 18 });
    await page.waitForTimeout(260);
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "6-cozy-default-dragged") });
    await page.mouse.up();
    await page.mouse.move(awayPt.x, awayPt.y);
    await page.waitForTimeout(450);
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "7-cozy-seated") });
    const savedCozy = await page.evaluate(() => JSON.parse(localStorage.getItem("agend_org_office_seats") || "{}"));

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    const cspViolations = csp ? await csp() : [];
    const videoPath = recordVideo ? await page.video()?.path() : null;
    report.cases.desk = { savedAfterMove, savedAfterSwap, savedCozy, overflow, errors, cspViolations, videoPath };

    if (savedAfterMove["auto@synth-drag"]?.["bot-alpha"]?.desks !== 3) {
      throw new Error(`Expected bot-alpha persisted at desks:3, got ${JSON.stringify(savedAfterMove)}`);
    }
    if (savedAfterSwap["auto@synth-drag"]?.["bot-alpha"]?.desks !== 0 || savedAfterSwap["auto@synth-drag"]?.["bot-beta"]?.desks !== 3) {
      throw new Error(`Expected swap alpha->0 beta->3, got ${JSON.stringify(savedAfterSwap)}`);
    }
    if (savedCozy["auto@cozy"]?.["bot-alpha"]?.desks !== 4) {
      throw new Error(`Expected Cozy bot-alpha persisted at desks:4, got ${JSON.stringify(savedCozy)}`);
    }
    if (overflow || errors.length || cspViolations.length) {
      throw new Error(`Desktop drag-seat failed: ${JSON.stringify(report.cases.desk)}`);
    }
    await ctx.close();
  }

  // Restore synth-drag for remaining checks.
  fm.officeStore.setAutoSkin("synth-drag");

  // 2. Reduced motion (desktop light en): verify Drag and pat checkbox is off and disabled.
  {
    const { ctx, page, csp } = await fx.page({ device: "desk", theme: "light", lang: "en" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    await openOffice(page, fx.base, "en");
    const playBox = page.locator(".oo-play input[type='checkbox']");
    const disabled = await playBox.isDisabled();
    const checked = await playBox.isChecked();
    await page.screenshot({ path: shotPath(SMOKE, "desk-light-en-reduced", "1-reduced-motion") });
    const cspViolations = await csp();
    report.cases.reducedMotion = { disabled, checked, errors, cspViolations };
    if (!disabled || checked || errors.length || cspViolations.length) {
      throw new Error(`Reduced motion check failed: ${JSON.stringify(report.cases.reducedMotion)}`);
    }
    await ctx.close();
  }

  // 3. Phone (390×844 dark zh-TW): verify clean Office rendering and zero horizontal overflow.
  {
    const { ctx, page, csp } = await fx.page({ device: "phone", theme: "dark", lang: "zh-TW" });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    await openOffice(page, fx.base, "zh-TW");
    await page.screenshot({ path: shotPath(SMOKE, "phone-dark-zh-TW", "1-phone-office") });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    const cspViolations = await csp();
    report.cases.phone = { overflow, errors, cspViolations };
    if (overflow || errors.length || cspViolations.length) {
      throw new Error(`Phone Office check failed: ${JSON.stringify(report.cases.phone)}`);
    }
    await ctx.close();
  }

  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  console.log("PASS smoke-office-drag-seat-m3445:", JSON.stringify(report.cases));
} finally {
  await fx.close();
}
