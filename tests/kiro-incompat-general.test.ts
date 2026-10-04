/**
 * kiro V1 → V3 migration, P1: when the installed kiro-cli cannot run a kiro
 * instance as configured (#1109), every General hears it as an agent —
 * `[system:kiro-incompat]`, held in the delivery outbox until it is taken —
 * and can look the facts up with kiro_engine_status.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryOutbox, DURABLE_DELIVERY_MAX_AGE_MS, SYSTEM_NOTICE_KIND, SYSTEM_NOTICE_MAX_AGE_MS } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { InstanceLifecycle, type IncidentEventSource, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setLocale, t } from "../src/locale.js";
import { UnsupportedCliError } from "../src/backend/types.js";
import { BackendOutageTracker } from "../src/backend-outage.js";
import { kiroEngineCandidates, kiroEngineStatus } from "../src/kiro-engine-status.js";
import { recordKiroLaunch } from "../src/backend/kiro-engine-ledger.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import type { KiroCliCompatibility } from "../src/backend/kiro.js";

const dirs: string[] = [];
const scratch = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
beforeEach(() => setLocale("en"));
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const REASON = "kiro-cli 3.0.0 no longer offers the legacy UI (--legacy-ui) this instance runs on.";
const notices = (outbox: DeliveryOutbox) => outbox.listPending().filter(d => d.kind === SYSTEM_NOTICE_KIND);

describe("a system notice in the delivery outbox", () => {
  it("is a fleet_inbound held for its target, admitted once per key", () => {
    const outbox = new DeliveryOutbox(join(scratch("agend-notice-"), "outbox.db"), "manager");
    try {
      expect(outbox.admitSystemNotice("general", "k1", "[system:x] hello")).toBe(true);
      expect(outbox.admitSystemNotice("general", "k1", "[system:x] hello")).toBe(false);
      const [row] = notices(outbox);
      expect(row).toMatchObject({ targetInstance: "general", state: "queued", sourceInstance: "agend-system" });
      expect(row.payload).toMatchObject({ type: "fleet_inbound", content: "[system:x] hello" });
    } finally { outbox.close(); }
  });

  it("waits for its target past the ordinary 24h, across a manager restart; ordinary deliveries keep 24h (#1174 r1)", () => {
    const db = join(scratch("agend-notice-"), "outbox.db");
    const first = new DeliveryOutbox(db, "manager-1");
    first.admitSystemNotice("general", "k1", "[system:x] hello");
    first.admit({ operationId: "op", sourceKey: "ordinary", sourceInstance: "w", sourceDaemonBootId: "b", targetInstance: "general", kind: "send_to_instance", payload: { type: "fleet_inbound", content: "hi" } });
    first.close();
    const second = new DeliveryOutbox(db, "manager-2");
    try {
      second.recoverForBoot("manager-2");
      // The two rows may be admitted a millisecond apart: judge by the later one.
      const created = Math.max(...second.listPending().map(d => Date.parse(d.createdAt!)));
      const ordinaryCreated = Date.parse(second.listPending().find(d => d.kind !== SYSTEM_NOTICE_KIND)!.createdAt!);
      expect(second.nextExpiryAt()).toBe(new Date(ordinaryCreated + DURABLE_DELIVERY_MAX_AGE_MS).toISOString());
      expect(second.expireStale(created + DURABLE_DELIVERY_MAX_AGE_MS + 1)).toBe(1);   // the ordinary one only
      expect(notices(second)).toHaveLength(1);
      expect(second.expireStale(created + SYSTEM_NOTICE_MAX_AGE_MS + 1)).toBeGreaterThanOrEqual(1);
      expect(notices(second)).toEqual([]);
    } finally { second.close(); }
    // Alone in the outbox, its expiry is the longer one.
    const alone = new DeliveryOutbox(join(scratch("agend-notice-"), "outbox.db"), "manager-1");
    try {
      alone.admitSystemNotice("general", "k1", "[system:x] hello");
      expect(alone.nextExpiryAt()).toBe(new Date(Date.parse(notices(alone)[0].createdAt!) + SYSTEM_NOTICE_MAX_AGE_MS).toISOString());
    } finally { alone.close(); }
  });

  it("a target that is not ready yet after a day keeps it waiting, rather than failing it", () => {
    const outbox = new DeliveryOutbox(join(scratch("agend-notice-"), "outbox.db"), "manager-1");
    try {
      outbox.admitSystemNotice("general", "k1", "[system:x] hello", new Date(Date.now() - DURABLE_DELIVERY_MAX_AGE_MS - 60_000));
      const claimed = outbox.claimNext("manager-1", () => "general-boot", new Set())!;
      expect(outbox.retryBeforeBegin(claimed.deliveryId, "general-boot", claimed.attemptNo, "not ready")).toBe(true);
      expect(outbox.get(claimed.deliveryId)?.state).toBe("retry_wait");
    } finally { outbox.close(); }
  });

  it("a notice that fails is not answered with a failure notice to nobody", () => {
    const outbox = new DeliveryOutbox(join(scratch("agend-notice-"), "outbox.db"), "manager");
    try {
      outbox.admitSystemNotice("general", "k1", "[system:x] hello");
      outbox.failBeforeBegin(notices(outbox)[0].deliveryId, "target gone");
      expect(outbox.listPending().filter(d => d.kind === "delivery_outcome_notice")).toEqual([]);
    } finally { outbox.close(); }
  });
});

function makeFleet(instances: Record<string, unknown>) {
  const dataDir = scratch("agend-kiro-incompat-");
  const fm = new FleetManager(dataDir);
  fm.fleetConfig = { defaults: { backend: "kiro-cli", startup: { concurrency: 4, stagger_delay_ms: 0 } }, instances } as any;
  const outbox = new DeliveryOutbox(join(dataDir, "outbox.db"), "manager");
  Object.assign(fm, { notifyFleetError: vi.fn(), ensureDeliveryOutbox: () => {}, deliveryOutbox: outbox });
  const cleanup = () => {
    fm.stormWindow.shutdown(); fm.spawnGate.shutdown();
    for (const m of ["startupRetries", "startupRetryNotices", "unsupportedCliNotices", "kiroIncompatNotices"]) {
      for (const p of (fm as any)[m].values()) clearTimeout(p.timer);
    }
    outbox.close();
  };
  return { fm, outbox, cleanup };
}

describe("General hears a kiro incompatibility", () => {
  beforeEach(() => vi.useFakeTimers());

  it("refused at start: one notice per General, naming every refused kiro instance and the reason", async () => {
    const { fm, outbox, cleanup } = makeFleet({
      general: { general_topic: true }, "general-tg": { general_topic: true }, a: {}, b: {},
    });
    vi.spyOn(fm, "startInstance").mockRejectedValue(new UnsupportedCliError(REASON));
    try {
      await (fm as any).startInstancesWithConcurrency([["a", {}], ["b", {}]], false);
      expect(notices(outbox)).toEqual([]);             // aggregated first, like the operator's notice
      await vi.advanceTimersByTimeAsync(1_000);
      const sent = notices(outbox);
      expect(sent.map(d => d.targetInstance).sort()).toEqual(["general", "general-tg"]);
      for (const d of sent) expect(d.payload.content).toBe(t("fleet.kiro_incompat_general", "a, b", REASON));
      expect(String(sent[0].payload.content)).toMatch(/^\[system:kiro-incompat\]/);
    } finally { cleanup(); }
  });

  it("the same refusal again the same day is not sent again", async () => {
    const { fm, outbox, cleanup } = makeFleet({ general: { general_topic: true }, a: {} });
    try {
      fm.queueKiroIncompatNotice("a", REASON);
      await vi.advanceTimersByTimeAsync(1_000);
      fm.queueKiroIncompatNotice("a", REASON);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(notices(outbox)).toHaveLength(1);
    } finally { cleanup(); }
  });

  it("a ClassicBot kiro instance counts, though it is not in fleet.yaml and the fleet default is another backend (#1174 r1)", async () => {
    const { fm, outbox, cleanup } = makeFleet({ general: { general_topic: true } });
    (fm.fleetConfig as any).defaults.backend = "claude-code";
    (fm as any).classicChannels = {
      getAll: () => [{ instanceName: "classic-kiro", backend: "kiro-cli", channelId: "c1" }],
      getChannelIdByInstance: (n: string) => n === "classic-kiro" ? "c1" : undefined,
      getBackendByInstance: (n: string, d?: string) => n === "classic-kiro" ? "kiro-cli" : d ?? "claude-code",
    };
    try {
      fm.queueKiroIncompatNotice("classic-kiro", REASON);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(notices(outbox).map(d => d.payload.content)).toEqual([t("fleet.kiro_incompat_general", "classic-kiro", REASON)]);
    } finally { cleanup(); }
  });

  it("an instance on another backend is not a kiro incompatibility", async () => {
    const { fm, outbox, cleanup } = makeFleet({ general: { general_topic: true }, c: { backend: "claude-code" } });
    try {
      fm.queueKiroIncompatNotice("c", REASON);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(notices(outbox)).toEqual([]);
    } finally { cleanup(); }
  });

  it("refused at a respawn (kiro-cli replaced itself): the lifecycle passes it on; other endings do not", async () => {
    const queueKiroIncompatNotice = vi.fn();
    const dataDir = scratch("agend-kiro-incompat-lc-");
    const ctx = {
      fleetConfig: { defaults: { backend: "kiro-cli" }, instances: { general: { general_topic: true }, "kiro-a": {} } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dataDir,
      getInstanceDir: (name: string) => { const d = join(dataDir, "instances", name); mkdirSync(d, { recursive: true }); return d; },
      eventLog: { insert: vi.fn() },
      isPlannedRestart: () => false, isClassicInstance: () => false,
      notifyInstanceTopic: vi.fn(), notifyFleetError: vi.fn(), setTopicIcon: vi.fn(), notifyNormalExit: vi.fn(async () => {}),
      instanceIpcClients: new Map(), ipcStoppingInstances: new Set(), sessionRegistry: new Map(),
      backendOutage: new BackendOutageTracker(), webhookEmit: vi.fn(),
      queueKiroIncompatNotice,
    } as unknown as LifecycleContext;
    const lifecycle = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() }) as IncidentEventSource & EventEmitter;
    lifecycle.attachIncidentHandlers("kiro-a", daemon);
    vi.useRealTimers();
    daemon.emit("supervision_ended", { name: "kiro-a", reason: "crash retries exhausted", remedy: "x" });
    daemon.emit("supervision_ended", { name: "kiro-a", reason: REASON, remedy: "x", cause: "cli_unsupported" });
    await new Promise(r => setImmediate(r));
    expect(queueKiroIncompatNotice.mock.calls).toEqual([["kiro-a", REASON]]);
  });
});

const COMPAT_3: KiroCliCompatibility = {
  version: "kiro-cli 3.0.0", supportsLegacyUi: false, supportsTui: true, supportsV3: true,
  agentEngines: ["v2", "v3"], supportsEffortFlag: true, source: "help",
};
const SNAPSHOT = () => ({ binaryPath: "/usr/bin/kiro-cli", compatibility: COMPAT_3, at: "2026-10-04T00:00:00.000Z" });

describe("kiro_engine_status", () => {
  it("reports each kiro instance's UI, next launch or refusal, recorded launches and V3 session", () => {
    const agendHome = scratch("agend-kes-");
    recordKiroLaunch({ instance: "legacy-one", workingDirectory: "/w1", credentialProfile: null, kiroVersion: "kiro-cli 2.27.1", ui: "legacy", flags: ["--legacy-ui", "--agent-engine=v1"] }, join(agendHome, "kiro-engine-ledger.json"));
    mkdirSync(join(agendHome, "kiro-v3", "instances"), { recursive: true });
    mkdirSync(join(agendHome, "kiro-v3", "claims"), { recursive: true });
    writeFileSync(join(agendHome, "kiro-v3", "instances", "v3-one.json"), JSON.stringify({ bucket: "b", credentialProfile: null, id: "sess_x", since: 0, known: [] }));
    writeFileSync(join(agendHome, "kiro-v3", "claims", "sess_x"), "v3-one\n");
    writeFileSync(join(agendHome, "kiro-v3", "instances", "tui-one.json"), "{oops");
    const fleet = {
      defaults: { backend: "kiro-cli" },
      instances: { "legacy-one": {}, "tui-one": { kiro_ui: "tui" }, "v3-one": { kiro_ui: "v3" }, claude: { backend: "claude-code" } },
    } as any;
    const status = kiroEngineStatus(kiroEngineCandidates(fleet), { agendHome, snapshot: SNAPSHOT });
    expect(status.kiro_cli).toEqual({ binary: "/usr/bin/kiro-cli", version: "kiro-cli 3.0.0", probed_at: "2026-10-04T00:00:00.000Z" });
    const by = Object.fromEntries(status.instances.map(i => [i.name, i]));
    expect(Object.keys(by).sort()).toEqual(["legacy-one", "tui-one", "v3-one"]);
    expect(by["legacy-one"].kiro_ui).toBe("legacy");
    expect(by["legacy-one"].next_launch).toMatchObject({ refused: expect.stringContaining("no longer offers the legacy UI") });
    expect(by["legacy-one"].last_launch).toMatchObject({ kiroVersion: "kiro-cli 2.27.1", flags: ["--legacy-ui", "--agent-engine=v1"] });
    expect(by["legacy-one"].history).toHaveLength(1);
    expect(by["legacy-one"].v3).toEqual({ kind: "none" });
    expect(by["tui-one"].next_launch).toEqual({ flags: ["--tui", "--agent-engine=v2"] });
    expect(by["tui-one"].last_launch).toBeNull();
    expect(by["tui-one"].v3).toEqual({ kind: "unreadable" });
    expect(by["v3-one"].v3).toEqual({ kind: "owned", id: "sess_x", claimHeld: true, credentialProfile: null });
  });

  it("probes nothing: with no launch since the fleet started it says so; a kiro-cli that did not answer is reported as such (#1174 r1)", () => {
    const candidates = kiroEngineCandidates({ defaults: { backend: "kiro-cli" }, instances: { a: {} } } as any);
    const agendHome = scratch("agend-kes-");
    const none = kiroEngineStatus(candidates, { agendHome, snapshot: () => null });
    expect(none.kiro_cli).toEqual({ binary: null, version: null, probed_at: null });
    expect(none.instances[0].next_launch).toMatchObject({ unknown: expect.stringContaining("has not been probed") });
    const silent = () => ({ ...SNAPSHOT(), binaryPath: "kiro-cli", compatibility: { ...COMPAT_3, source: "unknown" as const, version: undefined } });
    expect(kiroEngineStatus(candidates, { agendHome, snapshot: silent }).instances[0].next_launch)
      .toMatchObject({ unknown: expect.stringContaining("did not answer") });
  });

  it("a fresh-start mark, a claim no longer held, and a mark that is not a real time (#1174 r1)", () => {
    const agendHome = scratch("agend-kes-");
    mkdirSync(join(agendHome, "kiro-v3", "instances"), { recursive: true });
    writeFileSync(join(agendHome, "kiro-v3", "instances", "a.json"), JSON.stringify({ bucket: "b", credentialProfile: "work", id: null, since: Date.parse("2026-10-03T02:00:00.000Z"), known: [] }));
    writeFileSync(join(agendHome, "kiro-v3", "instances", "b.json"), JSON.stringify({ bucket: "b", credentialProfile: null, id: "sess_gone", since: 0, known: [] }));
    writeFileSync(join(agendHome, "kiro-v3", "instances", "c.json"), JSON.stringify({ bucket: "b", credentialProfile: null, id: null, since: 1e20, known: [] }));
    const fleet = { defaults: { backend: "kiro-cli" }, instances: { a: {}, b: {}, c: {} } } as any;
    const by = Object.fromEntries(kiroEngineStatus(kiroEngineCandidates(fleet), { agendHome, snapshot: () => null }).instances.map(i => [i.name, i.v3]));
    expect(by.a).toEqual({ kind: "fresh", since: "2026-10-03T02:00:00.000Z", credentialProfile: "work" });
    expect(by.b).toEqual({ kind: "owned", id: "sess_gone", claimHeld: false, credentialProfile: null });
    expect(by.c).toEqual({ kind: "unreadable" });
  });

  it("includes ClassicBot kiro instances, launched from the fleet defaults; excludes other backends (#1174 r1)", () => {
    const fleet = { defaults: { backend: "claude-code", kiro_ui: "tui" }, instances: { general: {} } } as any;
    const classic = {
      getAll: () => [{ instanceName: "classic-kiro", backend: "kiro-cli" }, { instanceName: "classic-claude" }],
      getBackendByInstance: (_n: string, d?: string) => d ?? "claude-code",
    };
    expect(kiroEngineCandidates(fleet, classic)).toEqual([{ name: "classic-kiro", kiroUi: "tui", credentialProfile: null, classic: true }]);
  });

  it("reports the credential profile the launch resolves to, not the raw setting (#1174 r1)", () => {
    const fleet = { defaults: { backend: "kiro-cli", backend_options: { "kiro-cli": { credential_profile: " home " } } }, instances: { a: { backend_options: { "kiro-cli": { credential_profile: " work " } } }, b: {} } } as any;
    const by = Object.fromEntries(kiroEngineCandidates(fleet).map(c => [c.name, c.credentialProfile]));
    expect(by).toEqual({ a: "work", b: "home" });
  });

  it("the tool answers for one kiro instance, ClassicBot ones too, and refuses a name that is not one", async () => {
    const handler = outboundHandlers.get("kiro_engine_status")!;
    const ctx = {
      fleetConfig: { defaults: { backend: "claude-code" }, instances: { a: { backend: "kiro-cli" }, c: {} } },
      classicChannels: { getAll: () => [{ instanceName: "classic-kiro", backend: "kiro-cli" }] },
    } as any;
    const call = (args: unknown) => new Promise<{ result: any; error?: string }>(resolve => handler(ctx, args as never, (result: any, error?: string) => resolve({ result, error }), undefined as never));
    const one = await call({ name: "a" });
    expect(one.error).toBeUndefined();
    expect(one.result.instances.map((i: { name: string }) => i.name)).toEqual(["a"]);
    expect((await call({ name: "classic-kiro" })).result.instances[0]).toMatchObject({ name: "classic-kiro", classic: true });
    expect((await call({ name: "c" })).error).toMatch(/not a kiro-cli instance/);
  });
});

describe("the compatibility kiro_engine_status reads", () => {
  it("is the one each kiro launch was judged by, published as it is built", async () => {
    const { KiroBackend, lastKiroCompatibilitySnapshot } = await import("../src/backend/kiro.js");
    const backend = new KiroBackend(scratch("agend-kes-inst-"), COMPAT_3);
    expect(() => backend.buildCommand({ workingDirectory: scratch("agend-kes-w-"), instanceDir: scratch("i-"), instanceName: "x", mcpServers: {}, kiroUi: "tui" })).not.toThrow();
    expect(lastKiroCompatibilitySnapshot()).toMatchObject({ compatibility: COMPAT_3 });
    expect(() => backend.buildCommand({ workingDirectory: scratch("agend-kes-w-"), instanceDir: scratch("i-"), instanceName: "x", mcpServers: {} })).toThrow(UnsupportedCliError);
    expect(lastKiroCompatibilitySnapshot()?.compatibility).toBe(COMPAT_3);   // a refused launch publishes it too
  });
});

describe("the kiro-engine-migration skill", () => {
  it("is General's, and every tool it tells General to call is one General has", async () => {
    const { readFileSync } = await import("node:fs");
    const { toolsFor } = await import("../src/tool-permissions.js");
    const skill = readFileSync(new URL("../src/general-knowledge/skills/kiro-engine-migration/SKILL.md", import.meta.url), "utf8");
    expect(skill).toMatch(/^---\nname: kiro-engine-migration\n[\s\S]*?roles: \[general\]\n---/);
    expect(skill).toContain("[system:kiro-incompat]");
    const general = toolsFor("general");
    for (const tool of ["kiro_engine_status"]) {
      expect(skill).toContain(`\`${tool}\``);
      expect(general.has(tool)).toBe(true);
    }
    // The notice General receives points at this skill and this tool by name.
    expect(t("fleet.kiro_incompat_general", "a", "r")).toContain("kiro-engine-migration");
    expect(t("fleet.kiro_incompat_general", "a", "r")).toContain("kiro_engine_status");
  });
});
