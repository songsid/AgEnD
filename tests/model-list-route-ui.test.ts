import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest } from "../src/web-api.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

// GET /ui/models waits for the one bounded discovery an empty list gets; an open Settings field reads again
// when the server says the list changed.
function get(path: string, ctx: Record<string, unknown>) {
  const token = "c".repeat(48);
  const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host: "127.0.0.1:19280", "x-agend-token": token }, socket: { remoteAddress: "127.0.0.1", destroy() {} } });
  let status = 0, body = "";
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const res = Object.assign(new EventEmitter(), {
    headersSent: false, destroyed: false, writableEnded: false, setHeader() {}, getHeader() { return undefined; },
    writeHead: vi.fn((c: number): void => { status = c; res.headersSent = true; }),
    end: vi.fn((t = ""): void => { body = String(t); res.writableEnded = true; finish(); }),
    write() { return true; },
  });
  handleWebRequest(req as never, res as never, new URL(path, "http://127.0.0.1:19280"), { webToken: token, logger: { info() {}, debug() {}, error() {}, warn() {} }, ...ctx } as never);
  return { finished, res, status: () => status, json: () => JSON.parse(body || "null") };
}

describe("GET /ui/models on an empty list", () => {
  it("answers only after the fleet's one discovery, and from the list it wrote", async () => {
    let models: unknown[] = []; let release!: () => void;
    const ensure = vi.fn(() => new Promise<void>(resolve => { release = () => { models = [{ id: "found", label: "Found" }]; resolve(); }; }));
    const r = get("/ui/models?backend=antigravity&instance=w", { modelCatalogFor: () => models, ensureModelCatalog: ensure });
    await new Promise(resolve => setImmediate(resolve));
    expect(r.res.writeHead).not.toHaveBeenCalled();                       // the page is loading, not shown an empty list
    release(); await r.finished;
    expect(ensure).toHaveBeenCalledWith("antigravity", "w", undefined);
    expect(r.json()).toEqual({ backend: "antigravity", models: [{ id: "found", label: "Found" }] });
  });
  it("passes a named account through, and a failing discovery is still an answer", async () => {
    const ensure = vi.fn(async () => { throw new Error("boom"); });
    const r = get("/ui/models?backend=claude-code&instance=w&profile=work", { modelCatalogFor: () => [{ id: "x", label: "x" }], ensureModelCatalog: ensure });
    await r.finished;
    expect(ensure).toHaveBeenCalledWith("claude-code", "w", { profile: "work" });
    expect(r.status()).toBe(503);
  });
});

let p: AppPage;
afterEach(async () => { if (p) { await p.unmount(); p.restore(); } vi.unstubAllGlobals(); });
describe("an open Settings model field", () => {
  it("reads its list again when the server says that backend's list changed, and not for another backend's", async () => {
    p = page(); (await import("/ui/js/model-picker.js")).forgetModelPickerCatalogs();
    const { appStore } = await import("/assets/app-store.js");
    const handlers = new Map<string, (d: unknown) => void>();
    appStore.set({ streamOn: (name: string, fn: (d: unknown) => void) => { handlers.set(name, fn); return () => handlers.delete(name); } } as never);
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { reads++; return { ok: true, json: async () => ({ models: reads === 1 ? [] : [{ id: "hydrogen", label: "Hydrogen" }] }) }; }));
    const { ModelSelect } = await import("/ui/js/settings-dialogs.js");
    await p.mount(h(ModelSelect, { backend: "antigravity", instance: "w", value: "", onChange() {} })); await settle(8);
    expect(p.root.querySelectorAll("option").map((o: any) => o.value)).not.toContain("hydrogen");
    handlers.get("models")!({ backend: "codex" }); await settle(8);
    expect(reads).toBe(1);
    handlers.get("models")!({ backend: "antigravity" }); await settle(8);
    expect(reads).toBe(2);
    expect(p.root.querySelectorAll("option").map((o: any) => o.value)).toContain("hydrogen");
  });
});
