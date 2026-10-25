/**
 * #2648: a kiro conversation saved with a model kiro has retired. For an instance with no model of its own, the launch
 * reads the resumed conversation's saved model (v1: its own row, read-only; v2: its session file, in the async launch
 * preparation — never on the fleet loop) and, when kiro's cached list no longer has it, launches with kiro's default
 * model, announced once per conversation. A model error the launch could not foresee restarts it once; after that, and
 * for an instance whose own model is the unavailable one, it is said once — never switched against the configuration.
 * Every root is a scratch directory (AGEND_HOME, XDG_DATA_HOME and KIRO_HOME stubbed); no kiro, fleet or tmux runs.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Session files are never read synchronously on the fleet loop (#1417): any such read fails this file's tests.
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const guard = (path: unknown) => { if (String(path).includes("/sessions/cli")) throw new Error("session IO on fleet loop"); };
  return { ...fs, readFileSync: (...args: any[]) => { guard(args[0]); return (fs.readFileSync as any)(...args); },
    statSync: (...args: any[]) => { guard(args[0]); return (fs.statSync as any)(...args); } };
});

const { KiroBackend } = await import("../src/backend/kiro.js");
const { recordKiroLaunch } = await import("../src/backend/kiro-engine-ledger.js");
const { decideKiroModelError, readKiroModelRecords } = await import("../src/backend/kiro-retired-model.js");
const { InstanceLifecycle } = await import("../src/instance-lifecycle.js");
const { t, setLocale } = await import("../src/locale.js");
type Compat = import("../src/backend/kiro.js").KiroCliCompatibility;

let root: string, cwd: string, instanceDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-2648-"));
  cwd = join(root, "work"); instanceDir = join(root, "agend", "instances", "worker");
  mkdirSync(cwd, { recursive: true }); mkdirSync(instanceDir, { recursive: true });
  vi.stubEnv("AGEND_HOME", join(root, "agend")); vi.stubEnv("XDG_DATA_HOME", join(root, "xdg")); vi.stubEnv("KIRO_HOME", join(root, "kiro"));
  catalog();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setLocale("en"); rmSync(root, { recursive: true, force: true }); });

const COMPAT: Compat = { version: "kiro-cli 2.30.0", source: "version", supportsLegacyUi: true, supportsTui: true, supportsV3: true,
  supportsInstanceAgent: true, agentEngines: ["v2", "v1", "v3"], supportsEffortFlag: true };
const RETIRED = "claude-opus-4.6";

/** AgEnD's cached `--list-models` (cli-env/kiro-cli.json); `null` removes it. */
function catalog(over: Record<string, unknown> | null = {}): void {
  const dir = join(root, "agend", "cli-env"); mkdirSync(dir, { recursive: true });
  const path = join(dir, "kiro-cli.json");
  if (over === null) { rmSync(path, { force: true }); return; }
  writeFileSync(path, JSON.stringify({ backend: "kiro-cli", probedAt: Date.now(), version: "kiro-cli 2.30.0",
    models: ["auto", "claude-sonnet-4.6", "claude-haiku-4.5"].map(id => ({ id, label: id })), currentModel: "auto", ...over }));
}
function v1Row(id: string, model: string | null): void {
  const dir = join(root, "xdg", "kiro-cli"); mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  db.exec("CREATE TABLE IF NOT EXISTS conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id)); CREATE INDEX IF NOT EXISTS idx_conversations_v2_key_updated ON conversations_v2(key, updated_at DESC);");
  db.prepare("INSERT OR REPLACE INTO conversations_v2 VALUES (?, ?, ?, 100, 100)").run(cwd, id,
    JSON.stringify(model ? { model_info: { model_name: model, model_id: model }, history: [] } : { history: [] }));
  db.close();
}
function v2Session(id: string, model: string | null): void {
  const dir = join(root, "kiro", "sessions", "cli"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ session_id: id, cwd, created_at: "2026-10-25T08:00:00Z", updated_at: "2026-10-25T08:00:00Z",
    session_state: { rts_model_state: model ? { model_info: { model_name: model, model_id: model } } : { model_info: null } } }));
}
function config(over: Record<string, unknown> = {}) {
  return { workingDirectory: cwd, instanceDir, instanceName: "worker", mcpServers: { agend: { command: "node", args: ["s.js"], env: {} } },
    instructions: "# AgEnD", ...over } as never;
}
/** One launch attempt as the daemon makes it: prepare (async), writeConfig, buildCommand. */
async function launch(backend: InstanceType<typeof KiroBackend>, over: Record<string, unknown> = {}): Promise<string> {
  const c = config(over);
  await backend.prepareLaunch(c); backend.writeConfig(c);
  return backend.buildCommand(c);
}
const classic = () => recordKiroLaunch({ instance: "worker", workingDirectory: cwd, credentialProfile: null, kiroVersion: "2.27.0", ui: "legacy", flags: ["--legacy-ui", "--agent-engine=v1"] });
const tui = () => recordKiroLaunch({ instance: "worker", workingDirectory: cwd, credentialProfile: null, kiroVersion: "2.27.0", ui: "tui", flags: ["--tui", "--agent-engine=v2"] });
const announced = (from = RETIRED, to = "auto") => t("kiro.retired_model_switched", "worker", from, to);

