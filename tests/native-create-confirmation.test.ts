/** The New Agent request must pass the real settings projection and server-owned approval replay. */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsExecution, settingsFingerprint } from "../src/settings-transaction.js";
import { nativeInstanceConfig } from "../src/native-instance-registry.js";
import { nativeCliAuthorization } from "../src/windows-cli-api.js";
import { createSettingsReplay } from "../src/settings-request-capability.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_SESSION_COOKIE, evaluateWebRequest, type WebGateRequest } from "../src/web-auth.js";
import { WindowsAgents, type WindowsAgent } from "../src/windows-agents.js";
import { FleetWindowsRuntime } from "../src/fleet-windows-runtime.js";
import type { WindowsCliExecutor } from "../src/windows-cli.js";

const TOKEN = "native-confirmation-test-".repeat(3);
const NATIVE_ID = "12345678-1234-4321-abcd-123456789012";
const MACHINE_ID = "12345678-1234-4321-abcd-123456789013";
const BODY = { runtime: "windows", topic_name: "CodexTest", backend: "codex", model: "gpt-6.1-sol", description: "", systemPrompt: "", sandbox: "read-only" };
const stores: SettingsConfirmationStore[] = [];
const roots: string[] = [];
beforeEach(() => vi.stubEnv("AGEND_WINDOWS_CLI", "1"));
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close();
  for (const dir of roots.splice(0)) { if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe confirmation test cleanup"); rmSync(dir, { recursive: true, force: true }); }
});

function harness(tier: "admin" | "read" | "guest" = "admin") {
  const cfg: any = { defaults: { backend: "claude-code" }, instances: {} };
  const sessions = new WebSessionStore();
  const session = sessions.create({ tier, surface: "local", label: "Native create test", tokenEpoch: tokenEpoch(TOKEN),
    ...(tier === "guest" ? { owner: { adapterId: "test", userId: "reader" } } : {}) });
  const save = vi.fn();
  const create = vi.fn(async (profile: Record<string, unknown>, allowed: () => boolean, execution?: SettingsExecution) => {
    expect(execution).toBeInstanceOf(SettingsExecution);
    if (!allowed()) throw Error("Expired native creation authority");
    const agent = { id: NATIVE_ID, name: profile.name, cli: profile.cli, cwd: profile.cwd ?? "C:\\Users\\Test\\.agend-runtime\\workspaces\\" + NATIVE_ID,
      model: profile.model, description: profile.description, instructions: profile.instructions, sandbox: profile.sandbox,
      ...(profile.machineId ? { machineId: profile.machineId } : {}), createdAt: Date.now(), turns: [] } as unknown as WindowsAgent;
    const name = `windows-${NATIVE_ID}`;
    execution!.mutate(() => { cfg.instances[name] = nativeInstanceConfig(agent); save(); });
    execution!.complete();
    return { name, runtime: "windows", agent };
  });
  const context = { webToken: TOKEN, webSessions: sessions, fleetConfig: cfg, nativeInstanceRuntime: () => ({ create }),
    emitSseEvent: vi.fn(), getUiStatus: () => ({ instances: [] }), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as WebApiContext;
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const gate = new SettingsHttpConfirmation(store, {
    principal(req) {
      const allowed = evaluateWebRequest(req as unknown as WebGateRequest, new URL("http://localhost/ui/instances"), TOKEN, sessions, { touch: false });
      if (allowed.kind !== "allow" || allowed.via !== "session" || allowed.session.tier !== "admin") return null;
      return { id: session.sessionId, label: "Native administrator", source: "web_session", current: () => context.webToken === TOKEN,
        localAdmin: () => context.webToken === TOKEN && tier === "admin" };
    },
    baseline: async () => ({ config: cfg, classic: {}, fingerprint: settingsFingerprint(cfg) }),
    snapshot: () => cfg,
  });
  const request = (body: unknown = BODY, authenticated = true) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = new EventEmitter() as unknown as IncomingMessage;
    Object.assign(req, { method: "POST", url: "/ui/instances", headers: { host: "localhost", origin: "http://localhost",
      "idempotency-key": JSON.stringify(body), ...(authenticated ? { cookie: `${WEB_SESSION_COOKIE}=${session.sessionId}`, "x-agend-csrf": csrfTokenFor(session.sessionId) } : {}) }, destroy: vi.fn() });
    let status = 0;
    const rawResponse = { destroyed: false, headersSent: false, once: vi.fn(),
      writeHead(code: number) { status = code; this.headersSent = true; }, end(value: unknown) { resolve({ status, body: JSON.parse(String(value)) }); } };
    const res = rawResponse as unknown as ServerResponse;
    try {
      expect(gate.handle(req, res, new URL("http://localhost/ui/instances"), (rq, rs, url) => handleWebRequest(rq, rs, url, context))).toBe(true);
      queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
    } catch (error) { reject(error); }
  });
  return { cfg, context, create, save, store, request, sessionId: session.sessionId };
}

