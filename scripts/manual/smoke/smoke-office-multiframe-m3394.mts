// M-3394 (#4231) on the real app: multi-sheet (6 sheets × 30 frames = 180 frames, 6 s at 30 FPS with loopFrom intro)
// and frame-list (variable per-frame durations) character animations mixed with classic single-sheet strips in one
// synthetic skin pack (zero real names or chat IDs).
//   desk (dark zh-TW & light en): uploads synthetic pack, opens Office, verifies all 6 sheets load & animate across
//         sheet boundaries with zero CSP/console errors, captures a 6-step frame strip + live WebM video.
//   phone (390×844 dark zh-TW): verifies smooth multi-sheet animation on mobile viewport and captures frame strip.
//   desk reduced-motion: verifies canvas stays pixel-identical (frozen on frame 0) over 1.5 s.
// Run:
//   PW_DIR=$HOME/.cache/contrast-tools REPO=<checkout> OUT=<dir> \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-office-multiframe-m3394.mts
// ui-gate: {"name": "Office multi-frame character animations (#4231)", "hp": 19731}
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, mounted, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-office-multiframe-m3394";
const OUT_DIR = join(process.env.OUT ?? "/tmp/smoke-out", SMOKE);
mkdirSync(OUT_DIR, { recursive: true });

const ROSTER = [
  { name: "bot-alpha", displayName: "Alpha", backend: "claude-code", team: "Studio", status: "running" as const, general: true },
  { name: "bot-beta", displayName: "Beta", backend: "codex", team: "Studio", status: "running" as const },
  { name: "bot-gamma", displayName: "Gamma", backend: "kiro-cli", team: "Studio", status: "running" as const },
  { name: "bot-delta", displayName: "Delta", backend: "claude-code", team: "Studio", status: "paused" as const },
];

const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49040), roster: ROSTER, classic: false });
const fm = fx.fm;

// Mark bot-alpha as actively "working" so it sits in the Work zone playing the 6-sheet 180-frame working animation;
// bot-beta and bot-gamma stay idle in the Lounge; bot-delta sleeps in the Nap corner.
const origUiStatus = fm.getUiStatus.bind(fm);
fm.getUiStatus = (...a: unknown[]) => {
  const s = origUiStatus(...a);
  if (s && Array.isArray(s.instances)) {
    for (const inst of s.instances) {
      if (inst.name === "bot-alpha") { inst.status = "running"; inst.execution_state = "working"; inst.state = "working"; }
      else if (inst.name === "bot-delta") { inst.status = "paused"; inst.execution_state = "idle"; }
      else { inst.status = "running"; inst.execution_state = "idle"; }
    }
  }
  return s;
};

