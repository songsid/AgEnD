/** Settings management only: real Preact, bounded inert file bytes, no frame/Worker or runtime resource reads. */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { MiniEvent } from "./helpers/mini-dom.js";
import { resolveEffectParams } from "../src/web-effect.js";
const ID = "a".repeat(32), g = globalThis as any;
const M = { v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "snow", title: "Snow", regions: ["chat"], layer: "behind", wants: [], params: {
  speed: { type: "number", min: 0, max: 10, step: 0.5, default: 1 }, count: { type: "int", min: 0, max: 5, default: 2 }, enabled: { type: "bool", default: true }, shade: { type: "color", default: "#112233" }, mode: { type: "enum", values: ["snow", "rain"], default: "snow" },
} };
const entry = (over: any = {}) => ({ id: ID, bytes: 400, manifest: M, ownClaim: true, sharedByYou: false, profiles: { status: "unmeasured", records: [] }, ...over });
const catalog = (effects = [entry()], canWrite = true) => ({ effects, canWrite });
let p: AppPage | null = null;
const calls: Array<{ url: string; method: string; body?: any; signal?: AbortSignal }> = [];
let serve: (url: string, init: any) => any;
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });
afterEach(async () => {
  const { confirmStore, answerConfirm } = await import("/assets/ui-confirm.js");
  for (const q of confirmStore.get().queue) answerConfirm(q.id, false);
  if (p) { await p.unmount(); p.restore(); p = null; }
  delete g.fetch; delete g.confirm;
});
async function api() { return await import("/ui/js/settings-effects.js"); }
async function mount(opts: { data?: any; public?: boolean; lang?: "en" | "zh-TW"; handler?: typeof serve } = {}) {
  p = page({ url: "http://127.0.0.1:19280/settings/appearance" });
  g.confirm = undefined;
  if (opts.public) p.document.body.dataset.publicLink = "1";
  calls.length = 0;
  serve = opts.handler || ((url) => url === "/ui/effects" ? json(opts.data ?? catalog()) : json({ ok: true }));
  g.fetch = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method || "GET", signal: init.signal, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    return await serve(url, init);
  };
  const { appStore } = await import("/assets/app-store.js"); appStore.set({ ready: true, instances: [{ name: "worker" }, { name: "other" }] });
  (await import("/assets/app-i18n.js")).setLang(opts.lang || "en", { store: false });
  const { EffectsCard } = await api(); await p.mount(h(EffectsCard, {})); await settle(); await settle();
}
const $ = (s: string) => p!.root.querySelector(s);
const $$ = (s: string) => p!.root.querySelectorAll(s);
const event = async (node: any, type: string, value?: unknown) => { if (value !== undefined) node.value = value; node.dispatchEvent(new MiniEvent(type, { bubbles: true })); await settle(); await settle(); };
const click = async (s: string) => { $(s).click(); await settle(); await settle(); };
function file(path: string, bytes: string | Uint8Array = "x", extra: any = {}) {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return { name: path.split("/").at(-1), webkitRelativePath: `snow/${path}`, size: b.length, arrayBuffer: async () => Uint8Array.from(b).buffer, ...extra };
}
const folder = () => [file("effect.json", "{}"), file("worker.js", "throw Error('must not run')"), file("assets/snow.png", new Uint8Array([0, 255, 128]))];
const writes = () => calls.filter(c => c.method !== "GET");

