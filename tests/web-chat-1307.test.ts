/**
 * #1307 (segment 1): the chat-first layout. Light and dark from semantic tokens (system by default, a per-browser
 * override applied before paint), no inline style attribute anywhere on the dashboard (#1300), and the pure pieces
 * the conversation leans on: "at the bottom" and a code block's line count. The DOM behaviour (keyed messages,
 * stick-to-bottom, Send → Stop) runs against the real page script in web-chat-c3.test.ts and in a real browser.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const UI = join(process.cwd(), "src", "ui");
const DASHBOARD = readFileSync(join(UI, "dashboard.html"), "utf8");
const THEME = readFileSync(join(UI, "shared", "theme.js"), "utf8");
type Render = { isNearBottom(t: number, c: number, h: number, slack?: number): boolean; lineCount(s: unknown): number; CODE_FOLD_LINES: number };
const render = (): Render => { const c = vm.createContext({}); vm.runInContext(readFileSync(join(UI, "chat-render.js"), "utf8"), c); return (c as { AgendChatRender: Render }).AgendChatRender; };

describe("theme.js: system by default, this browser's choice when it made one", () => {
  function boot(stored: string | null | Error) {
    const attrs: Record<string, string> = {};
    const store: Record<string, string> = typeof stored === "string" ? { agend_theme: stored } : {};
    const storage = stored instanceof Error
      ? { getItem() { throw stored; }, setItem() { throw stored; }, removeItem() { throw stored; } }
      : { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } };
    const window: Record<string, any> = {};
    const c = vm.createContext({
      window, localStorage: storage,
      document: { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; }, removeAttribute: (k: string) => { delete attrs[k]; } } },
    });
    vm.runInContext(THEME, c);
    return { attrs, store, theme: window.AgendTheme as { get(): string; set(v: string): void } };
  }

  it.each([["light", "light"], ["dark", "dark"]])("a stored %s is applied at once (before paint)", (stored, want) => {
    const b = boot(stored);
    expect(b.attrs["data-theme"]).toBe(want);
    expect(b.theme.get()).toBe(want);
  });

  it.each([null, "system", "neon", "<script>"])("nothing usable stored (%s): no data-theme, the device decides", (stored) => {
    const b = boot(stored);
    expect(b.attrs).toEqual({});
    expect(b.theme.get()).toBe("system");
  });

  it("set() stores and applies; System removes both, so the device decides again", () => {
    const b = boot(null);
    b.theme.set("dark");
    expect([b.attrs["data-theme"], b.store.agend_theme]).toEqual(["dark", "dark"]);
    b.theme.set("system");
    expect([b.attrs["data-theme"], b.store.agend_theme]).toEqual([undefined, undefined]);
    b.theme.set("bogus");
    expect(b.attrs["data-theme"], "anything else is System").toBeUndefined();
  });

  it("storage blocked: the page still loads on System, and a choice applies to this page", () => {
    const b = boot(new Error("SecurityError"));
    expect(b.theme.get()).toBe("system");
    b.theme.set("light");
    expect(b.attrs["data-theme"]).toBe("light");
  });
});

describe("the dashboard's tokens and markup", () => {
  const style = DASHBOARD.slice(DASHBOARD.indexOf("<style>"), DASHBOARD.indexOf("</style>"));
  const block = (selector: string) => {
    const at = style.indexOf(selector);
    const open = style.indexOf("{", at), close = style.indexOf("}", open);
    return Object.fromEntries([...style.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2]!.trim()]));
  };
  const dark = block(":root {"), systemLight = block(':root:not([data-theme="dark"]) {'), forcedLight = block(':root[data-theme="light"] {');

  it("light is defined twice — for the device and for a forced choice — and the two are identical", () => {
    expect(Object.keys(systemLight).length).toBeGreaterThan(30);
    expect(forcedLight).toEqual(systemLight);
    expect(style).toContain("@media (prefers-color-scheme: light)");
  });

  it("every colour token dark defines, light redefines (nothing stays dark in light mode)", () => {
    const colours = Object.keys(dark).filter(k => !["--font-ui", "--font-mono", "--col"].includes(k));
    expect(colours.filter(k => !(k in systemLight))).toEqual([]);
  });

  it("the system font stack, no web font", () => {
    expect(dark["--font-ui"]).toMatch(/^system-ui, -apple-system/);
    expect(dark["--font-mono"]).toMatch(/^ui-monospace/);
    expect(DASHBOARD).not.toMatch(/DM Sans|Outfit|IBM Plex|fonts\.googleapis/);
  });

  it("theme.js loads in <head> before the stylesheet and before anything paints", () => {
    const head = DASHBOARD.slice(0, DASHBOARD.indexOf("</head>"));
    expect(head.indexOf('<script src="/assets/theme.js"></script>')).toBeGreaterThan(-1);
    expect(head.indexOf("/assets/theme.js")).toBeLessThan(head.indexOf("/assets/shell.css"));
    expect(head).not.toMatch(/theme\.js"[^>]*\b(defer|async)\b/);
  });

  it("no style attribute anywhere on the page, in its markup or in what its script writes (#1300)", () => {
    expect(DASHBOARD.match(/\sstyle\s*=/g) ?? []).toEqual([]);
  });
});

describe("chat-render: at the bottom, and how long a code block is", () => {
  it("at the bottom means within 48px of it, by default", () => {
    const r = render();
    expect(r.isNearBottom(452, 500, 1000)).toBe(true);    // 48 px left
    expect(r.isNearBottom(451, 500, 1000)).toBe(false);   // 49
    expect(r.isNearBottom(500, 500, 1000)).toBe(true);
    expect(r.isNearBottom(0, 500, 400), "nothing to scroll").toBe(true);
    expect(r.isNearBottom(490, 500, 1000, 0)).toBe(false);
    expect(r.isNearBottom(500, 500, 1000, 0)).toBe(true);
  });

  it("counts lines; a trailing newline does not start another; nothing is none", () => {
    const r = render();
    expect([r.lineCount("a"), r.lineCount("a\nb"), r.lineCount("a\nb\n"), r.lineCount(""), r.lineCount(null), r.lineCount("\n")]).toEqual([1, 2, 2, 0, 0, 0]);
    expect(r.CODE_FOLD_LINES).toBe(30);
  });
});
