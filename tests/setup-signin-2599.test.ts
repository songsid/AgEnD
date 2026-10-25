/** Real loopback setup HTTP + confirmation socket, injected inert CLI transport only. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { SetupHost } from "../src/setup-host.js";
import { setupHttp, decideSetup } from "./helpers/setup-confirmation-1423.js";
import { readPendingBackendSignIns } from "../src/backend-signin-pending.js";

const fixtures: { host: SetupHost; dir: string }[] = [];
afterEach(async () => { for (const h of fixtures.splice(0)) { await h.host.shutdown(false, "test cleanup"); rmSync(h.dir, { recursive: true, force: true }); } vi.restoreAllMocks(); });
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function rig(selected: ("codex" | "claude-code" | "kiro-cli" | "antigravity")[] = ["codex"]) {
  const dir = mkdtempSync(join(tmpdir(), "agend-setup-signin-")), logs: string[] = [];
  const state = { auth: "invalid" as "valid" | "invalid", pane: "https://auth.openai.com/codex/device\nTEST-CODE", alive: true, now: performance.now() };
  const transport = { start: vi.fn(async () => {}), capture: vi.fn(async () => state.pane), status: vi.fn(async () => ({ alive: state.alive })), write: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const spawnFleet = vi.fn(), installed = vi.fn(async () => ["codex", "kiro-cli", "claude-code", "antigravity"]), checkAuth = vi.fn(async () => state.auth);
  const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, backendSignIns: selected,
    spawnFleet, now: () => state.now, log: line => logs.push(line), signInDeps: { installed, checkAuth, transport: () => transport } });
  fixtures.push({ host, dir }); const { port, path, code } = await host.start();
  const signed = await setupHttp(port, path + "open", "POST", { code });
  const cookie = String(signed.headers["set-cookie"]).split(";")[0]!;
  const api = (data?: unknown, who = cookie) => setupHttp(port, path + "setup/signins", data ? "POST" : "GET", data, who);
  return { host, dir, logs, state, transport, spawnFleet, installed, checkAuth, port, path, cookie, api };
}
async function commit(h: Awaited<ReturnType<typeof rig>>, web = true) {
  const body = web ? { web_only: true, backend: "codex", working_directory: h.dir, instance_name: "agent-1" }
    : { platform: "telegram", token_env: "AGEND_BOT_TOKEN", backend: "codex", working_directory: h.dir, instance_name: "agent-1", group_id: "-100123", admin_user_id: "42", token: "123456:ABC" };
  const proposed = await setupHttp(h.port, h.path + "api/settings/quickstart/commit", "POST", body, h.cookie);
  expect(proposed.status).toBe(202); expect((await decideSetup(h.dir, proposed.body.pending_change.id)).pending_change.state).toBe("applied");
}
function raw(h: Awaited<ReturnType<typeof rig>>, headers: Record<string, string>, method = "POST", path = "setup/signins") {
  return new Promise<number>((resolve, reject) => { const req = request({ host: "127.0.0.1", port: h.port, path: h.path + path, method,
    headers: { cookie: h.cookie, ...headers } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }); req.on("error", reject); req.end(method === "POST" ? JSON.stringify({ operation: "start", backend: "codex" }) : undefined); });
}
it("authenticates before hints/assets; wrong Origin/Host and public setup cannot start a child", async () => {
  const h = await rig();
  expect((await h.api(undefined, "")).status).toBe(401);
  expect(await raw(h, { origin: "https://foreign.invalid" })).toBe(403);
  expect(await raw(h, { host: "foreign.invalid" })).toBe(403);
  expect(await raw(h, {}, "GET", "setup/signin.js")).toBe(200);
  expect(await raw(h, { cookie: "" }, "GET", "setup/signin.js")).toBe(401);
  // This is the same explicit public/tunnel marker checked on every login request.
  (h.host as any).externalHost = "setup.trycloudflare.com";
  expect(await raw(h, { host: "setup.trycloudflare.com" })).toBe(403);
  (h.host as any).externalHost = null;
  expect(h.transport.start).not.toHaveBeenCalled(); expect(h.installed).not.toHaveBeenCalled();
});
it("same-cookie refresh joins the attempt; hints stay owner-only/in memory and pending IDs are0600", async () => {
  const h = await rig(); const a = await h.api({ operation: "start", backend: "codex" });
  expect(a.status).toBe(200); expect(a.body.login).toMatchObject({ phase: "authorization", code: "TEST-CODE", mine: true });
  const b = await h.api({ operation: "start", backend: "codex" }); expect(b.body.login.id).toBe(a.body.login.id);
  const current = await h.api(); expect(current.body.login.id).toBe(a.body.login.id); expect(h.transport.start).toHaveBeenCalledOnce();
  expect(h.logs.join("\n")).not.toMatch(/TEST-CODE|auth.openai/);
  const stored = readFileSync(join(h.dir, "backend-signin-pending.json"), "utf8");
  expect(JSON.parse(stored)).toEqual({ version: 1, selected: ["codex"], pending: ["codex"] });
  expect(statSync(join(h.dir, "backend-signin-pending.json")).mode & 0o777).toBe(0o600);
});
it("rejects a raw command, unsupported backend and stale revision without input", async () => {
  const h = await rig(); expect((await h.api({ operation: "exec", command: "sh" })).status).toBe(409);
  expect((await h.api({ operation: "start", backend: "antigravity" })).status).toBe(409);
  const started = await h.api({ operation: "start", backend: "codex" });
  const input = await h.api({ operation: "input", id: started.body.login.id, revision: -1, action: { kind: "code", value: "nope" } });
  expect(input.body.error).toBe("signin_action_stale"); expect(h.transport.write).not.toHaveBeenCalled();
});
it("rechecks setup ownership and expiry after the installed probe before starting", async () => {
  const h = await rig(); const installed = deferred<string[]>(); h.installed.mockReturnValue(installed.promise);
  const response = h.api({ operation: "start", backend: "codex" }); await vi.waitFor(() => expect(h.installed).toHaveBeenCalled());
  h.state.now += 16 * 60_000; installed.resolve(["codex"]);
  expect((await response).body.error).toBe("signin_session_expired"); expect(h.transport.start).not.toHaveBeenCalled();
});
it.each([true, false])("skip waits for reap and allows confirmed handoff (web-only: %s)", async web => {
  const h = await rig(["codex", "antigravity"]); await h.api({ operation: "start", backend: "codex" }); await commit(h, web);
  expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(409);
  const close = deferred(); h.transport.close.mockReturnValue(close.promise);
  const skip = h.api({ operation: "skip", backend: "codex" }); await vi.waitFor(() => expect(h.transport.close).toHaveBeenCalled());
  expect(h.spawnFleet).not.toHaveBeenCalled(); close.resolve(); expect((await skip).status).toBe(200);
  expect((await h.api({ operation: "skip", backend: "antigravity" })).body.ready).toBe(true);
  expect(readPendingBackendSignIns(h.dir).pending).toEqual(["codex", "antigravity"]);
  const finish = await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie); expect(finish.status).toBe(202);
  await h.host.shutdown(true, "finished"); expect(h.transport.close).toHaveBeenCalledOnce(); expect(h.spawnFleet).toHaveBeenCalledOnce();
});
it("a failed reap is safe, remains pending and refuses both retry and fleet handoff", async () => {
  const h = await rig(); await h.api({ operation: "start", backend: "codex" }); await commit(h);
  h.transport.close.mockRejectedValue(new Error("vendor private-code here"));
  const skip = await h.api({ operation: "skip", backend: "codex" }); expect(skip.status).toBe(503); expect(skip.body.error).toBe("signin_cleanup_failed");
  expect((await h.api({ operation: "start", backend: "codex" })).status).toBe(503);
  expect((await setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie)).status).toBe(409);
  await h.host.shutdown(true, "forced test shutdown"); expect(h.spawnFleet).not.toHaveBeenCalled(); expect(h.logs.join("\n")).not.toContain("private-code");
});
it("a provider success screen still needs the independent auth probe", async () => {
  const h = await rig(); h.state.pane = "Logged in successfully"; h.state.alive = false;
  const failed = await h.api({ operation: "start", backend: "codex" }); expect(failed.body.login).toMatchObject({ phase: "failed", reason: "auth_unconfirmed" });
  expect(failed.body.pending).toEqual(["codex"]); h.state.auth = "valid";
  const done = await h.api({ operation: "start", backend: "codex" }); expect(done.body.login.phase).toBe("done"); expect(done.body.pending).toEqual([]); expect(done.body.ready).toBe(true);
});
it("a later auth recheck restores an expired backend to the pending list", async () => {
  const h = await rig(); h.state.auth = "valid"; expect((await h.api()).body.ready).toBe(true);
  h.state.auth = "invalid"; expect((await h.api({ operation: "refresh" })).body.pending).toEqual(["codex"]);
});
it("passive sign-in polling cannot extend setup idle lifetime, but a deliberate action can", async () => {
  const h = await rig(); const touch = vi.spyOn(h.host as any, "touch");
  await h.api(); await h.api(); expect(touch).not.toHaveBeenCalled();
  await h.api({ operation: "refresh" }); expect(touch).toHaveBeenCalledOnce();
});
it("the installer checklist cannot be erased, and invalid IDs never persist", async () => {
  const h = await rig(); expect((await h.api({ operation: "select", backends: [] })).body.selected).toEqual(["codex"]);
  expect((await h.api({ operation: "select", backends: ["sh;anything"] })).status).toBe(409);
  expect(readPendingBackendSignIns(h.dir).selected).toEqual(["codex"]); expect(h.transport.start).not.toHaveBeenCalled();
});
it("revocation during the installed probe cannot expose hints or create a child", async () => {
  const h = await rig(), probe = deferred<string[]>(); h.installed.mockReturnValue(probe.promise);
  const response = h.api({ operation: "start", backend: "codex" }); await vi.waitFor(() => expect(h.installed).toHaveBeenCalled());
  (h.host as any).credentials.revoke(); probe.resolve(["codex"]);
  expect((await response).body.error).toBe("signin_session_expired"); expect(h.transport.start).not.toHaveBeenCalled();
});
it("rechecks the committed file after awaited cleanup before granting fleet handoff", async () => {
  const h = await rig(); h.state.auth = "valid"; await h.api(); await commit(h);
  const close = deferred<boolean>(); const closing = vi.spyOn((h.host as any).signIns, "close").mockReturnValue(close.promise);
  const finish = setupHttp(h.port, h.path + "setup/finish", "POST", undefined, h.cookie);
  await vi.waitFor(() => expect(closing).toHaveBeenCalled());
  writeFileSync(join(h.dir, "fleet.yaml"), "instances: {}\n"); close.resolve(true);
  expect((await finish).status).toBe(409); expect(h.spawnFleet).not.toHaveBeenCalled();
});
