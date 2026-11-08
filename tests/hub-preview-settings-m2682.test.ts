/**
 * M-2682 part B: fleet Settings → Hub → HTML previews on this Hub (src/hub-preview-settings.ts) — the view, and the patch for
 * a requested state with its conflict checks: the Hub's own rule (as the mount applies it), this fleet's ports, a free bind,
 * and an unfinished sealed-settings commit.
 */
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { hubPreviewPatch, hubPreviewSettingsView, portFree } from "../src/hub-preview-settings.js";

const raw = (hub: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({ health_port: 19280, ...top, hub: {
  enabled: true, webOrigin: "https://hub.example.test:8444", memberOrigin: "https://hub.example.test:8443",
  webListen: { host: "127.0.0.1", port: 8444 }, memberListen: { host: "127.0.0.1", port: 8443 }, ...hub } });
const free = async () => true;

describe("HTML previews on this Hub (M-2682)", () => {
  it("the view: off with a suggestion, on with its port, not hosted without a Hub", () => {
    expect(hubPreviewSettingsView(raw())).toEqual({ hosted: true, enabled: false, port: null, suggested: 8445 });
    expect(hubPreviewSettingsView(raw({ web: { preview_port: 9443 } }))).toEqual({ hosted: true, enabled: true, port: 9443, suggested: 8445 });
    expect(hubPreviewSettingsView(raw({ memberListen: { host: "127.0.0.1", port: 8445 } })).suggested).toBeNull();   // next port taken
    expect(hubPreviewSettingsView(raw({}, { health_port: 8444 - 1 })).suggested).toBe(8445);
    expect(hubPreviewSettingsView({ hub: { enabled: false } }).hosted).toBe(false);
    expect(hubPreviewSettingsView({}).hosted).toBe(false);
  });
  it("switching on writes the port; off removes the key", async () => {
    expect(await hubPreviewPatch(raw(), { enabled: true, port: 8445 }, { free })).toEqual({ patch: { path: ["hub", "web", "preview_port"], value: 8445 } });
    expect(await hubPreviewPatch(raw({ web: { preview_port: 8445 } }), { enabled: false }, { free })).toEqual({ patch: { path: ["hub", "web", "preview_port"], remove: true } });
  });
  it("refuses a bad port, a port the Hub or this fleet uses, a busy port, an unfinished commit, and a fleet without a Hub", async () => {
    const r = async (body: unknown, cfg: unknown = raw(), opts = {}) => { const p = await hubPreviewPatch(cfg, body, { free, ...opts }); return "refused" in p ? p.refused : "ok"; };
    for (const port of [0, 65536, 8445.5, "8445", null]) expect(await r({ enabled: true, port })).toBe("invalid_port");
    expect(await r({ enabled: "yes" })).toBe("invalid_port");
    expect(await r({ enabled: true, port: 8444 })).toBe("port_conflict");          // the Hub's web listener
    expect(await r({ enabled: true, port: 8443 })).toBe("port_conflict");          // its member listener
    expect(await r({ enabled: true, port: 19280 })).toBe("port_conflict");         // this fleet's dashboard
    expect(await r({ enabled: true, port: 19281 })).toBe("port_conflict");         // this fleet's own preview (health + 1)
    expect(await r({ enabled: true, port: 7000 }, raw({}, { web: { preview_port: 7000 } }))).toBe("port_conflict");
    expect(await r({ enabled: true, port: 19281 }, raw({}, { web: { preview: false } }))).toBe("ok");   // the fleet's previews are off
    expect(await r({ enabled: true, port: 8445 }, raw(), { free: async () => false })).toBe("port_in_use");
    expect(await r({ enabled: true, port: 8445 }, raw({ web: { preview_port: 8445 } }), { free: async () => false })).toBe("ok");   // its own, already listening
    expect(await r({ enabled: true, port: 8445 }, raw(), { busy: () => true })).toBe("busy");
    expect(await r({ enabled: true, port: 8445 }, { hub: { enabled: false } })).toBe("not_hosted");
  });
  it("the bind check: a port in use is not free; a free one is, and is left closed", async () => {
    const s = createServer(); await new Promise<void>((res) => s.listen({ host: "127.0.0.1", port: 0 }, res));
    const used = (s.address() as { port: number }).port;
    expect(await portFree("127.0.0.1", used)).toBe(false);
    await new Promise<void>((res) => s.close(() => res()));
    expect(await portFree("127.0.0.1", used)).toBe(true);
    expect(await portFree("127.0.0.1", used)).toBe(true);   // the probe closed its own listener
  });
});
