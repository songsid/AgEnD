import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { WebFileLedger } from "../src/web-upload.js";
import { bindGuestRequest, type GuestRequest } from "../src/web-guest-access.js";
import { FleetManager } from "../src/fleet-manager.js";
// @ts-expect-error browser JS module
import { createChatStore } from "../src/ui/chat-store.js";

const TOKEN = "w".repeat(48);
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(classic = false) {
  const dir = mkdtempSync(join(tmpdir(), "web-paused-2189-")); dirs.push(dir); vi.stubEnv("AGEND_HOME", dir);
  const delivered = vi.fn(async () => true);
  const c = { webToken: TOKEN, dataDir: dir, sseClients: new Set(),
    fleetConfig: { instances: classic ? {} : { alpha: { working_directory: dir } } },
    instanceIpcClients: new Map(), daemons: new Map(), isClassicInstance: (n: string) => classic && n === "alpha",
    getInstanceStatus: () => "paused", deliverToInstance: delivered,
    adapter: null, logger: { info() {}, debug() {}, error() {} }, eventLog: null,
    lastInboundUser: new Map(), emitSseEvent: vi.fn(), getUiStatus: () => ({}), webFiles: new WebFileLedger(),
    cancelInstance: vi.fn(() => false),
  } as unknown as WebApiContext;
  return { c, dir, delivered };
}
function request(c: WebApiContext, path: string, body?: unknown, guest?: GuestRequest, streaming = false) {
  const req = Object.assign(new EventEmitter(), { method: "POST", url: path, complete: true,
    headers: { "x-agend-token": TOKEN, "x-agend-filename": "note.txt" }, destroy() {}, resume() {} });
  if (guest) bindGuestRequest(req, guest);
  let resolve!: (v: any) => void;
  const done = new Promise<any>(r => { resolve = r; });
  const res = Object.assign(new EventEmitter(), { status: 0, destroyed: false, headersSent: false,
    setHeader() {}, writeHead(status: number) { res.status = status; return res; },
    end(b?: unknown) { resolve({ status: res.status, body: JSON.parse(String(b ?? "{}")) }); return res; } });
  handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(path, "http://localhost"), c);
  const end = () => { if (body !== undefined) req.emit("data", Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))); req.emit("end"); };
  if (!streaming) end();
  return { req, res, done, end };
}
const text = { instance: "alpha", message: "wake and answer" };