/** Generate a crisp synthetic pixel-art skin pack using Chromium's 2D canvas (zero external art, zero real names). */
async function buildSyntheticPack(browser: any) {
  const page = await browser.newPage();
  try {
    const data = await page.evaluate(`(() => {
      const toB64 = (cv) => cv.toDataURL("image/png").split(",")[1];
      const mk = (w, h) => {
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        return { cv, ctx };
      };

      // 1. 1280×720 warm pixel-art studio background (16:9).
      const bg = mk(1280, 720);
      const g = bg.ctx;
      g.fillStyle = "#1c2029"; g.fillRect(0, 0, 1280, 720);
      for (let y = 80; y < 720; y += 24) {
        g.fillStyle = y % 48 === 0 ? "#252b38" : "#222834";
        g.fillRect(0, y, 1280, 24);
        g.fillStyle = "#1a1f29"; g.fillRect(0, y + 23, 1280, 1);
      }
      g.fillStyle = "#2d3546"; g.fillRect(0, 0, 1280, 84);
      g.fillStyle = "#3e4960"; g.fillRect(0, 80, 1280, 4);
      for (const wx of [180, 520, 880, 1080]) {
        g.fillStyle = "#485978"; g.fillRect(wx - 4, 14, 128, 56);
        const grad = g.createLinearGradient(wx, 18, wx, 66);
        grad.addColorStop(0, "#3b5888"); grad.addColorStop(1, "#6ea0d6");
        g.fillStyle = grad; g.fillRect(wx, 18, 120, 48);
        g.fillStyle = "#485978"; g.fillRect(wx + 58, 18, 4, 48);
      }
      const zone = (x, y, w, h, fill, border, label) => {
        g.fillStyle = fill; g.fillRect(x, y, w, h);
        g.strokeStyle = border; g.lineWidth = 3; g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
        g.fillStyle = "#d9e1f2"; g.font = "600 16px system-ui, sans-serif";
        g.fillText(label, x + 16, y + 28);
      };
      zone(60, 130, 540, 420, "#232e3f", "#45638f", "Work · 6-sheet 30 FPS (180f)");
      zone(650, 130, 570, 270, "#24342f", "#3f7a68", "Lounge · Variable ms + Classic");
      zone(650, 430, 270, 220, "#35262a", "#8a4b58", "Help desk");
      zone(950, 430, 270, 220, "#2c263a", "#6b5a99", "Nap corner");
      g.fillStyle = "#6e4c32"; g.fillRect(230, 326, 200, 14);
      g.fillStyle = "#523622"; g.fillRect(238, 340, 184, 34);
      g.fillStyle = "#1f242e"; g.fillRect(298, 290, 64, 38);
      g.fillStyle = "#62d2ff"; g.fillRect(302, 294, 56, 30);
      g.fillStyle = "#5a4230"; g.fillRect(850, 250, 140, 44);
      g.fillStyle = "#7a5b42"; g.fillRect(854, 254, 132, 36);

      const drawChibi = (ctx, ox, opts) => {
        const y0 = Math.round(opts.bob ?? 0);
        ctx.fillStyle = "rgba(0,0,0,0.32)";
        ctx.beginPath(); ctx.ellipse(ox + 32, 74, 14, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#2b3040";
        ctx.fillRect(ox + 24, 62 + y0, 6, 12);
        ctx.fillRect(ox + 34, 62 + y0, 6, 12);
        ctx.fillStyle = opts.coat;
        ctx.fillRect(ox + 20, 40 + y0, 24, 23);
        ctx.fillStyle = "#f5f2ea";
        ctx.fillRect(ox + 28, 40 + y0, 8, 8);
        ctx.fillStyle = opts.accent;
        ctx.fillRect(ox + 30, 46 + y0, 4, 12);
        const aL = Math.round(opts.armL ?? 0), aR = Math.round(opts.armR ?? 0);
        ctx.fillStyle = opts.coat;
        ctx.fillRect(ox + 14, 42 + y0 + aL, 6, 14);
        ctx.fillRect(ox + 44, 42 + y0 + aR, 6, 14);
        ctx.fillStyle = "#f3cba5";
        ctx.fillRect(ox + 14, 54 + y0 + aL, 6, 4);
        ctx.fillRect(ox + 44, 54 + y0 + aR, 6, 4);
        if (opts.wave) {
          ctx.fillStyle = opts.coat; ctx.fillRect(ox + 44, 26 + y0, 6, 16);
          ctx.fillStyle = "#f3cba5"; ctx.fillRect(ox + 44, 22 + y0, 6, 5);
        }
        ctx.fillStyle = opts.hair; ctx.fillRect(ox + 18, 14 + y0, 28, 10);
        ctx.fillStyle = "#f3cba5"; ctx.fillRect(ox + 20, 22 + y0, 24, 18);
        ctx.fillStyle = opts.hair; ctx.fillRect(ox + 18, 20 + y0, 4, 12); ctx.fillRect(ox + 42, 20 + y0, 4, 12);
        ctx.fillStyle = "#1b1e28";
        if (opts.blink || opts.sleep) {
          ctx.fillRect(ox + 24, 30 + y0, 5, 2); ctx.fillRect(ox + 35, 30 + y0, 5, 2);
        } else {
          ctx.fillRect(ox + 25, 28 + y0, 4, 5); ctx.fillRect(ox + 35, 28 + y0, 4, 5);
          ctx.fillStyle = "#ffffff"; ctx.fillRect(ox + 26, 29 + y0, 1, 2); ctx.fillRect(ox + 36, 29 + y0, 1, 2);
        }
        ctx.fillStyle = "rgba(255,120,130,0.45)";
        ctx.fillRect(ox + 22, 34 + y0, 4, 2); ctx.fillRect(ox + 38, 34 + y0, 4, 2);
        if (opts.sip) {
          ctx.fillStyle = "#ffffff"; ctx.fillRect(ox + 36, 36 + y0, 8, 8);
          ctx.fillStyle = "#9c6334"; ctx.fillRect(ox + 37, 36 + y0, 6, 2);
        }
        if (opts.orbAngle !== undefined && opts.orbColor) {
          const rx = ox + 32 + Math.cos(opts.orbAngle) * 24;
          const ry = 22 + Math.sin(opts.orbAngle) * 12;
          ctx.fillStyle = opts.orbColor;
          ctx.globalAlpha = 0.28; ctx.beginPath(); ctx.arc(rx, ry, 8, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(rx, ry, 4, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#ffffff"; ctx.fillRect(Math.round(rx - 1), Math.round(ry - 1), 2, 2);
        }
        if (opts.bar !== undefined) {
          ctx.fillStyle = "rgba(16,20,28,0.8)"; ctx.fillRect(ox + 6, 2, 52, 7);
          ctx.fillStyle = opts.orbColor ?? "#5eead4"; ctx.fillRect(ox + 7, 3, Math.round(50 * opts.bar), 5);
        }
        if (opts.badge) {
          ctx.fillStyle = "rgba(16,20,28,0.85)"; ctx.fillRect(ox + 2, 66, 18, 11);
          ctx.fillStyle = "#f8fafc"; ctx.font = "700 8px monospace"; ctx.fillText(opts.badge, ox + 4, 74);
        }
      };

      const files = { "bg.png": toB64(bg.cv) };
      const sheetColors = ["#38bdf8", "#2dd4bf", "#4ade80", "#facc15", "#fb923c", "#c084fc"];
      const alphaSheets = [];
      for (let s = 0; s < 6; s++) {
        const name = "alpha_w" + (s + 1) + ".png";
        alphaSheets.push(name);
        const strip = mk(30 * 64, 80);
        for (let f = 0; f < 30; f++) {
          const globalF = s * 30 + f;
          const isIntro = globalF < 30;
          const phase = isIntro ? globalF / 30 : (globalF - 30) / 150;
          const bob = isIntro ? -Math.sin(phase * Math.PI) * 5 : Math.sin(globalF * 0.35) * 2;
          const armL = isIntro ? -10 * Math.sin(phase * Math.PI) : Math.sin(globalF * 0.9) * 3;
          const armR = isIntro ? -10 * Math.sin(phase * Math.PI) : Math.cos(globalF * 0.9) * 3;
          drawChibi(strip.ctx, f * 64, {
            coat: "#3b82f6", hair: "#1e293b", accent: "#93c5fd",
            bob, armL, armR,
            orbAngle: isIntro ? -Math.PI / 2 + phase * Math.PI * 2 : phase * Math.PI * 2,
            orbColor: sheetColors[s],
            bar: globalF / 179,
            badge: "S" + (s + 1),
          });
        }
        files[name] = toB64(strip.cv);
      }

      const mkFrame = (opts) => { const c = mk(64, 80); drawChibi(c.ctx, 0, opts); return toB64(c.cv); };
      files["beta_sit.png"] = mkFrame({ coat: "#10b981", hair: "#5b3a29", accent: "#a7f3d0", badge: "F0" });
      files["beta_blink.png"] = mkFrame({ coat: "#10b981", hair: "#5b3a29", accent: "#a7f3d0", blink: true, badge: "F1" });
      files["beta_sip.png"] = mkFrame({ coat: "#10b981", hair: "#5b3a29", accent: "#a7f3d0", sip: true, bob: -1, badge: "F2" });
      files["beta_wave.png"] = mkFrame({ coat: "#10b981", hair: "#5b3a29", accent: "#a7f3d0", wave: true, bob: -2, badge: "F3" });

      const gamma = mk(4 * 64, 80);
      for (let f = 0; f < 4; f++) {
        drawChibi(gamma.ctx, f * 64, { coat: "#a855f7", hair: "#312e81", accent: "#e9d5ff", bob: f % 2 ? -2 : 0, armR: f >= 2 ? -4 : 0 });
      }
      files["gamma_idle.png"] = toB64(gamma.cv);

      const delta = mk(3 * 64, 80);
      for (let f = 0; f < 3; f++) {
        drawChibi(delta.ctx, f * 64, { coat: "#f59e0b", hair: "#3f2c1c", accent: "#fde68a", sleep: true, bob: f === 1 ? 1 : 0 });
        delta.ctx.fillStyle = "#e2e8f0"; delta.ctx.font = "700 10px system-ui";
        delta.ctx.fillText("Z".repeat(f + 1), f * 64 + 44, 18 - f * 3);
      }
      files["delta_nap.png"] = toB64(delta.cv);

      const manifest = {
        format: 1,
        id: "synth-anim",
        scale: 1,
        matte: "#1c2029",
        background: "bg.png",
        areas: {
          desks: { rect: [60, 130, 540, 420], seats: [[330, 390], [200, 390], [460, 390]] },
          lounge: { rect: [650, 130, 570, 270], seats: [[780, 320], [1050, 320], [920, 240]] },
          alert: { rect: [650, 430, 270, 220], seats: [[785, 560]] },
          nap: { rect: [950, 430, 270, 220], seats: [[1085, 560]] },
        },
        stateZones: { working: "desks", idle: "lounge", needs: "alert", crashed: "alert", stuck: "alert", paused: "nap", stopped: "nap", default: "lounge" },
        characters: {
          default: {
            idle: { src: "gamma_idle.png", frames: 4, w: 64, h: 80, fps: 4, dw: 96, dh: 120, ax: 32, ay: 74 },
            working: { src: alphaSheets, frames: 30, w: 64, h: 80, fps: 30, loopFrom: 30, dw: 112, dh: 140, ax: 32, ay: 74 },
            paused: { src: "delta_nap.png", frames: 3, w: 64, h: 80, fps: 2, dw: 96, dh: 120, ax: 32, ay: 74 },
          },
          betaSet: {
            idle: {
              w: 64, h: 80, dw: 112, dh: 140, ax: 32, ay: 74,
              frames: [
                { src: "beta_sit.png", ms: 900 },
                { src: "beta_blink.png", ms: 200 },
                { src: "beta_sip.png", ms: 700 },
                { src: "beta_sit.png", ms: 600 },
                { src: "beta_wave.png", ms: 600 },
              ],
            },
          },
        },
        byInstance: { "bot-beta": "betaSet" },
      };
      return { manifest, files };
    })()`);
    return data;
  } finally {
    await page.close();
  }
}