describe("native Agent creation through settings confirmation", () => {
  it.each([false, true])("holds %s remote creation without allocating a profile, then replays the approved request exactly once", async remote => {
    const h = harness(), body = { ...BODY, ...(remote ? { machineId: MACHINE_ID, directory: "D:\\Projects\\Runtime" } : {}) };
    const pending = await h.request(body);
    expect(pending.status).toBe(202); expect(pending.body.pending_change.state).toBe("pending");
    expect(h.create).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled(); expect(h.cfg.instances).toEqual({});
    const summary = pending.body.pending_change.summary.join("\n");
    expect(summary).toContain("windows"); expect(summary).toContain("read-only"); expect(summary).toContain("CodexTest");
    if (remote) expect(summary).toContain(MACHINE_ID);
    const confirmed = await h.store.decide(pending.body.pending_change.id, "confirm", { label: "Host administrator", current: () => true });
    expect(confirmed.state, JSON.stringify({ outcome: confirmed.outcome, calls: h.create.mock.calls.length, saved: h.save.mock.calls.length, instances: Object.keys(h.cfg.instances) })).toBe("applied"); expect(h.create).toHaveBeenCalledOnce(); expect(h.save).toHaveBeenCalledOnce();
    expect(h.create.mock.calls[0]![0]).toMatchObject({ name: "CodexTest", cli: "codex", sandbox: "read-only", model: "gpt-6.1-sol" });
    if (remote) expect(h.create.mock.calls[0]![0]).toHaveProperty("machineId", MACHINE_ID);
    else expect(h.create.mock.calls[0]![0]).not.toHaveProperty("machineId");
    expect(h.cfg.instances[`windows-${NATIVE_ID}`]).toMatchObject({ runtime: "windows", native_agent_id: NATIVE_ID, display_name: "CodexTest" });
    const repeated = await h.request(body); expect(repeated.body.pending_change.state).toBe("applied"); expect(h.create).toHaveBeenCalledOnce();
  });
  it("does not apply a pending native creation after its original administrator authority expires", async () => {
    const h = harness(), pending = await h.request(); Object.assign(h.context, { webToken: null });
    const outcome = await h.store.decide(pending.body.pending_change.id, "confirm", { label: "Host administrator", current: () => true });
    expect(outcome.state).not.toBe("applied"); expect(h.create).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  });
  it.each(["missing", "read", "guest"])("does not offer native creation to %s sessions", async kind => {
    const h = harness(kind === "missing" ? "admin" : kind as "read" | "guest");
    const response = await h.request(BODY, kind !== "missing");
    expect(response.status).toBe(401); expect(h.create).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  });
  it.each([{ machineId: "not-a-machine" }, { sandbox: "danger-full-access" }, { executable: "private-path" }, { native_agent_id: NATIVE_ID }, { branch: "not-supported" }, { backend: "unknown" }])("rejects invalid or unapproved native creation fields before proposing %j", async patch => {
    const h = harness(), response = await h.request({ ...BODY, ...patch });
    expect(response.status).toBe(400); expect(h.create).not.toHaveBeenCalled(); expect(h.store.list(h.sessionId)).toEqual([]);
  });
  it.each([false, true])("persists a real native profile and Fleet identity only after approval (remote=%s)", async remote => {
    const h = harness(), root = mkdtempSync(join(tmpdir(), "agend-native-confirmation-")); roots.push(root);
    const fleetPath = join(root, "fleet.json"), profilePath = join(root, "windows-agents.json");
    const prepareWorkspace = vi.fn(async (id: string) => `C:\\Users\\Test\\Managed\\${id}`);
    const start = vi.fn(() => { throw Error("Creation must not start any CLI"); });
    const bridge = { prepareWorkspace, start, get: () => null, hasActiveTask: () => false } as unknown as WindowsCliExecutor;
    const profiles = new WindowsAgents(root, bridge);
    const runtime = new FleetWindowsRuntime({ owner: { dataDir: root }, fleet: () => h.cfg, save: () => { h.save(); writeFileSync(fleetPath, JSON.stringify(h.cfg)); },
      emit: vi.fn(), stopping: () => false, validateMachine: vi.fn(), machineAvailable: () => true }, { store: profiles, bridge });
    const create = vi.spyOn(runtime, "create"); Object.assign(h.context, { nativeInstanceRuntime: () => runtime });
    const body = { ...BODY, ...(remote ? { machineId: MACHINE_ID } : {}) }, pending = await h.request(body);
    expect(pending.status).toBe(202); expect(prepareWorkspace).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(existsSync(profilePath)).toBe(false); expect(existsSync(fleetPath)).toBe(false);
    const confirmed = await h.store.decide(pending.body.pending_change.id, "confirm", { label: "Host administrator", current: () => true });
    expect(confirmed.state, JSON.stringify(confirmed.outcome)).toBe("applied"); expect(create).toHaveBeenCalledOnce(); expect(h.save).toHaveBeenCalledOnce();
    const saved = new WindowsAgents(root, bridge).list(); expect(saved).toHaveLength(1);
    const agent = saved[0]!, name = `windows-${agent.id}`;
    expect(agent).toMatchObject({ name: "CodexTest", cli: "codex", model: "gpt-6.1-sol", sandbox: "read-only", fleet_instance: name });
    expect(agent.cwd).toBe(`C:\\Users\\Test\\Managed\\${agent.id}`);
    expect(JSON.parse(readFileSync(fleetPath, "utf8")).instances[name]).toMatchObject({ runtime: "windows", native_agent_id: agent.id, display_name: "CodexTest", model: "gpt-6.1-sol" });
    if (remote) { expect(agent.machineId).toBe(MACHINE_ID); expect(prepareWorkspace).toHaveBeenCalledWith(agent.id, expect.any(Function), MACHINE_ID); }
    else expect(prepareWorkspace).toHaveBeenCalledWith(agent.id, expect.any(Function));
    await h.request(body); expect(create).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
  });
});

