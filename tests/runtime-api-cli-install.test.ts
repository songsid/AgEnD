import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { handleRuntimeRequest, type RuntimeApiContext } from "../src/runtime-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

// #3190 Part 3b: the dashboard's routes for "install a CLI on that computer". Who may ask, what may be asked, and what is answered. The coordinator is a
// stand-in here: its own transport is covered in runtime-cli-install-3b.test.ts.
const token = "t".repeat(48), machineId = "12345678-1234-4321-abcd-123456789012";
class Response extends ServerResponse {
  status = 0; body = "";
  override writeHead(code: number): this { this.status = code; return this; }
  override end(chunk?: unknown): this { this.body += String(chunk ?? ""); return this; }
}
type Kind = "admin" | "guest" | "token" | "gateway" | "remote-admin" | "none";
/** What a request leaves out, to see that its absence alone is a refusal. */
type Omit = "csrf" | "origin";
const store = new WebSessionStore();
function request(path: string, method: string, kind: Kind, body: unknown = {}, omit?: Omit): { req: IncomingMessage; res: Response } {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  req.method = method; req.url = path; req.headers = { host: "localhost" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true });
  if (kind === "token") req.headers["x-agend-token"] = token;
  else if (kind !== "none") {
    const session = store.create({ tier: kind === "guest" ? "guest" : "admin", surface: kind === "remote-admin" ? "gateway" : "local", label: "test", tokenEpoch: tokenEpoch(token),
      ...(kind === "guest" ? { owner: { adapterId: "tg", userId: "1" } } : {}), ...(kind === "remote-admin" ? { exposureId: "a".repeat(32) } : {}) });
    req.headers.cookie = `${WEB_SESSION_COOKIE}=${session.sessionId}`;
    if (omit !== "origin") req.headers.origin = "http://localhost";
    if (omit !== "csrf") req.headers["x-agend-csrf"] = csrfTokenFor(session.sessionId);
    if (kind === "gateway") bindGatewayRequest(req, { surface: "gateway", exposureId: "a".repeat(32), expectedOrigin: "https://public.example", isCurrent: () => true });
  }
  return { req, res: new Response(req) };
}
let calls: Array<{ operation: string; payload: any; timeout?: number }>, outcome: () => Promise<unknown>, machine: any, switchesAnswer: unknown;
const hub = () => ({
  machine: (id: string) => id === machineId ? machine : undefined,
  callAccount: vi.fn(async (_id: string, operation: string, payload: any, timeout?: number) => { calls.push({ operation, payload, timeout }); if (operation === "accounts.switches") return switchesAnswer; return outcome(); }),
  listMachines: () => [], diagnosticTasks: () => [],
}) as unknown as RuntimeCoordinator;
let current: RuntimeCoordinator;
const ctx = (): RuntimeApiContext => ({ webToken: token, webSessions: store, runtimeCoordinator: () => current });
const ask = async (path: string, method: string, kind: Kind, body: unknown = {}, omit?: Omit) => {
  const { req, res } = request(path, method, kind, body, omit);
  expect(handleRuntimeRequest(req, res, new URL(path, "http://localhost"), ctx())).toBe(true);
  await vi.waitFor(() => expect(res.status).not.toBe(0), { timeout: 4000 });
  return { status: res.status, json: JSON.parse(res.body) };
};
const SETUP = `/ui/runtimes/machines/${machineId}/remote-setup`, INSTALL = `/ui/runtimes/machines/${machineId}/cli-install`;
beforeEach(() => {
  vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); calls = []; outcome = async () => ({ version: "0.165.0" }); switchesAnswer = { accounts: { on: false }, install: { on: true } }; current = hub();
  machine = { id: machineId, status: "online", runtimeInfo: { capabilities: ["exec", "remote-signin", "cli-install"] } };
});
afterEach(() => vi.unstubAllEnvs());

describe("install a CLI from the dashboard: who may ask", () => {
  it("only a local administrator session; a header token, guest, public link, outside admin or no one gets nothing and nothing is sent", async () => {
    for (const kind of ["token", "guest", "gateway", "remote-admin", "none"] as Kind[]) {
      expect((await ask(INSTALL, "POST", kind, { cli: "codex" })).status, kind).toBe(403);
      expect((await ask(SETUP, "GET", kind)).status, kind).toBe(403);
    }
    expect(calls).toEqual([]);
  });
  it("a local administrator reads the computer's switches from the computer, and the audit name is an opaque session handle", async () => {
    const answer = await ask(SETUP, "GET", "admin");
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ capable: true, online: true, switches: { install: { on: true } }, job: null, catalog: [{ id: "claude-code", version: "2.1.316" }, { id: "codex", version: "0.165.0" }] });
    expect(calls[0]).toMatchObject({ operation: "accounts.switches", payload: {} });
    const install = await ask(INSTALL, "POST", "admin", { cli: "codex" });
    expect(install.status).toBe(202);
    expect(calls.at(-1)!.payload).toEqual({ cli: "codex", actor: expect.stringMatching(/^admin:[a-f0-9]{16}$/) });
  });
});

