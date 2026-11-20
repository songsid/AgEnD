/**
 * M-3433 (#4256): skin-pack Agent profile card style & layout — manifest schema, WCAG contrast checks,
 * upload image/slice caps, preset & auto-foreground resolution, share-link privacy invariant, and backing canvas.
 */
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { CARD_BG_MAX, FRAME_MAX, checkSkinUpload } from "../src/web-office-skins.js";
import { OfficeShareView, type OfficeShareSource } from "../src/office-share.js";

/** Minimal valid solid-colour RGBA PNG of w × h px (no external deps). */
function png(w: number, h: number): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 4);
  const raw = Buffer.alloc(row.length * h);
  for (let y = 0; y < h; y++) row.copy(raw, y * row.length);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const baseManifest = (extra: Record<string, unknown> = {}) => ({
  format: 1,
  id: "cardpack",
  characters: { default: { idle: { src: "idle.png", frames: 1, w: 16, h: 16 } } },
  ...extra,
});

const RPG_CARD = {
  preset: "rpg",
  style: {
    background: "#1f1916",
    backgroundImage: "ui/card_bg.png",
    frame: "ui/card_frame.png",
    slice: 12,
    border: "#c8a165",
    text: "#f6ead7",
    muted: "#c9b69a",
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
};

let p: AppPage;
let PK: any, C: any, LV: any;

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  PK = await import("/ui/js/fleet-office-pack.js");
  C = await import("/ui/js/fleet-office-card.js");
  LV = await import("/ui/js/fleet-office-levels.js");
});
afterAll(() => p.restore());

describe("skin-pack card schema & WCAG contrast checks (#4256)", () => {
  it("packs without card omit the key and stay 100% unchanged", () => {
    const r = PK.checkSkinPack(baseManifest());
    expect(r.ok).toBe(true);
    expect("card" in r.pack).toBe(false);
  });

  it("accepts a complete RPG card manifest, normalises hex colours, and registers lazy images", () => {
    const r = PK.checkSkinPack(baseManifest({ card: { ...RPG_CARD, style: { ...RPG_CARD.style, background: "#1F1916" } } }));
    expect(r.ok).toBe(true);
    expect(r.pack.card.preset).toBe("rpg");
    expect(r.pack.card.style.background).toBe("#1f1916");
    expect(r.pack.card.style.slice).toBe(12);
    expect(PK.packPortraitImages(r.pack)).toEqual(expect.arrayContaining(["ui/card_bg.png", "ui/card_frame.png"]));
    expect(PK.packImages(r.pack)).toEqual(expect.arrayContaining(["idle.png", "ui/card_bg.png", "ui/card_frame.png"]));
  });

  it("defaults frame slice to 8 and refuses slice without frame", () => {
    const ok = PK.checkSkinPack(baseManifest({ card: { style: { frame: "ui/f.png" } } }));
    expect(ok.ok).toBe(true);
    expect(ok.pack.card.style.slice).toBe(8);
    expect(PK.checkSkinPack(baseManifest({ card: { style: { slice: 8 } } })).error).toBe("card.style.slice: only with frame");
  });

  it("refuses unknown keys, invalid enums, out-of-range numbers, and missing required sections", () => {
    const check = (card: unknown) => PK.checkSkinPack(baseManifest({ card }));
    expect(check({ css: "body{}" }).error).toBe('card: unknown key "css"');
    expect(check({ preset: "neon" }).error).toMatch(/^card\.preset:/);
    expect(check({ style: { background: "rgb(0,0,0)" } }).error).toBe("card.style.background: a colour as #rrggbb");
    expect(check({ style: { radius: "xl" } }).error).toMatch(/^card\.style\.radius:/);
    expect(check({ style: { frame: "f.png", slice: 129 } }).error).toMatch(/^card\.style\.slice:/);
    expect(check({ layout: { avatarSize: "huge" } }).error).toMatch(/^card\.layout\.avatarSize:/);
    expect(check({ layout: { avatarSource: "url" } }).error).toMatch(/^card\.layout\.avatarSource:/);
    expect(check({ layout: { headerAlign: "right" } }).error).toMatch(/^card\.layout\.headerAlign:/);
    expect(check({ layout: { width: 279 } }).error).toMatch(/^card\.layout\.width:/);
    expect(check({ layout: { width: 401 } }).error).toMatch(/^card\.layout\.width:/);
    expect(check({ layout: { rowColumns: 3 } }).error).toBe("card.layout.rowColumns: 1 or 2");
    expect(check({ layout: { sections: ["header", "rows"] } }).error).toBe('card.layout.sections: must include "header" and "actions"');
    expect(check({ layout: { sections: ["rows", "actions"] } }).error).toBe('card.layout.sections: must include "header" and "actions"');
    expect(check({ layout: { sections: ["header", "header", "actions"] } }).error).toMatch(/listed twice/);
    expect(check({ layout: { rows: ["office", "office"] } }).error).toMatch(/listed twice/);
    expect(check({ layout: { hide: ["close"] } }).error).toMatch(/^card\.layout\.hide\[0\]:/);
  });

  it("enforces WCAG contrast ratios on explicit colour pairs (4.5:1 text/accent/buttons, 3.0:1 border/bar)", () => {
    const check = (style: Record<string, unknown>) => PK.checkSkinPack(baseManifest({ card: { style } }));
    expect(check({ background: "#1f1916", text: "#3a302a" }).error).toMatch(/card\.style\.text: contrast ratio against background must be at least 4\.5:1/);
    expect(check({ background: "#1f1916", muted: "#554b44" }).error).toMatch(/card\.style\.muted: contrast ratio against background must be at least 4\.5:1/);
    expect(check({ background: "#181614", accent: "#181614" }).error).toMatch(/card\.style\.accent: contrast ratio against background must be at least 4\.5:1/);
    expect(check({ buttonBg: "#3a2c22", buttonText: "#665544" }).error).toMatch(/card\.style\.buttonText: contrast ratio against buttonBg must be at least 4\.5:1/);
    expect(check({ buttonPrimaryBg: "#c88d2e", buttonPrimaryText: "#f6ead7" }).error).toMatch(/card\.style\.buttonPrimaryText: contrast ratio against buttonPrimaryBg must be at least 4\.5:1/);
    expect(check({ background: "#1f1916", border: "#302824" }).error).toMatch(/card\.style\.border: contrast ratio against background must be at least 3:1/);
    expect(check({ barTrack: "#382d25", barFill: "#52443a" }).error).toMatch(/card\.style\.barFill: contrast ratio against barTrack must be at least 3:1/);
    expect(check({ background: "#1f1916", text: "#f6ead7", muted: "#c9b69a", accent: "#e5b84b", border: "#c8a165", barTrack: "#382d25", barFill: "#e5b84b" }).ok).toBe(true);
  });
});

