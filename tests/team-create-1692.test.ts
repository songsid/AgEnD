/**
 * #1692 (follow-up of #1689; design: the comment on #1692): a team created on the web goes through the same path as the
 * create_team tool (commitTeamCreate) — members must be fleet.yaml's instances, an existing team is never overwritten,
 * a name every object already has is not a team name, a failed save undoes the create, and the web write is
 * re-authorized once its body is in. The real shared function, MCP handler and route handler.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { commitTeamCreate, outboundHandlers } from "../src/outbound-handlers.js";
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";

const token = "t".repeat(48);
type Fleet = { instances: Record<string, unknown>; teams?: Record<string, { members: string[]; description?: string }> };
const fleet = (): Fleet => ({ instances: { alpha: {}, beta: {} }, teams: { core: { members: ["alpha"], description: "The core" } } });

function post(body: unknown, f: Fleet, save: () => void = () => {}) {
  const saveFleetConfig = vi.fn(save);
  return new Promise<{ status: number; body: any; saved: number }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/teams", headers: { host: "127.0.0.1:19280", "x-agend-token": token, "content-type": "application/json" }, destroy: vi.fn() });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
      end: (t = "") => resolve({ status, body: t ? JSON.parse(String(t)) : null, saved: saveFleetConfig.mock.calls.length }) });
    handleWebRequest(req as never, res as never, new URL("/ui/teams", "http://127.0.0.1:19280"), { webToken: token, fleetConfig: f, saveFleetConfig, logger: { debug() {}, info() {}, error() {} } } as never);
    req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end");
  });
}

describe("POST /ui/teams goes through the create_team path", () => {
  it("a normal create: the team as asked (repeats dropped), saved once", async () => {
    const f = fleet();
    const r = await post({ name: "ops", members: ["alpha", "beta", "alpha"], description: " Ops " }, f);
    expect([r.status, r.body, r.saved, f.teams!.ops]).toEqual([200, { created: "ops", members: ["alpha", "beta"] }, 1, { members: ["alpha", "beta"], description: "Ops" }]);
  });
  it("an unknown member — or an inherited name like constructor — is refused (400) and nothing is saved", async () => {
    const outcomes = [];
    for (const m of ["ghost", "constructor", "__proto__", "toString"]) {
      const f = fleet();
      const r = await post({ name: "ops", members: ["alpha", m] }, f);
      outcomes.push([m, r.status, r.saved, Object.hasOwn(f.teams!, "ops")]);
    }
    expect(outcomes).toEqual(["ghost", "constructor", "__proto__", "toString"].map((m) => [m, 400, 0, false]));
  });
  it("an existing team is never overwritten (409): its members and description stay", async () => {
    const f = fleet();
    const r = await post({ name: "core", members: ["beta"], description: "Taken over" }, f);
    expect([r.status, r.body.error, r.saved, f.teams!.core]).toEqual([409, "Team already exists: core", 0, { members: ["alpha"], description: "The core" }]);
  });
  it("a name every object already has is not a team name (400)", async () => {
    const outcomes = [];
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const f = fleet();
      const r = await post({ name, members: ["alpha"] }, f);
      outcomes.push([name, r.status, r.saved, Object.hasOwn(f.teams!, name)]);
    }
    expect(outcomes).toEqual(["constructor", "toString", "hasOwnProperty", "valueOf"].map((n) => [n, 400, 0, false]));
  });
  it("a save that fails undoes the create (500) — a teams map made just now goes too", async () => {
    const failing = () => { throw new Error("EIO: i/o error, fsync"); };
    const withTeams = fleet();
    const a = await post({ name: "ops", members: ["alpha"] }, withTeams, failing);
    const bare: Fleet = { instances: { alpha: {} } };
    const b = await post({ name: "ops", members: ["alpha"] }, bare, failing);
    expect([a.status, Object.keys(withTeams.teams!), b.status, Object.hasOwn(bare, "teams")]).toEqual([500, ["core"], 500, false]);
  });
  it("re-authorized once the body is in: a session revoked meanwhile creates nothing (401); the control is 200", async () => {
    const outcomes: unknown[] = [];
    for (const revoke of [false, true]) {
      const f = fleet();
      const sessions = new WebSessionStore();
      const s = sessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
      const saveFleetConfig = vi.fn();
      const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/teams", destroy: vi.fn(),
        headers: { host: "127.0.0.1:19280", cookie: `agend_session=${s.sessionId}`, origin: "http://127.0.0.1:19280", "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" } });
      const status = await new Promise<number>((resolve) => {
        let code = 0;
        const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { code = c; }, end: () => resolve(code) });
        handleWebRequest(req as never, res as never, new URL("/ui/teams", "http://127.0.0.1:19280"), { webToken: token, webSessions: sessions, fleetConfig: f, saveFleetConfig, logger: { debug() {}, info() {}, error() {} } } as never);
        if (revoke) sessions.revokeById(s.sessionId);
        req.emit("data", Buffer.from(JSON.stringify({ name: "ops", members: ["alpha"] }))); req.emit("end");
      });
      outcomes.push([revoke, status, saveFleetConfig.mock.calls.length, Object.hasOwn(f.teams!, "ops")]);
    }
    expect(outcomes).toEqual([[false, 200, 1, true], [true, 401, 0, false]]);
  });
});

describe("the create_team tool (agents): the same path", () => {
  const run = (args: Record<string, unknown>, f: Fleet = fleet(), save: () => void = () => {}) => {
    let out: { result: unknown; error?: string } = { result: null };
    void outboundHandlers.get("create_team")!({ fleetConfig: f, saveFleetConfig: save } as never, args, (result: unknown, error?: string) => { out = { result, error }; }, {} as never);
    return { out, f };
  };
  it("creates; refuses an existing team, a prototype name and an unknown member; a failed save leaves no team", () => {
    const ok = run({ name: "ops", members: ["beta"] });
    const exists = run({ name: "core", members: ["beta"] });
    const proto = run({ name: "constructor", members: ["beta"] });
    const unknown = run({ name: "ops", members: ["ghost"] });
    const failed = run({ name: "ops", members: ["beta"] }, fleet(), () => { throw new Error("EIO"); });
    expect([ok.out, exists.out.error, exists.f.teams!.core, proto.out.error, unknown.out.error, failed.out.error?.startsWith("Saving fleet.yaml failed"), Object.hasOwn(failed.f.teams!, "ops")])
      .toEqual([{ result: { created: "ops", members: ["beta"] }, error: undefined }, "Team already exists: core", { members: ["alpha"], description: "The core" },
        "Invalid team name: constructor", "Invalid instance names: ghost", true, false]);
  });
  it("commitTeamCreate on no fleet config: refused, nothing saved", () => {
    const save = vi.fn();
    expect([commitTeamCreate(null, { name: "x", members: [] }, save), save.mock.calls.length]).toEqual([{ ok: false, status: 500, error: "Fleet config not available" }, 0]);
  });
});
