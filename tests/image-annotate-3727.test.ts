/**
 * #3727 (M-2973): the image viewer's annotation editor — the parts that are logic, without a browser:
 * - the history: undo / redo / clear in any order (a clear is undoable; a new mark drops what redo held);
 * - the canvas size (the original's, scaled down to MAX_SIDE), the stroke width, the new file's name;
 * - each tool's drawing calls (pen, box, arrow with its head, text with an outline), on a recording context;
 * - the viewer offers 「標註」 only when its chat passed quote targets (a Hub room or another viewer never does), and the
 *   editor module is loaded only on the press.
 * The browser leg (draw with a mouse and a finger, quote, send, the original's bytes, split chat, SKEW) is
 * scripts/manual/smoke/smoke-chat-annotate-3727.mts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
// The module imports the dashboard's own /assets/* (served by the web server); stub them so its pure exports load here.
const src = readFileSync(join(ROOT, "src/ui/image-annotate.js"), "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/^register\(/m, "(() => 0)(");
const mod = await import(`data:text/javascript;base64,${Buffer.from(`const html = () => null, t = (k) => k, Icon = null, useEffect = () => {}, useRef = () => ({}), useState = (v) => [v, () => {}];\n${src}`).toString("base64")}`);

describe("history: undo, redo, clear", () => {
  it("undo takes back the last mark and redo puts it back; a new mark drops what redo held", () => {
    const h = mod.history();
    h.add({ tool: "pen", n: 1 }); h.add({ tool: "box", n: 2 });
    expect(h.undo()).toBe(true);
    expect(h.visible().map((s: any) => s.n)).toEqual([1]);
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe(true);
    expect(h.visible().map((s: any) => s.n)).toEqual([1, 2]);
    h.undo(); h.add({ tool: "arrow", n: 3 });
    expect([h.canRedo, h.redo()]).toEqual([false, false]);
    expect(h.visible().map((s: any) => s.n)).toEqual([1, 3]);
  });
  it("clear hides every mark and is itself undoable; clearing nothing adds nothing", () => {
    const h = mod.history();
    h.clear();
    expect(h.shapes).toEqual([]);
    h.add({ tool: "pen", n: 1 }); h.clear();
    expect(h.visible()).toEqual([]);
    h.add({ tool: "box", n: 2 });
    expect(h.visible().map((s: any) => s.n)).toEqual([2]);
    h.undo(); h.undo();                                                      // the box, then the clear
    expect(h.visible().map((s: any) => s.n)).toEqual([1]);
    expect(h.undo()).toBe(true); expect(h.undo()).toBe(false);
  });
});

describe("sizes and names", () => {
  it("the canvas is the original's size, scaled down to MAX_SIDE on its longest side", () => {
    expect(mod.canvasSize(1200, 800)).toEqual({ w: 1200, h: 800 });
    expect(mod.canvasSize(5120, 2880)).toEqual({ w: mod.MAX_SIDE, h: 1440 });
    expect(mod.canvasSize(1000, 8000)).toEqual({ w: 320, h: mod.MAX_SIDE });
    expect(mod.canvasSize(0, 0)).toEqual({ w: 1, h: 1 });
  });
  it("the stroke grows with the picture, never under 3 px", () => {
    expect(mod.strokeWidth(400, 300)).toBe(3);
    expect(mod.strokeWidth(2560, 1440)).toBe(8);
  });
  it("the new file keeps the original's name before its extension and is always a .png", () => {
    expect(mod.annotatedName("screenshot 2026-11-12.jpeg")).toBe("screenshot 2026-11-12-annotated.png");
    expect(mod.annotatedName("a/b:c.png")).toBe("a_b_c-annotated.png");
    expect(mod.annotatedName("")).toBe("image-annotated.png");
  });
});

describe("drawing each tool", () => {
  /** A 2D context that records every call and property set, in order. */
  const recorder = () => {
    const calls: string[] = [];
    const ctx: any = new Proxy({}, {
      get: (_t, k) => (...args: unknown[]) => { calls.push(`${String(k)}(${args.map(a => typeof a === "number" ? Math.round(a) : a).join(",")})`); },
      set: (_t, k, v) => { calls.push(`${String(k)}=${v}`); return true; },
    });
    return { ctx, calls };
  };
  it("pen: one path through its points, in its colour", () => {
    const { ctx, calls } = recorder();
    mod.drawShape(ctx, { tool: "pen", colour: "#e5484d", points: [[1, 2], [3, 4], [5, 6]] }, 4);
    expect(calls).toEqual(expect.arrayContaining(["strokeStyle=#e5484d", "lineWidth=4", "moveTo(1,2)", "lineTo(3,4)", "lineTo(5,6)", "stroke()"]));
  });
  it("box: a rectangle from either corner", () => {
    const { ctx, calls } = recorder();
    mod.drawShape(ctx, { tool: "box", colour: "#3e8eff", x0: 50, y0: 40, x1: 10, y1: 20 }, 3);
    expect(calls).toContain("strokeRect(10,20,40,20)");
  });
  it("arrow: its line, then a filled head at the end", () => {
    const { ctx, calls } = recorder();
    mod.drawShape(ctx, { tool: "arrow", colour: "#ffc53d", x0: 0, y0: 0, x1: 100, y1: 0 }, 4);
    expect(calls.filter(c => c.startsWith("moveTo") || c === "fill()" || c === "closePath()")).toEqual(["moveTo(0,0)", "moveTo(100,0)", "closePath()", "fill()"]);
    expect(calls).toContain("lineTo(100,0)");
  });
  it("text: outlined, then filled, at its point; an empty text draws nothing", () => {
    const { ctx, calls } = recorder();
    mod.drawShape(ctx, { tool: "text", colour: "#ffffff", x: 7, y: 9, text: "here" }, 4);
    expect(calls).toEqual(expect.arrayContaining(["strokeStyle=#000000", "strokeText(here,7,9)", "fillText(here,7,9)"]));
    const empty = recorder();
    mod.drawShape(empty.ctx, { tool: "text", colour: "#ffffff", x: 7, y: 9, text: "" }, 4);
    expect(empty.calls.some(c => c.startsWith("fillText"))).toBe(false);
  });
});

