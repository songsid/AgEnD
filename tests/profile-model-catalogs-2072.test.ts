/**
 * #2072 part 2: a model catalog is the account's. A Claude credential profile gets its own cached catalog, probed with
 * that profile's login; `/model`, its "More models…", the claude model check and the web choices read the catalog of
 * the instance's own profile; and the model an instance runs is always among its choices. No CLI, no account, no
 * network: the probe worker is a fake and fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:worker_threads", async () => ({ Worker: (await import("./helpers/probe-worker.js")).FakeProbeWorker }));
vi.mock("../src/logger.js", async () => ({
  createLogger: (await import("./helpers/probe-worker.js")).fakeProbeLogger,
  rotateLogIfNeeded: vi.fn(),
}));
vi.mock("../src/backend/factory.js", () => ({ createBackend: () => { throw new Error("backend constructor on fleet thread"); } }));
import { FakeProbeWorker } from "./helpers/probe-worker.js";

let home: string, dataDir: string;
const realHome = process.env.AGEND_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agend-2072-")); process.env.AGEND_HOME = home;
  dataDir = mkdtempSync(join(tmpdir(), "agend-2072-data-"));
  FakeProbeWorker.reset();
});
afterEach(() => {
  if (realHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = realHome;
  rmSync(home, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const profiled = (profile: string) => ({ backend: "claude-code", backend_options: { "claude-code": { credential_profile: profile } } });
async function makeFleet(instances: Record<string, unknown>) {
  const { FleetManager } = await import("../src/fleet-manager.js");
  const fm = new FleetManager(dataDir) as any;
  fm.fleetConfig = { defaults: { backend: "claude-code" }, channel: {}, instances };
  return fm;
}
function seed(file: string, env: Record<string, unknown>) {
  mkdirSync(join(home, "cli-env"), { recursive: true });
  writeFileSync(join(home, "cli-env", file), JSON.stringify({ backend: "claude-code", models: [{ id: "opus", label: "opus" }], probedAt: Date.now(), ...env }));
}

describe("a credential profile has its own catalog", () => {
  it("probes with the profile's login store and writes the profile's own cache file", async () => {
    const seen: any[] = [];
    FakeProbeWorker.answer = (input) => { seen.push(input); return { models: [{ id: "opus", label: "opus" }], apiModels: [{ id: "claude-work-1", label: "claude-work-1" }] }; };
    const fm = await makeFleet({ w: profiled("work") });
    await fm.probeBackendBounded("claude-code", { profile: "work" });
    expect(seen[0].config.credentialStoreHome).toContain(join("work"));
    expect(existsSync(join(home, "cli-env", "claude-code@work.json"))).toBe(true);
    expect(existsSync(join(home, "cli-env", "claude-code.json"))).toBe(false);          // the default login's is untouched
    expect(JSON.parse(readFileSync(join(home, "cli-env", "claude-code@work.json"), "utf8")).apiModels[0].id).toBe("claude-work-1");
    await fm.probeBackendBounded("claude-code");
    expect(seen[1].config.credentialStoreHome).toBeUndefined();
  });
  it("two profiles probing at once are two flights, not one shared answer", async () => {
    FakeProbeWorker.answer = (input) => ({ models: [{ id: "opus", label: "opus" }], apiModels: [{ id: input.config.credentialStoreHome ? "p" : "d", label: "x" }] });
    const fm = await makeFleet({});
    const [a, b] = await Promise.all([fm.probeBackendBounded("claude-code", { profile: "work" }), fm.probeBackendBounded("claude-code")]);
    expect(a.apiModels[0].id).toBe("p"); expect(b.apiModels[0].id).toBe("d");
  });
  it("More models… and the model check read the instance's own profile; the default login's list stays its own", async () => {
    seed("claude-code.json", { apiModels: [{ id: "claude-default-1", label: "claude-default-1" }] });
    seed("claude-code@work.json", { apiModels: [{ id: "claude-work-1", label: "claude-work-1" }] });
    FakeProbeWorker.answer = () => { throw new Error("no probe: the caches are fresh"); };
    const fm = await makeFleet({ onwork: profiled("work"), plain: { backend: "claude-code" } });
    expect((await fm.claudeApiModelOptions("onwork")).map((m: any) => m.id)).toEqual(["claude-work-1"]);
    expect((await fm.claudeApiModelOptions("plain")).map((m: any) => m.id)).toEqual(["claude-default-1"]);
    expect(fm.claudeModelKnown("onwork", "claude-work-1", null).known).toBe(true);
    expect(fm.claudeModelKnown("plain", "claude-work-1", null).known).toBe(false);
    expect(fm.claudeModelKnown("plain", "claude-default-1", null).known).toBe(true);
  });
  it("another backend's catalog is the backend's own, profile or not (its probe reads the process environment)", async () => {
    const fm = await makeFleet({ c: { backend: "codex", backend_options: { codex: { credential_profile: "work" } } } });
    expect(fm.catalogProfile("codex", "c")).toBeNull();
    expect(fm.catalogProfile("claude-code", "c")).toBeNull();
  });
});

describe("the model an instance runs is always a choice", () => {
  it("a current model the catalog does not list is shown first, marked; one it lists is not repeated", async () => {
    const fm = await makeFleet({});
    const list = [{ id: "opus", label: "opus" }, { id: "sonnet", label: "sonnet" }];
    const { t } = await import("../src/locale.js");
    expect(fm.withCurrentModel(list, "claude-legacy-9")).toEqual([{ id: "claude-legacy-9", label: "claude-legacy-9", description: t("model.not_listed") }, ...list]);
    expect(fm.withCurrentModel(list, "sonnet")).toBe(list);
    expect(fm.withCurrentModel(list, "default")).toBe(list);
    expect(fm.withCurrentModel(list, null)).toBe(list);
  });
  it("the /model menu carries it, with the ✓ of the current model", async () => {
    const fm = await makeFleet({ w: { backend: "claude-code" } });
    const choices = fm.modelMenuChoices("w", "n", [{ id: "opus", label: "opus" }], "claude-legacy-9");
    expect(choices[1].label.startsWith("✓ claude-legacy-9")).toBe(true);
    expect(choices.map((c: any) => c.id.split(":").pop())).toEqual(["__refresh__", "claude-legacy-9", "opus", "__more__"]);
  });
});

describe("claude's account catalog uses the profile's token", () => {
  it("listApiModels(storeHome) asks for that store's token", async () => {
    const providers = await import("../src/usage/providers.js");
    const token = vi.spyOn(providers, "getClaudeOAuthToken").mockResolvedValue("tok-" + "c".repeat(8));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "claude-x" }] }) })));
    const { ClaudeCodeBackend } = await import("../src/backend/claude-code.js");
    const be = Object.create(ClaudeCodeBackend.prototype);
    expect((await be.listApiModels("/store/work")).map((m: any) => m.id)).toEqual(["claude-x", "claude-x[1m]"]);
    expect(token).toHaveBeenLastCalledWith("/store/work");
    await be.listApiModels();
    expect(token).toHaveBeenLastCalledWith(undefined);
    token.mockRestore();
  });
  it("probeCLIEnv(config) carries config.credentialStoreHome to the token (Fable R1 P2: the feature's core)", async () => {
    const providers = await import("../src/usage/providers.js");
    const token = vi.spyOn(providers, "getClaudeOAuthToken").mockResolvedValue("tok-" + "c".repeat(8));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "claude-x" }] }) })));
    const { ClaudeCodeBackend } = await import("../src/backend/claude-code.js");
    const be = Object.create(ClaudeCodeBackend.prototype);
    be.binaryPath = "/nonexistent/claude-2072";            // probeCliVersion answers undefined: no CLI runs
    be.listModels = async () => [{ id: "opus", label: "opus" }];
    const env = await be.probeCLIEnv({ workingDirectory: "", instanceDir: "", instanceName: "p", mcpServers: {}, credentialStoreHome: "/store/work" });
    expect(token).toHaveBeenLastCalledWith("/store/work");
    expect(env.apiModels.map((m: any) => m.id)).toEqual(["claude-x", "claude-x[1m]"]);
    await be.probeCLIEnv({ workingDirectory: "", instanceDir: "", instanceName: "p", mcpServers: {} });
    expect(token).toHaveBeenLastCalledWith(undefined);
    token.mockRestore();
  });
});

describe("Fable R1 P3: every reader of a profile's catalog, locked", () => {
  it("/model reads a fresh profile cache without probing", async () => {
    seed("claude-code@work.json", { models: [{ id: "opus", label: "opus" }, { id: "sonnet", label: "sonnet" }] });
    FakeProbeWorker.answer = () => { throw new Error("a fresh profile cache must not be probed"); };
    const fm = await makeFleet({ onwork: profiled("work") });
    expect((await fm.getModelOptions("onwork")).map((m: any) => m.id)).toEqual(["opus", "sonnet"]);
    expect(FakeProbeWorker.workers).toHaveLength(0);
  });
  it("the web /model choices read the instance's profile catalog and keep its current model", async () => {
    seed("claude-code.json", { models: [{ id: "default-only", label: "default-only" }] });
    seed("claude-code@work.json", { models: [{ id: "opus", label: "opus" }] });
    const fm = await makeFleet({ onwork: { ...profiled("work"), model: "claude-legacy-9" } });
    const r = await fm.webCommand({ instance: "onwork", command: "model" }, { publicLink: false });
    const ids = r.body.choices.options.map((o: any) => o.id);
    expect(ids).toEqual(["claude-legacy-9", "opus"]);
  });
  it("startup probes each Claude profile in use, with its own login store", async () => {
    const stores: Array<string | undefined> = [];
    FakeProbeWorker.answer = (input) => { stores.push(input.config.credentialStoreHome); return { models: [{ id: "opus", label: "opus" }] }; };
    const fm = await makeFleet({ a: profiled("work"), b: profiled("work"), c: profiled("home"), d: { backend: "claude-code" } });
    fm.probeCliEnvs();
    await vi.waitFor(() => expect(stores.length).toBe(3));
    // Fable #2080 R2: exact paths (a TMPDIR containing "work" must not decide it)
    const { credentialProfileStoreHome } = await import("../src/backend/credential-profile.js");
    const { getAgendHome } = await import("../src/paths.js");
    expect(stores.filter(Boolean).sort()).toEqual([credentialProfileStoreHome(getAgendHome(), "claude-code", "home"), credentialProfileStoreHome(getAgendHome(), "claude-code", "work")].sort());
    expect(stores.filter(s => s === undefined)).toHaveLength(1);       // the default login, once
  });
});

describe("part 3: the catalog a Settings model field offers", () => {
  it("merges the CLI's list and the account catalog, deduplicated; follows a named instance's profile; never probes", async () => {
    seed("claude-code.json", { models: [{ id: "opus", label: "opus" }], apiModels: [{ id: "opus", label: "opus" }, { id: "claude-default-1", label: "claude-default-1" }] });
    seed("claude-code@work.json", { models: [{ id: "opus", label: "opus" }], apiModels: [{ id: "claude-work-1", label: "claude-work-1" }] });
    FakeProbeWorker.answer = () => { throw new Error("a Settings field never probes"); };
    const fm = await makeFleet({ onwork: profiled("work"), plain: { backend: "claude-code" } });
    expect(fm.modelCatalogFor("claude-code", null).map((m: any) => m.id)).toEqual(["opus", "claude-default-1"]);
    expect(fm.modelCatalogFor("claude-code", "onwork").map((m: any) => m.id)).toEqual(["opus", "claude-work-1"]);
    expect(fm.modelCatalogFor("claude-code", "no-such-instance").map((m: any) => m.id)).toEqual(["opus", "claude-default-1"]);
    expect(fm.modelCatalogFor("not-a-backend", null)).toEqual([]);
    expect(fm.modelCatalogFor("mock", null)).toEqual([]);
    expect(fm.modelCatalogFor("codex", null)).toEqual([]);                 // nothing cached: an empty list, not a probe
  });
});
