import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeDocumentedModels } from "../src/model-catalog-defaults.js";
import { handleNativeModelCatalog } from "../src/native-model-catalog.js";
import { probeNativeClis, readNativeCodexModels } from "../src/windows-cli-worker.js";
import { boundNativeModelOptions } from "../src/windows-cli-providers.js";

const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of scratch.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))) throw Error("Unsafe scratch directory");
    rmSync(path, { recursive: true, force: true });
  }
});

describe("documented Claude Code choices", () => {
  it("offers named 5.5 choices for supported native CLI versions and literal aliases", () => {
    const choices = claudeDocumentedModels("2.1.299 (Claude Code)");
    expect(choices.slice(0, 3)).toEqual([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    ]);
    expect(choices.map(model => model.id)).toEqual(expect.arrayContaining(["opus", "sonnet", "haiku", "opusplan"]));
  });
  it.each([
    [null, []], ["malformed", []], ["2.1.279", []], ["2.1.280", ["claude-opus-5-5"]],
    ["2.1.284", ["claude-opus-5-5", "claude-sonnet-5-5"]],
  ] as const)("does not offer explicit versions unsupported by %s", (version, ids) => {
    expect(claudeDocumentedModels(version).filter(model => model.id.startsWith("claude-")).map(model => model.id)).toEqual(ids);
  });
});

describe("native model metadata", () => {
  it("bounds a large vendor catalog so seven providers fit the worker reply budget", () => {
    const options = Array.from({ length: 200 }, (_, i) => ({ id: `model-${i}`, name: "名稱".repeat(100), description: "描述".repeat(200) }));
    const bounded = boundNativeModelOptions(options);
    expect(bounded.length).toBeGreaterThan(1);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(6 * 1024);
    expect(options[0].description.length).toBe(400);
  });
  it("reads only selectable Codex cache fields, hides internal models, and tolerates corrupt data", () => {
    const home = mkdtempSync(join(tmpdir(), "agend-native-models-")); scratch.push(home);
    const dir = join(home, ".codex"); mkdirSync(dir);
    const path = join(dir, "models_cache.json");
    writeFileSync(path, JSON.stringify({ token: "must-not-leave-cache", models: [
      { slug: "gpt-real", display_name: "GPT Real", description: "A discovered model", secret: "never-returned" },
      { slug: "gpt-real", display_name: "Duplicate" },
      { slug: "hidden", visibility: "hide" }, { slug: "hidden-2", hidden: true },
      { slug: "bad;command" }, null, "wrong-shape",
    ] }));
    expect(readNativeCodexModels(home, {})).toEqual([{ id: "gpt-real", name: "GPT Real", description: "A discovered model" }]);
    writeFileSync(path, "bad JSON"); expect(readNativeCodexModels(home, {})).toEqual([]);
    writeFileSync(path, '{"models":{}}'); expect(readNativeCodexModels(home, {})).toEqual([]);
    expect(readNativeCodexModels(join(home, "missing"), {})).toEqual([]);
  });
  it("adds model metadata during existing discovery without running inference or an invented models command", async () => {
    const calls: string[][] = [];
    const result = await probeNativeClis({
      find: async id => id === "claude-code" ? { path: "C:\\CLI\\claude.exe", command: "C:\\CLI\\claude.exe", args: [] } : null,
      run: async (_entry, args) => {
        calls.push(args);
        return { ok: true, text: args.includes("--version") ? "2.1.299 (Claude Code)" : args.includes("--help") ? "--print --output-format --input-format --permission-prompts --tools --strict-mcp-config --mcp-config" : '{"loggedIn":true}' };
      },
    });
    expect(calls).toEqual([["--version"], ["--help"], ["auth", "status"]]);
    const row = result.clis.find(cli => cli.id === "claude-code")!;
    expect(row.modelsSource).toBe("official-catalog");
    expect(row.models[0]).toEqual({ id: "claude-opus-5-5", name: "Claude Opus 5.5" });
    expect(result.clis.find(cli => cli.id === "codex")!.models).toEqual([]);
  });
});

const token = "b".repeat(48);
function invoke(path: string, bridge: unknown, config: Record<string, unknown> = {}, authorized = true, extra: Record<string,unknown> = {}) {
  const req = Object.assign(new EventEmitter(), { method: "GET", headers: { host: "localhost:19280", "x-agend-token": authorized ? token : "wrong" }, socket: { remoteAddress: "127.0.0.1" } });
  let status = 0, body: unknown;
  const res = { writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } };
  const ctx = { webToken: token as string | null, fleetConfig: { instances: config }, ...extra };
  const handled = handleNativeModelCatalog(req as never, res as never, new URL(path, "http://localhost:19280"), ctx as never, bridge as never);
  return { ctx, handled, status: () => status, body: () => body };
}

