import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsControlServer, requestSettingsConfirmation, settingsSocketPath, type SettingsInspection } from "../src/settings-control.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SETUP_FORM_HTML } from "../src/setup-form.js";
const roots: string[] = [], servers: SettingsControlServer[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), "agend-test-settings-control-")); roots.push(root); return root; }
async function control() {
  const root = directory(), apply = vi.fn(async (_current, execution) => execution.commit(() => ({ ok: true })));
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const view = store.propose({ session: "browser", key: "key", bytes: 1, source: "web_session", section: "access", requestedBy: "operator browser", fingerprint: "effect",
    summary: ["fleet access: add fleet admin (F) ID 42"], current: () => true, unchanged: async () => true, apply }).view;
  const server = new SettingsControlServer(root, store, () => true); servers.push(server); await server.listen();
  const inspect = () => requestSettingsConfirmation(root, { action: "inspect", id: view.id }, {}) as Promise<SettingsInspection>;
  return { root, store, apply, view, server, inspect };
}
describe("#1423 independent host authority", () => {
  it("private real socket requires the inspected exact ticket and applies once", async () => {
    const h = await control(), inspected = await h.inspect();
    expect(lstatSync(join(h.root, "operator")).mode & 0o777).toBe(0o700); expect(lstatSync(settingsSocketPath(h.root)).mode & 0o777).toBe(0o600);
    expect(inspected.pending_change.summary).toContain("fleet access: add fleet admin (F) ID 42");
    await expect(requestSettingsConfirmation(h.root, { action: "confirm", ticket: { ...inspected.ticket, summary_fingerprint: "different" } }, {})).rejects.toThrow(); expect(h.apply).not.toHaveBeenCalled();
    const result = await requestSettingsConfirmation(h.root, { action: "confirm", ticket: inspected.ticket }, {});
    expect(result.pending_change.state).toBe("applied"); expect(h.apply).toHaveBeenCalledOnce();
    await expect(requestSettingsConfirmation(h.root, { action: "confirm", ticket: inspected.ticket }, {})).rejects.toThrow(); expect(h.apply).toHaveBeenCalledOnce();
  });
  it("agent presence, including an empty value, is rejected before any path access", async () => {
    for (const value of ["worker", ""]) await expect(requestSettingsConfirmation("/does-not-exist", { action: "inspect", id: "a".repeat(32) }, { AGEND_INSTANCE_NAME: value })).rejects.toThrow("Agent sessions");
  });
  it("group-accessible socket and symlink operator directory are rejected", async () => {
    const h = await control(); chmodSync(settingsSocketPath(h.root), 0o660); await expect(h.inspect()).rejects.toThrow("private socket");
    const root = directory(), target = directory(); symlinkSync(target, join(root, "operator")); const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
    const server = new SettingsControlServer(root, store, () => true); servers.push(server); await expect(server.listen()).rejects.toThrow();
    expect(lstatSync(join(root, "operator")).isSymbolicLink()).toBe(true);
  });
  it("shutdown invalidates inspected tickets before another request can commit", async () => {
    const h = await control(), ticket = (await h.inspect()).ticket; const stopped = h.server.close();
    await expect(requestSettingsConfirmation(h.root, { action: "confirm", ticket }, {})).rejects.toThrow(); await stopped; expect(h.apply).not.toHaveBeenCalled();
  });
});
function cli() {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const begin = source.indexOf('.action(async (id: string, options: { yes?: boolean }) => {', source.indexOf('const settingsCommand'));
  const end = source.indexOf('\n  });', begin); expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  const client = vi.fn(async (_path, request) => request.action === "inspect" ? { pending_change: { source: "web_session", requested_by: "browser", summary: ["add F ID 42"] }, ticket: { id: "same", generation: "original", fingerprint: "effect" } }
    : { pending_change: { state: "applied", outcome: { message: "applied" } } });
  const process = { stdin: { isTTY: false }, exitCode: 0 }, console = { log: vi.fn(), error: vi.fn() };
  const context = createContext({ process, console, requestSettingsConfirmation: client, DATA_DIR: "/private/test" });
  const callback = source.slice(begin + '.action('.length, end) + '\n}';
  runInContext(ts.transpileModule(`const action = ${callback}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { action: runInContext("action", context) as (id: string, options: any) => Promise<void>, client, process, console };
}
it("actual CLI callback prints source/requester/full summary and uses the inspected ticket only with explicit --yes", async () => {
  const h = cli(); await h.action("same", {}); expect(h.client).toHaveBeenCalledOnce(); expect(h.process.exitCode).toBe(1);
  const yes = cli(); await yes.action("same", { yes: true }); expect(yes.console.log.mock.calls[0][0]).toBe("Source: web_session\nRequester: browser\nadd F ID 42");
  expect(yes.client.mock.calls[1][1]).toEqual({ action: "confirm", ticket: { id: "same", generation: "original", fingerprint: "effect" } });
});
function form() {
  const elements = new Map<string, any>(); const $ = (id: string) => { if (!elements.has(id)) elements.set(id, { disabled: false, value: "", addEventListener: vi.fn() }); return elements.get(id); };
  $("token").value = "secret-sentinel"; const timers: (() => Promise<void>)[] = []; let outcome = "pending", fail = false;
  const api = vi.fn(async (path: string, _options?: any) => {
    if (path === "api/settings/pending") return { ok: true, body: [] };
    if (path === "api/settings/quickstart/commit") { if (fail) { fail = false; throw Error("lost response"); } return { ok: true, body: { result: "pending_confirmation", pending_change: { id: "123" } } }; }
    if (path === "api/settings/pending/123") return { ok: true, body: { state: outcome } };
    return { ok: true, body: { watch: false } };
  });
  const state = { identity: { valid: true } }; let serial = 0;
  const context = createContext({ $, api, state, input: () => ({ platform: "telegram" }), document: { querySelectorAll: () => [$("token")] },
    crypto: { randomUUID: () => "key-" + ++serial }, setTimeout: (fn: any) => timers.push(fn), waitForFleet: vi.fn() });
  const begin = SETUP_FORM_HTML.indexOf("  let approvedSetup = false;"), end = SETUP_FORM_HTML.indexOf("  // The host is gone;", begin);
  expect(begin).toBeGreaterThan(0); runInContext(SETUP_FORM_HTML.slice(begin, end), context);
  return { $, api, timers, failNext: () => { fail = true; }, outcome: (next: string) => { outcome = next; } };
}
describe("#1423 exact Setup form consent callbacks", () => {
  it("202 clears the token and never finishes; only applied plus an explicit second click starts", async () => {
    const h = form(); await h.$("finish").onclick(); expect(h.$("token").value).toBe(""); expect(h.api.mock.calls.some(([path]) => path === "setup/finish")).toBe(false);
    h.outcome("applied"); await h.timers.shift()!(); expect(h.$("finish").textContent).toBe("Start AgEnD"); expect(h.api.mock.calls.some(([path]) => path === "setup/finish")).toBe(false);
    await h.$("finish").onclick(); expect(h.api.mock.calls.filter(([path]) => path === "setup/finish")).toHaveLength(1);
  });
  it("lost responses reuse bytes/key; terminal rejection requires a new key and token entry", async () => {
    const h = form(); h.failNext(); await h.$("finish").onclick(); await h.$("finish").onclick();
    const writes = h.api.mock.calls.filter(([path]) => path === "api/settings/quickstart/commit"); expect(writes[0][1]).toEqual(writes[1][1]);
    h.outcome("rejected"); await h.timers.shift()!(); h.$("token").value = "different-secret"; await h.$("finish").onclick();
    const last = h.api.mock.calls.filter(([path]) => path === "api/settings/quickstart/commit").at(-1)![1];
    expect(last.headers["Idempotency-Key"]).not.toBe(writes[0][1].headers["Idempotency-Key"]); expect(JSON.parse(last.body).token).toBe("different-secret");
  });
});
