/**
 * #1408 §2: the design tokens every panel shares, and the bundled Inter.
 * - Every theme block names the same tokens, and the two light blocks carry the same values.
 * - Text meets WCAG AA (4.5:1) on the surfaces it is used on; focus rings and strong borders meet 3:1.
 * - M-3216 (the user's phone contrast audit): on the dark page the secondary and tertiary greys reach APCA Lc 60 on the
 *   page, the sidebar and a card; the phone layout's two small sizes are 13px and 14px.
 * - The font is local (font-src 'self'), swaps, covers only Latin, and Chinese falls back to the system CJK fonts in order.
 * - Both files are served to anyone (static, no data) and listed on the public link; the licence ships beside the font.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { panelContentSecurityPolicy } from "../src/web-host-guard.js";

const SHARED = join(process.cwd(), "src", "ui", "shared");
const CSS = readFileSync(join(SHARED, "tokens.css"), "utf8");

function block(selector: RegExp): Record<string, string> {
  const m = CSS.match(new RegExp(`${selector.source}\\s*\\{([^{}]*)\\}`));
  if (!m) throw new Error(`no block ${selector}`);
  return Object.fromEntries([...m[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(x => [x[1]!, x[2]!.trim()]));
}
const DARK = block(/\n:root/);
const LIGHT_MEDIA = block(/:root:not\(\[data-theme="dark"\]\)/);
const LIGHT = block(/:root\[data-theme="light"\]/);
const COLOURS = Object.keys(LIGHT);

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const c = [0, 2, 4].map(i => parseInt(m[1]!.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** APCA Lc (APCA-W3 0.0.98G-4g, the WCAG 3 draft's contrast): signed, |Lc| 60 is the floor for readable small content text. */
function apca(text: string, bg: string): number {
  const y = (hex: string) => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); const v = 0.2126729 * c[0]! ** 2.4 + 0.7151522 * c[1]! ** 2.4 + 0.072175 * c[2]! ** 2.4; return v < 0.022 ? v + (0.022 - v) ** 1.414 : v; };
  const t = y(text), b = y(bg);
  if (Math.abs(b - t) < 0.0005) return 0;
  if (b > t) { const s = (b ** 0.56 - t ** 0.57) * 1.14; return s < 0.1 ? 0 : (s - 0.027) * 100; }
  const s = (b ** 0.65 - t ** 0.62) * 1.14; return s > -0.1 ? 0 : (s + 0.027) * 100;
}

describe("the theme blocks", () => {
  it("dark and both light blocks name the same colour tokens; the two light blocks are identical", () => {
    expect(COLOURS.length).toBeGreaterThan(25);
    expect(Object.keys(LIGHT_MEDIA).sort()).toEqual([...COLOURS].sort());
    expect(LIGHT_MEDIA).toEqual(LIGHT);
    for (const k of COLOURS) expect(DARK[k], k).toBeDefined();
    expect(DARK["color-scheme"]).toBeUndefined();   // a property, not a token
    expect(CSS).toMatch(/\n:root \{[^}]*color-scheme: dark;/);
    expect(CSS).toMatch(/:root\[data-theme="light"\] \{\s*color-scheme: light;/);
  });

  it("the scales every panel uses: type, space, radii, motion, layout", () => {
    for (const k of ["fs-xs", "fs-sm", "fs-md", "fs-lg", "fs-xl", "lh-md", "s-1", "s-4", "s-8", "r-sm", "r-md", "r-lg", "r-full", "t-fast", "t-med", "col", "sidebar-w", "tap", "font-ui", "font-mono"]) {
      expect(DARK[k], k).toBeDefined();
    }
    expect(DARK.col).toBe("768px");
    expect(DARK.tap).toBe("44px");
    // Reduced motion: the durations go to zero for everything that uses them.
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*:root \{ --t-fast: 0ms; --t-med: 0ms; \}/);
  });
});