describe("web paused delivery uses the channel facade, never a cached IPC", () => {
  it.each([false, true])("wakes a marker-only configured recipient (Classic=%s), then hands off once", async classic => {
    const { c, dir } = fixture(classic);
    const fm = new FleetManager(dir), order: string[] = [];
    vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(true);
    vi.spyOn(fm as any, "enforceWarmCap").mockImplementation(() => {});
    vi.spyOn(fm.lifecycle, "wake").mockImplementation(async () => {
      order.push("wake");
      fm.instanceIpcClients.set("alpha", { connected: true, send: () => { order.push("send"); return true; } } as any);
    });
    c.deliverHumanToInstance = vi.fn((name, payload, _origin, original, options) => {
      expect(original).toBe(text.message); return fm.deliverToInstance(name, payload, options);
    });
    const answer = await request(c, "/ui/send", text).done;
    expect(answer.status).toBe(200); expect(order).toEqual(["wake", "send"]);
    expect(c.deliverHumanToInstance).toHaveBeenCalledTimes(1);
    expect(c.emitSseEvent).toHaveBeenCalledWith("message", expect.objectContaining({ text: text.message }));
  });
  it.each([
    ["No warm slot is free for alpha", "wake_capacity"], ["account login expired /private/key", "wake_credentials"],
    ["wake ready timeout", "wake_timeout"], ["Cannot wake stopped instance alpha", "instance_stopped"],
    ["secret=/private/sensitive/token", "delivery_unavailable"],
    ["author metadata unavailable", "delivery_unavailable"], ["authority snapshot unavailable", "delivery_unavailable"],
    ["Authentication expired", "wake_credentials"],
  ])("reports a bounded actionable failure for %s", async (error, reason) => {
    const { c, delivered } = fixture(); delivered.mockRejectedValueOnce(new Error(error));
    const r = await request(c, "/ui/send", text).done;
    expect(r).toMatchObject({ status: 503, body: { reason } });
    expect(r.body.error).toMatch(/Retry|retry/); expect(JSON.stringify(r)).not.toMatch(/private|secret=/);
    expect(c.emitSseEvent).not.toHaveBeenCalled();
  });
  it("revoked admission, guest scope or registration during wake refuses the actual handoff", async () => {
    for (const change of ["token", "scope", "registration"] as const) {
      const { c } = fixture(); let scope = new Set(["alpha"]);
      const guest = { owner: { adapterId: "demo", userId: "person" }, scope: () => scope, chat: () => true, current: () => true };
      const observed: boolean[] = [];
      c.deliverHumanToInstance = async (_n, _p, _o, _t, options) => {
        observed.push(options?.stillCurrent?.() === true);
        if (change === "token") (c as any).webToken = "new-token";
        if (change === "scope") scope = new Set();
        if (change === "registration") delete c.fleetConfig!.instances.alpha;
        observed.push(options?.stillCurrent?.() === true); return observed[1];
      };
      expect((await request(c, "/ui/send", text, guest).done).status).toBe(503);
      expect(observed).toEqual([true, false]);
      expect(c.emitSseEvent).not.toHaveBeenCalled();
    }
  });
  it("does not grant unknown names, guests' commands/read-only/out-of-scope sends", async () => {
    const { c, delivered } = fixture();
    expect((await request(c, "/ui/send", { ...text, instance: "missing" }).done).status).toBe(404);
    expect((await request(c, "/ui/send", { ...text, instance: "constructor" }).done).status).toBe(404);
    const guest = { owner: { adapterId: "demo", userId: "person" }, scope: () => new Set(["alpha"]), current: () => true, chat: () => false };
    expect((await request(c, "/ui/send", text, guest).done).status).toBe(403);
    expect((await request(c, "/ui/send", { ...text, instance: "other" }, guest).done).status).toBe(404);
    expect((await request(c, "/ui/send", { ...text, message: "/wake" }, { ...guest, chat: () => true }).done).status).toBe(403);
    expect(delivered).not.toHaveBeenCalled();
    expect((await request(c, "/ui/send", text, { ...guest, chat: () => true }).done).status).toBe(200);
  });
  it.each([false, true])("stages a paused recipient's file without waking; rechecks registration (Classic=%s)", async classic => {
    const { c, delivered, dir } = fixture(classic);
    expect((await request(c, "/ui/upload?instance=alpha", Buffer.from("hello")).done).status).toBe(200);
    expect(delivered).not.toHaveBeenCalled();
    const late = request(c, "/ui/upload?instance=alpha", Buffer.from("gone"), undefined, true);
    if (classic) c.isClassicInstance = () => false; else delete c.fleetConfig!.instances.alpha;
    late.end(); expect((await late.done).status).toBe(404);
    expect(readdirSync(join(dir, "workspaces", "alpha", "inbox"))).toHaveLength(1);
  });
  it.each([
    ["stopped", "admission"], ["stopped", "body"], ["stopped", "finish"],
    ["crashed", "admission"], ["crashed", "body"], ["crashed", "finish"],
  ] as const)("refuses a registered %s recipient at %s", async (status, phase) => {
    const { c, dir, delivered } = fixture();
    let current: "paused" | "stopped" | "crashed" = phase === "admission" ? status : "paused";
    c.getInstanceStatus = () => current;
    const upload = request(c, "/ui/upload?instance=alpha", Buffer.from("do not store"), undefined, true);
    const atAdmission = upload.res.status;
    if (phase === "body") current = status;
    upload.end();
    const atBodyEnd = upload.res.status;
    // out.end's callback is a separate wait after the body-end admission.
    if (phase === "finish") current = status;
    const answer = await upload.done;
    expect(atAdmission).toBe(phase === "admission" ? 404 : 0);
    expect(atBodyEnd).toBe(phase === "finish" ? 0 : 404);
    expect(answer.status).toBe(404);
    expect(answer.body).not.toHaveProperty("id");
    const inbox = join(dir, "workspaces", "alpha", "inbox");
    expect(existsSync(inbox) ? readdirSync(inbox) : []).toEqual([]);
    expect(delivered).not.toHaveBeenCalled();
  });
  it("Cancel recognizes a paused Classic room, returns not-running, and never wakes", async () => {
    const { c, delivered } = fixture(true);
    expect(await request(c, "/ui/cancel/alpha").done).toEqual({ status: 409, body: { error: "alpha is not running" } });
    expect((await request(c, "/ui/cancel/missing").done).status).toBe(404);
    expect(delivered).not.toHaveBeenCalled();
  });
});

describe("chat waking state and explicit retry preserve the draft", () => {
  it("shows waking while held, retains a failed draft, retries exactly once, then clears the reason", async () => {
    let release!: (v: any) => void;
    const fetch = vi.fn(() => new Promise<any>(r => { release = r; }));
    const store = createChatStore({ fetch, toast() {}, announce() {}, t: (s: string) => s });
    store.applyStatus({ instances: [{ name: "alpha", status: "paused" }] }); store.setCurrent("alpha"); store.setDraft("alpha", "hello");
    const sending = store.send("alpha");
    expect(store.state.waking.alpha).toBe(true); expect(store.state.sending.alpha).toBe(true);
    release({ json: async () => ({ error: "No slot free. Retry later.", reason: "wake_capacity" }) }); await sending;
    expect(store.state.waking.alpha).toBeUndefined(); expect(store.state.drafts.alpha).toBe("hello");
    expect(store.state.sendFailures.alpha.error).toBe("No slot free. Retry later."); expect(store.canRetrySend("alpha")).toBe(true);
    const retry = store.retrySend("alpha"); store.retrySend("alpha");
    expect(fetch).toHaveBeenCalledTimes(2);
    release({ json: async () => ({ sent: true }) }); await retry;
    expect(store.state.sendFailures.alpha).toBeUndefined(); expect(store.state.drafts.alpha).toBe("");
  });
  it("a concurrent draft or navigation never gets overwritten or silently retried", async () => {
    let release!: (v: any) => void;
    const fetch = vi.fn(() => new Promise<any>(r => { release = r; }));
    const store = createChatStore({ fetch, toast() {}, announce() {}, t: (s: string) => s });
    store.setCurrent("alpha"); store.setDraft("alpha", "original"); const pending = store.send("alpha");
    store.setDraft("alpha", "new text"); store.setCurrent("other");
    release({ json: async () => ({ error: "not ready" }) }); await pending;
    expect(store.state.drafts.alpha).toBe("new text"); expect(store.state.failedSends.alpha).toBe("original");
    expect(store.canRetrySend("alpha")).toBe(false); store.retrySend("alpha"); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
