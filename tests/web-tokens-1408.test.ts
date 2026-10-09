/**
 * #1408 §2: the design tokens every panel shares, and the bundled Inter.
 * - Every theme block names the same tokens, and the two light blocks carry the same values.
 * - Text meets WCAG AA (4.5:1) on the surfaces it is used on; focus rings and strong borders meet 3:1.
 * - The font is local (font-src 'self'), swaps, covers only Latin, and Chinese falls back to the system CJK fonts in order.
 * - Both files are served to anyone (static, no data) and listed on the public link; the licence ships beside the font.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
    ["text", "surface-2"], ["text-2", "surface-2"], ["text", "user-bubble"],
    ["on-accent", "accent-fill"], ["on-danger", "danger-fill"],
    ...["text", "tk-k", "tk-s", "tk-n", "tk-c"].map(t => [t, "code-bg"] as [string, string]),
    ["text", "code-head"], ["text-2", "code-head"], ["text", "inline-code"],
  ];
  const UI_ON: Array<[string, string]> = ["focus", "border-strong"].flatMap(t => ["bg", "bg-sidebar", "surface"].map(b => [t, b] as [string, string]));

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
    expect([...CSS.matchAll(/url\(([^)]*)\)/g)].map(m => m[1])).toEqual(['"/assets/inter.woff2"']);
  });

  it("names the CJK fallbacks in the agreed order, before the generic system stack", () => {
    const stack = DARK["font-ui"]!.split(",").map(s => s.trim().replace(/"/g, ""));
    expect(stack.slice(0, 4)).toEqual(["Inter", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei"]);
    expect(stack.indexOf("system-ui")).toBeGreaterThan(3);
    expect(stack.at(-1)).toBe("sans-serif");
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
