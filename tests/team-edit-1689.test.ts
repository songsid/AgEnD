/**
 * #1689 (design: the comment on #1689): a team edited on the web — PATCH /ui/teams/<name> through the same update as the
 * update_team tool (applyTeamUpdate): members and description, own keys only, never over the public link; the form
 * filled in from the team, its name not editable. And the separate tightening: the public link no longer creates or
 * deletes teams. The real shared function, MCP handlers, route handler, gateway manifest and Fleet panel.
 */
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTeamUpdate, outboundHandlers } from "../src/outbound-handlers.js";
import { handleWebRequest } from "../src/web-api.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { fire } from "./helpers/mini-dom.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const token = "t".repeat(48);
function fleet() {
  const instances: Record<string, unknown> = { alpha: {}, beta: {}, gamma: {} };
  const teams: Record<string, { members: string[]; description?: string }> = { core: { members: ["alpha", "beta"], description: "The core" } };
  return { instances, teams };
}

describe("the one update (applyTeamUpdate) — update_team and the web both use it", () => {
  it("changes members and description; an empty description clears it", () => {
    const f = fleet();
    const r1 = applyTeamUpdate(f as never, { name: "core", add: ["gamma"], remove: ["alpha"], description: "  New purpose " });
    const after1 = structuredClone(f.teams.core);
    applyTeamUpdate(f as never, { name: "core", description: "" });
    expect([r1, after1, f.teams.core]).toEqual([{ ok: true, result: { name: "core", members: ["beta", "gamma"], description: "New purpose" } },
      { members: ["beta", "gamma"], description: "New purpose" }, { members: ["beta", "gamma"] }]);
  });
  it("an unknown instance, or an inherited name like constructor, is refused — and nothing changes", () => {
    const outcomes = ["ghost", "constructor", "__proto__", "toString"].map((m) => {
      const f = fleet();
      const r = applyTeamUpdate(f as never, { name: "core", add: [m], remove: ["alpha"], description: "x" });
      return [r.ok ? "ok" : r.status, f.teams.core];
    });
    expect(outcomes).toEqual(Array(4).fill([400, { members: ["alpha", "beta"], description: "The core" }]));
  });
  it("a team is one fleet.yaml defines: __proto__, constructor and an unknown name are not found", () => {
    const f = fleet();
    expect(["__proto__", "constructor", "nope"].map((name) => { const r = applyTeamUpdate(f as never, { name, add: ["alpha"] }); return r.ok ? "ok" : r.status; }))
      .toEqual([404, 404, 404]);
  });
});

describe("the update_team tool (agents)", () => {
  const run = (tool: string, args: Record<string, unknown>, f = fleet()) => {
    const saveFleetConfig = vi.fn();
    let out: { result: unknown; error?: string } = { result: null };
    void outboundHandlers.get(tool)!({ fleetConfig: f, saveFleetConfig } as never, args, (result: unknown, error?: string) => { out = { result, error }; }, {} as never);
    return { out, saved: saveFleetConfig.mock.calls.length, f };
  };
  it("still adds and removes, now sets the description too; saves once", () => {
    const r = run("update_team", { name: "core", add: ["gamma"], remove: ["beta"], description: "Reviewers" });
    expect([r.out, r.saved, r.f.teams.core]).toEqual([{ result: { name: "core", members: ["alpha", "gamma"], description: "Reviewers" }, error: undefined }, 1,
      { members: ["alpha", "gamma"], description: "Reviewers" }]);
  });
  it("refuses a __proto__ team and a constructor member without saving", () => {
    const a = run("update_team", { name: "__proto__", add: ["alpha"] });
    const b = run("update_team", { name: "core", add: ["constructor"] });
    expect([a.out.error, a.saved, b.out.error, b.saved]).toEqual(["Team not found: __proto__", 0, "Invalid instance names: constructor", 0]);
  });
  it("#1693 r1: a save that fails leaves the team as it was (the tool's answer says so)", () => {
    const f = fleet();
    let out: { result: unknown; error?: string } = { result: null };
    void outboundHandlers.get("update_team")!({ fleetConfig: f, saveFleetConfig: () => { throw new Error("EIO"); } } as never,
      { name: "core", add: ["gamma"], description: "New" }, (result: unknown, error?: string) => { out = { result, error }; }, {} as never);
    expect([out.error?.startsWith("Saving fleet.yaml failed; the team is unchanged"), f.teams.core]).toEqual([true, { members: ["alpha", "beta"], description: "The core" }]);
  });
  it("create_team: own keys too — a constructor member and a __proto__ name are refused", () => {
    const a = run("create_team", { name: "ops", members: ["constructor"] });
    const b = run("create_team", { name: "__proto__", members: ["alpha"] });
    const c = run("create_team", { name: "ops", members: ["alpha"] });
    expect([a.out.error, b.out.error, a.saved + b.saved, c.out.error, Object.hasOwn(c.f.teams, "ops")]).toEqual(["Invalid instance names: constructor", "Invalid team name: __proto__", 0, undefined, true]);
  });
});

