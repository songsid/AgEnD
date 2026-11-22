// M-3433 (#4256) on the real app: skin-pack Agent profile card style & layout presets
// with synthetic skin packs (zero real names or chat IDs).
//   1. desk-default-zh (dark zh-TW, Cozy without `card`): unchanged legacy .oo-card (320px, no custom wrapper).
//   2. desk-rpg-zh (dark zh-TW, synthetic RPG pack with backgroundImage + 9-slice frame + portrait):
//      verifies 84px portrait avatar, centered header, backing canvas, hidden instance, stage clamping,
//      and single-line `今天` row (zero orphaned character wrap).
//   3. desk-compact-en (light en, synthetic Compact pack): 296px width, 44px avatar, 3 sections, hidden XP/now.
//   4. phone-rpg-zh (390×844 dark zh-TW, RPG pack): full-width bottom sheet, <= 75dvh, >= 44px tap targets, zero overflow.
// Run:
//   PW_DIR=$HOME/.cache/contrast-tools REPO=<checkout> OUT=<dir> \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-office-card-style-m3433.mts
// ui-gate: {"name": "Office Agent card style and layout from skin pack (#4256)", "hp": 19733}
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-office-card-style-m3433";

const ROSTER = [
  { name: "bot-alpha", displayName: "Alpha", backend: "claude-code", model: "claude-opus-5-5", team: "Studio", status: "running" as const, general: true },
  { name: "bot-beta", displayName: "Beta", backend: "codex", model: "gpt-5.4", team: "Studio", status: "running" as const },
  { name: "bot-gamma", displayName: "Gamma", backend: "kiro-cli", model: "claude-sonnet-4-6", team: "Studio", status: "running" as const },
];

const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 49042), roster: ROSTER, classic: false });
const fm = fx.fm;

const origUiStatus = fm.getUiStatus.bind(fm);
fm.getUiStatus = (...a: unknown[]) => {
  const s = origUiStatus(...a);
  if (s && Array.isArray(s.instances)) {
    for (const inst of s.instances) {
      if (inst.name === "bot-alpha") {
        inst.status = "running"; inst.execution_state = "working"; inst.state = "working";
        inst.model = "claude-opus-5-5";
      } else {
        inst.status = "running"; inst.execution_state = "idle"; inst.state = "idle";
      }
    }
  }
  return s;
};

// Realistic synthetic Office levels via the real /ui/office-levels path (zero real usage data).
fm.officeLevels = async () => ({
  "bot-alpha": { level: 50, workTokens: 256_400_000, estimated: false, today: { workTokens: 1_800_000, requests: 64 }, firstSeen: "2026-10-10" },
  "bot-beta": { level: 24, workTokens: 58_000_000, estimated: false, today: { workTokens: 420_000, requests: 18 }, firstSeen: "2026-10-20" },
  "bot-gamma": { level: 12, workTokens: 14_500_000, estimated: false, today: { workTokens: 110_000, requests: 7 }, firstSeen: "2026-11-01" },
});

