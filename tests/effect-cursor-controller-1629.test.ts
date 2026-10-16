/** Modeled DOM/CSSOM/decoder ownership. Native recipe separately proves real cursor inheritance. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { isServedAsset } from "../src/auth-api.js";
const { createEffectCursor } = await import(new URL("../src/ui/shared/effect-cursor.js", import.meta.url).href);
const { effectHostStyle } = await import(new URL("../src/ui/shared/effect-host-style.js", import.meta.url).href);
const ID = "a".repeat(32), OTHER = "b".repeat(32), PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64"));
const chosen = (id = ID, generation = 1, hotspot = [0, 0]) => ({ id, generation, hotspot });
const held = () => { let resolve = (_x?: any) => {}; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
const pages: AppPage[] = [], cleanups: (() => void)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0)) f(); for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } vi.restoreAllMocks(); });
function fixture(patch: any = {}) {
  const pg = page(); pages.push(pg); const host: any = pg.window, doc: any = pg.document, shell: any = doc.createElement("div"); shell.className = "shell"; pg.root.appendChild(shell);
  let time = 0, current = true, serial = 0; const timers = new Map<number, () => void>(), images: any[] = [], hides = new Set<() => void>();
  const sheet: any = { cssRules: [], href: "https://dashboard.example/assets/app.css", disabled: false,
    insertRule: vi.fn((_text: string, n: number) => { const values = new Map(); const rule = { selectorText: _text.split("{")[0], style: { setProperty: vi.fn((k: string, v: string, priority?: string) => { expect(priority).toBeUndefined(); values.set(k, v); }), getPropertyValue: (k: string) => values.get(k) ?? "", removeProperty: vi.fn((k: string) => values.delete(k)) } }; sheet.cssRules.splice(n, 0, rule); return n; }),
    deleteRule: vi.fn((n: number) => sheet.cssRules.splice(n, 1)) };
  const link: any = doc.createElement("link"); link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/app.css"); link.disabled = false; link.sheet = sheet; sheet.ownerNode = link; doc.head.appendChild(link);
  host.location = { origin: "https://dashboard.example" };
  Object.assign(host, { addEventListener(type: string, fn: () => void) { if (type === "pagehide") hides.add(fn); }, removeEventListener(type: string, fn: () => void) { if (type === "pagehide") hides.delete(fn); }, Blob, AbortController, performance: { now: () => time }, URL: { createObjectURL: vi.fn(() => `blob:https://dashboard.example/${++serial}`), revokeObjectURL: vi.fn() },
    setTimeout: vi.fn((fn: () => void, _delay: number) => { timers.set(++serial, fn); return serial; }), clearTimeout: vi.fn((n: number) => timers.delete(n)),
    getComputedStyle: vi.fn((el: any) => ({ cursor: el.getAttribute("data-agend-effect-cursor") ? sheet.cssRules.find((r: any) => r.selectorText.includes(el.getAttribute("data-agend-effect-cursor")))?.style.getPropertyValue("cursor") ?? "auto" : "auto" })) });
  const create = doc.createElement.bind(doc); vi.spyOn(doc, "createElement").mockImplementation(((tag: string) => { const el: any = create(tag); if (tag === "img") {
    const wait = held(); el.decode = vi.fn(() => patch.heldDecode ? wait.promise : Promise.resolve()); Object.defineProperty(el, "naturalWidth", { get: () => patch.width ?? 1 }); Object.defineProperty(el, "naturalHeight", { get: () => patch.height ?? 1 }); images.push({ el, wait });
  } return el; }) as never);
  const readImage = vi.fn(async (_id?: any, _signal?: any) => PNG), changed = vi.fn();
  const args = { window: host, current: () => current, readImage, onChange: changed }; patch.prepare?.({ args, host, doc, shell, sheet, link, readImage, changed });
  const api = createEffectCursor(args); cleanups.push(() => api.dispose());
  return { pg, host, doc, shell, sheet, link, api, args, readImage, changed, images, timers, at(n: number) { time = n; }, pagehide() { for (const fn of [...hides]) fn(); }, lose() { current = false; }, timeout() { for (const fn of [...timers.values()]) fn(); }, cursor: () => host.getComputedStyle(shell).cursor };
}
describe("fixed host stylesheet seam", () => {
  it("serves the verified geometry seam and the product cursor controller", () => { expect(isServedAsset("effect-host-style.js")).toBe(true); expect(isServedAsset("effect-cursor.js")).toBe(true); });
  it("returns only the existing exact enabled sheet and makes no new sheet/style", () => { const h = fixture(); expect(effectHostStyle(h.host)).toBe(h.sheet); expect(h.doc.querySelectorAll("style")).toHaveLength(0); expect(h.sheet.insertRule).not.toHaveBeenCalled(); });
  it.each(["missing", "foreign-doc", "disconnected", "disabled-link", "disabled-sheet", "owner", "href", "insert", "delete", "rules"])("refuses %s", fault => {
    const h = fixture(); if (fault === "missing" || fault === "disconnected") h.link.remove(); if (fault === "foreign-doc") h.link.ownerDocument = {}; if (fault === "disabled-link") h.link.disabled = true; if (fault === "disabled-sheet") h.sheet.disabled = true; if (fault === "owner") h.sheet.ownerNode = {}; if (fault === "href") h.sheet.href = "https://other/assets/app.css"; if (fault === "insert") h.sheet.insertRule = null; if (fault === "delete") h.sheet.deleteRule = null; if (fault === "rules") Object.defineProperty(h.sheet, "cssRules", { get() { throw Error("unreadable"); } });
    expect(effectHostStyle(h.host)).toBeNull();
  });
});
describe("unmounted static cursor lifecycle", () => {
  it("decodes before an owned shell-only rule with integer hotspot and auto fallback; no DOM runtime or inline style", async () => {
    const h = fixture({ heldDecode: true }); expect(h.api.ok).toBe(true); h.api.update(chosen(), true); await flush(); expect(h.images[0].el.decode).toHaveBeenCalledOnce(); expect(h.sheet.insertRule).not.toHaveBeenCalled(); expect(h.cursor()).toBe("auto");
    h.images[0].wait.resolve(); await flush(); expect(h.api.snapshot()).toEqual({ status: "running", id: ID }); expect(h.readImage).toHaveBeenCalledExactlyOnceWith(chosen(), expect.any(AbortSignal));
    expect(h.sheet.cssRules[0].selectorText).toMatch(/^#app > \.shell\[data-agend-effect-cursor="agend-effect-cursor-\d+"\]$/); expect(h.cursor()).toMatch(/^url\("blob:https:\/\/dashboard\.example\/\d+"\) 0 0, auto$/);
    expect(h.doc.querySelectorAll("iframe,canvas,style,img")).toHaveLength(0); expect(h.shell.hasAttribute("style")).toBe(false); expect(h.host.setTimeout.mock.calls[0][1]).toBe(10000);
    h.api.dispose(); expect(h.cursor()).toBe("auto"); expect(h.shell.isConnected).toBe(true); expect(h.sheet.cssRules).toEqual([]); expect(h.host.URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
  it("passes an immutable exact generation/hotspot snapshot to the shared-read adapter", async () => {
    const h = fixture(), selected = chosen(); h.api.update(selected, true); selected.id = OTHER; selected.generation = 2; selected.hotspot[0] = 5; await flush();
    const actual = h.readImage.mock.calls[0][0]; expect(actual).toEqual(chosen()); expect(Object.isFrozen(actual)).toBe(true); expect(Object.isFrozen(actual.hotspot)).toBe(true); expect(h.api.snapshot()).toEqual({ status: "running", id: ID });
  });
  it("unchanged selections do not refetch, and unrelated shell class changes keep the owned attribute", async () => {
    const h = fixture(); h.api.update(chosen(), true); await flush(); h.shell.className = "shell narrow collapsed"; for (let n = 0; n < 5; n++) h.api.update(chosen(), true); await flush(); expect(h.readImage).toHaveBeenCalledOnce(); expect(h.api.snapshot().status).toBe("running");
  });
  it.each([null, {}, { id: ID, generation: -1, hotspot: [0, 0] }, chosen(ID, 1, [0]), chosen(ID, 1, [64, 0]), chosen(ID, 1, [0.1, 0]), { ...chosen(), extra: true }])("unknown selection %# leaves normal cursor and performs no read", async selection => { const h = fixture(); h.api.update(selection, true); await flush(); expect(h.readImage).not.toHaveBeenCalled(); expect(h.cursor()).toBe("auto"); });
  it("refuses getter/sparse/exotic selection data without reading it", async () => {
    const h = fixture(), get = vi.fn(() => ID), bad = { get id() { return get(); }, generation: 1, hotspot: [0, 0] };
    h.api.update(bad, true); h.api.update(chosen(ID, 1, Array(2)), true); h.api.update(Object.assign(Object.create({}), chosen()), true); await flush(); expect(get).not.toHaveBeenCalled(); expect(h.readImage).not.toHaveBeenCalled();
  });
  it.each(["none", "false", "unknown"])("%s gate restores the normal cursor synchronously", async gate => { const h = fixture(); h.api.update(chosen(), true); await flush(); h.api.update(gate === "none" ? null : chosen(), gate === "unknown" ? undefined : false); expect(h.cursor()).toBe("auto"); expect(h.sheet.cssRules).toHaveLength(0); expect(h.host.URL.revokeObjectURL).toHaveBeenCalledOnce(); });
  it.each(["missing", "duplicate", "foreign", "claimed"])("%s shell admits no image", async fault => {
    const h = fixture(); if (fault === "missing") h.shell.remove(); if (fault === "duplicate") { const el = h.doc.createElement("div"); el.className = "shell"; h.pg.root.appendChild(el); } if (fault === "foreign") h.shell.ownerDocument = {}; if (fault === "claimed") h.shell.setAttribute("data-agend-effect-cursor", "other");
    h.api.update(chosen(), true); await flush(); expect(h.readImage).not.toHaveBeenCalled(); expect(h.api.snapshot().status).toBe("unavailable");
  });
  it.each(["read", "decode"])("same-id generation replacement waits for physical %s settlement and rejects the stale answer", async phase => {
    const wait = held(), h = fixture({ heldDecode: phase === "decode", prepare({ readImage }: any) { if (phase === "read") readImage.mockImplementationOnce(() => wait.promise); } });
    h.api.update(chosen(), true); await flush(); h.api.update(chosen(ID, 2), true); await flush(); expect(h.readImage).toHaveBeenCalledOnce(); expect(h.cursor()).toBe("auto");
    if (phase === "read") wait.resolve(PNG); else h.images[0].wait.resolve(); await flush(); expect(h.readImage).toHaveBeenCalledTimes(2);
    if (phase === "decode") { expect(h.images[1].el.decode).toHaveBeenCalledOnce(); h.images[1].wait.resolve(); await flush(); }
    expect(h.api.snapshot()).toEqual({ status: "running", id: ID }); expect(h.sheet.cssRules).toHaveLength(1);
  });
  it.each(["read", "decode"])("dispose retains the Window reservation until held %s really settles", async phase => {
    const wait = held(), h = fixture({ heldDecode: phase === "decode", prepare({ readImage }: any) { if (phase === "read") readImage.mockImplementationOnce(() => wait.promise); } }); h.api.update(chosen(), true); await flush(); h.api.dispose(); expect(h.cursor()).toBe("auto"); expect(createEffectCursor(h.args).ok).toBe(false);
    if (phase === "read") wait.resolve(PNG); else h.images[0].wait.resolve(); await flush(); const next = createEffectCursor(h.args); cleanups.push(() => next.dispose()); expect(next.ok).toBe(true); expect(h.sheet.cssRules).toHaveLength(0);
  });
  it.each([9999, 10000, 10001])("decode at %dms cannot bypass a delayed deadline timer", async at => { const h = fixture({ heldDecode: true }); h.api.update(chosen(), true); await flush(); h.at(at); h.images[0].wait.resolve(); await flush(); expect(h.api.snapshot().status).toBe(at < 10000 ? "running" : "unavailable"); expect(h.sheet.cssRules.length).toBe(at < 10000 ? 1 : 0); });
  it("timeout revokes the URL and restores cursor immediately, but does not admit another physical decode", async () => {
    const h = fixture({ heldDecode: true }); h.api.update(chosen(), true); await flush(); h.at(10000); h.timeout(); expect(h.host.URL.revokeObjectURL).toHaveBeenCalledOnce(); expect(h.cursor()).toBe("auto"); h.api.update(chosen(OTHER, 2), true); await flush(); expect(h.readImage).toHaveBeenCalledOnce(); expect(h.images[0].el.decode).toHaveBeenCalledOnce(); h.images[0].wait.resolve(); await flush(); expect(h.readImage).toHaveBeenCalledTimes(2); h.images[1].wait.resolve(); await flush(); expect(h.api.snapshot().status).toBe("running");
  });
  it.each(["size", "hotspot", "mime", "url", "blob-origin", "cascade", "cssom", "insert"])("%s refusal latches and retains no custom cursor", async fault => {
    const h = fixture({ width: fault === "size" ? 2 : 1, prepare({ host, readImage, sheet }: any) { if (fault === "mime") readImage.mockResolvedValueOnce(new Uint8Array([1])); if (fault === "url") host.URL.createObjectURL.mockReturnValue("https://outside/image"); if (fault === "blob-origin") host.URL.createObjectURL.mockReturnValue("blob:https://outside/image"); if (fault === "cascade") host.getComputedStyle.mockReturnValue({ cursor: "pointer" }); if (fault === "cssom") sheet.insertRule.mockImplementation((text: string, n: number) => { sheet.cssRules.push({ selectorText: text, style: { setProperty() {}, getPropertyValue: () => "", removeProperty() {} } }); return n; }); if (fault === "insert") sheet.insertRule.mockImplementation(() => { throw Error("refused"); }); } });
    h.api.update(chosen(ID, 1, fault === "hotspot" ? [1, 0] : [0, 0]), true); await flush(); expect(h.api.snapshot().status).toBe("unavailable"); expect(h.shell.hasAttribute("data-agend-effect-cursor")).toBe(false); expect(h.sheet.cssRules).toHaveLength(0); for (let n = 0; n < 5; n++) h.api.update(chosen(ID, 1, fault === "hotspot" ? [1, 0] : [0, 0]), true); expect(h.readImage).toHaveBeenCalledOnce();
  });
  it("clear disarms its selector even if the former stylesheet cannot delete rules", async () => { const h = fixture(); h.api.update(chosen(), true); await flush(); h.sheet.deleteRule.mockImplementation(() => { throw Error("unreadable"); }); h.sheet.cssRules[0].style.removeProperty.mockImplementation(() => { throw Error("unreadable"); }); h.api.dispose(); expect(h.shell.hasAttribute("data-agend-effect-cursor")).toBe(false); expect(h.cursor()).toBe("auto"); expect(h.shell.isConnected).toBe(true); });
  it("deletes by rule object identity after index shifts, preserving unrelated rules and attributes", async () => { const h = fixture(); h.api.update(chosen(), true); await flush(); const extra = { selectorText: ".other", style: {} }; h.sheet.cssRules.unshift(extra); h.shell.setAttribute("data-other", "keep"); h.api.dispose(); h.api.dispose(); expect(h.sheet.cssRules).toEqual([extra]); expect(h.shell.getAttribute("data-other")).toBe("keep"); });
  it.each(["target", "sheet", "cascade", "owner", "pagehide", "clock"])("%s loss removes the current cursor without replacing stock content", async fault => {
    const h = fixture(); h.api.update(chosen(), true); await flush(); if (fault === "target") h.shell.remove(); if (fault === "sheet") h.link.sheet = {}; if (fault === "cascade") h.host.getComputedStyle.mockReturnValue({ cursor: "text" }); if (fault === "owner") h.lose(); if (fault === "pagehide") h.pagehide(); if (fault === "clock") h.at(-1); h.api.update(chosen(), true); expect(h.shell.hasAttribute("data-agend-effect-cursor")).toBe(false); expect(h.host.URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
  it("onChange replacement during loading keeps only B and owns one physical image at a time", async () => { let switched = false; const h = fixture({ prepare({ args }: any) { args.onChange = () => { if (!switched && h?.api) { switched = true; h.api.update(chosen(OTHER, 2), true); } }; } }); h.api.update(chosen(), true); await flush(); expect(h.api.snapshot()).toEqual({ status: "running", id: OTHER }); expect(h.readImage).toHaveBeenCalledExactlyOnceWith(chosen(OTHER, 2), expect.any(AbortSignal)); expect(h.sheet.cssRules).toHaveLength(1); });
  it("onChange may dispose while loading without creating an image or leaking the Window owner", async () => { const other = fixture({ prepare({ args }: any) { args.onChange = () => other?.api.dispose(); } }); other.api.update(chosen(), true); await flush(); expect(other.images).toHaveLength(0); expect(other.readImage).not.toHaveBeenCalled(); const next = createEffectCursor(other.args); cleanups.push(() => next.dispose()); expect(next.ok).toBe(true); });
});