// No resets of vendored Preact: renderer and component hooks must belong to the same module graph.
describe("bounded effect folders", () => {
  it("preserves exact bytes and strips only the common picker root, without executing JS", async () => {
    const { encodeEffectFolder } = await api(); const rows = JSON.parse(await encodeEffectFolder(folder()));
    expect(rows.map((r: any) => r.path)).toEqual(["effect.json", "worker.js", "assets/snow.png"]);
    expect(Buffer.from(rows[1].data_b64, "base64").toString()).toBe("throw Error('must not run')");
    expect([...Buffer.from(rows[2].data_b64, "base64")]).toEqual([0, 255, 128]);
  });
  it("also supports an explicit flat file selection", async () => {
    const { encodeEffectFolder } = await api(); const rows = JSON.parse(await encodeEffectFolder(folder().slice(0, 2).map(f => ({ ...f, webkitRelativePath: "" }))));
    expect(rows.map((r: any) => r.path)).toEqual(["effect.json", "worker.js"]);
  });
  it.each(["../worker.js", "/worker.js", "assets/../worker.js", "assets/a.svg", "assets/a.css", "assets/a/one.png", "Worker.js", "assets/UP.png", "assets/a\\b.png"])("refuses unsupported path %s before reading", async path => {
    let reads = 0; const { encodeEffectFolder } = await api();
    await expect(encodeEffectFolder([...folder().slice(0, 2), file(path, "x", { arrayBuffer: () => { reads++; throw Error(); } })])).rejects.toThrow(); expect(reads).toBe(0);
  });
  it.each(["mixed-root", "mixed-flat", "duplicate", "missing-worker", "too-many", "raw-limit", "bad-size", "null-file"])("preflights %s", async kind => {
    let reads = 0; let input: any[] = folder().map(f => ({ ...f, arrayBuffer: () => { reads++; throw Error(); } }));
    if (kind === "mixed-root") input[1].webkitRelativePath = "else/worker.js";
    if (kind === "mixed-flat") input[1].webkitRelativePath = "";
    if (kind === "duplicate") input.push(input[0]);
    if (kind === "missing-worker") input.splice(1, 1);
    if (kind === "too-many") input = Array(21).fill(input[0]);
    if (kind === "raw-limit") input[0].size = 8 * 1024 * 1024;
    if (kind === "bad-size") input[0].size = -1;
    if (kind === "null-file") input[1] = null;
    await expect((await api()).encodeEffectFolder(input)).rejects.toThrow(); expect(reads).toBe(0);
  });
  it("accepts 16 assets and refuses a 17th", async () => {
    const input = [...folder().slice(0, 2), ...Array.from({ length: 16 }, (_, i) => file(`assets/a${i}.png`))];
    const { encodeEffectFolder } = await api(); expect(JSON.parse(await encodeEffectFolder(input))).toHaveLength(18);
    await expect(encodeEffectFolder([...input, file("assets/extra.png")])).rejects.toThrow();
  });
  it("checks actual read size and cancellation before and after a held read", async () => {
    const { encodeEffectFolder } = await api();
    await expect(encodeEffectFolder([file("effect.json", "x", { size: 2 }), file("worker.js")])).rejects.toThrow();
    const ac = new AbortController(); ac.abort(); await expect(encodeEffectFolder(folder(), ac.signal)).rejects.toThrow("cancelled");
    let finish!: (value: ArrayBuffer) => void; const ac2 = new AbortController();
    const held = encodeEffectFolder([file("effect.json", "x", { arrayBuffer: () => new Promise(resolve => { finish = resolve; }) }), file("worker.js")], ac2.signal);
    ac2.abort(); finish(new Uint8Array([1]).buffer); await expect(held).rejects.toThrow("cancelled");
  });
});

describe("typed parameter drafts and catalog", () => {
  it("converts all five param types and sends only non-default overrides", async () => {
    const r = (await api()).effectParamOverrides(M, { speed: "1.5", count: "3", enabled: false, shade: "#AABBCC", mode: "rain" });
    expect(r).toEqual({ speed: 1.5, count: 3, enabled: false, shade: "#aabbcc", mode: "rain" });
    expect(resolveEffectParams(M as any, r)).toMatchObject({ ok: true, overrides: r });
    expect((await api()).effectParamOverrides(M)).toEqual({});
  });
  it.each([{ speed: "" }, { speed: "NaN" }, { speed: "Infinity" }, { speed: "1.2" }, { speed: 11 }, { count: 1.5 }, { enabled: "false" }, { shade: "red" }, { mode: "storm" }, { missing: 1 }])("rejects invalid draft %j", async draft => {
    expect((await api()).effectParamOverrides(M, draft)).toBeNull();
  });
  it.each([{}, { effects: [], canWrite: 1 }, catalog([entry({ id: "not-an-id" })]), catalog([entry(), entry()]), catalog([entry({ ownClaim: false, sharedByYou: true })]), catalog([entry({ manifest: { ...M, params: { x: { type: "script", default: "x" } } } })])])("refuses malformed catalog without guessing permissions", async data => {
    expect((await api()).effectCatalog(data)).toBeNull();
  });
});