/** The route with a given fleet and saver (local, header token). */
function callWith(method: string, path: string, body: unknown, f: ReturnType<typeof fleet>, saveFleetConfig: () => void) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "127.0.0.1:19280", "x-agend-token": token, "content-type": "application/json" }, destroy: vi.fn() });
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => resolve({ status, body: t ? JSON.parse(String(t)) : null }) });
    handleWebRequest(req as never, res as never, new URL(path, "http://127.0.0.1:19280"), { webToken: token, fleetConfig: f, saveFleetConfig, logger: { debug() {}, info() {}, error() {} } } as never);
    req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end");
  });
}

describe("PATCH /ui/teams/<name>", () => {
  function call(method: string, path: string, body: unknown, opts: { publicLink?: boolean; f?: ReturnType<typeof fleet> } = {}) {
    const f = opts.f ?? fleet();
    const saveFleetConfig = vi.fn();
    // The public link: its own listener's request with its __Host- session (a header token is not taken there).
    const sessions = new WebSessionStore(), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com";
    const s = opts.publicLink ? sessions.create({ tier: "admin", surface: "gateway", exposureId, label: "t", tokenEpoch: tokenEpoch(token) }) : null;
    const headers: Record<string, string> = s
      ? { host: "sample.trycloudflare.com", cookie: `__Host-agend_session=${s.sessionId}`, origin: pub, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" }
      : { host: "127.0.0.1:19280", "x-agend-token": token, "content-type": "application/json" };
    return new Promise<{ status: number; body: any; saved: number; f: ReturnType<typeof fleet> }>((resolve) => {
      const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy: vi.fn() });
      if (opts.publicLink) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
      let status = 0;
      const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; },
        end: (t = "") => resolve({ status, body: t ? JSON.parse(String(t)) : null, saved: saveFleetConfig.mock.calls.length, f }) });
      handleWebRequest(req as never, res as never, new URL(path, opts.publicLink ? pub : "http://127.0.0.1:19280"),
        { webToken: token, webSessions: sessions, fleetConfig: f, saveFleetConfig, logger: { debug() {}, info() {}, error() {} } } as never);
      if (body !== undefined) { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }
    });
  }
  it("an edit changes members and description (what to add and remove worked out from the team as it is); saved once", async () => {
    const r = await call("PATCH", "/ui/teams/core", { members: ["beta", "gamma"], description: "Front line" });
    expect([r.status, r.body, r.saved, r.f.teams.core]).toEqual([200, { updated: { name: "core", members: ["beta", "gamma"], description: "Front line" } }, 1,
      { members: ["beta", "gamma"], description: "Front line" }]);
  });
  it("PUT is the same edit", async () => {
    const r = await call("PUT", "/ui/teams/core", { members: ["alpha"] });
    expect([r.status, r.f.teams.core.members]).toEqual([200, ["alpha"]]);
  });
  it("an unknown instance is refused (400) and nothing is saved", async () => {
    const r = await call("PATCH", "/ui/teams/core", { members: ["alpha", "ghost"] });
    expect([r.status, r.body.error, r.saved, r.f.teams.core.members]).toEqual([400, "Invalid instance names: ghost", 0, ["alpha", "beta"]]);
  });
  it("a __proto__ or constructor team (404) or member (400): refused, nothing saved", async () => {
    const outcomes = await Promise.all([
      call("PATCH", "/ui/teams/__proto__", { members: ["alpha"] }), call("PATCH", "/ui/teams/constructor", { members: ["alpha"] }),
      call("PATCH", "/ui/teams/core", { members: ["alpha", "constructor"] }), call("PATCH", "/ui/teams/core", { members: ["__proto__"] }),
    ]);
    expect(outcomes.map((o) => [o.status, o.saved])).toEqual([[404, 0], [404, 0], [400, 0], [400, 0]]);
  });
  it("no rename, no other field: a body with a name is refused", async () => {
    const r = await call("PATCH", "/ui/teams/core", { name: "renamed", members: ["alpha"] });
    expect([r.status, r.saved, Object.hasOwn(r.f.teams, "renamed")]).toEqual([400, 0, false]);
  });
  it("the public link: the edit is refused by the handler (403) and its manifest has no route for it", async () => {
    const r = await call("PATCH", "/ui/teams/core", { members: ["gamma"] }, { publicLink: true });
    expect([r.status, r.body.error, r.saved, isPublicWebRoute("PATCH", "/ui/teams/core"), isPublicWebRoute("PUT", "/ui/teams/core")])
      .toEqual([403, "teams_not_over_public_link", 0, false, false]);
  });
  it("separate tightening: the public link no longer creates or deletes a team (manifest and handler); reading stays", async () => {
    const created = await call("POST", "/ui/teams", { name: "ops", members: ["alpha"] }, { publicLink: true });
    const deleted = await call("DELETE", "/ui/teams/core", undefined, { publicLink: true });
    expect([created.status, deleted.status, created.saved + deleted.saved, Object.hasOwn(deleted.f.teams, "core"),
      isPublicWebRoute("POST", "/ui/teams"), isPublicWebRoute("DELETE", "/ui/teams/core"), isPublicWebRoute("GET", "/ui/teams")])
      .toEqual([403, 403, 0, true, false, false, true]);
  });
  it("#1693 r1: a session revoked, or the token rotated, while the body was on its way — nothing written, nothing saved", async () => {
    const outcomes: unknown[] = [];
    for (const change of ["none", "revoke", "rotate"] as const) {
      const f = fleet();
      const sessions = new WebSessionStore();
      const s = sessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
      const saveFleetConfig = vi.fn();
      const ctx = { webToken: token, webSessions: sessions, fleetConfig: f, saveFleetConfig, logger: { debug() {}, info() {}, error() {} } } as any;
      const req = Object.assign(new EventEmitter(), { method: "PATCH", url: "/ui/teams/core", destroy: vi.fn(),
        headers: { host: "127.0.0.1:19280", cookie: `agend_session=${s.sessionId}`, origin: "http://127.0.0.1:19280", "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" } });
      const status = await new Promise<number>((resolve) => {
        let code = 0;
        const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { code = c; }, end: () => resolve(code) });
        handleWebRequest(req as never, res as never, new URL("/ui/teams/core", "http://127.0.0.1:19280"), ctx);
        if (change === "revoke") sessions.revokeById(s.sessionId);
        if (change === "rotate") ctx.webToken = "u".repeat(48);
        req.emit("data", Buffer.from(JSON.stringify({ members: ["gamma"], description: "New" }))); req.emit("end");
      });
      outcomes.push([change, status, saveFleetConfig.mock.calls.length, f.teams.core]);
    }
    expect(outcomes).toEqual([["none", 200, 1, { members: ["gamma"], description: "New" }],
      ["revoke", 401, 0, { members: ["alpha", "beta"], description: "The core" }], ["rotate", 401, 0, { members: ["alpha", "beta"], description: "The core" }]]);
  });
  it("#1693 r1: a save that fails leaves the team as it was (500, not 400) — PATCH and PUT; a team with no description gets none back", async () => {
    const failing = () => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); };
    const outcomes: unknown[] = [];
    for (const method of ["PATCH", "PUT"]) {
      const f = fleet();
      f.teams.bare = { members: ["alpha"] };
      const r1 = await callWith(method, "/ui/teams/core", { members: ["gamma"], description: "New" }, f, failing);
      const r2 = await callWith(method, "/ui/teams/bare", { members: ["beta"], description: "Added" }, f, failing);
      outcomes.push([method, r1.status, r2.status, f.teams.core, f.teams.bare, Object.hasOwn(f.teams.bare, "description")]);
    }
    expect(outcomes).toEqual(Array.from(["PATCH", "PUT"], (m) => [m, 500, 500, { members: ["alpha", "beta"], description: "The core" }, { members: ["alpha"] }, false]));
  });
  it("delete: own keys — a __proto__ team is not found", async () => {
    const r = await call("DELETE", "/ui/teams/__proto__", undefined);
    expect([r.status, r.saved]).toEqual([404, 0]);
  });
});

