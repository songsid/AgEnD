/**
 * #1307 (segment 1): the chat-first layout. Light and dark from semantic tokens (system by default, a per-browser
 * override applied before paint), no inline style attribute anywhere on the app (#1300), and the pure pieces
 * the conversation leans on: "at the bottom" and a code block's line count. The DOM behaviour (keyed messages,
 * stick-to-bottom, Send → Stop) runs against the app's modules in the harness and in a real browser.
 * #1408 step 1: the dashboard is the app shell (app.html + shared/tokens.css + shared/app.css + the modules), so
 * the markup and style checks below read those files.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const UI = join(process.cwd(), "src", "ui");
const SHARED = join(UI, "shared");
const APP = readFileSync(join(UI, "app.html"), "utf8");
const TOKENS = readFileSync(join(SHARED, "tokens.css"), "utf8");
const APP_CSS = readFileSync(join(SHARED, "app.css"), "utf8");
const PANEL_CHAT = readFileSync(join(UI, "panel-chat.js"), "utf8");
const APP_SHELL = readFileSync(join(SHARED, "app-shell.js"), "utf8");
const THEME = readFileSync(join(UI, "shared", "theme.js"), "utf8");
type Render = {
  isNearBottom(t: number, c: number, h: number, slack?: number): boolean; lineCount(s: unknown): number; CODE_FOLD_LINES: number;
  isLongPaste(s: unknown): boolean; LONG_PASTE_CHARS: number; formatElapsed(ms: unknown): string;
};
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

describe("the app's tokens and markup", () => {
  // The colour blocks of tokens.css, by their selector: "name: value" pairs, nothing else.
  const block = (selector: string) => {
    const at = TOKENS.indexOf(selector);
    const open = TOKENS.indexOf("{", at), close = TOKENS.indexOf("}", open);
    return Object.fromEntries([...TOKENS.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2]!.trim()]));
  };
  const isColour = (v: string) => /^(#|rgba?\()/.test(v);
  const dark = block(":root {"), systemLight = block(':root:not([data-theme="dark"]) {'), forcedLight = block(':root[data-theme="light"] {');

  it("light is defined twice — for the device and for a forced choice — and the two are identical", () => {
    expect(Object.keys(systemLight).length).toBeGreaterThan(30);
    expect(forcedLight).toEqual(systemLight);
    expect(TOKENS).toContain("@media (prefers-color-scheme: light)");
  });

  it("every colour token dark defines, light redefines (nothing stays dark in light mode)", () => {
    const colours = Object.keys(dark).filter(k => isColour(dark[k]!));
    expect(colours.length).toBeGreaterThan(20);
    expect(colours.filter(k => !(k in systemLight))).toEqual([]);
  });

  it("the type is Inter, bundled from this origin, with the system fonts behind it — no web font from anywhere else", () => {
    expect(dark["--font-ui"]).toMatch(/^Inter, /);
    expect(dark["--font-ui"]).toContain("system-ui, -apple-system");
    expect(dark["--font-mono"]).toMatch(/^ui-monospace/);
    expect(TOKENS).toContain('src: url("/assets/inter.woff2")');
    for (const css of [TOKENS, APP_CSS, APP]) expect(css).not.toMatch(/DM Sans|Outfit|IBM Plex|fonts\.googleapis|fonts\.gstatic/);
  });

  it("theme.js loads in <head> before the stylesheets and before anything paints", () => {
    const head = APP.slice(0, APP.indexOf("</head>"));
    expect(head.indexOf('<script src="/assets/theme.js"></script>')).toBeGreaterThan(-1);
    expect(head.indexOf("/assets/theme.js")).toBeLessThan(head.indexOf("/assets/tokens.css"));
    expect(head.indexOf("/assets/theme.js")).toBeLessThan(head.indexOf("/assets/app.css"));
    expect(head).not.toMatch(/theme\.js"[^>]*\b(defer|async)\b/);
  });

  it("no style attribute anywhere on the app, in its markup or in what its modules write (#1300)", () => {
    expect(APP.match(/\sstyle\s*=/g) ?? []).toEqual([]);
    expect(APP_CSS.match(/\sstyle\s*=/g) ?? []).toEqual([]);
    for (const file of ["app-shell.js", "app.js", "app-nav.js", "app-session.js"]) {
      expect(readFileSync(join(SHARED, file), "utf8").match(/\sstyle\s*=|[{,]\s*style\s*:/g) ?? [], file).toEqual([]);
    }
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

describe("chat-render: the turn's elapsed time and a long paste (segment 2)", () => {
  it("elapsed is m:ss, h:mm:ss past an hour, never negative", () => {
    const r = render();
    expect([0, 999, 1000, 59_999, 60_000, 754_000, 3_599_999, 3_600_000, 3_723_000].map(r.formatElapsed))
      .toEqual(["0:00", "0:00", "0:01", "0:59", "1:00", "12:34", "59:59", "1:00:00", "1:02:03"]);
    expect([-5000, NaN, undefined, "x"].map(r.formatElapsed)).toEqual(["0:00", "0:00", "0:00", "0:00"]);
  });

  it("a paste over 4,000 characters is long; 4,000 is not (#1269)", () => {
    const r = render();
    expect(r.LONG_PASTE_CHARS).toBe(4_000);
    expect([r.isLongPaste("a".repeat(4_000)), r.isLongPaste("a".repeat(4_001)), r.isLongPaste(""), r.isLongPaste(null)]).toEqual([false, true, false, false]);
  });
});

describe("phones and assistive tech (segment 3)", () => {
  const narrow = APP_CSS.slice(APP_CSS.indexOf("@media (max-width: 899px)"));

  it("the keyboard resizes the page instead of covering the composer; content may reach the notch, and is padded clear of it", () => {
    expect(APP).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">');
    expect(APP_CSS).toMatch(/height: 100vh; height: 100dvh;/);
    for (const inset of ["top", "bottom", "left", "right"]) expect(APP_CSS, inset).toContain(`env(safe-area-inset-${inset})`);
  });

  // #1317 review: the cascade, not the presence of env(): every padding rule the panel's header ends up with keeps the
  // notch insets — no later shorthand resets them to plain pixels. The header is .panel-head (app.css) now.
  it("at phone width the panel header's padding still honours the top and side insets (the last rule that sets it wins)", () => {
    const rules = [...APP_CSS.matchAll(/\.panel-head \{([^}]*)\}/g)].map(m => m[1]!);
    expect(rules.length).toBeGreaterThan(0);
    const last = rules.filter(r => /padding/.test(r)).at(-1)!;
    // Split the shorthand on spaces outside parentheses: max(6px, env(…)) is one value.
    const value = /padding:\s*([^;]+);/.exec(last)![1]!;
    const shorthand: string[] = [];
    let depth = 0, part = "";
    for (const ch of value) {
      if (ch === "(") depth++; else if (ch === ")") depth--;
      if (ch === " " && depth === 0) { if (part) shorthand.push(part); part = ""; } else part += ch;
    }
    if (part) shorthand.push(part);
    expect(shorthand, "top right bottom left").toHaveLength(4);
    expect(shorthand[0]).toContain("env(safe-area-inset-top)");
    expect(shorthand[1]).toContain("env(safe-area-inset-right)");
    expect(shorthand[3]).toContain("env(safe-area-inset-left)");
    expect(narrow).toMatch(/\.toasts \{ top: calc\(60px \+ env\(safe-area-inset-top\)\)/);
  });

  it("on a phone the composer's text is 16px (smaller, and iOS zooms the page on focus)", () => {
    expect(narrow).toMatch(/\.composer textarea \{ font-size: 16px; \}/);
  });

  it("the conversation is a log that is not read out message by message; one polite status line carries the coarse events", () => {
    expect(PANEL_CHAT).toMatch(/class="thread" ref=\$\{list\} role="log" aria-live="off" aria-label=/);
    // The announcer is the one polite status line; the panel creates it once, with the same three attributes.
    expect(PANEL_CHAT).toMatch(/el\.id = "announcer"; el\.className = "sr-only"; el\.setAttribute\("role", "status"\); el\.setAttribute\("aria-live", "polite"\); el\.setAttribute\("aria-atomic", "true"\)/);
    const workBar = PANEL_CHAT.split("\n").find(l => l.includes('class=${`work-bar'))!;
    expect(workBar, "the working line is no longer a live region of its own").toBeDefined();
    expect(workBar).not.toMatch(/aria-live|role=/);
  });

  it("the sidebar's rows are real links, so the keyboard reaches and chooses them (no role=button on a div)", () => {
    // alpha.2 (N1): the rows are instance-nav.js's, on every page; a row links to the view the page is in.
    const NAV = readFileSync(join(process.cwd(), "src", "ui", "shared", "instance-nav.js"), "utf8");
    expect(NAV).toMatch(/<li key=\$\{name\}><a class=\$\{`inst v-inst\$\{on \? " active" : ""\}`\} href=\$\{toView \? viewPath\(name\) : chatPath\(name\)\}/);
    for (const src of [APP_SHELL, NAV]) expect(src).not.toMatch(/role="button"|data-act=/);
  });
});