describe("Settings effect library", () => {
  it("loads once, renders only host poster and inert text, and fetches no Worker resource", async () => {
    await mount({ data: catalog([entry({ manifest: { ...M, title: "<script>bad</script>", poster: "poster.png" } })]) });
    expect(calls.map(c => c.url)).toEqual(["/ui/effects"]);
    expect($(".s-fx-item h4").textContent).toBe("<script>bad</script>");
    expect($(".s-fx-poster").getAttribute("src")).toBe(`/ui/effects/image/${ID}/poster.png`);
    expect($$("iframe").length + $$("script").length).toBe(0);
    expect(p!.root.textContent).toContain("Not measured yet");
    expect(p!.root.textContent).toContain("1 effect"); expect(p!.root.textContent).not.toContain("1 effects");
  });
  it("public links read nothing; read sessions have no write controls", async () => {
    await mount({ public: true }); expect(calls).toEqual([]); expect($(".s-fx-choose")).toBeNull();
    await p!.unmount(); p!.restore(); p = null;
    await mount({ data: catalog([entry()], false) });
    expect(p!.root.textContent).toContain("Read-only session");
    expect($$(".s-fx-share").length + $$(".s-fx-delete").length + $$(".s-fx-apply").length + $$(".s-fx-upload").length).toBe(0);
    expect(writes()).toEqual([]);
  });
  it("shared-only entries don't offer someone else's share or delete controls", async () => {
    await mount({ data: catalog([entry({ ownClaim: false })]) });
    expect(p!.root.textContent).toContain("Shared with you"); expect($(".s-fx-share")).toBeNull(); expect($(".s-fx-delete")).toBeNull();
    expect($(".s-fx-apply").disabled).toBe(true);
  });
  it("saves explicit typed values only for a selected known chat, and removes via the separate route", async () => {
    await mount(); await event($(".s-fx-target"), "change", "worker");
    await event($("[data-param=speed]"), "input", "1.5"); await event($("[data-param=count]"), "input", "3");
    $("[data-param=enabled]").checked = false; await event($("[data-param=enabled]"), "change");
    await event($("[data-param=shade]"), "input", "#ABCDEF"); await event($("[data-param=mode]"), "change", "rain");
    await click(".s-fx-apply");
    expect(writes()[0]).toMatchObject({ url: "/ui/effects/apply", body: { instance: "worker", id: ID, params: { speed: 1.5, count: 3, enabled: false, shade: "#abcdef", mode: "rain" } } });
    await click(".s-fx-remove"); expect(writes()[1]).toMatchObject({ url: "/ui/effects/remove", body: { instance: "worker", id: ID } });
    expect(p!.root.textContent).toContain("Your effect files, and which one a chat uses.");
  });
  it("refuses invalid params and a no-longer-known selection without a write", async () => {
    await mount(); await event($(".s-fx-target"), "change", "worker"); await event($("[data-param=speed]"), "input", "1.2"); await click(".s-fx-apply");
    expect(writes()).toEqual([]); expect(p!.root.textContent).toContain("Check the parameter values.");
    (await import("/assets/app-store.js")).appStore.set({ instances: [] }); await settle(); expect($(".s-fx-apply").disabled).toBe(true);
  });
  it("shares only the caller's claim with an explicit boolean", async () => {
    await mount(); $(".s-fx-share").checked = true; await event($(".s-fx-share"), "change");
    expect(writes()).toHaveLength(1); expect(writes()[0]).toMatchObject({ url: "/ui/effects/share", body: { id: ID, shared: true } });
  });
  it("deletes only after confirmation and never after unmount during confirmation", async () => {
    await mount(); const { confirmStore, answerConfirm } = await import("/assets/ui-confirm.js");
    await click(".s-fx-delete"); expect(writes()).toEqual([]); let q = confirmStore.get().queue[0]; answerConfirm(q.id, false); await settle();
    expect(writes()).toEqual([]); await click(".s-fx-delete"); q = confirmStore.get().queue[0]; answerConfirm(q.id, true); await settle(); await settle();
    expect(writes()).toHaveLength(1); expect(writes()[0]).toMatchObject({ method: "DELETE", url: `/ui/effects/${ID}` });
    await click(".s-fx-delete"); q = confirmStore.get().queue[0]; await p!.unmount(); answerConfirm(q.id, true); await settle(); expect(writes()).toHaveLength(1);
  });
  it("uploads inert files and aborts a held file read when the page closes", async () => {
    await mount(); const input = $(".s-fx-upload"); input.files = folder(); await event(input, "change");
    expect(writes()).toHaveLength(1); expect(writes()[0].url).toBe("/ui/effects/upload"); expect(writes()[0].body[1].path).toBe("worker.js");
    let done!: (v: ArrayBuffer) => void; input.files = [file("effect.json", "x", { arrayBuffer: () => new Promise(resolve => { done = resolve; }) }), file("worker.js")];
    await event(input, "change"); await p!.unmount(); done(new Uint8Array([1]).buffer); await settle(); expect(writes()).toHaveLength(1);
  });
  it("doesn't duplicate a synchronous repeated write and discards late responses after unmount", async () => {
    let done!: (value: any) => void;
    await mount({ handler: (url) => url === "/ui/effects" ? json(catalog()) : new Promise(resolve => { done = resolve; }) });
    const node = $(".s-fx-share"); node.checked = true; node.dispatchEvent(new MiniEvent("change", { bubbles: true })); node.dispatchEvent(new MiniEvent("change", { bubbles: true })); await settle();
    expect(writes()).toHaveLength(1); const signal = writes()[0].signal!; await p!.unmount(); expect(signal.aborted).toBe(true); done(json({ ok: true })); await settle(); expect(calls.filter(c => c.url === "/ui/effects")).toHaveLength(1);
  });
  it("reports refused writes and a saved write whose refresh failed truthfully", async () => {
    let lists = 0, refuse = true;
    await mount({ handler: url => url === "/ui/effects" ? (++lists > 1 ? json({ error: "library_unreadable" }, false) : json(catalog())) : json(refuse ? { error: "effect_in_use" } : { ok: true }, !refuse) });
    $(".s-fx-share").checked = true; await event($(".s-fx-share"), "change"); expect(p!.root.textContent).toContain("This effect is still in use and cannot be deleted.");
    refuse = false; await event($(".s-fx-share"), "change"); expect(p!.root.textContent).toContain("Saved. Reload the library to see the result."); expect($(".s-fx-item")).toBeNull();
  });
  it("reads profile history only on request, and never turns unavailable into unmeasured", async () => {
    await mount({ data: catalog([entry({ profiles: { error: "profiles_unreadable" } })]) }); expect(p!.root.textContent).toContain("Profile unavailable");
    expect(calls).toHaveLength(1); await click(".s-fx-item button");
    expect(calls[1].url).toBe(`/ui/effects/profile/${ID}`); expect(p!.root.textContent).toContain("Couldn't read profile history.");
  });
  it("fails closed on unknown catalog and supports the approved zh-TW surface", async () => {
    await mount({ data: {} }); expect(p!.root.textContent).toContain("Couldn't load the library."); expect($(".s-fx-upload")).toBeNull(); expect(p!.root.textContent).not.toContain("No effects in your library.");
    await p!.unmount(); p!.restore(); p = null; await mount({ lang: "zh-TW" });
    expect(p!.root.textContent).toContain("上傳效果資料夾"); expect(p!.root.textContent).toContain("你持有的副本");
  });
  it("renders reported summaries and history as observations, without inventing measurements", async () => {
    const measured = { device: "standard", fps_p50: 60, fps_p10: 57, long_task_p95: null };
    await mount({ handler: url => json(url === "/ui/effects" ? catalog([entry({ profiles: { status: "reported", records: [measured] } })]) : { status: "reported", records: [{ ...measured, device: "constrained", long_task_p95: 80 }] }) });
    expect(p!.root.textContent).toContain("Reported host observations; they don't prove an effect's cost.");
    expect(p!.root.textContent).toContain("60 / 57"); expect(p!.root.textContent).toContain("Not observed");
    await click(".s-fx-item button"); expect(p!.root.textContent).toContain("Constrained device"); expect(p!.root.textContent).toContain("80 ms");
  });
  it.each([ ["effect_quota", "Your library reached its 10-effect or 8 MiB limit."], ["rate_limited", "Too many changes."], ["constructor", "Couldn't save this change."] ])("uses closed explanations for %s", async (error, words) => {
    await mount({ handler: url => url === "/ui/effects" ? json(catalog()) : json({ error }, false) });
    $(".s-fx-share").checked = true; await event($(".s-fx-share"), "change"); expect(p!.root.textContent).toContain(words);
  });
  it("upload rejection, invalid bytes and failed transport remain retryable", async () => {
    let reject = true;
    await mount({ handler: url => url === "/ui/effects" ? json(catalog()) : (reject ? json({ error: "invalid_manifest" }, false) : json({ ok: true })) });
    const input = $(".s-fx-upload"); input.files = folder(); await event(input, "change"); expect(p!.root.textContent).toContain("Couldn't upload this folder.");
    reject = false; input.files = folder(); await event(input, "change"); expect(p!.root.textContent).toContain("Saved."); expect(writes()).toHaveLength(2);
  });
  it("paginates a shared catalog and the upload button activates the accessible file control", async () => {
    await mount({ data: catalog(Array.from({ length: 51 }, (_, i) => entry({ id: i.toString(16).padStart(32, "0"), ownClaim: false }))) });
    expect($$(".s-fx-item")).toHaveLength(50);
    const more = Array.from($$("button")).find((b: any) => b.textContent === "Show more") as any; more.click(); await settle(); expect($$(".s-fx-item")).toHaveLength(51);
    let clicks = 0; const input = $(".s-fx-upload"); input.addEventListener("click", () => clicks++); await click(".s-fx-choose");
    expect(clicks).toBe(1); expect(input.getAttribute("aria-label")).toBe("Upload an effect folder");
    expect(readFileSync("src/ui/settings-effects.js", "utf8")).toContain("webkitdirectory=${true}");
  });
  it("keeps execution and owner preference selection outside this management PR", () => {
    const source = readFileSync("src/ui/settings-effects.js", "utf8");
    expect(source).not.toMatch(/new\s+(?:Worker|Function)|eval\(|createElement\(["']iframe|\/ui\/effects\/resource|effect-registry\.js|fx\.(?:sidebar|header|page|box|cursor)/);
  });
});
