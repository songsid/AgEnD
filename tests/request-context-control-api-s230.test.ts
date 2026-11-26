import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { handleRequestContextControlApi, projectRequestContextControl, projectRequestContextNeeds, requestContextControlSnapshot, type RequestContextControlHost, type RequestContextControlView } from "../src/request-context-control-api.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { handleSettingsRequest } from "../src/settings-api.js";

const path = "/api/settings/request-context";
function rig() {
  let verified = false, allowed = true, binding = "fixture-session", continued = true;
  const view: RequestContextControlView = { revision: 2, enabled: true, everActivated: false, phase: "blocked", canChange: true,
    blockers: [{ id: "owner-fixture", kind: "owners", labels: ["Demo worker"] }] };
  const host: RequestContextControlHost = { principal: () => ({ binding, verified, current: () => allowed }),
    snapshot: () => view,
    permitContinuation: (_req, res) => { if (continued) return true; res.writeHead(403); res.end(JSON.stringify({ error: "csrf" })); return false; },
    read: vi.fn(() => view), change: vi.fn((input, actor): RequestContextControlView => {
      if (!actor.current() || !actor.verified) throw Error("owner-required");
      if (input.revision !== view.revision) throw Error("stale");
      if (input.action === "resolve") {
        const blocker = view.blockers.find(row => row.id === input.blockerId && row.action === input.resolution);
        if (!blocker) throw Error("stale");
        view.blockers = view.blockers.filter(row => row !== blocker); view.revision++;
        if (!view.blockers.length) { view.phase = "off"; view.enabled = false; }
      } else Object.assign(view, { revision: view.revision + 1, enabled: input.action !== "disable", phase: input.action === "disable" ? "draining" : "on" });
      return structuredClone(view);
    }) };
  const request = (method = "GET", body?: unknown, url = path, installed = true, throughSettings = false) => {
    const req = Object.assign(new PassThrough(), { method, url, headers: {} }); let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const res: any = { destroyed: false, writableEnded: false, status: 0, text: "", writeHead(status: number) { this.status = status; },
      end(text: string) { this.text = text; this.writableEnded = true; finish(); } };
    const consumed = throughSettings
      ? handleSettingsRequest(req as any, res, new URL(url, "http://localhost"), { requestContextControl: installed ? host : undefined } as any)
      : handleRequestContextControlApi(req as any, res, new URL(url, "http://localhost"), installed ? host : undefined);
    if (body !== undefined) req.end(typeof body === "string" ? body : JSON.stringify(body));
    return { req, consumed, done: async () => { await done; return { status: res.status, body: JSON.parse(res.text) }; } };
  };
  return { host, view, request, verify: (value = true) => { verified = value; }, revoke: () => { allowed = false; },
    replace: () => { binding = "another-session"; }, csrf: () => { continued = false; } };
}
it("an unverified recognized owner can read status but cannot change activation", async () => {
  const r = rig(); expect(await r.request().done()).toEqual({ status: 200, body: { ...r.view, canChange: false } });
  expect(await r.request("POST", { revision: 2, action: "enable" }).done()).toEqual({ status: 403, body: { error: "verification-required" } });
  expect(r.host.change).not.toHaveBeenCalled();
});
it("an absent host stays absent and never probes or enables policy", async () => {
  const r = rig(); expect(await r.request("GET", undefined, path, false).done()).toEqual({ status: 404, body: { error: "not-found" } });
  expect(r.host.read).not.toHaveBeenCalled(); expect(r.host.change).not.toHaveBeenCalled();
});
it("the real Settings router reaches the control before its terminal unknown-route response", async () => {
  const r = rig(); expect((await r.request("GET", undefined, path, true, true).done()).body).toMatchObject({ phase: "blocked", canChange: false });
  r.verify(); expect((await r.request("POST", { revision: 2, action: "disable" }, path, true, true).done()).body).toMatchObject({ phase: "draining" });
});
it.each(["revoke", "replace", "unverify"])("a %s during the body read prevents a host write", async change => {
  const r = rig(); r.verify(); const pending = r.request("POST");
  if (change === "revoke") r.revoke(); else if (change === "replace") r.replace(); else r.verify(false);
  pending.req.end(JSON.stringify({ revision: 2, action: "disable" }));
  expect((await pending.done()).status).toBe(403); expect(r.host.change).not.toHaveBeenCalled();
});
it.each(["revoke", "replace"])("a %s during an awaited read cannot reveal the owner status", async change => {
  const r = rig(); let release!: (value: RequestContextControlView) => void;
  vi.mocked(r.host.read).mockReturnValue(new Promise(resolve => { release = resolve; }));
  const pending = r.request(); if (change === "revoke") r.revoke(); else r.replace(); release(r.view);
  const answer = await pending.done(); expect(answer.status).toBe(403); expect(JSON.stringify(answer.body)).not.toContain("Demo worker");
});
it("Off is an explicit revision-bound owner write, not an optimistic client state", async () => {
  const r = rig(); r.verify();
  expect(await r.request("POST", { revision: 1, action: "disable" }).done()).toEqual({ status: 409, body: { error: "stale" } });
  expect((await r.request("POST", { revision: 2, action: "disable" }).done()).body).toMatchObject({ enabled: false, phase: "draining", revision: 3 });
  expect((await r.request("POST", { revision: 3, action: "check" }).done()).status).toBe(200);
});
it.each([{ revision: 2, action: "enable", authority: "owner" }, { revision: 2, action: "drop-barrier" }, { enabled: true }, "{"])(
  "model/body claims cannot widen the control protocol", async body => {
    const r = rig(); r.verify(); expect((await r.request("POST", body).done()).status).toBe(400); expect(r.host.change).not.toHaveBeenCalled();
  });