describe("the viewer offers 標註 only from a chat that can quote, and loads the editor on the press", () => {
  const lightbox = readFileSync(join(ROOT, "src/ui/image-lightbox.js"), "utf8");
  const chat = readFileSync(join(ROOT, "src/ui/panel-chat.js"), "utf8");
  it("the button is drawn only with quote targets; the store keeps none without them", () => {
    expect(lightbox).toMatch(/annotate: annotate && annotate\.targets\?\.length \? annotate : null/);
    expect(lightbox).toMatch(/\$\{annotate \? html`<button type="button" class="btn btn-sm lb-annotate"/);
  });
  it("the editor module is a dynamic import, checked by its marker; a failed load is a notice, not a throw", () => {
    expect(lightbox).toContain('const loadAnnotate = () => import("./image-annotate.js");');
    expect(lightbox).not.toMatch(/^import .*image-annotate/m);
    expect(lightbox).toMatch(/m\.annotateV1 === true/);
    expect(lightbox).toMatch(/\.catch\(\(\) => annotate\?\.notice\?\.\(t\("lbAnnotate\.failed"\)\)\)/);
  });
  it("only the fleet chat passes targets (its composer, and the other pane's in split chat)", () => {
    expect(chat).toContain("openImage: (links, img) => openLightbox(links, img, annotateFor(name, img))");
    const hub = readFileSync(join(ROOT, "src/ui/panel-hub.js"), "utf8");
    expect(hub).not.toContain("annotateFor");
  });
  it("the media tokens are theme-independent: one block after the themes, never redefined by a theme, same as the canvas", () => {
    const tokens = readFileSync(join(ROOT, "src/ui/shared/tokens.css"), "utf8");
    const at = tokens.indexOf("--media-ink:");
    expect(tokens.lastIndexOf(":root[data-theme=\"light\"] {")).toBeLessThan(at);           // after every theme block
    expect(tokens.match(/--media-ink:/g)).toHaveLength(1);                                      // defined once, never per theme
    for (const [k, v] of mod.COLOURS) expect(tokens).toContain(`--mark-${k}: ${v};`);           // swatch = what is drawn
    for (const [k, v] of mod.MEDIA_TOKENS) expect(tokens.replace(/\s+/g, " ")).toContain(`${k}: ${v}`);   // the editor's fallback = the token
  });
  it("no style attribute in the new module (#1300)", () => {
    const editor = readFileSync(join(ROOT, "src/ui/image-annotate.js"), "utf8");
    expect(editor).not.toMatch(/\sstyle=/);
  });
});