describe("#2648 step 1 + 3: classic (v1) — the owned row's saved model, read at launch", () => {
  it("a retired saved model launches on kiro's default, announced once; later launches keep it, quietly", async () => {
    classic(); v1Row("conv-1", RETIRED);
    const b = new KiroBackend(instanceDir, COMPAT);
    const cmd = await launch(b);
    expect(cmd).toContain(" --resume-id 'conv-1'");
    expect(cmd).toMatch(/ --model 'auto'/);
    expect(b.consumeLaunchWarning()).toContain(announced());
    expect(readKiroModelRecords(instanceDir).switched["conv-1"]).toEqual({ from: RETIRED, to: "auto", announced: true });
    const again = new KiroBackend(instanceDir, COMPAT);
    expect(await launch(again)).toMatch(/ --resume-id 'conv-1'.* --model 'auto'/);
    expect(again.consumeLaunchWarning() ?? "").not.toContain(announced());
  });

  it("a saved model kiro still offers launches exactly as before (no --model)", async () => {
    classic(); v1Row("conv-1", "claude-sonnet-4.6");
    const b = new KiroBackend(instanceDir, COMPAT);
    expect(await launch(b)).not.toContain("--model");
    expect(b.consumeLaunchWarning() ?? "").not.toContain("no longer offers");
  });

  it("a later supported choice in the conversation (/model) wins over an earlier switch; the announcement stays once (#2649 review)", async () => {
    classic(); v1Row("conv-1", RETIRED);
    const b = new KiroBackend(instanceDir, COMPAT);
    expect(await launch(b)).toContain(" --model 'auto'");
    b.consumeLaunchWarning();
    v1Row("conv-1", "claude-haiku-4.5");                                     // the person picked haiku with /model
    const next = new KiroBackend(instanceDir, COMPAT);
    expect(await launch(next)).not.toContain("--model");
    expect(next.consumeLaunchWarning() ?? "").not.toContain(announced());
    v1Row("conv-1", RETIRED);                                                // retired again (same conversation): switched,
    const again = new KiroBackend(instanceDir, COMPAT);                      // not announced a second time
    expect(await launch(again)).toContain(" --model 'auto'");
    expect(again.consumeLaunchWarning() ?? "").not.toContain(announced());
  });

  it("kiro's catalog default is used when it names one of its models", async () => {
    catalog({ currentModel: "claude-sonnet-4.6" });
    classic(); v1Row("conv-1", RETIRED);
    expect(await launch(new KiroBackend(instanceDir, COMPAT))).toContain(" --model 'claude-sonnet-4.6'");
  });

  it("nothing is foreseen without a fresh catalog, a readable store or a saved model — the launch is unchanged", async () => {
    classic(); v1Row("conv-1", RETIRED);
    catalog(null);
    expect(await launch(new KiroBackend(instanceDir, COMPAT))).not.toContain("--model");
    catalog({ probedAt: Date.now() - 365 * 24 * 3600_000 });                 // stale
    expect(await launch(new KiroBackend(instanceDir, COMPAT))).not.toContain("--model");
    catalog(); v1Row("conv-1", null);                                         // no saved model
    expect(await launch(new KiroBackend(instanceDir, COMPAT))).not.toContain("--model");
    writeFileSync(join(root, "xdg", "kiro-cli", "data.sqlite3"), "not a database");
    expect(await launch(new KiroBackend(instanceDir, COMPAT))).not.toContain("--model");   // unreadable store: step 2's job
  });

  it("an instance with a model of its own (its own or the fleet's) is never switched, and its store is not read", async () => {
    classic(); v1Row("conv-1", RETIRED);
    const b = new KiroBackend(instanceDir, COMPAT);
    const cmd = await launch(b, { model: RETIRED });
    expect(cmd).toContain(` --model '${RETIRED}'`);
    expect(cmd).not.toContain("--model 'auto'");
    expect(readKiroModelRecords(instanceDir).switched).toEqual({});
  });

  it("a damaged record file reads as empty and is rewritten", async () => {
    classic(); v1Row("conv-1", RETIRED);
    writeFileSync(join(instanceDir, "kiro-model.json"), "{ not json");
    const b = new KiroBackend(instanceDir, COMPAT);
    expect(await launch(b)).toContain(" --model 'auto'");
    expect(b.consumeLaunchWarning()).toContain(announced());
    expect(JSON.parse(readFileSync(join(instanceDir, "kiro-model.json"), "utf-8")).switched["conv-1"].announced).toBe(true);
  });
});