it("CSRF refusal runs before reading or dispatching the write", async () => {
  const r = rig(); r.verify(); r.csrf();
  expect(await r.request("POST").done()).toEqual({ status: 403, body: { error: "csrf" } }); expect(r.host.change).not.toHaveBeenCalled();
});
it("a drain resolution carries only the exact offered item/action and cannot be replayed or substituted", async () => {
  const r = rig(); r.verify(); r.view.phase = "draining"; r.view.everActivated = true;
  r.view.blockers = [{ id: "return-fixture", kind: "returns", labels: ["Demo worker"], action: "stop-waiting" }];
  const input = { revision: 2, action: "resolve", blockerId: "return-fixture", resolution: "stop-waiting" };
  expect((await r.request("POST", { ...input, resolution: "withdraw" }).done()).status).toBe(409);
  expect((await r.request("POST", input).done()).body).toMatchObject({ phase: "off", blockers: [], revision: 3 });
  expect((await r.request("POST", input).done()).status).toBe(409);
  expect(r.view.revision).toBe(3);
});
it("unexpected installer/storage errors never expose their private text", async () => {
  const r = rig(); vi.mocked(r.host.read).mockImplementation(() => { throw Error("PRIVATE_SQL_OR_MACHINE_STATE"); });
  expect(await r.request().done()).toEqual({ status: 503, body: { error: "unavailable" } });
});
it("a result lost after the owner changed state is unavailable, never replayed; GET reveals the current revision", async () => {
  const r = rig(); r.verify();
  vi.mocked(r.host.change).mockImplementation(() => {
    Object.assign(r.view, { revision: 3, enabled: false, phase: "draining" }); throw Error("unavailable");
  });
  expect(await r.request("POST", { revision: 2, action: "disable" }).done()).toEqual({ status: 503, body: { error: "unavailable" } });
  expect(r.host.change).toHaveBeenCalledTimes(1);
  expect((await r.request().done()).body).toMatchObject({ revision: 3, phase: "draining" });
  expect(r.host.change).toHaveBeenCalledTimes(1);
});
it("both control methods are routed on quick and named links; the same owner gate still refuses nonowners", async () => {
  expect(isPublicWebRoute("GET", path)).toBe(true); expect(isPublicWebRoute("POST", path)).toBe(true);
  const r = rig(); r.revoke();
  expect((await r.request().done()).status).toBe(403); expect((await r.request("POST").done()).status).toBe(403);
});
it("passive Needs you and stream state are scoped to the same current owner, including before verification", () => {
  const r = rig(), req = {} as any, url = new URL("http://localhost/ui/needs");
  const ordinary = { id: "ordinary" }, item = { id: "cutover", reason: "request_context_cutover", requestContextCutover: r.view };
  expect(projectRequestContextNeeds(req, url, undefined, [ordinary, item])).toEqual([ordinary]);
  expect(projectRequestContextNeeds(req, url, r.host, [item])).toEqual([{ ...item, requestContextCutover: { ...r.view, canChange: false } }]);
  r.verify(); expect(projectRequestContextControl(req, url, r.host, r.view)?.canChange).toBe(true);
  r.revoke(); expect(projectRequestContextNeeds(req, url, r.host, [ordinary, item])).toEqual([ordinary]);
  expect(projectRequestContextControl(req, url, r.host, r.view)).toBeUndefined();
});
it("passive poll/reconnect snapshots neither run readiness nor leak a revoked owner's state", () => {
  const r = rig(), req = {} as any, url = new URL("http://localhost/ui/poll");
  r.host.snapshot = vi.fn(() => r.view);
  expect(requestContextControlSnapshot(req, url, undefined)).toBeUndefined();
  expect(requestContextControlSnapshot(req, url, r.host)).toMatchObject({ phase: "blocked", canChange: false });
  expect(r.host.read).not.toHaveBeenCalled(); expect(r.host.change).not.toHaveBeenCalled();
  r.revoke(); expect(requestContextControlSnapshot(req, url, r.host)).toBeNull();
  r.host.snapshot = () => { throw Error("PRIVATE_FLEET_STATE"); };
  expect(requestContextControlSnapshot(req, url, r.host)).toBeNull();
});