describe("#1693 r1: agend-agent team-update", () => {
  it("sends lists (comma-separated, \"\" for none) and a description when given — what update_team takes", async () => {
    const posts: unknown[] = [];
    const server = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { posts.push(JSON.parse(b)); res.end(JSON.stringify({ ok: true })); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const home = mkdtempSync(join(tmpdir(), "team-cli-1693-"));
    const run = (...argv: string[]) => new Promise<number>((resolve) => {
      execFile(process.execPath, ["--import", "tsx", join(process.cwd(), "src/agent-cli.ts"), ...argv], {
        env: { ...process.env, AGEND_PORT: String((server.address() as any).port), AGEND_INSTANCE_NAME: "worker", AGEND_HOME: home }, timeout: 30_000,
      }, (err) => resolve(err ? 1 : 0));
    });
    try {
      await run("team-update", "core", "gamma, beta", "alpha", "Front line");
      await run("team-update", "core", "", "beta");
      await run("team-update", "core", "", "", "");
      expect(posts).toEqual([
        { instance: "worker", op: "team-update", args: { name: "core", add: ["gamma", "beta"], remove: ["alpha"], description: "Front line" } },
        { instance: "worker", op: "team-update", args: { name: "core", remove: ["beta"] } },
        { instance: "worker", op: "team-update", args: { name: "core", description: "" } },
      ]);
    } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
  }, 60_000);
});

describe("the Teams tab: Edit opens the form filled in", () => {
  const mounted: AppPage[] = [];
  const realFetch = (globalThis as { fetch?: unknown }).fetch;
  afterEach(async () => {
    for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
    (globalThis as { fetch?: unknown }).fetch = realFetch;
  });
  async function teamsTab(opts: { publicLink?: boolean } = {}) {
    const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/teams", storage: { agend_tour_done: "1" } });
    mounted.push(pg);
    if (opts.publicLink) pg.document.body.setAttribute("data-public-link", "1");
    const writes: Array<{ path: string; method: string; body: any }> = [];
    (globalThis as { fetch?: unknown }).fetch = async (path: string, init: any = {}) => {
      if ((init.method ?? "GET") !== "GET") { writes.push({ path, method: init.method, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ updated: {} }) }; }
      return { ok: true, status: 200, json: async () => ({ teams: { core: { members: ["alpha", "gone"], description: "The core" } } }) };
    };
    const { startRouter } = await import("/assets/app-nav.js");
    const { applyStatus } = await import("/assets/app-store.js");
    // @ts-expect-error — a JS module of the app, with no types
    const { FleetPanel } = await import("../src/ui/panel-fleet.js");
    startRouter(pg.window);
    applyStatus({ instances: [{ name: "alpha", status: "running" }, { name: "beta", status: "running" }] });
    await pg.mount(h(FleetPanel, { route: { panel: "fleet", tab: "teams" }, navKey: `fleet:teams|${opts.publicLink ? 1 : 0}` }));
    await settle(6);
    return { pg, writes };
  }
  it("members ticked (one no longer in the fleet listed too), the description, the name read-only and why; Save sends PATCH", async () => {
    const { pg, writes } = await teamsTab();
    fire(pg.root.querySelector("button.team-edit") as any, "click"); await settle(4);
    const dialog = pg.document.querySelector(".dialog, [role=dialog]") as any ?? pg.root;
    const inputs = [...dialog.querySelectorAll("input")] as any[];
    const name = inputs.find((i) => i.type !== "checkbox" && i.value === "core");
    const desc = inputs.find((i) => i.type !== "checkbox" && i.value === "The core");
    const boxes = [...dialog.querySelectorAll('input[type="checkbox"]')].map((b: any) => [b.parentNode.textContent.trim(), b.checked]);
    const note = [...dialog.querySelectorAll("p.note")].map((p: any) => p.textContent);
    expect([!!name, name?.getAttribute("aria-readonly"), !!desc, boxes, note]).toEqual([true, "true", true, [["alpha", true], ["beta", false], ["gone", true]],
      ["Renaming isn't supported — create a new team and delete this one."]]);
    // Two ticks before the next render (beta in, alpha out): both count.
    const box = (n: string) => ([...dialog.querySelectorAll('input[type="checkbox"]')] as any[]).find((b) => b.parentNode.textContent.trim() === n);
    fire(box("beta"), "change"); fire(box("alpha"), "change"); await settle();
    // The dialog's own Save (labelled for an edit, not "Create").
    const save = [...pg.root.querySelectorAll("button")].find((b: any) => b.textContent.trim() === "Save changes") as any;
    fire(save, "click"); await settle(6);
    expect(writes).toEqual([{ path: "/ui/teams/core", method: "PATCH", body: { members: ["gone", "beta"], description: "The core" } }]);
  });
  it("the public link lists the teams but offers no New, Edit or Delete", async () => {
    const { pg } = await teamsTab({ publicLink: true });
    expect([pg.root.querySelectorAll(".row-item").length, pg.root.querySelector("button.team-edit"), pg.root.querySelector(".list-head button"), pg.root.querySelector(".row-item button.danger")])
      .toEqual([1, null, null, null]);
  });
});