describe("#2648 step 1 + 3: TUI (v2) — the recorded conversation's session file, read in the async preparation", () => {
  it("a retired saved model launches on kiro's default, announced once, with no synchronous session read", async () => {
    tui(); v2Session("1a2b3c4d-0000-4000-8000-000000000001", RETIRED);
    const id = "1a2b3c4d-0000-4000-8000-000000000001";
    // First launch adopts the conversation (recorded only now); the next one foresees its model.
    const first = new KiroBackend(instanceDir, COMPAT);
    expect(await launch(first, { kiroUi: "tui" })).toContain(` --resume-id '${id}'`);
    const b = new KiroBackend(instanceDir, COMPAT);
    const cmd = await launch(b, { kiroUi: "tui" });
    expect(cmd).toContain(` --resume-id '${id}'`);
    expect(cmd).toContain(" --model 'auto'");
    expect(b.consumeLaunchWarning()).toContain(announced());
    const again = new KiroBackend(instanceDir, COMPAT);
    expect(await launch(again, { kiroUi: "tui" })).toContain(" --model 'auto'");
    expect(again.consumeLaunchWarning() ?? "").not.toContain(announced());
  });

  it("a saved model kiro still offers, or a configured model: no switch", async () => {
    const id = "1a2b3c4d-0000-4000-8000-000000000002";
    tui(); v2Session(id, "claude-haiku-4.5");
    await launch(new KiroBackend(instanceDir, COMPAT), { kiroUi: "tui" });
    expect(await launch(new KiroBackend(instanceDir, COMPAT), { kiroUi: "tui" })).not.toContain("--model");
    v2Session(id, RETIRED);
    const own = await launch(new KiroBackend(instanceDir, COMPAT), { kiroUi: "tui", model: "claude-sonnet-4.6" });
    expect(own).toContain(" --model 'claude-sonnet-4.6'");
    expect(own).not.toContain("'auto'");
  });
});

describe("#2648 steps 2 + 4: a model error after the launch", () => {
  it("no model of its own, unforeseen: one restart on kiro's default (announced by that launch), then said once, then quiet", async () => {
    classic(); v1Row("conv-1", RETIRED);
    catalog(null);                                       // the launch cannot foresee it
    const b = new KiroBackend(instanceDir, COMPAT);
    expect(await launch(b)).not.toContain("--model");
    expect(b.onModelError()).toEqual({ kind: "restart", model: "auto" });
    // The restart's launch runs on the default and announces it.
    const restarted = new KiroBackend(instanceDir, COMPAT);
    expect(await launch(restarted)).toContain(" --model 'auto'");
    expect(restarted.consumeLaunchWarning()).toContain(announced());     // the model that failed, read at this launch
    // Still failing on the default: never a second restart — said once, then quiet across restarts.
    expect(restarted.onModelError()).toEqual({ kind: "notify", configured: null });
    const later = new KiroBackend(instanceDir, COMPAT);
    await launch(later);
    expect(later.onModelError()).toEqual({ kind: "quiet" });
  });

  it("a configured retired model is said once and never switched (step 4)", async () => {
    classic(); v1Row("conv-1", RETIRED);
    for (let i = 0; i < 3; i++) {
      const b = new KiroBackend(instanceDir, COMPAT);
      const cmd = await launch(b, { model: RETIRED });
      expect(cmd).toContain(` --model '${RETIRED}'`);
      expect(cmd).not.toContain("'auto'");
      expect(b.onModelError()).toEqual(i === 0 ? { kind: "notify", configured: RETIRED } : { kind: "quiet" });
    }
    expect(readKiroModelRecords(instanceDir).restarted).toEqual([]);
    expect(readKiroModelRecords(instanceDir).switched).toEqual({});
  });

  it("a fresh conversation (nothing resumed) is never restarted for a model error", () => {
    expect(decideKiroModelError(instanceDir, { ownModel: null, launchModel: null, conversation: null }, "auto")).toEqual({ kind: "notify", configured: null });
    expect(decideKiroModelError(instanceDir, { ownModel: null, launchModel: null, conversation: null }, "auto")).toEqual({ kind: "quiet" });
  });

  it("one restart per conversation, even when the restart's launch could not apply the switch", () => {
    const launch = { ownModel: null, launchModel: null, conversation: "conv-9" };
    expect(decideKiroModelError(instanceDir, launch, "auto")).toEqual({ kind: "restart", model: "auto" });
    expect(decideKiroModelError(instanceDir, launch, "auto")).toEqual({ kind: "notify", configured: null });
    expect(decideKiroModelError(instanceDir, { ...launch, conversation: "conv-10" }, "auto")).toEqual({ kind: "restart", model: "auto" });
  });

  it("a restart that cannot be recorded is not made: said instead, and never a restart loop (#2649 review)", () => {
    mkdirSync(join(instanceDir, "kiro-model.json"));                       // the record cannot be replaced
    const launch = { ownModel: null, launchModel: null, conversation: "conv-1" };
    expect(decideKiroModelError(instanceDir, launch, "auto")).toEqual({ kind: "notify", configured: null });
    expect(decideKiroModelError(instanceDir, launch, "auto")).toEqual({ kind: "notify", configured: null });
  });

  it("the restart's record is applied only while the conversation still holds the failed model or cannot be read", async () => {
    classic(); v1Row("conv-1", RETIRED); catalog(null);
    const b = new KiroBackend(instanceDir, COMPAT);
    await launch(b);
    expect(b.onModelError()).toEqual({ kind: "restart", model: "auto" });
    writeFileSync(join(root, "xdg", "kiro-cli", "data.sqlite3"), "not a database");      // unreadable: the record applies
    expect(await launch(new KiroBackend(instanceDir, COMPAT))).toContain(" --model 'auto'");
    rmSync(join(root, "xdg", "kiro-cli", "data.sqlite3")); v1Row("conv-1", "auto");   // kiro saved the default
    expect(await launch(new KiroBackend(instanceDir, COMPAT))).not.toContain("--model");
  });

  it("a damaged record file reads as empty", () => {
    writeFileSync(join(instanceDir, "kiro-model.json"), "[1,2");
    expect(decideKiroModelError(instanceDir, { ownModel: null, launchModel: null, conversation: "c" }, "auto")).toEqual({ kind: "restart", model: "auto" });
  });
});

