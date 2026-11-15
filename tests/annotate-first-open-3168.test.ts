/**
 * M-3168: the first 「標註」 used to paint the bare editor (the picture at the far left) until its stylesheet arrived, then
 * jump into place. annotateCssReady links the stylesheet once and settles when it has arrived (load, error, or a bounded
 * wait); the viewer shows the editor only then. Nothing is linked before the first 「標註」.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const src = readFileSync(join(ROOT, "src/ui/shared/image-annotate.js"), "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/^register\(/m, "(() => 0)(");
const mod = await import(`data:text/javascript;base64,${Buffer.from(`const html = () => null, t = (k) => k, Icon = null, useEffect = () => {}, useRef = () => ({}), useState = (v) => [v, () => {}];\n${src}`).toString("base64")}`);

/** A document with a head that keeps what is appended; links fire their own load/error listeners. */
function fakeDoc() {
  const els: any[] = [];
  const mkLink = () => {
    const attrs: Record<string, string> = {}, on: Record<string, Set<() => void>> = { load: new Set(), error: new Set() };
    return { attrs, sheet: null as unknown, setAttribute(k: string, v: string) { attrs[k] = v; }, getAttribute(k: string) { return attrs[k] ?? null; },
      addEventListener(k: string, f: () => void) { on[k]!.add(f); }, removeEventListener(k: string, f: () => void) { on[k]!.delete(f); },
      fire(k: string) { if (k === "load") this.sheet = {}; for (const f of [...on[k]!]) (f as (e: unknown) => void)({ type: k }); }, listeners: () => on.load.size + on.error.size };
  };
  return { els, head: { appendChild(el: any) { els.push(el); } }, createElement: () => mkLink(),
    querySelector: (sel: string) => sel === 'link[data-annotate-css="1"]' ? els.find((e) => e.attrs["data-annotate-css"] === "1") ?? null : null };
}
const settled = async (p: Promise<unknown>) => { let done = false; void p.then(() => { done = true; }); for (let i = 0; i < 5; i++) await Promise.resolve(); return done; };

describe("annotateCssReady (M-3168)", () => {
  it("links the stylesheet once and settles only when it has loaded", async () => {
    const doc = fakeDoc();
    const p = mod.annotateCssReady(doc, 60_000);
    expect(doc.els).toHaveLength(1);
    expect(doc.els[0].attrs).toMatchObject({ rel: "stylesheet", href: "/assets/image-annotate.css", "data-annotate-css": "1" });
    expect(await settled(p)).toBe(false);                       // still arriving: the editor stays shut
    const again = mod.annotateCssReady(doc, 60_000);            // a second press while it arrives: no second link
    expect(doc.els).toHaveLength(1);
    doc.els[0].fire("load");
    expect(await settled(p)).toBe(true);
    expect(await settled(again)).toBe(true);
    expect(doc.els[0].listeners()).toBe(0);                     // nothing left listening
  });
  it("an already loaded stylesheet answers at once (a second open)", async () => {
    const doc = fakeDoc();
    void mod.annotateCssReady(doc, 60_000); doc.els[0].fire("load");
    expect(await settled(mod.annotateCssReady(doc, 60_000))).toBe(true);
    expect(doc.els).toHaveLength(1);
  });
  it("a failed or slow stylesheet never keeps the editor shut", async () => {
    const failed = fakeDoc(), p = mod.annotateCssReady(failed, 60_000);
    failed.els[0].fire("error");
    expect(await settled(p)).toBe(true);
    // Fable #3977: once failed, a later open does not wait again (the old link fires no new event).
    expect(await settled(mod.annotateCssReady(failed, 60_000))).toBe(true);
    expect(failed.els).toHaveLength(1);
    vi.useFakeTimers();
    try {
      const slow = fakeDoc(), q = mod.annotateCssReady(slow, 4000);
      vi.advanceTimersByTime(3999); expect(await settled(q)).toBe(false);
      vi.advanceTimersByTime(1); expect(await settled(q)).toBe(true);
      expect(slow.els[0].listeners()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("no document: nothing to wait for", async () => {
    expect(await settled(mod.annotateCssReady(null))).toBe(true);
  });
});

describe("the viewer waits for it before showing the editor", () => {
  const lightbox = readFileSync(join(ROOT, "src/ui/shared/image-lightbox.js"), "utf8");
  it("setEditor runs after annotateCssReady settles; an older module without it still opens", () => {
    expect(lightbox).toMatch(/Promise\.resolve\(typeof m\.annotateCssReady === "function" \? m\.annotateCssReady\(\) : null\)\.then\(\(\) => setEditor\(\(\) => m\.AnnotateEditor\)\)/);
    expect(lightbox.match(/setEditor\(\(\) => m\.AnnotateEditor\)/g)).toHaveLength(1);   // no earlier, unstyled show
  });
  it("still nothing of the editor on a page load: the module is imported on the first 「標註」 only", () => {
    expect(lightbox).toContain('const loadAnnotate = () => import("./image-annotate.js");');
    expect(lightbox).not.toMatch(/^import .*image-annotate/m);
    expect(lightbox).not.toMatch(/image-annotate\.css/);
  });
});
