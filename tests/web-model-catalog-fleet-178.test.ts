/**
 * AGEND-178: the model list Web Settings gets from a real FleetManager's cached catalog (cli-env/claude-code.json, as the
 * probe wrote it), through GET /ui/models and POST /ui/models/refresh. Pins the claude `[1m]` rule end to end: a model
 * reporting 1M that does not have it by default gets its `[1m]` in the 1M group; a 200K model and a native-1M model do not.
 * No CLI, no network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest } from "../src/web-api.js";

const M = 1_000_000;
const ACCOUNT: Array<[string, number]> = [["claude-opus-5-5", M], ["claude-opus-4-6", M], ["claude-opus-4-5-20251101", 200_000], ["claude-haiku-4-5-20251001", 200_000]];
// an older daemon's cache: a [1m] after every model, each with the model's own window
const apiModels = ACCOUNT.flatMap(([id, tokens]) => [{ id, label: id, maxInputTokens: tokens }, { id: `${id}[1m]`, label: `${id}[1m]`, maxInputTokens: tokens }]);
const aliases = ["default", "sonnet", "opus", "haiku", "Fable"].map(id => ({ id, label: id }));

describe("Web Settings' Claude list from the fleet's cache", { timeout: 60_000 }, () => {
  let root: string;
  const servers: Server[] = [];
  const savedHome = process.env.AGEND_HOME;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agend-web-models-178-")); process.env.AGEND_HOME = join(root, "agend"); });
  afterEach(async () => {
    if (savedHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = savedHome;
    for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    rmSync(root, { recursive: true, force: true });
  });
  async function rig(cache: Record<string, unknown>) {
    mkdirSync(join(root, "agend", "cli-env"), { recursive: true });
    writeFileSync(join(root, "agend", "cli-env", "claude-code.json"), JSON.stringify({ backend: "claude-code", probedAt: Date.now(), ...cache }));
    vi.resetModules();
    vi.doMock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }) }));
    const { FleetManager } = await import("../src/fleet-manager.js");
    const file = join(root, "fleet.yaml");
    writeFileSync(file, "instances:\n  w: { working_directory: /tmp, backend: claude-code }\n");
    const fm = new FleetManager(root) as any;
    fm.loadConfig(file);
    const token = "a".repeat(48);
    const ctx: any = { webToken: token, logger: { info() {}, error() {}, warn() {}, debug() {} },
      modelCatalogFor: fm.modelCatalogFor.bind(fm), modelCatalogForWeb: fm.modelCatalogForWeb.bind(fm),
      refreshModelCatalogFor: async (b: string, i: string | null) => ({ models: fm.modelCatalogFor(b, i), refreshed: true }),
      backendAvailabilityRows: () => [{ backend: "claude-code", version: "2.1.299" }] };
    const server = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
    servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    return {
      fm,
      get: async (query: string) => (await fetch(`${base}/ui/models?${query}`, { headers: { "x-agend-token": token } })).json() as Promise<any>,
      refresh: async (body: unknown) => (await fetch(`${base}/ui/models/refresh`, { method: "POST", headers: { "Content-Type": "application/json", "x-agend-token": token }, body: JSON.stringify(body) })).json() as Promise<any>,
    };
  }
  const ids = (r: any) => r.models.map((m: any) => m.id);

  it("GET and Refresh both list claude-opus-4-6[1m] under the 1M group; no 200K or native-1M [1m]; no alias", async () => {
    const r = await rig({ models: aliases, apiModels });
    for (const answer of [await r.get("backend=claude-code&instance=w"), await r.refresh({ backend: "claude-code", instance: "w" })]) {
      expect(ids(answer)).toEqual(["claude-opus-5-5", "claude-opus-4-6", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001", "claude-opus-4-6[1m]"]);
      expect(answer.models.find((m: any) => m.id === "claude-opus-4-6[1m]").group).toBe("oneMillion");
      expect(answer.models.filter((m: any) => m.group).length).toBe(1);
    }
  });
  it("no account list cached: the documentation's ids, marked, from GET and from Refresh", async () => {
    const r = await rig({ models: aliases, apiModels: [] });
    for (const answer of [await r.get("backend=claude-code&instance=w"), await r.refresh({ backend: "claude-code", instance: "w" })]) {
      expect(answer.source).toBe("official-catalog");
      expect(answer.models.length).toBeGreaterThan(0);
      expect(answer.models.every((m: any) => m.id.startsWith("claude-") && m.group === "unverified")).toBe(true);
    }
  });
});
