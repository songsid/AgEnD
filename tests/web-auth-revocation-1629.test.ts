import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../src/ui/shared/agend-auth.js", import.meta.url), "utf8");
function fixture({ body = true, preinstalled = false } = {}) {
  const order: string[] = [], bars: any[] = [];
  const location = { href: "https://dashboard.example/ui/chat/own", origin: "https://dashboard.example", pathname: "/ui/chat/own", search: "" };
  const element = () => ({ style: {}, setAttribute: vi.fn(), append: vi.fn() });
  const doc: any = { body: body ? { prepend: vi.fn((el: any) => { order.push("banner"); bars.push(el); }) } : null, createElement: vi.fn(element), createTextNode: vi.fn((text: string) => ({ text })) };
  const nativeFetch = vi.fn(async (path: any, _init?: any): Promise<any> => { order.push(`fetch:${path}`); return { ok: true, status: 200, json: async () => path === "/auth/session" ? { csrf: "private-csrf", handle: "b".repeat(16) } : {} }; });
  const win: any = { fetch: nativeFetch, localStorage: { removeItem: vi.fn() } }; if (preinstalled) win.AgendAuth = { existing: true };
  const storage = { setItem: vi.fn() };
  runInNewContext(source, { window: win, document: doc, location, history: { replaceState: vi.fn() }, navigator: { language: "en-US" }, sessionStorage: storage, URL, Request, Headers });
  return { win, auth: win.AgendAuth, doc, location, nativeFetch, storage, order, bars };
}
function held<T>() { let resolve: (value: T) => void = () => {}; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const reply = (status: number, payload: any = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
describe("#1629 synchronous auth revocation observations", () => {
  it("registration is lazy, removable and conveys no auth/CSRF identity", () => {
    const h = fixture(), fn = vi.fn(), off = h.auth.onSessionEnd(fn); expect(h.auth.sessionEnded()).toBe(false); expect(h.nativeFetch).not.toHaveBeenCalled(); expect(fn).not.toHaveBeenCalled(); off(); off();
    expect(h.auth.onSessionEnd(null)).toBeTypeOf("function"); expect(h.auth.onSessionEnd({})).toBeTypeOf("function"); expect(h.nativeFetch).not.toHaveBeenCalled();
  });
  it.each(["admin", "read", undefined, "unknown"])("canWrite is only a display hint for the explicit %s tier, sharing the session read", async tier => {
    const h = fixture(); h.nativeFetch.mockResolvedValueOnce(reply(200, { csrf: "private-csrf", handle: "b".repeat(16), tier }));
    expect(await h.auth.canWrite()).toBe(tier === "admin"); expect(await h.auth.sessionHandle()).toBe("b".repeat(16)); expect(await h.auth.csrf()).toBe("private-csrf"); expect(h.nativeFetch).toHaveBeenCalledOnce();
    await h.auth.signOut(); expect(await h.auth.canWrite()).toBe(false);
  });
  it.each([["admin", "local", true], ["read", "local", false], ["admin", "gateway", false], ["admin", undefined, false]])("Trial display hint uses the same server session: %s %s", async (tier, surface, allowed) => {
    const h = fixture(); h.nativeFetch.mockResolvedValueOnce(reply(200, { csrf: "private-csrf", handle: "b".repeat(16), tier, surface }));
    const value = await h.auth.trialSession(); expect(value).toEqual({ epoch: "b".repeat(16), localAdmin: allowed }); expect(Object.isFrozen(value)).toBe(true);
    expect(await h.auth.sessionHandle()).toBe("b".repeat(16)); expect(await h.auth.csrf()).toBe("private-csrf"); expect(h.nativeFetch).toHaveBeenCalledOnce();
    await h.auth.signOut(); expect(await h.auth.trialSession()).toBeNull();
  });
  it.each([undefined, "", "a".repeat(15), "A".repeat(16)])("Trial display hint refuses malformed handle %s", async handle => {
    const h = fixture(); h.nativeFetch.mockResolvedValueOnce(reply(200, { csrf: "private-csrf", handle, tier: "admin", surface: "local" })); expect(await h.auth.trialSession()).toBeNull();
  });
  it("sign-out notifies synchronously before its first await or native request", async () => {
    const h = fixture(), pending = held<any>(), fn = vi.fn((_event: any) => { h.order.push("revoked"); });
    h.auth.onSessionEnd(fn); h.nativeFetch.mockImplementationOnce(() => { h.order.push("csrf-request"); return pending.promise; });
    const done = h.auth.signOut(); expect(fn).toHaveBeenCalledExactlyOnceWith({ reason: "sign_out" }); expect(Object.keys(fn.mock.calls[0]![0])).toEqual(["reason"]); expect(Object.isFrozen(fn.mock.calls[0]![0])).toBe(true); expect(h.order).toEqual(["revoked", "csrf-request"]); expect(h.auth.sessionEnded()).toBe(true); expect(h.location.href).not.toBe("/signin");
    pending.resolve(reply(200, { csrf: "private-csrf", handle: "b".repeat(16) })); await done; expect(h.location.href).toBe("/signin"); expect(h.nativeFetch).toHaveBeenLastCalledWith("/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-Agend-CSRF": "private-csrf" } });
  });
  it("same-origin data401 revokes before the existing banner and before returning the response", async () => {
    const h = fixture(), fn = vi.fn(() => h.order.push("revoked")); h.auth.onSessionEnd(fn); const response = reply(401); h.nativeFetch.mockResolvedValueOnce(response);
    expect(await h.win.fetch("/ui/instances")).toBe(response); expect(h.order).toEqual(["revoked", "banner"]); expect(fn).toHaveBeenCalledExactlyOnceWith({ reason: "unauthorized" }); expect(h.bars).toHaveLength(1);
    h.nativeFetch.mockResolvedValueOnce(reply(401)); await h.win.fetch("/ui/tasks"); expect(fn).toHaveBeenCalledOnce(); expect(h.bars).toHaveLength(1);
  });
  it("revokes even when body/banner rendering is not available", async () => {
    const h = fixture({ body: false }), fn = vi.fn(); h.auth.onSessionEnd(fn); h.nativeFetch.mockResolvedValueOnce(reply(401)); await h.win.fetch("/ui/instances"); expect(fn).toHaveBeenCalledExactlyOnceWith({ reason: "unauthorized" }); expect(h.doc.createElement).not.toHaveBeenCalled();
  });
  it("native auth/session401 revokes observers without adding a new banner path", async () => {
    const h = fixture(), fn = vi.fn(); h.auth.onSessionEnd(fn); h.nativeFetch.mockResolvedValueOnce(reply(401)); expect(await h.auth.sessionHandle()).toBeNull(); expect(fn).toHaveBeenCalledExactlyOnceWith({ reason: "unauthorized" }); expect(h.bars).toHaveLength(0);
  });
  it.each([403, 404, 429, 500, 503])("a data%s failure is not evidence of session end", async status => {
    const h = fixture(), fn = vi.fn(); h.auth.onSessionEnd(fn); h.nativeFetch.mockResolvedValueOnce(reply(status)); await h.win.fetch("/ui/instances"); expect(fn).not.toHaveBeenCalled(); expect(h.auth.sessionEnded()).toBe(false);
  });
  it("external401 and an auth/login refusal cannot revoke this page", async () => {
    const h = fixture(), fn = vi.fn(); h.auth.onSessionEnd(fn); h.nativeFetch.mockResolvedValueOnce(reply(401)); await h.win.fetch("https://other.example/data");
    h.nativeFetch.mockResolvedValueOnce(reply(401)); await h.win.fetch("/auth/session"); expect(fn).not.toHaveBeenCalled(); expect(h.auth.sessionEnded()).toBe(false);
  });
  it("transient session reads and failed data fetches do not fabricate revocation", async () => {
    const h = fixture(), fn = vi.fn(); h.auth.onSessionEnd(fn); h.nativeFetch.mockRejectedValueOnce(Error("network")); expect(await h.auth.sessionHandle()).toBeNull();
    h.nativeFetch.mockRejectedValueOnce(Error("network")); await expect(h.win.fetch("/ui/instances")).rejects.toThrow("network"); expect(fn).not.toHaveBeenCalled(); expect(h.auth.sessionEnded()).toBe(false);
    expect(await h.auth.sessionHandle()).toBe("b".repeat(16)); expect(h.auth.sessionEnded()).toBe(false);
  });
  it("late observers receive the same frozen first reason immediately, with no authority to reset", async () => {
    const h = fixture(), first = vi.fn(); h.auth.onSessionEnd(first); h.nativeFetch.mockResolvedValueOnce(reply(401)); await h.win.fetch("/ui/instances");
    const late = vi.fn(); const off = h.auth.onSessionEnd(late); expect(late).toHaveBeenCalledOnce(); expect(late.mock.calls[0]![0]).toBe(first.mock.calls[0]![0]); off();
    await h.auth.signOut(); expect(first).toHaveBeenCalledOnce(); expect(late).toHaveBeenCalledOnce(); expect(h.auth.sessionEnded()).toBe(true); expect(first.mock.calls[0]![0].reason).toBe("unauthorized");
    const afterSecondEnd = vi.fn(); h.auth.onSessionEnd(afterSecondEnd); expect(afterSecondEnd.mock.calls[0]![0]).toBe(first.mock.calls[0]![0]);
  });
  it("observer throws, unsubscription and reentry cannot suppress another active cleanup", async () => {
    const h = fixture(), second = vi.fn(), late = vi.fn(); let off = () => {};
    h.auth.onSessionEnd(() => { off(); h.auth.onSessionEnd(late); throw Error("one display failed"); }); off = h.auth.onSessionEnd(second);
    h.nativeFetch.mockResolvedValueOnce(reply(401)); await h.win.fetch("/ui/instances"); expect(second).toHaveBeenCalledOnce(); expect(late).toHaveBeenCalledOnce();
    expect(() => h.auth.onSessionEnd(() => { throw Error("late display failed"); })).not.toThrow(); expect(h.bars).toHaveLength(1);
  });
  it("an unsubscribed observer is not called; successful requests preserve CSRF/session caching", async () => {
    const h = fixture(), fn = vi.fn(), off = h.auth.onSessionEnd(fn); off(); await h.win.fetch("/ui/config", { method: "POST", body: "{}" });
    const headers = h.nativeFetch.mock.calls.at(-1)![1]!.headers; expect(headers.get("X-Agend-CSRF")).toBe("private-csrf"); expect(await h.auth.sessionHandle()).toBe("b".repeat(16));
    expect(h.nativeFetch.mock.calls.filter(([path]: any[]) => path === "/auth/session")).toHaveLength(1); expect(fn).not.toHaveBeenCalled(); expect(h.auth.sessionEnded()).toBe(false);
    h.nativeFetch.mockResolvedValueOnce(reply(401)); await h.win.fetch("/ui/instances"); expect(h.auth.sessionEnded()).toBe(true); expect(fn).not.toHaveBeenCalled();
  });
  it("a failed logout remains locally revoked and preserves the existing durability warning", async () => {
    const h = fixture(), fn = vi.fn(); h.auth.onSessionEnd(fn); h.nativeFetch.mockImplementation(async (path: any) => path === "/auth/session" ? reply(200, { csrf: "private-csrf", handle: "b".repeat(16) }) : reply(500, { error: "restore warning" }));
    await h.auth.signOut(); expect(fn).toHaveBeenCalledExactlyOnceWith({ reason: "sign_out" }); expect(h.auth.sessionEnded()).toBe(true); expect(h.storage.setItem).toHaveBeenCalledWith("agend_signout_note", "restore warning"); expect(h.location.href).toBe("/signin");
  });
  it("does not replace an already-installed auth bridge or change unrelated legacy cleanup", () => {
    const h = fixture({ preinstalled: true }); expect(h.auth).toEqual({ existing: true }); expect(h.win.fetch).toBe(h.nativeFetch); expect(h.nativeFetch).not.toHaveBeenCalled();
    const fresh = fixture(); expect(fresh.win.localStorage.removeItem).toHaveBeenCalledExactlyOnceWith("agend_web_token");
  });
});
