import { describe, expect, it, vi } from "vitest";
import { parseWebEffectManifest } from "../src/web-effect.js";
const { checkEffectOwnerSlots, createEffectRuntimeLoader } = await import(new URL("../src/ui/shared/effect-runtime-loader.js", import.meta.url).href);
const ID = "a".repeat(32), EPOCH = "b".repeat(16), KEYS = ["fx.sidebar", "fx.header", "fx.page", "fx.box", "fx.cursor"];
const manifest = (title = "Canvas", description = "") => ({ v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "canvas", title, description,
  regions: ["sidebar", "header", "page", "box"], layer: "behind", wants: [], box: { anchor: "center", width: 64, height: 64, offset: 0 }, cursor: { hotspot: [0, 0] } });
function state(m: any = manifest()) { return { rev: 1, slots: Object.fromEntries(KEYS.map(key => [key, { status: "available", id: ID, manifest: structuredClone(m) }])) }; }
function fixture() {
  let now = 0; const timers = new Map(), host = { AbortController, performance: { now: () => now }, fetch: vi.fn(async () => new Response(JSON.stringify(state()), { headers: { "content-type": "application/json" } })),
    setTimeout(fn: () => void) { timers.set(fn, fn); return fn; }, clearTimeout(fn: () => void) { timers.delete(fn); } };
  return { host, api: createEffectRuntimeLoader({ window: host, ownerEpoch: EPOCH, current: () => true }), at(n: number) { now = n; } };
}
describe("#1629 shared closed personal-effect projection", () => {
  it.each([
    ["ZWJ", "👨‍👩‍👧".repeat(40), "👨‍👩‍👧".repeat(200)],
    ["combining", "x\u0301".repeat(40), "x\u0301".repeat(200)],
    ["NFC", "e\u0301".repeat(40), "e\u0301".repeat(200)],
  ])("server-valid %s display text survives projection and bounded HTTP", async (_name, title, description) => {
    const parsed = parseWebEffectManifest(manifest(title, description)); expect(parsed.ok).toBe(true); if (!parsed.ok) throw Error("fixture");
    const source = state(parsed.manifest), x = checkEffectOwnerSlots(source); expect(x).toEqual(source); expect(Object.isFrozen(x.slots["fx.page"].manifest)).toBe(true);
    source.slots["fx.page"].manifest.title = "changed"; expect(x.slots["fx.page"].manifest.title).toBe(parsed.manifest.title);
    const h = fixture(); h.host.fetch.mockResolvedValueOnce(new Response(JSON.stringify(state(parsed.manifest)), { headers: { "content-type": "application/json" } }));
    expect(await h.api.owner()).toEqual(state(parsed.manifest)); expect(h.host.fetch).toHaveBeenCalledWith(`/ui/effects/owner?ownerEpoch=${EPOCH}`, expect.objectContaining({ cache: "no-store", redirect: "error", credentials: "same-origin" })); h.api.dispose();
  });
  it("five full legal manifests fit the owner tree budget without loosening the per-resource bound", () => {
    const params = Object.fromEntries(Array.from({ length: 16 }, (_, n) => [`p${n}`, { type: "enum", values: Array.from({ length: 16 }, (_, i) => `v${i}`), default: "v0" }]));
    const parsed = parseWebEffectManifest({ ...manifest(), params }); expect(parsed.ok).toBe(true); if (!parsed.ok) throw Error("fixture"); expect(checkEffectOwnerSlots(state(parsed.manifest))).not.toBeNull();
  });
  it.each([
    ["title graphemes", "👨‍👩‍👧".repeat(41), "valid"], ["description graphemes", "valid", "👨‍👩‍👧".repeat(201)],
    ["title units", "x" + "\u0301".repeat(400), "valid"], ["description units", "valid", "x" + "\u0301".repeat(2000)],
  ])("refuses server-invalid %s", (_name, title, description) => { const m = manifest(title, description); expect(parseWebEffectManifest(m).ok).toBe(false); expect(checkEffectOwnerSlots(state(m))).toBeNull(); });
  it.each(["extra", "missing", "rev", "id", "status", "manifest", "runtime", "region", "box", "cursor", "getter"])("closed or incompatible %s never grants a selection", fault => {
    const x: any = state(); const getter = vi.fn(() => "unsafe");
    if (fault === "extra") x.slots["fx.page"].code = "private"; if (fault === "missing") delete x.slots["fx.header"]; if (fault === "rev") x.rev = -1;
    if (fault === "id") x.slots["fx.page"].id = "../x"; if (fault === "status") x.slots["fx.page"].status = "running";
    if (fault === "manifest") x.slots["fx.page"].manifest = { title: "Canvas" }; if (fault === "runtime") x.slots["fx.page"].manifest.runtime = "html"; if (fault === "region") x.slots["fx.header"].manifest.regions = ["page"];
    if (fault === "box") delete x.slots["fx.box"].manifest.box; if (fault === "cursor") delete x.slots["fx.cursor"].manifest.cursor;
    if (fault === "getter") Object.defineProperty(x.slots["fx.page"].manifest, "title", { get: getter });
    expect(checkEffectOwnerSlots(x)).toBeNull(); expect(getter).not.toHaveBeenCalled();
  });
  it("none and unavailable preserve their distinct closed shapes", () => {
    const x = state(); x.slots["fx.page"] = { status: "none", id: null } as any; x.slots["fx.box"] = { status: "unavailable", id: ID } as any;
    expect(checkEffectOwnerSlots(x)).toEqual(x); (x.slots["fx.box"] as any).manifest = manifest(); expect(checkEffectOwnerSlots(x)).toBeNull();
  });
  it("owner metadata shares the existing one-operation metadata reservation with chat placements", async () => {
    const h = fixture(); let release: (r: Response) => void = () => {}; h.host.fetch.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const op = h.api.owner(); await Promise.resolve(); expect(await h.api.placements("own")).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce();
    release(new Response(JSON.stringify(state()), { headers: { "content-type": "application/json" } })); expect(await op).not.toBeNull(); h.api.dispose();
  });
  it.each([9999, 10000, 10001])("owner completion at %i keeps the existing exact deadline", async at => {
    const h = fixture(); let release: (r: Response) => void = () => {}; h.host.fetch.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const op = h.api.owner(); await Promise.resolve(); h.at(at); release(new Response(JSON.stringify(state()), { headers: { "content-type": "application/json" } }));
    expect(await op).toEqual(at < 10000 ? state() : null); h.api.dispose();
  });
  it("owner metadata stays in the 256 KiB metadata budget, never the 8 MiB Worker wire budget", async () => {
    const h = fixture(); h.host.fetch.mockResolvedValueOnce(new Response(" ".repeat(262145) + JSON.stringify(state()), { headers: { "content-type": "application/json" } }));
    expect(await h.api.owner()).toBeNull(); h.api.dispose();
  });
  it.each([401, 403, 409])("owner %i revokes the shared loader, including later chat resource reads", async status => {
    const h = fixture(); h.host.fetch.mockResolvedValueOnce(new Response("{}", { status, headers: { "content-type": "application/json" } }));
    expect(await h.api.owner()).toBeNull(); expect(await h.api.resource({ id: ID, instance: "own" })).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce(); h.api.dispose();
  });

});
