import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { adminKey, base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE } from "../src/web-remote-access.js";

const token = "d".repeat(48), roots: string[] = [], fleets: any[] = [], servers: Server[] = [];
const secret = (user: string) => base32Encode(Buffer.from(`secret-for-${user}`.padEnd(20, "#").slice(0, 20)));
const code = (user: string) => hotp(base32Decode(secret(user))!, totpStep(Date.now()));
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  for (const fm of fleets.splice(0)) { fm.settingsConfirmation?.store.close(); fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-host-cli-2793-")); roots.push(dir);
  writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, admins: {
    [adminKey("a", "100")]: { secret: secret("100"), enrolledAt: 1, lastStep: 0, strict: true },
    [adminKey("a", "200")]: { secret: secret("200"), enrolledAt: 1, lastStep: 0 },
  }, outside: false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  const fm: any = new FleetManager(dir); fleets.push(fm);
  fm.fleetConfig = { defaults: { backend: "codex" }, web: { verified_authority: { enabled: true, loopback_only: false, named_link: true, quick_link: true } }, channels: [{ id: "a", type: "telegram", mode: "topic", group_id: "-1001", access: { mode: "locked", allowed_users: ["100", "200"] } }],
    instances: { general: { working_directory: dir, general_topic: true } } };
  fm.configPath = join(dir, "fleet.yaml");
  writeFileSync(fm.configPath, JSON.stringify(fm.fleetConfig));
  writeFileSync(join(dir, "web.token"), token, { mode: 0o600 }); fm.initializeWebSessions();
  const start = vi.spyOn(fm, "startWebInstall").mockResolvedValue({ started: true });
  // This is the actual host writer boundary; no tmux, CLI or vendor process may run.
  vi.spyOn(fm, "promptSettingsChange").mockResolvedValue(undefined);
  const gate = fm.settingsGate();
  let bypass = false;
  const next = (req: any, res: any, url: URL) => handleWebRequest(req, res, url, fm);
  const server = createServer((req, res) => {
    if (req.headers["x-fixture-gateway"]) bindGatewayRequest(req, { surface: "gateway", exposureId: "x", expectedOrigin: req.headers.origin!, isCurrent: () => true } as any);
    const url = new URL(req.url!, "http://localhost");
    if (!(bypass ? false : gate.handle(req, res, url, next)) && !next(req, res, url)) { res.writeHead(404); res.end(); }
  });
  servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const session = (user = "100", gateway = false) => {
    const s = fm.webSessions.create({ tier: "admin", surface: gateway ? "gateway" : "local", label: `admin ${user}`, tokenEpoch: tokenEpoch(token),
      owner: { adapterId: "a", userId: user }, ...(gateway ? { exposureId: "x" } : {}) });
    return { record: s.record, headers: { cookie: `${gateway ? "__Host-agend_session" : "agend_session"}=${s.sessionId}`, origin,
      "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json", "x-forwarded-for": "192.0.2.20", ...(gateway ? { "x-fixture-gateway": "1" } : {}) } };
  };
  const call = async (path: string, s: ReturnType<typeof session>, body?: unknown) => {
    const res = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: s.headers as Record<string, string>, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  const terminal = async (id: string, s: ReturnType<typeof session>) => {
    for (let i = 0; i < 50; i++) {
      const r = await call(`/api/settings/pending/${id}`, s);
      if (!["pending", "applying"].includes(r.body.state)) return r.body;
      await new Promise<void>(r => setImmediate(r));
    }
    throw Error("held operation did not settle");
  };
  return { fm, start, session, call, terminal, gate, bypass: () => { bypass = true; } };
}

it("an enforcing admin's remote Install waits for their OWN code; another admin's code and replay do not start it", async () => {
  const r = await rig(), a = r.session();
  const p = await r.call("/ui/host-install", a, { backend: "grok" });
  expect(p.status).toBe(202);
  expect(p.body.pending_change).toMatchObject({ state: "pending", totp: "ready" });
  expect(r.start).not.toHaveBeenCalled();
  const v = p.body.pending_change, confirm = `/api/settings/pending/${v.id}/confirm-totp`;
  expect((await r.call(confirm, a, { code: code("100"), digest: "0".repeat(64) })).status).toBe(409);
  expect((await r.call(confirm, a, { code: code("200"), digest: v.confirm_digest })).status).toBe(401);
  expect((await r.call(confirm, r.session("200"), { code: code("100"), digest: v.confirm_digest })).status).toBe(404);
  expect(r.start).not.toHaveBeenCalled();
  expect((await r.call(confirm, a, { code: code("100"), digest: v.confirm_digest })).status).toBe(202);
  expect((await r.terminal(v.id, a)).state).toBe("applied");
  expect(r.start).toHaveBeenCalledTimes(1);
  expect(r.start.mock.calls[0]![0]).toBe("grok");
  expect((await r.call(confirm, a, { code: code("100"), digest: v.confirm_digest })).status).toBe(409);
  expect(r.start).toHaveBeenCalledTimes(1);
});

it("the lenient admin installs without an extra confirmation click; an enforcing admin does not change that admin's policy", async () => {
  const r = await rig(), b = r.session("200");
  const p = await r.call("/ui/host-install", b, { backend: "grok" });
  expect(p.status).toBe(202);
  expect((await r.terminal(p.body.pending_change.id, b)).state).toBe("applied");
  expect(r.start).toHaveBeenCalledTimes(1);
});

it("public links are refused before any held change, even for a lenient admin", async () => {
  const r = await rig(), s = r.session("200", true);
  expect((await r.call("/ui/host-install", s, { backend: "grok" })).status).toBe(403);
  expect(r.gate.store.list(s.record.idHash)).toEqual([]);
  expect(r.start).not.toHaveBeenCalled();
});

it("the enforcing admin on the AgEnD computer still needs no code", async () => {
  const r = await rig(), a = r.session();
  delete (a.headers as Record<string, string>)["x-forwarded-for"];
  const p = await r.call("/ui/host-install", a, { backend: "grok" });
  expect(p.status).toBe(202);
  expect((await r.terminal(p.body.pending_change.id, a)).state).toBe("applied");
  expect(r.start).toHaveBeenCalledTimes(1);
});

it("an authenticated direct call cannot bypass the held-change middleware", async () => {
  const r = await rig(); r.bypass();
  expect(await r.call("/ui/host-install", r.session(), { backend: "grok" })).toMatchObject({ status: 403, body: { error: "install_confirmation_required" } });
  expect(r.start).not.toHaveBeenCalled();
});

it("an authority change during the accepted preflight prevents the actual installer dispatch", async () => {
  const r = await rig(), b = r.session("200");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const dispatch = vi.fn();
  r.start.mockImplementation(async (...args: unknown[]) => {
    entered(); await held;
    (args[2] as import("../src/settings-transaction.js").SettingsExecution).complete();
    dispatch(); return { started: true };
  });
  const p = await r.call("/ui/host-install", b, { backend: "grok" });
  expect(p.status).toBe(202); await arrived;
  r.fm.webRemoteAccess().setStrict(adminKey("a", "200"), true);
  release();
  expect((await r.terminal(p.body.pending_change.id, b)).state).toBe("failed");
  expect(dispatch).not.toHaveBeenCalled();
});

it("revoking the requester while their install waits leaves no installer", async () => {
  const r = await rig(), a = r.session();
  const p = await r.call("/ui/host-install", a, { backend: "grok" });
  expect(p.status).toBe(202);
  r.fm.webSessions.revokeByHandle(a.record.handle);
  expect((await r.call(`/api/settings/pending/${p.body.pending_change.id}/confirm-totp`, a, { code: code("100"), digest: p.body.pending_change.confirm_digest })).status).toBe(401);
  expect(r.start).not.toHaveBeenCalled();
});