describe("host upload image & slice caps (#4256)", () => {
  const idleB64 = png(16, 16).toString("base64");

  it("accepts valid card backgroundImage and 9-slice frame PNGs", () => {
    const res = checkSkinUpload({
      manifest: baseManifest({ card: { preset: "rpg", style: { backgroundImage: "ui/bg.png", frame: "ui/frame.png", slice: 10 } } }),
      files: {
        "idle.png": idleB64,
        "ui/bg.png": png(340, 240).toString("base64"),
        "ui/frame.png": png(48, 48).toString("base64"),
      },
    }, "admin", 1000);
    expect(res.ok).toBe(true);
  });

  it("refuses oversized backgroundImage (> CARD_BG_MAX), oversized frame (> FRAME_MAX), and invalid slice", () => {
    const bigBg = checkSkinUpload({
      manifest: baseManifest({ card: { style: { backgroundImage: "ui/bg.png" } } }),
      files: { "idle.png": idleB64, "ui/bg.png": png(CARD_BG_MAX.w + 1, 64).toString("base64") },
    }, "admin", 1000);
    expect(bigBg.ok).toBe(false);
    if (!bigBg.ok) expect(bigBg.error).toBe("skin_card_dimensions");

    const bigFrame = checkSkinUpload({
      manifest: baseManifest({ card: { style: { frame: "ui/frame.png", slice: 8 } } }),
      files: { "idle.png": idleB64, "ui/frame.png": png(FRAME_MAX.w + 1, 64).toString("base64") },
    }, "admin", 1000);
    expect(bigFrame.ok).toBe(false);
    if (!bigFrame.ok) expect(bigFrame.error).toBe("skin_card_dimensions");

    const badSlice = checkSkinUpload({
      manifest: baseManifest({ card: { style: { frame: "ui/frame.png", slice: 16 } } }),
      files: { "idle.png": idleB64, "ui/frame.png": png(32, 32).toString("base64") },
    }, "admin", 1000);
    expect(badSlice.ok).toBe(false);
    if (!badSlice.ok) expect(badSlice.error).toBe("skin_card_dimensions");
  });

  it("refuses upload when a card image declared in manifest is missing", () => {
    const res = checkSkinUpload({
      manifest: baseManifest({ card: { style: { backgroundImage: "ui/bg.png" } } }),
      files: { "idle.png": idleB64 },
    }, "admin", 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("skin_file_missing");
  });
});

describe("resolveCardSpec, auto-foreground contrast & share-link security (#4256)", () => {
  it("returns null for packs without card", () => {
    expect(C.resolveCardSpec(null)).toBeNull();
    expect(C.resolveCardSpec(undefined)).toBeNull();
  });

  it("resolves curated presets and allows explicit layout overrides", () => {
    const rpg = C.resolveCardSpec({ preset: "rpg" });
    expect([rpg.avatarPx, rpg.layout.avatarSource, rpg.layout.headerAlign, rpg.layout.width]).toEqual([84, "portrait", "center", 340]);
    expect(rpg.hideSet.has("instance")).toBe(true);

    const compact = C.resolveCardSpec({ preset: "compact" });
    expect([compact.avatarPx, compact.layout.width, compact.layout.sections]).toEqual([44, 296, ["header", "rows", "actions"]]);

    const dossier = C.resolveCardSpec({ preset: "dossier", layout: { width: 380, rowColumns: 2 } });
    expect([dossier.layout.width, dossier.layout.rowColumns]).toEqual([380, 2]);
  });

  it("auto-derives >= 4.5:1 foreground when pack sets only background or backgroundImage", () => {
    const darkOnly = C.resolveCardSpec({ style: { background: "#141118" } });
    expect(PK.contrastRatio(darkOnly.cssVars["--oo-card-text"], "#141118")).toBeGreaterThanOrEqual(4.5);
    expect(PK.contrastRatio(darkOnly.cssVars["--oo-card-muted"], "#141118")).toBeGreaterThanOrEqual(4.5);
    expect(PK.contrastRatio(darkOnly.cssVars["--oo-card-border"], "#141118")).toBeGreaterThanOrEqual(3.0);

    const lightOnly = C.resolveCardSpec({ style: { background: "#f7f4ee" } });
    expect(PK.contrastRatio(lightOnly.cssVars["--oo-card-text"], "#f7f4ee")).toBeGreaterThanOrEqual(4.5);
    expect(PK.contrastRatio(lightOnly.cssVars["--oo-card-muted"], "#f7f4ee")).toBeGreaterThanOrEqual(4.5);

    const imgOnly = C.resolveCardSpec({ style: { backgroundImage: "ui/bg.png" } });
    expect(imgOnly.backdrop.scrim).toMatch(/^rgba\(/);
    expect(imgOnly.cssVars["--oo-card-text"]).toBeTruthy();

    // RPG stat/XP tile tint: if explicit muted passes against background but dips below 4.5:1 against the tinted tile, auto-upgrade.
    const rpgTint = C.resolveCardSpec({ preset: "rpg", style: { background: "#141110", barTrack: "#5a4d42", muted: "#887e74" } });
    expect(PK.contrastRatio(rpgTint.cssVars["--oo-card-muted"], "#141110")).toBeGreaterThanOrEqual(4.5);
    expect(PK.contrastRatio(rpgTint.cssVars["--oo-card-muted"], "#413830")).toBeGreaterThanOrEqual(4.5);

    // Prism P2 partial-override controls: derived defaults must contrast with supplied counterparts.
    const goldTrack = C.resolveCardSpec({ style: { background: "#181614", barTrack: "#e5b84b" } });
    expect(PK.contrastRatio(goldTrack.cssVars["--oo-card-bar-fill"], "#e5b84b")).toBeGreaterThanOrEqual(3.0);

    const sameAccent = C.resolveCardSpec({ style: { background: "#181614", accent: "#181614" } });
    expect(PK.contrastRatio(sameAccent.cssVars["--oo-card-accent"], "#181614")).toBeGreaterThanOrEqual(4.5);

    // Accent-derived primary button must always pair with >= 4.5:1 buttonPrimaryText.
    const accentPrimary = C.resolveCardSpec({ style: { background: "#181614", accent: "#e5b84b" } });
    expect(accentPrimary.cssVars["--oo-card-btn-primary-bg"]).toBe("#e5b84b");
    expect(PK.contrastRatio(accentPrimary.cssVars["--oo-card-btn-primary-text"], "#e5b84b")).toBeGreaterThanOrEqual(4.5);

    // Partial overrides without background still resolve contrasting bar & button pairs.
    const trackOnly = C.resolveCardSpec({ style: { barTrack: "#e5b84b" } });
    expect(PK.contrastRatio(trackOnly.cssVars["--oo-card-bar-fill"], "#e5b84b")).toBeGreaterThanOrEqual(3.0);
    const btnTextOnly = C.resolveCardSpec({ style: { buttonText: "#f6ead7" } });
    expect(PK.contrastRatio("#f6ead7", btnTextOnly.cssVars["--oo-card-btn-bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it("Prism P3: dossier preset with rowColumns: 2 emits oo-card-cols-2 and CSS overrides dossier single-column rule", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
    expect(css).toContain(".oo-card-dossier.oo-card-cols-2 .oo-card-rows { grid-template-columns: 1fr 1fr;");
    const { render } = await import("/assets/app-html.js");
    const { h } = await import("/assets/app-html.js");
    const host = document.createElement("div");
    const node = { name: "alpha", state: "working", i: { name: "alpha", display_name: "Alpha", backend: "claude-code", model: "claude-opus-5-5" } };
    const m = C.cardModel({ node, lv: null, levels: null, share: false, state: "Working", now: "Typing", where: "Eng · Work" });
    render(h(C.OfficeCard, { model: m, onClose: () => {}, packCard: { preset: "dossier", layout: { rowColumns: 2 } } }), host);
    const cardEl = host.querySelector(".oo-card")!;
    expect(cardEl.className).toContain("oo-card-dossier");
    expect(cardEl.className).toContain("oo-card-cols-2");
    render(null, host);
  });

  it("share-link invariant: card.layout can never reveal stripped model/backend/today/firstSeen on a share link", () => {
    const node = { name: "alpha", state: "working", i: { name: "alpha", display_name: "Alpha", backend: "claude-code", model: "claude-opus-5-5" } };
    const lv = LV.levelsOk({ enabled: true, unit: 100_000, detail: true, levels: { alpha: { level: 50, workTokens: 250_000_000, today: { workTokens: 12_300, requests: 45 }, firstSeen: "2026-01-01" } } });
    const shared = C.cardModel({ node, lv, levels: null, share: true, state: "Working", now: "Typing", where: "Eng · Work" });
    const spec = C.resolveCardSpec({ layout: { rows: ["model", "backend", "today", "firstSeen", "office"] } });
    expect(C.visibleRows(shared, spec).map((r: { key: string }) => r.key)).toEqual(["office"]);

    const authed = C.cardModel({ node, lv, levels: null, share: false, state: "Working", now: "Typing", where: "Eng · Work" });
    expect(C.visibleRows(authed, spec).map((r: { key: string }) => r.key)).toEqual(["model", "backend", "today", "firstSeen", "office"]);
  });

  it("OfficeShareView.pack keeps card and its referenced images in files", () => {
    const src: OfficeShareSource = {
      status: () => ({ instances: [{ name: "alpha", state: "working" }] }),
      org: () => ({ general: ["alpha"], teams: [] }),
      offices: () => ({ rev: 1, offices: [{ id: "eng", name: "Eng", skin: "cardpack", members: ["alpha"] }] }),
      acts: () => [], traffic: () => ({ now: "t", items: [] }), needs: () => [], hidden: () => false,
    };
    const v = new OfficeShareView({ office: "eng", text: false }, src);
    const out = v.pack({
      manifest: baseManifest({ card: RPG_CARD }),
      files: { "idle.png": "aaa", "ui/card_bg.png": "bbb", "ui/card_frame.png": "ccc", "unused.png": "ddd" },
    }) as any;
    expect(out.manifest.card).toEqual(RPG_CARD);
    expect(Object.keys(out.files).sort()).toEqual(["idle.png", "ui/card_bg.png", "ui/card_frame.png"]);
  });

  it("drawCardBackdrop draws backgroundImage, scrim, and 9-slice frame cleanly", () => {
    const calls: string[] = [];
    const ctx = {
      setTransform: () => calls.push("setTransform"),
      clearRect: () => calls.push("clearRect"),
      drawImage: () => calls.push("drawImage"),
      fillRect: () => calls.push("fillRect"),
      fillStyle: "",
      imageSmoothingEnabled: true,
    };
    const cv = { clientWidth: 340, clientHeight: 280, width: 0, height: 0, getContext: () => ctx };
    const borderPx = C.drawCardBackdrop(cv, {
      bgIm: { width: 340, height: 280 },
      frameIm: { width: 48, height: 48 },
      slice: 10,
      scale: 2,
      scrim: "rgba(31, 25, 22, 0.56)",
    });
    expect(borderPx).toBe(20);
    expect(calls).toContain("fillRect");
    expect(calls.filter((c) => c === "drawImage").length).toBe(10); // 1 bg + 9 slices
  });
});