/** Build synthetic RPG & Compact skin packs in browser canvas (zero external files, zero real names). */
async function buildSyntheticCardPacks(browser: any) {
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

      // Shared 16:9 studio scene background (1280x720)
      const makeSceneBg = (dark) => {
        const bg = mk(1280, 720);
        const b = bg.ctx;
        b.fillStyle = dark ? "#191512" : "#e8e3d9";
        b.fillRect(0, 0, 1280, 720);
        const zone = (x, y, w, h, f1, f2, border, label) => {
          b.fillStyle = f1; b.fillRect(x, y, w, h);
          b.fillStyle = f2;
          for (let ty = y; ty < y + h; ty += 32) {
            for (let tx = x + (((ty - y) / 32) % 2) * 32; tx < x + w; tx += 64) {
              b.fillRect(tx, ty, Math.min(32, x + w - tx), Math.min(32, y + h - ty));
            }
          }
          b.strokeStyle = border; b.lineWidth = 3; b.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
          b.fillStyle = dark ? "#e8dcc8" : "#292524";
          b.font = "600 18px system-ui, sans-serif";
          b.fillText(label, x + 16, y + 30);
        };
        if (dark) {
          zone(60, 100, 560, 480, "#241e19", "#201a15", "#5a4632", "Guild Desk");
          zone(660, 100, 560, 480, "#1f2722", "#1b221e", "#3d5444", "Tavern Lounge");
        } else {
          zone(60, 100, 560, 480, "#f5f2ec", "#eee9df", "#b8b0a2", "Work");
          zone(660, 100, 560, 480, "#edf3ee", "#e4ede6", "#9eb5a3", "Lounge");
        }
        return toB64(bg.cv);
      };

      const drawChibi = (ctx, ox, coat, hair, accent, bob) => {
        const x = ox + 14, y = 14 + bob;
        ctx.fillStyle = "rgba(0,0,0,0.26)"; ctx.fillRect(x + 6, 70, 24, 5);
        ctx.fillStyle = "#1e293b"; ctx.fillRect(x + 10, y + 48, 6, 10); ctx.fillRect(x + 20, y + 48, 6, 10);
        ctx.fillStyle = coat; ctx.fillRect(x + 6, y + 28, 24, 22);
        ctx.fillStyle = accent; ctx.fillRect(x + 14, y + 28, 8, 10);
        ctx.fillStyle = hair; ctx.fillRect(x + 6, y + 2, 24, 12);
        ctx.fillStyle = "#f5d0b5"; ctx.fillRect(x + 8, y + 10, 20, 18);
        ctx.fillStyle = hair; ctx.fillRect(x + 6, y + 10, 3, 10); ctx.fillRect(x + 27, y + 10, 3, 10);
        ctx.fillStyle = "#1e1b24"; ctx.fillRect(x + 12, y + 16, 3, 4); ctx.fillRect(x + 21, y + 16, 3, 4);
      };
      const mkStrip = (coat, hair, accent) => {
        const s = mk(2 * 64, 80);
        drawChibi(s.ctx, 0, coat, hair, accent, 0);
        drawChibi(s.ctx, 64, coat, hair, accent, -1);
        return toB64(s.cv);
      };

      // RPG Portrait (168x168 pixel-art guild hero portrait for Alpha)
      const port = mk(168, 168);
      const pc = port.ctx;
      const grad = pc.createLinearGradient(0, 0, 0, 168);
      grad.addColorStop(0, "#3b2a1e"); grad.addColorStop(1, "#1f1610");
      pc.fillStyle = grad; pc.fillRect(0, 0, 168, 168);
      // Warm rim halo
      pc.fillStyle = "rgba(229, 184, 75, 0.16)";
      pc.beginPath(); pc.arc(84, 74, 58, 0, Math.PI * 2); pc.fill();
      // Shoulders / cape
      pc.fillStyle = "#2b4d8a"; pc.fillRect(32, 114, 104, 54);
      pc.fillStyle = "#c88d2e"; pc.fillRect(68, 114, 32, 54);
      pc.fillStyle = "#e5b84b"; pc.fillRect(76, 122, 16, 10);
      // Neck & head
      pc.fillStyle = "#e7b999"; pc.fillRect(72, 98, 24, 18);
      pc.fillStyle = "#f5d0b5"; pc.fillRect(50, 42, 68, 60);
      // Hair
      pc.fillStyle = "#2d2438";
      pc.fillRect(44, 24, 80, 26);
      pc.fillRect(42, 38, 14, 42);
      pc.fillRect(112, 38, 14, 42);
      pc.fillStyle = "#483a5a"; pc.fillRect(56, 30, 48, 8);
      // Eyes & smile
      pc.fillStyle = "#1e1b24";
      pc.fillRect(64, 64, 10, 14); pc.fillRect(94, 64, 10, 14);
      pc.fillStyle = "#ffffff";
      pc.fillRect(66, 66, 4, 4); pc.fillRect(96, 66, 4, 4);
      pc.fillStyle = "#b46b5b"; pc.fillRect(76, 86, 16, 4);

      // RPG Card Background Image (360x420 subtle parchment/wood grain texture)
      const cbg = mk(360, 420);
      const cb = cbg.ctx;
      const bgrad = cb.createLinearGradient(0, 0, 360, 420);
      bgrad.addColorStop(0, "#2b211a"); bgrad.addColorStop(0.5, "#1f1814"); bgrad.addColorStop(1, "#2a1e16");
      cb.fillStyle = bgrad; cb.fillRect(0, 0, 360, 420);
      cb.fillStyle = "rgba(229, 184, 75, 0.06)";
      for (let y = 0; y < 420; y += 24) cb.fillRect(0, y, 360, 2);
      cb.strokeStyle = "rgba(200, 161, 101, 0.14)"; cb.lineWidth = 2;
      cb.strokeRect(18, 18, 324, 384);

      // RPG 9-slice Frame (48x48, slice=10, golden bevel corners + dark bronze edge)
      const frm = mk(48, 48);
      const fc = frm.ctx;
      fc.clearRect(0, 0, 48, 48);
      // Outer rim
      fc.fillStyle = "#8a622a"; fc.fillRect(0, 0, 48, 48);
      fc.clearRect(4, 4, 40, 40);
      // Gold inner trim
      fc.fillStyle = "#d9ae5f"; fc.fillRect(1, 1, 46, 2); fc.fillRect(1, 45, 46, 2);
      fc.fillRect(1, 1, 2, 46); fc.fillRect(45, 1, 2, 46);
      // Subtle inner shadow line
      fc.fillStyle = "#4d361a"; fc.fillRect(3, 3, 42, 1); fc.fillRect(3, 44, 42, 1);
      fc.fillRect(3, 3, 1, 42); fc.fillRect(44, 3, 1, 42);
      // Corner studs (inside 10x10 corners)
      const stud = (x, y) => {
        fc.fillStyle = "#f2cf7e"; fc.fillRect(x, y, 5, 5);
        fc.fillStyle = "#6e4c1e"; fc.fillRect(x + 1, y + 1, 3, 3);
        fc.fillStyle = "#ffe59e"; fc.fillRect(x + 2, y + 2, 1, 1);
      };
      stud(1, 1); stud(42, 1); stud(1, 42); stud(42, 42);

      const strip = (src) => ({ src, frames: 2, w: 64, h: 80, fps: 4, ax: 32, ay: 72, dw: 54, dh: 68 });
      const areas = {
        work: { rect: [60, 100, 560, 480], seats: [[260, 340], [420, 340]] },
        lounge: { rect: [660, 100, 560, 480], seats: [[840, 340], [1020, 340]] },
      };
      const stateZones = { working: "work", idle: "lounge", default: "lounge" };

      const rpgPack = {
        name: "RPG Sheet Pack",
        manifest: {
          format: 1, id: "rpg-sheet", scale: 2, background: "bg.png", matte: "#191512",
          areas, stateZones, door: [640, 680],
          characters: {
            default: { idle: strip("alpha.png"), working: strip("alpha.png") },
            beta: { idle: strip("beta.png") },
          },
          byInstance: { "bot-beta": "beta" },
          portraits: {
            default: "portraits/alpha.png",
            byInstance: { "bot-alpha": "portraits/alpha.png" },
          },
          levels: {
            titles: [{ from: 0, name: "見習冒險者" }, { from: 20, name: "公會導師" }, { from: 50, name: "傳說工匠" }],
          },
          card: {
            preset: "rpg",
            style: {
              background: "#1f1916",
              backgroundImage: "ui/card_bg.png",
              frame: "ui/card_frame.png",
              slice: 10,
              border: "#c8a165",
              text: "#f6ead7",
              muted: "#e2d4bc",
              accent: "#e5b84b",
              barTrack: "#382d25",
              barFill: "#e5b84b",
              buttonBg: "#3a2c22",
              buttonText: "#f6ead7",
              buttonPrimaryBg: "#c88d2e",
              buttonPrimaryText: "#1a120b",
              radius: "sm",
            },
            layout: {
              avatarSize: "lg",
              avatarSource: "portrait",
              headerAlign: "center",
              width: 340,
              sections: ["header", "level", "rows", "now", "tell", "actions"],
              rows: ["office", "model", "backend", "today", "firstSeen"],
              rowColumns: 2,
              hide: ["instance"],
            },
          },
        },
        files: {
          "bg.png": makeSceneBg(true),
          "alpha.png": mkStrip("#2b4d8a", "#2d2438", "#e5b84b"),
          "beta.png": mkStrip("#2f6f55", "#5a3921", "#f0b429"),
          "portraits/alpha.png": toB64(port.cv),
          "ui/card_bg.png": toB64(cbg.cv),
          "ui/card_frame.png": toB64(frm.cv),
        },
      };

      const compactPack = {
        name: "Compact Studio Pack",
        manifest: {
          format: 1, id: "compact-studio", scale: 2, background: "bg.png", matte: "#e8e3d9",
          areas, stateZones, door: [640, 680],
          characters: {
            default: { idle: strip("alpha.png"), working: strip("alpha.png") },
          },
          card: {
            preset: "compact",
            style: {
              background: "#f6f4ef",
              border: "#6b7280",
              text: "#1c1917",
              muted: "#334155",
              accent: "#1d4ed8",
              buttonBg: "#e7e5e0",
              buttonText: "#1c1917",
              buttonPrimaryBg: "#1d4ed8",
              buttonPrimaryText: "#ffffff",
              radius: "md",
            },
            layout: {
              avatarSize: "sm",
              avatarSource: "sprite",
              headerAlign: "left",
              width: 296,
              sections: ["header", "rows", "actions"],
              rows: ["office", "model", "today"],
              rowColumns: 2,
              hide: ["instance", "badge", "level", "xpBar", "now"],
            },
          },
        },
        files: {
          "bg.png": makeSceneBg(false),
          "alpha.png": mkStrip("#2563eb", "#334155", "#93c5fd"),
        },
      };

      return { rpgPack, compactPack };
    })()`);
  } finally {
    await page.close();
  }
}

async function openOfficeAndCard(page: any, base: string, lang: string) {
  await page.goto(`${base}/ui/fleet/org`, { waitUntil: "domcontentloaded" });
  await page.locator(".oc-tools .seg-inline button", { hasText: lang === "en" ? "Office" : "辦公室" }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15_000 });
  await page.waitForTimeout(900);
  // Open Alpha's card via accessible desk list button (reliable on both desktop & phone regardless of zoom).
  const deskBtn = page.locator('button.oo-desk[data-name="bot-alpha"]').first();
  await deskBtn.waitFor({ state: "attached", timeout: 10_000 });
  await deskBtn.evaluate((el: HTMLElement) => el.click());
  await page.waitForSelector(".oo-card", { timeout: 10_000 });
  await page.waitForTimeout(500);
}

async function inspectCard(page: any) {
  return await page.evaluate(() => {
    const card = document.querySelector(".oo-card") as HTMLElement | null;
    if (!card) return null;
    const stage = document.querySelector(".oo-stage") as HTMLElement | null;
    const cr = card.getBoundingClientRect();
    const sr = stage ? stage.getBoundingClientRect() : null;
    const av = card.querySelector(".oo-card-avatar") as HTMLElement | null;
    const avRect = av ? av.getBoundingClientRect() : null;
    const bg = card.querySelector(".oo-card-bg") as HTMLCanvasElement | null;
    const closeBtn = card.querySelector(".oo-card-close") as HTMLElement | null;
    const closeRect = closeBtn ? closeBtn.getBoundingClientRect() : null;
    const actionBtns = [...card.querySelectorAll(".oo-card-actions .btn")].map((b) => {
      const r = b.getBoundingClientRect();
      return { text: b.textContent?.trim(), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const todayDd = card.querySelector('[data-row="today"] dd') as HTMLElement | null;
    const todayRect = todayDd ? todayDd.getBoundingClientRect() : null;
    const inlineStyledDescendants = [...card.querySelectorAll("[style]")].length;
    const body = card.querySelector(".oo-card-body") as HTMLElement | null;
    return {
      className: card.className,
      preset: card.getAttribute("data-preset"),
      rect: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height), right: Math.round(cr.right), bottom: Math.round(cr.bottom) },
      stageRect: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), right: Math.round(sr.right), bottom: Math.round(sr.bottom) } : null,
      avatar: avRect ? { w: Math.round(avRect.width), h: Math.round(avRect.height) } : null,
      hasBgCanvas: !!bg && bg.width > 0 && bg.height > 0,
      hasInstance: !!card.querySelector(".oo-card-instance"),
      hasXp: !!card.querySelector(".oo-card-xp"),
      hasNow: !!card.querySelector(".oo-card-now"),
      closeRect: closeRect ? { w: Math.round(closeRect.width), h: Math.round(closeRect.height) } : null,
      actionBtns,
      today: todayDd ? { text: todayDd.textContent?.trim(), w: Math.round(todayRect!.width), h: Math.round(todayRect!.height) } : null,
      inlineStyledDescendants,
      horizOverflow: (body || card).scrollWidth > (body || card).clientWidth + 1,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

try {
  const { rpgPack, compactPack } = await buildSyntheticCardPacks(fx.browser);
  const r1 = fm.officeSkins.add(rpgPack, "smoke");
  if (!r1.ok) throw new Error(`rpgPack refused: ${JSON.stringify(r1)}`);
  const r2 = fm.officeSkins.add(compactPack, "smoke");
  if (!r2.ok) throw new Error(`compactPack refused: ${JSON.stringify(r2)}`);

  const runCase = async (name: string, opts: { device: "desk" | "phone"; theme: "dark" | "light"; lang: "zh-TW" | "en"; skin: string }) => {
    const set = fm.officeStore.setAutoSkin(opts.skin);
    if (!set.ok) throw new Error(`setAutoSkin(${opts.skin}) failed: ${JSON.stringify(set)}`);
    const p = await fx.page({ device: opts.device, theme: opts.theme, lang: opts.lang });
    const errs: string[] = [];
    p.page.on("pageerror", (e: Error) => errs.push(`pageerror: ${e.message}`));
    p.page.on("console", (m: any) => { if (m.type() === "error") errs.push(`console: ${m.text()}`); });
    try {
      await openOfficeAndCard(p.page, fx.base, opts.lang);
      const info = await inspectCard(p.page);
      const csp = await p.csp();
      await p.page.screenshot({ path: shotPath(SMOKE, name, "card") });
      if (errs.length) throw new Error(`${name} runtime errors: ${errs.join("; ")}`);
      if (csp.length) throw new Error(`${name} CSP violations: ${csp.join("; ")}`);
      if (!info) throw new Error(`${name}: .oo-card did not open`);
      if (info.inlineStyledDescendants > 0) throw new Error(`${name}: unexpected inline style attribute on descendant`);
      if (info.horizOverflow || info.docOverflow) throw new Error(`${name}: horizontal overflow detected`);
      return info;
    } finally {
      await p.ctx.close();
    }
  };

  // Case 1: Built-in Cozy (no `card` key) — unchanged default, single-line 今天 (zero orphaned wrap)
  const def = await runCase("desk-default-zh", { device: "desk", theme: "dark", lang: "zh-TW", skin: "cozy" });
  if (def.className.includes("oo-card-custom")) throw new Error(`desk-default-zh should not have oo-card-custom: ${def.className}`);
  if (def.rect.w !== 320) throw new Error(`desk-default-zh width expected 320, got ${def.rect.w}`);
  if (!def.today || def.today.h > 28) throw new Error(`desk-default-zh today row wrapped unexpectedly: ${JSON.stringify(def.today)}`);
  console.log("PASS desk-default-zh:", JSON.stringify(def));

  // Case 2: RPG preset (dark zh-TW) — 84px portrait, backing bg+frame canvas, single-line 今天 (Glitch #2 fix)
  const rpg = await runCase("desk-rpg-zh", { device: "desk", theme: "dark", lang: "zh-TW", skin: "rpg-sheet" });
  if (!rpg.className.includes("oo-card-rpg") || !rpg.className.includes("oo-card-framed")) throw new Error(`desk-rpg-zh missing classes: ${rpg.className}`);
  if (!rpg.hasBgCanvas) throw new Error("desk-rpg-zh missing backing canvas");
  if (!rpg.avatar || rpg.avatar.w !== 84 || rpg.avatar.h !== 84) throw new Error(`desk-rpg-zh avatar expected 84x84, got ${JSON.stringify(rpg.avatar)}`);
  if (rpg.hasInstance) throw new Error("desk-rpg-zh should hide instance");
  if (!rpg.today || rpg.today.h > 28) throw new Error(`desk-rpg-zh today row wrapped unexpectedly: ${JSON.stringify(rpg.today)}`);
  if (rpg.stageRect && (rpg.rect.right > rpg.stageRect.right + 2 || rpg.rect.bottom > rpg.stageRect.bottom + 2)) {
    throw new Error(`desk-rpg-zh clipped outside stage: card=${JSON.stringify(rpg.rect)} stage=${JSON.stringify(rpg.stageRect)}`);
  }
  console.log("PASS desk-rpg-zh:", JSON.stringify(rpg));

  // Case 3: Compact preset (light en) — 296px width, 44px avatar, XP & Now hidden, all 4 buttons on 1 row
  const cmp = await runCase("desk-compact-en", { device: "desk", theme: "light", lang: "en", skin: "compact-studio" });
  if (!cmp.className.includes("oo-card-compact")) throw new Error(`desk-compact-en missing class: ${cmp.className}`);
  if (cmp.rect.w !== 296) throw new Error(`desk-compact-en width expected 296, got ${cmp.rect.w}`);
  if (!cmp.avatar || cmp.avatar.w !== 44 || cmp.avatar.h !== 44) throw new Error(`desk-compact-en avatar expected 44x44, got ${JSON.stringify(cmp.avatar)}`);
  if (cmp.hasXp || cmp.hasNow || cmp.hasInstance) throw new Error(`desk-compact-en should hide xp/now/instance: ${JSON.stringify(cmp)}`);
  if (new Set(cmp.actionBtns.map((b: any) => b.y)).size > 1) throw new Error(`desk-compact-en action buttons wrapped onto multiple rows: ${JSON.stringify(cmp.actionBtns)}`);
  console.log("PASS desk-compact-en:", JSON.stringify(cmp));

  // Case 4: Phone 390×844 RPG bottom sheet — full width, <= 75dvh, >= 44px tap targets, single-line 今天
  const ph = await runCase("phone-rpg-zh", { device: "phone", theme: "dark", lang: "zh-TW", skin: "rpg-sheet" });
  if (!ph.className.includes("sheet") || !ph.className.includes("oo-card-rpg")) throw new Error(`phone-rpg-zh classes: ${ph.className}`);
  if (ph.rect.w !== 390) throw new Error(`phone-rpg-zh width expected 390, got ${ph.rect.w}`);
  if (ph.rect.h > Math.ceil(844 * 0.75) + 2) throw new Error(`phone-rpg-zh height exceeds 75dvh: ${ph.rect.h}`);
  if (!ph.closeRect || ph.closeRect.w < 44 || ph.closeRect.h < 44) throw new Error(`phone-rpg-zh close target < 44px: ${JSON.stringify(ph.closeRect)}`);
  for (const b of ph.actionBtns) if (b.h < 44) throw new Error(`phone-rpg-zh action button < 44px: ${JSON.stringify(b)}`);
  if (!ph.today || ph.today.h > 28) throw new Error(`phone-rpg-zh today row wrapped: ${JSON.stringify(ph.today)}`);
  console.log("PASS phone-rpg-zh:", JSON.stringify(ph));

  console.log("ALL 4 M-3433 SMOKE CASES PASSED");
} finally {
  await fx.close();
}