describe("contrast (WCAG AA)", () => {
  const TEXT_ON: Array<[string, string]> = [
    ...["text", "text-2", "text-3", "accent", "ok", "warn", "danger"].flatMap(t => ["bg", "bg-sidebar", "surface"].map(b => [t, b] as [string, string])),
    ["text", "surface-2"], ["text-2", "surface-2"], ["text-3", "surface-2"], ["text", "user-bubble"],
    ["on-accent", "accent-fill"], ["on-danger", "danger-fill"],
    ...["text", "tk-k", "tk-s", "tk-n", "tk-c"].map(t => [t, "code-bg"] as [string, string]),
    ["text", "code-head"], ["text-2", "code-head"], ["text", "inline-code"],
  ];
  const UI_ON: Array<[string, string]> = ["focus", "border-strong"].flatMap(t => ["bg", "bg-sidebar", "surface"].map(b => [t, b] as [string, string]));

  it("APCA itself: known values (APCA-W3 0.0.98G-4g reference)", () => {
    expect(apca("#000000", "#ffffff")).toBeCloseTo(106.04, 1);
    expect(apca("#ffffff", "#000000")).toBeCloseTo(-107.88, 1);
    expect(apca("#888888", "#ffffff")).toBeCloseTo(63.06, 1);
    expect(apca("#a3a3a3", "#3a3a3a")).toBeCloseTo(-44.56, 1);   // the old dark --text-3 on --surface-2: the audit's dim grey
  });
  // M-3216: WCAG passed the old dark greys (#b4b4b4 / #a3a3a3, Lc 45–57) while the user found 12–13px grey text tiring on a
  // phone; the dark page is where WCAG 2 overrates light-on-dark small text.
  it("dark: the secondary and tertiary greys reach APCA Lc 60 on the page, the sidebar and a card", () => {
    for (const t of ["text-2", "text-3"]) for (const b of ["bg", "bg-sidebar", "surface"]) expect(Math.abs(apca(DARK[t]!, DARK[b]!)), `${t} on ${b}`).toBeGreaterThanOrEqual(60);
  });
  it("both themes: --text-2 is stronger than --text-3 on every background (the hierarchy stays)", () => {
    for (const theme of [DARK, LIGHT]) for (const b of ["bg", "bg-sidebar", "surface", "surface-2"]) expect(contrast(theme["text-2"]!, theme[b]!), b).toBeGreaterThan(contrast(theme["text-3"]!, theme[b]!));
  });
  it("the phone layout: the two small sizes are 13px and 14px, the desk keeps 12px and 13px", () => {
    expect(DARK["fs-xs-base"]).toBe("12px"); expect(DARK["fs-sm-base"]).toBe("13px");
    expect(DARK["lh-xs-base"]).toBe("16px"); expect(DARK["lh-sm-base"]).toBe("18px");
    expect(DARK["fs-xs"]).toBe("var(--fs-xs-base)"); expect(DARK["fs-sm"]).toBe("var(--fs-sm-base)");
    expect(DARK["lh-xs"]).toBe("var(--lh-xs-base)"); expect(DARK["lh-sm"]).toBe("var(--lh-sm-base)");
    const m = /@media \(max-width: 899px\), \(pointer: coarse\) and \(max-height: 500px\) and \(max-width: 1023px\) \{\s*:root \{([^}]*)\}\s*\}/.exec(CSS);
    expect(m, "the phone :root block").toBeTruthy();
    const phone = Object.fromEntries([...m![1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(x => [x[1]!, x[2]!.trim()]));
    expect(phone).toEqual({ "fs-3xs-base": "11px", "fs-2xs-base": "12px", "fs-xs-base": "13px", "lh-xs-base": "18px", "fs-sm-base": "14px", "lh-sm-base": "20px" });
    // M-3226: the two smallest steps, on the same base system.
    expect([DARK["fs-3xs-base"], DARK["fs-2xs-base"], DARK["fs-3xs"], DARK["fs-2xs"]]).toEqual(["10px", "11px", "var(--fs-3xs-base)", "var(--fs-2xs-base)"]);
  });
  // M-3226: the small type is all tokens, so the phone step, 文字大小 and a later style refresh reach every place. A hard rule
  // on top of tests/ui-css-literals-ratchet.test.ts (whose list no longer holds any of these): no font size under 14px is
  // written as a number in a shared stylesheet, as a font-size or in a font shorthand.
  it("no shared stylesheet writes a font size under 14px as a literal", () => {
    const small = /font(?:-size)?\s*:[^;{}]*?(?<![\w.-])(\d+(?:\.\d+)?)px/g;
    for (const f of readdirSync(SHARED).filter((n: string) => n.endsWith(".css") && n !== "tokens.css")) {
      const css = readFileSync(join(SHARED, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const found = [...css.matchAll(small)].filter(m => Number(m[1]) < 14).map(m => m[0].slice(0, 60));
      expect(found, f).toEqual([]);
    }
  });
  // Fable #4035: the text-size scopes (the chat, Details, Fleet, Log, the drawer's agents) redefine the small sizes; built on
  // fixed 12/13px they kept most phone text where it was. Every redefinition outside tokens.css must scale the base.
  it("every other stylesheet that redefines --fs-xs / --fs-sm builds it on the base, never a fixed size", () => {
    let seen = 0;
    for (const f of readdirSync(SHARED).filter((n: string) => n.endsWith(".css") && n !== "tokens.css")) {
      const css = readFileSync(join(SHARED, f), "utf8");
      for (const d of css.matchAll(/--(fs|lh)-(3xs|2xs|xs|sm):\s*([^;]+);/g)) {
        seen++;
        expect(d[3], `${f}: --${d[1]}-${d[2]}`).toContain(`var(--${d[1]}-${d[2]}-base)`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(12);   // app.css: the text-size scope and the drawer's, 6 each
  });

  for (const [name, theme] of [["dark", DARK], ["light", LIGHT]] as const) {
    it(`${name}: every text pair is 4.5:1 or better`, () => {
      for (const [t, b] of TEXT_ON) expect(contrast(theme[t]!, theme[b]!), `${t} on ${b}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: focus rings and strong borders are 3:1 or better`, () => {
      for (const [t, b] of UI_ON) expect(contrast(theme[t]!, theme[b]!), `${t} on ${b}`).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("Inter, bundled", () => {
  const face = CSS.match(/@font-face \{([^}]*)\}/)![1]!;

  it("is loaded from this origin only, swaps instead of hiding text, and covers Latin only", () => {
    expect(face).toContain('font-family: "Inter";');
    expect(face).toContain("font-weight: 100 900;");
    expect(face).toContain("font-display: swap;");
    expect(face).toContain('src: url("/assets/inter.woff2") format("woff2");');
    expect(face).toMatch(/unicode-range: U\+0000-00FF,/);
    expect(face).not.toMatch(/U\+(4E00|3000|AC00)/);   // no CJK range: Chinese is the system's font
    // Nothing anywhere in the file comes from another site.
    const urls = [...CSS.matchAll(/url\(([^)]*)\)/g)].map(m => m[1]!);
    expect(urls.filter(url => !/^"data:image\/svg\+xml,[^"]+"$/.test(url))).toEqual(['"/assets/inter.woff2"']);
    expect([...face.matchAll(/url\(([^)]*)\)/g)].map(m => m[1])).toEqual(['"/assets/inter.woff2"']);
  });

  it("names the CJK fallbacks in the agreed order, before the generic system stack", () => {
    const stack = DARK["font-ui"]!.split(",").map(s => s.trim().replace(/"/g, ""));
    expect(stack[0]).toBe("AgEnD Emoji");   // M-3796: emoji only (tests/web-emoji-fonts.test.ts)
    expect(stack.slice(1, 10)).toEqual([
      "Inter",
      "PingFang TC", "PingFang SC",
      "Noto Sans TC", "Noto Sans SC", "Noto Sans CJK TC", "Noto Sans CJK SC",
      "Microsoft JhengHei", "Microsoft YaHei",
    ]);
    expect(stack.indexOf("system-ui")).toBeGreaterThan(9);
    // …then the generic sans-serif, and last the colour emoji fonts (the user's tofu boxes: tests/web-emoji-fonts.test.ts).
    expect(stack.slice(-2)).toEqual(["sans-serif", "var(--font-emoji)"]);
  });

  it("the font file is a WOFF2 subset, and the OFL ships beside it", () => {
    const font = readFileSync(join(SHARED, "fonts", "inter.woff2"));
    expect(font.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(statSync(join(SHARED, "fonts", "inter.woff2")).size).toBeLessThan(64 * 1024);
    const ofl = readFileSync(join(SHARED, "fonts", "OFL.txt"), "utf8");
    expect(ofl).toContain("The Inter Project Authors");
    expect(ofl).toContain("SIL Open Font License, Version 1.1");
    expect(readFileSync(join(SHARED, "fonts", "README.md"), "utf8")).toContain("9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e");
  });

  it("the panel CSP already allows it and nothing else: fonts from 'self' only", () => {
    expect(panelContentSecurityPolicy("n")).toContain("font-src 'self' data:");
    expect(panelContentSecurityPolicy("n")).not.toMatch(/font-src[^;]*(https?:|\*)/);
  });
});

// ── served ──

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function get(port: number, path: string): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    r.end();
  });
}

describe("served from /assets", () => {
  it("to anyone, with the right types: they are static and carry no data (no session, no fleet)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-tokens-"));
    tempDirs.push(dir);
    const fm = new FleetManager(dir);
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
    vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
    (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
    (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
    await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
    const server = (fm as unknown as { healthServer: Server }).healthServer;
    const port = (server.address() as { port: number }).port;
    try {
      const css = await get(port, "/assets/tokens.css");
      expect(css.status).toBe(200);
      expect(css.type).toContain("text/css");
      expect(css.body.toString("utf8")).toBe(CSS);
      const font = await get(port, "/assets/inter.woff2");
      expect(font.status).toBe(200);
      expect(font.type).toBe("font/woff2");
      expect(font.body.equals(readFileSync(join(SHARED, "fonts", "inter.woff2")))).toBe(true);
      // Only the names in the map: not the licence's folder, not a path into it.
      for (const p of ["/assets/fonts/inter.woff2", "/assets/OFL.txt", "/assets/tokens.css.map", "/assets/inter.woff"]) expect((await get(port, p)).status, p).toBe(404);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      (fm as unknown as { healthServer: Server | null }).healthServer = null;
    }
  }, 30_000);

  it("the public link lists exactly these two names", () => {
    expect(isPublicWebRoute("GET", "/assets/tokens.css")).toBe(true);
    expect(isPublicWebRoute("GET", "/assets/inter.woff2")).toBe(true);
    for (const [m, p] of [["POST", "/assets/tokens.css"], ["GET", "/assets/fonts/inter.woff2"], ["GET", "/assets/OFL.txt"], ["GET", "/assets/inter.woff"]] as const) {
      expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
    }
  });
});