describe("#2648: the fleet's handling of a kiro model error", () => {
  function lifecycle(verdict: unknown) {
    const notifyInstanceTopic = vi.fn();
    const ctx = {
      fleetConfig: { defaults: { backend: "kiro-cli" }, instances: { worker: { backend: "kiro-cli" } } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataDir: root, getInstanceDir: (n: string) => join(root, "agend", "instances", n), eventLog: { insert: vi.fn() },
      isPlannedRestart: () => false, isClassicInstance: () => false, notifyInstanceTopic, setTopicIcon: vi.fn(), webhookEmit: vi.fn(),
      clearCancelButton: vi.fn(), checkModelFailover: vi.fn(), restartSingleInstance: vi.fn(async () => {}),
    } as any;
    const lc = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn(), kiroModelError: vi.fn(() => verdict) });
    lc.attachIncidentHandlers("worker", daemon as any);
    daemon.emit("pty_error", { name: "worker", type: "model_error", action: "notify", message: "Model unavailable — use /model to switch" });
    return { ctx, notifyInstanceTopic };
  }

  it("restart: the instance is restarted (resuming its conversation), nothing posted", async () => {
    const { ctx, notifyInstanceTopic } = lifecycle({ kind: "restart", model: "auto" });
    await vi.waitFor(() => expect(ctx.restartSingleInstance).toHaveBeenCalledWith("worker"));
    expect(notifyInstanceTopic).not.toHaveBeenCalled();
  });

  it("quiet: nothing posted, no restart", async () => {
    const { ctx, notifyInstanceTopic } = lifecycle({ kind: "quiet" });
    await new Promise(r => setTimeout(r, 10));
    expect(notifyInstanceTopic).not.toHaveBeenCalled();
    expect(ctx.restartSingleInstance).not.toHaveBeenCalled();
  });

  it("notify: a configured model names itself and says AgEnD will not switch it; otherwise the once-per-conversation text", async () => {
    const configured = lifecycle({ kind: "notify", configured: RETIRED });
    await vi.waitFor(() => expect(configured.notifyInstanceTopic).toHaveBeenCalledWith("worker", expect.stringContaining(t("kiro.model_unavailable_configured", "worker", RETIRED))));
    expect(configured.ctx.restartSingleInstance).not.toHaveBeenCalled();
    const plain = lifecycle({ kind: "notify", configured: null });
    await vi.waitFor(() => expect(plain.notifyInstanceTopic).toHaveBeenCalledWith("worker", expect.stringContaining(t("kiro.model_unavailable_once", "worker"))));
  });
});