describe("native administration continuation", () => {
  it("requires a server-owned, current local administrator capability limited to the creation route", () => {
    const ctx = { webToken: TOKEN }, snapshot = {};
    const execution = new SettingsExecution({ current: () => true, snapshot: () => snapshot });
    const url = new URL("http://localhost/ui/instances");
    const external = { method: "POST", headers: { host: "localhost" } } as IncomingMessage;
    expect(nativeCliAuthorization(external, url, ctx)).toBe(false);
    const replay = (method: string, path: string, localAdmin: () => boolean) => createSettingsReplay({ method, url: path, body: Buffer.from(JSON.stringify(BODY)), binding: "test", localAdmin }, execution);
    try {
      expect(nativeCliAuthorization(replay("POST", "/ui/instances", () => false), url, ctx)).toBe(false);
      expect(nativeCliAuthorization(replay("POST", "/ui/instances", () => true), url, ctx)).toBe(true);
      expect(nativeCliAuthorization(replay("POST", "/ui/windows-cli/tasks", () => true), new URL("http://localhost/ui/windows-cli/tasks"), ctx)).toBe(false);
      expect(nativeCliAuthorization(replay("PATCH", "/ui/instances", () => true), url, ctx)).toBe(false);
      execution.cancel(); expect(nativeCliAuthorization(replay("POST", "/ui/instances", () => true), url, ctx)).toBe(false);
    } finally { execution.close(); }
  });
});

describe("native creation fields remain scoped to their schema-owned effect", () => {
  it("includes selected sandbox and remote identity in the confirmation fingerprint", () => {
    const cfg: any = { defaults: {}, instances: {} };
    const project = (body: unknown) => prepareSettingsEffect("POST", "/ui/instances", body, { config: cfg, classic: {} }).diff!;
    const readOnly = project(BODY), write = project({ ...BODY, sandbox: "workspace-write" }), remote = project({ ...BODY, machineId: MACHINE_ID });
    expect(readOnly.fingerprint).not.toBe(write.fingerprint); expect(readOnly.fingerprint).not.toBe(remote.fingerprint);
    expect(write.summary.join("\n")).toContain("workspace-write"); expect(remote.summary.join("\n")).toContain(MACHINE_ID);
  });
  it("projects native identity without Linux channel effects and confirms schema-owned tag labels", () => {
    const cfg: any = { defaults: {}, instances: {}, channels: [{ id: "main", type: "telegram", group_id: "-1001" }] };
    const effect = prepareSettingsEffect("POST", "/ui/instances", { ...BODY, tags: ["review", "windows"] }, { config: cfg, classic: {} });
    expect(effect.diff?.authority).toEqual({ connections: [], primaryGeneral: false, unknown: false });
    expect(effect.diff?.summary.join("\n")).toContain("review"); expect(effect.diff?.summary.join("\n")).not.toMatch(/channels|group_id/);
  });
  it.each(["runtime", "machineId", "sandbox"])("still refuses an unknown free-text %s outside native creation", key => {
    expect(() => settingsChangeDiff({}, { unknown: { [key]: "sensitive-canary" } }, { operation: "unsupported" })).toThrow("unsupported_sensitive_effect");
  });
});