describe("machine-scoped native model catalogs",()=>{
  const first="11111111-1111-4111-8111-111111111111", second="22222222-2222-4222-8222-222222222222";
  const catalog=(id:string)=>({home:`C:\\${id}`,clis:[{id:"codex",modelsSource:"cli-cache",models:[{id:`${id}-model`,name:`${id} Model`}]}]});
  function remote(){
    vi.stubEnv("AGEND_REMOTE_RUNTIME","1");vi.stubEnv("AGEND_WINDOWS_CLI","0");
    return {machine:vi.fn((id:string)=>[first,second].includes(id)?{id,status:"online",inventory:catalog(id)}:null),call:vi.fn(async(id:string)=>catalog(id))};
  }
  it("isolates two Windows machines without probing the coordinator's local Windows tools",async()=>{
    const hub=remote(),probe=vi.fn();
    for(const id of [first,second]){
      const res=invoke(`/ui/models?backend=codex&runtime=windows&machineId=${id}`,{probe},{},true,{runtimeCoordinator:()=>hub});
      await vi.waitFor(()=>expect(res.status()).toBe(200));
      expect(res.body()).toMatchObject({machineId:id,source:"cli-cache",models:[{id:`${id}-model`}]});
    }
    expect(probe).not.toHaveBeenCalled();expect(hub.call).not.toHaveBeenCalled();
  });
  it("infers the fixed machine from an instance and refuses another machine's model query",async()=>{
    const hub=remote(),config={worker:{runtime:"windows",backend:"codex",machine_id:first}},extra={runtimeCoordinator:()=>hub};
    const inferred=invoke("/ui/models?backend=codex&instance=worker",{},config,true,extra);
    await vi.waitFor(()=>expect(inferred.status()).toBe(200));expect(inferred.body()).toMatchObject({machineId:first});
    const crossed=invoke(`/ui/models?backend=codex&instance=worker&machineId=${second}`,{},config,true,extra);
    expect(crossed.status()).toBe(400);
  });
  it("refreshes only the selected machine and rechecks browser authorization after the response",async()=>{
    const hub=remote();let finish!:(value:unknown)=>void;
    const call=vi.fn(()=>new Promise(done=>{finish=done;}));
    const result=invoke(`/ui/models?backend=codex&runtime=windows&machineId=${first}&refresh=1`,{}, {},true,{runtimeCoordinator:()=>({...hub,call})});
    expect(call).toHaveBeenCalledWith(first,"probe",{});result.ctx.webToken=null;finish(catalog(first));
    await vi.waitFor(()=>expect(result.status()).toBe(403));expect(result.body()).not.toHaveProperty("models");
  });
  it("does not treat a machine ID as a WSL model catalog",()=>{
    remote();const result=invoke(`/ui/models?backend=codex&runtime=wsl&machineId=${first}`,{});
    expect(result.status()).toBe(400);expect(result.handled).toBe(true);
  });
  it("rejects revoked or unknown machine inventory rather than falling back to local models",async()=>{
    const hub=remote(),probe=vi.fn(),result=invoke("/ui/models?backend=codex&runtime=windows&machineId=33333333-3333-4333-8333-333333333333",{probe},{},true,{runtimeCoordinator:()=>hub});
    await vi.waitFor(()=>expect(result.status()).toBe(503));expect(probe).not.toHaveBeenCalled();
  });
});

describe("shared native model endpoint", () => {
  it("returns the native inventory rather than the WSL account and forwards a requested refresh", async () => {
    vi.stubEnv("AGEND_WINDOWS_CLI", "1");
    const probe = vi.fn(async () => ({ clis: [{ id: "codex", modelsSource: "cli-cache", models: [{ id: "native-model", name: "Native Model", description: "From Windows" }] }], home: "C:\\WindowsUser" }));
    const response = invoke("/ui/models?backend=codex&runtime=windows&refresh=1", { probe });
    await vi.waitFor(() => expect(response.status()).toBe(200));
    expect(probe).toHaveBeenCalledWith({ force: true });
    expect(response.body()).toEqual({ backend: "codex", runtime: "windows", models: [{ id: "native-model", label: "Native Model", description: "From Windows" }], source: "cli-cache" });
  });
  it("infers the native runtime from a registered instance even when the query omits runtime", async () => {
    vi.stubEnv("AGEND_WINDOWS_CLI", "1");
    const probe = vi.fn(async () => ({ clis: [], home: "C:\\WindowsUser" }));
    const response = invoke("/ui/models?backend=codex&instance=native", { probe }, { native: { runtime: "windows", backend: "codex" } });
    await vi.waitFor(() => expect(response.status()).toBe(200));
    expect(response.body()).toEqual({ backend: "codex", runtime: "windows", models: [], source: "unavailable" });
  });
  it("does not intercept the WSL cache route or start any discovery", () => {
    const probe = vi.fn();
    expect(invoke("/ui/models?backend=codex&runtime=wsl", { probe }).handled).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
  it("rejects mismatched instances and unauthorized/disabled reads before discovery", () => {
    const probe = vi.fn();
    vi.stubEnv("AGEND_WINDOWS_CLI", "0");
    expect(invoke("/ui/models?backend=codex&runtime=windows", { probe }).status()).toBe(404);
    vi.stubEnv("AGEND_WINDOWS_CLI", "1");
    expect(invoke("/ui/models?backend=codex&runtime=windows", { probe }, {}, false).status()).toBe(403);
    expect(invoke("/ui/models?backend=codex&runtime=windows&instance=linux", { probe }, { linux: { runtime: "wsl", backend: "codex" } }).status()).toBe(400);
    expect(invoke("/ui/models?backend=codex&instance=native", { probe }, { native: { runtime: "windows", backend: "claude-code" } }).status()).toBe(400);
    expect(invoke("/ui/models?backend=codex&runtime=wsl&instance=native", { probe }, { native: { runtime: "windows", backend: "codex" } }).status()).toBe(400);
    expect(probe).not.toHaveBeenCalled();
  });
  it("rechecks authorization after native discovery and never returns stale privileged metadata", async () => {
    vi.stubEnv("AGEND_WINDOWS_CLI", "1");
    let release!: (value: unknown) => void;
    const response = invoke("/ui/models?backend=codex&runtime=windows", { probe: () => new Promise(done => { release = done; }) });
    response.ctx.webToken = null;
    release({ clis: [{ id: "codex", models: [{ id: "private-model" }] }] });
    await vi.waitFor(() => expect(response.status()).toBe(403));
    expect(response.body()).toEqual({ error: "Authorization expired" });
  });
});