describe("install a CLI from the dashboard: what may be asked", () => {
  it("only Claude Code or Codex, by id, with no other field", async () => {
    for (const body of [{ cli: "grok" }, { cli: "kiro" }, { cli: "@evil/pkg" }, { cli: "codex@9" }, { cli: "constructor" }, {}, { cli: "codex", version: "9.9.9" }, { cli: "codex", argv: ["x"] }, { cli: 7 }, []]) {
      expect((await ask(INSTALL, "POST", "admin", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  it("a known computer only; the other methods are not routes", async () => {
    expect((await ask(`/ui/runtimes/machines/22345678-1234-4321-abcd-123456789012/cli-install`, "POST", "admin", { cli: "codex" })).status).toBe(404);
    expect((await ask(INSTALL, "GET", "admin")).status).toBe(404);
    expect((await ask(SETUP, "POST", "admin", {})).status).toBe(404);
  });
  it("a refusal known at once is answered at once (offline, an older Runtime, a switch that is off), and starts no job", async () => {
    outcome = async () => { throw new Error("The owner of that computer has not turned this on. On that computer, run: agend-runtime remote-setup install on [--for 2h]"); };
    const refused = await ask(INSTALL, "POST", "admin", { cli: "claude-code" });
    expect(refused.status).toBe(400); expect(refused.json.error).toMatch(/remote-setup install on/);
    expect((await ask(SETUP, "GET", "admin")).json.job).toBeNull();
  });
});

describe("install a CLI from the dashboard: a run under way", () => {
  it("follows the job, refuses a second install while one runs, then shows how it ended", async () => {
    let finish: (value: unknown) => void = () => {}; outcome = () => new Promise(done => { finish = done; });
    expect((await ask(INSTALL, "POST", "admin", { cli: "codex" })).status).toBe(202);
    expect(calls.at(-1)!.timeout).toBe(11 * 60_000);
    expect((await ask(SETUP, "GET", "admin")).json.job).toMatchObject({ cli: "codex", state: "installing" });
    const second = await ask(INSTALL, "POST", "admin", { cli: "claude-code" });
    expect(second.status).toBe(409); expect(calls.filter(call => call.operation === "cli.install")).toHaveLength(1);
    finish({ version: "0.165.0" });
    await vi.waitFor(async () => expect((await ask(SETUP, "GET", "admin")).json.job).toMatchObject({ state: "done", version: "0.165.0" }));
    // A failure that comes later (the install ran, then a check failed) is a job that failed, not a refusal.
    outcome = () => new Promise((_done, fail) => setTimeout(() => fail(new Error("A downloaded package is not the one this AgEnD version expects, so nothing was installed")), 1700));
    expect((await ask(INSTALL, "POST", "admin", { cli: "codex" })).status).toBe(202);
    await vi.waitFor(async () => expect((await ask(SETUP, "GET", "admin")).json.job).toMatchObject({ state: "failed", error: expect.stringMatching(/not the one this AgEnD version expects/) }), { timeout: 3000 });
  });
  it("a Runtime that cannot install is shown as such, and is not asked", async () => {
    machine.runtimeInfo = { capabilities: ["exec"] };
    expect((await ask(SETUP, "GET", "admin")).json).toMatchObject({ capable: false, switches: null });
    expect(calls).toEqual([]);
  });
});

describe("install a CLI from the dashboard: a request that is not the page's own", () => {
  it("a POST without the CSRF header, or without an Origin, is refused (403) and nothing is sent; the same request with both is accepted", async () => {
    for (const omit of ["csrf", "origin"] as Omit[]) {
      const refused = await ask(INSTALL, "POST", "admin", { cli: "codex" }, omit);
      expect(refused.status, omit).toBe(403);
      expect(calls, omit).toEqual([]);
    }
    expect((await ask(INSTALL, "POST", "admin", { cli: "codex" })).status).toBe(202);
    expect(calls.filter(call => call.operation === "cli.install")).toHaveLength(1);
  });
});

describe("N5: the job is taken before anything is awaited", () => {
  it("two POSTs at the same moment: one install is started and the other is answered 409", async () => {
    outcome = () => new Promise(() => {});
    const answers = await Promise.all([ask(INSTALL, "POST", "admin", { cli: "codex" }), ask(INSTALL, "POST", "admin", { cli: "codex" }), ask(INSTALL, "POST", "admin", { cli: "claude-code" })]);
    expect(answers.map(answer => answer.status).sort()).toEqual([202, 409, 409]);
    expect(calls.filter(call => call.operation === "cli.install")).toHaveLength(1);
  });
  it("a refusal that comes at once removes the job it had taken, and shows the earlier job again", async () => {
    expect((await ask(INSTALL, "POST", "admin", { cli: "codex" })).status).toBe(202);
    await vi.waitFor(async () => expect((await ask(SETUP, "GET", "admin")).json.job).toMatchObject({ state: "done" }));
    outcome = async () => { throw new Error("The owner of that computer has not turned this on"); };
    expect((await ask(INSTALL, "POST", "admin", { cli: "claude-code" })).status).toBe(400);
    expect((await ask(SETUP, "GET", "admin")).json.job).toMatchObject({ cli: "codex", state: "done", version: "0.165.0" });
    // and the machine is not left "installing": the next request is accepted
    outcome = async () => ({ version: "2.1.316" });
    expect((await ask(INSTALL, "POST", "admin", { cli: "claude-code" })).status).toBe(202);
  });
});

describe("N8: what the computer says about its switches is checked before the browser sees it", () => {
  it("passes a well-formed answer on, with only the fields it knows", async () => {
    switchesAnswer = { accounts: { on: true, until: 1234, extra: "x" }, install: { on: false }, secret: "s" };
    const answer = await ask(SETUP, "GET", "admin");
    expect(answer.status).toBe(200);
    expect(answer.json.switches).toEqual({ accounts: { on: true, until: 1234 }, install: { on: false } });
    expect(JSON.stringify(answer.json)).not.toMatch(/extra|secret/);
  });
  it.each([
    ["a string", "all on"], ["an array", []], ["a number", 7], ["no install", { accounts: { on: true } }], ["a non-boolean on", { accounts: { on: "yes" }, install: { on: true } }],
    ["a non-number until", { accounts: { on: true, until: "soon" }, install: { on: true } }], ["a non-finite until", { accounts: { on: true, until: null }, install: { on: true } }],
    ["a null entry", { accounts: null, install: { on: true } }],
  ])("a wrong shape (%s) is one fixed error and none of the answer reaches the browser", async (_name, wrong) => {
    switchesAnswer = wrong;
    const answer = await ask(SETUP, "GET", "admin");
    expect(answer.status).toBe(502);
    expect(answer.json).toEqual({ error: "That computer's answer about its setup was not understood" });
  });
  it("a computer that does not answer at all is still shown as `could not read` (no switches), not as an error", async () => {
    current = { ...hub(), callAccount: vi.fn(async () => { throw new Error("offline"); }) } as unknown as RuntimeCoordinator;
    const answer = await ask(SETUP, "GET", "admin");
    expect(answer.status).toBe(200); expect(answer.json.switches).toBeNull();
  });
});

describe("F2: a refusal that the Runtime sends back within a few milliseconds is a 400, not a 202", () => {
  const OFF = "The owner of that computer has not turned this on. On that computer, run: agend-runtime remote-setup install on [--for 2h]";
  const installCalls = (): number => calls.filter(call => call.operation === "cli.install").length;
  it("a switch-off answer that arrives after a few ms (not in the same tick) is answered 400 with the Runtime's sentence, and no job is left", async () => {
    outcome = () => new Promise((_done, fail) => setTimeout(() => fail(new Error(OFF)), 25));
    const refused = await ask(INSTALL, "POST", "admin", { cli: "codex" });
    expect(refused.status).toBe(400); expect(refused.json.error).toBe(OFF);
    expect((await ask(SETUP, "GET", "admin")).json.job).toBeNull();
    // and the computer is not left "installing": the next request is taken (and refused for its own reason)
    outcome = async () => ({ version: "0.165.0" });
    expect((await ask(INSTALL, "POST", "admin", { cli: "codex" })).status).toBe(202);
  });
  it("the earlier job is shown again after such a refusal", async () => {
    expect((await ask(INSTALL, "POST", "admin", { cli: "codex" })).status).toBe(202);
    await vi.waitFor(async () => expect((await ask(SETUP, "GET", "admin")).json.job).toMatchObject({ state: "done" }));
    outcome = () => new Promise((_done, fail) => setTimeout(() => fail(new Error(OFF)), 25));
    expect((await ask(INSTALL, "POST", "admin", { cli: "claude-code" })).status).toBe(400);
    expect((await ask(SETUP, "GET", "admin")).json.job).toMatchObject({ cli: "codex", state: "done" });
  });
  it("a Runtime that answers only after the waiting time is answered 202, and the job then follows it to its end", async () => {
    outcome = () => new Promise((_done, fail) => setTimeout(() => fail(new Error(OFF)), 1800));
    const started = Date.now(), accepted = await ask(INSTALL, "POST", "admin", { cli: "codex" });
    expect(accepted.status).toBe(202); expect(Date.now() - started).toBeGreaterThanOrEqual(1400); expect(Date.now() - started).toBeLessThan(1790);
    expect((await ask(SETUP, "GET", "admin")).json.job).toMatchObject({ cli: "codex", state: "installing" });
    await vi.waitFor(async () => expect((await ask(SETUP, "GET", "admin")).json.job).toMatchObject({ state: "failed", error: expect.stringMatching(/remote-setup install on/) }), { timeout: 3000 });
  });
  it("while the first request is still waiting, a second one is answered 409 and sends nothing", async () => {
    outcome = () => new Promise((_done, fail) => setTimeout(() => fail(new Error(OFF)), 300));
    const first = ask(INSTALL, "POST", "admin", { cli: "codex" });
    await new Promise(done => setTimeout(done, 50));
    const second = await ask(INSTALL, "POST", "admin", { cli: "claude-code" });
    expect(second.status).toBe(409);
    expect((await first).status).toBe(400);
    expect(installCalls()).toBe(1);
    expect((await ask(SETUP, "GET", "admin")).json.job).toBeNull();
  });
});