const pack = await buildSyntheticPack(fx.browser);
const added = fm.officeSkins.add(pack, "smoke");
if (!added.ok) throw new Error(`Synthetic pack refused: ${JSON.stringify(added)}`);
const setStyle = fm.officeStore.setAutoSkin("synth-anim");
if (!setStyle.ok) throw new Error(`setAutoSkin failed: ${JSON.stringify(setStyle)}`);
console.log("Synthetic pack uploaded:", added.pack);

const report: Record<string, any> = { pack: added.pack, cases: {} };

async function openOffice(page: any, base: string, lang: string) {
  await page.goto(`${base}/ui/fleet/org`);
  await page.locator(".oc-tools .seg-inline button", { hasText: lang === "en" ? "Office" : "辦公室" }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await page.waitForTimeout(1500);
}

try {
  // 1. Desktop dark zh-TW — verify 6-frame progression across sheets (optional WebM video when RECORD_VIDEO=1 locally;
  //    CI ui-gate runners do not install Playwright's ffmpeg binary).
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
    const imgHits: string[] = [];
    page.on("response", (res: any) => { if (res.url().includes("/ui/office-skins/synth-anim/img/") && res.status() === 200) imgHits.push(res.url()); });

    await mounted(page, 30000);
    await openOffice(page, fx.base, c.lang);
    for (let w = 0; w < 25 && imgHits.length < 13; w++) await page.waitForTimeout(200);

    // Capture 6 evenly-spaced frames over ~6 seconds (crossing every sheet S1→S6!).
    const canvas = page.locator(".oo-canvas");
    const bufs: Buffer[] = [];
    for (let i = 0; i < 6; i++) {
      const p = shotPath(SMOKE, "desk-dark-zh-TW", `f${i + 1}`);
      const buf = await canvas.screenshot({ path: p });
      bufs.push(buf);
      if (i < 5) await page.waitForTimeout(1050);
    }
    await page.screenshot({ path: shotPath(SMOKE, "desk-dark-zh-TW", "full") });
    if (recordVideo) await page.waitForTimeout(1500);

    const uniqueFrames = new Set(bufs.map((b) => b.toString("base64"))).size;
    const videoPath = recordVideo ? await page.video()?.path() : null;
    const cspViolations = csp ? await csp() : [];
    await ctx.close();
    report.cases["desk-dark-zh-TW"] = {
      ok: errors.length === 0 && cspViolations.length === 0 && imgHits.length >= 13 && uniqueFrames >= 5,
      errors, cspViolations, imagesLoaded: imgHits.length, uniqueFrames, ...(videoPath ? { videoPath } : {}),
    };
  }

  // 2. Phone (390×844) dark zh-TW — capture 4 frames across sheets to prove smooth phone playback.
  {
    const c = { device: "phone" as const, theme: "dark" as const, lang: "zh-TW" as const };
    const { ctx, page, csp } = await fx.page(c);
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await mounted(page, 30000);
    await openOffice(page, fx.base, c.lang);
    const bufs: Buffer[] = [];
    for (let i = 0; i < 4; i++) {
      const p = shotPath(SMOKE, "phone-dark-zh-TW", `f${i + 1}`);
      bufs.push(await page.screenshot({ path: p }));
      if (i < 3) await page.waitForTimeout(1400);
    }
    const uniqueFrames = new Set(bufs.map((b) => b.toString("base64"))).size;
    const cspViolations = await csp();
    await ctx.close();
    report.cases["phone-dark-zh-TW"] = { ok: errors.length === 0 && cspViolations.length === 0 && uniqueFrames >= 3, errors, cspViolations, uniqueFrames };
  }

  // 3. Desktop reduced-motion — canvas must remain pixel-identical over 1.5 s (strictly frame 0).
  {
    const c = { device: "desk" as const, theme: "light" as const, lang: "en" as const };
    const { ctx, page, csp } = await fx.page(c);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mounted(page, 30000);
    await openOffice(page, fx.base, c.lang);
    const canvas = page.locator(".oo-canvas");
    const a = await canvas.screenshot({ path: shotPath(SMOKE, "desk-light-en-reduced", "t0") });
    await page.waitForTimeout(1500);
    const b = await canvas.screenshot({ path: shotPath(SMOKE, "desk-light-en-reduced", "t1") });
    const frozen = a.equals(b);
    const cspViolations = await csp();
    await ctx.close();
    report.cases["desk-light-en-reduced"] = { ok: frozen && cspViolations.length === 0, frozen, cspViolations };
  }
} finally {
  await fx.close();
}

writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (Object.values(report.cases).some((c: any) => !c.ok)) process.exit(1);
