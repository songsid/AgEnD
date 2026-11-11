/** Mount the real single card. The browser acceptance separately exercises the actual protocol and Settings gate. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let widget: any, clientModule: any, words: any, confirmations: any, shell: any;
const pages: AppPage[] = [];
const id = "11111111-2222-4333-8444-555555555555", pendingId = "a".repeat(32);
const paired = (link = "online") => ({ state: "paired", binding: "b".repeat(64), hub: { hubId: id, name: "Example Hub", memberOrigin: "https://member.example.test", webOrigin: "https://hub.example.test", fingerprint: { kind: "hub-key", digest: "f".repeat(64) } }, link });
const response = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
const until = async (test: () => unknown) => { for (let i = 0; i < 100 && !test(); i++) await settle(4); expect(test()).toBeTruthy(); };
beforeAll(async () => {
  const p = page(); widget = await import("/ui/js/settings-hub-connection.js"); clientModule = await import("/ui/js/hub-client.js"); words = await import("/assets/app-i18n.js");
  confirmations = await import("/ui/js/settings-confirm.js"); shell = await import("/assets/app-shell.js"); p.restore();
});
afterEach(async () => {
  for (const p of pages.splice(0)) { await p.unmount(); p.restore(); }
  confirmations.resetConfirmations(); clientModule.setHubClient(null); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function fixture(options: { enabled?: boolean; pairing?: any; language?: string; legacy?: boolean; public?: boolean; bad?: any; heldRead?: Promise<any>; write?: Promise<any>; pending?: boolean; operation?: any; failedAfterWrite?: number; display?: any } = {}) {
  const p = page({ url: "http://127.0.0.1:19290/settings/hub", storage: { agend_lang: options.language ?? "en" } }); pages.push(p);
  vi.stubGlobal("crypto", webcrypto); if (options.public) p.document.body.dataset.publicLink = "1";
  words.setLang(options.language ?? "en");
  let enabled = options.enabled ?? false, pairing = options.pairing ?? { state: "unpaired" }, changed = false, failures = options.failedAfterWrite ?? 0;
  const calls: any[] = [], listeners = new Set<(p: any) => void>(), off = vi.fn();
  let rows = [{ agent: "atlas", display: "Atlas", revision: 0, state: "private", exposureId: null, enforceable: true }];
  const c = { stub: false, pairing: vi.fn(async () => pairing), subscribe: vi.fn((fn: any) => { listeners.add(fn); return () => { off(); listeners.delete(fn); }; }),
    exposures: vi.fn(async () => rows), pairingNotices: () => [],
    setExposed: vi.fn(async (...args: any[]) => { rows = rows.map(r => ({ ...r, state: args[1] ? "published" : "withdrawn", revision: r.revision + 1 })); return { ok: true }; }),
    connect: vi.fn(), disconnect: vi.fn(), cancel: vi.fn() };
  clientModule.setHubClient(c);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: any = {}) => {
    calls.push({ path, init });
    if (path.startsWith("/api/settings/hub/membership")) {
      if (init.method === "PUT") {
        if (options.write) return options.write;
        if (options.pending) return response({ result: "pending_confirmation", pending_change: { id: pendingId, state: "pending", can_self_confirm: true, can_withdraw: true, remaining_ms: 60000 } }, 202);
        enabled = JSON.parse(init.body).enabled; changed = true; return response({ ok: true, enabled });
      }
      if (changed && failures-- > 0) return response({ error: "unavailable" }, 503);
      if (options.heldRead) return options.heldRead;
      return response(options.bad ?? { ok: true, enabled, ...(!options.legacy && path.includes("?v=2") ? { connectionCardV1: true, pairing } : {}) });
    }
    if (path === "/api/hub/member/company-join") return response({ ok: true, bound: pairing.state !== "unpaired", operation: options.operation ?? null, display: options.display ?? null });
    if (path.endsWith("/company-join/reconnect") || path.endsWith("/company-join/remove")) { pairing = { state: "unpaired" }; return response({ ok: true, operation: { operationId: id, state: "awaiting-sign-in" } }); }
    if (path.endsWith("/confirm")) { enabled = true; return response({ result: "pending_confirmation", pending_change: { id: pendingId, state: "applied", outcome: { result: { ok: true } } } }, 202); }
    return response({ ok: true });
  }));
  await p.mount(h("div", null, h(shell.PendingChanges, { inline: true }), h(widget.HubConnectionSettings))); await settle(30);
  return { p, calls, c, off, setEnabled: (v: boolean) => { enabled = v; }, update: (v: any) => { pairing = v; for (const fn of listeners) fn(v); } };
}
const button = (p: AppPage, label: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === label);
async function click(p: AppPage, label: string) { const b = button(p, label); expect(b, label).toBeTruthy(); fire(b, "click"); await settle(20); }
describe("one Hub connection card", () => {
  it.each(["en", "zh-TW"])("off and unconnected: one frame, main sign-in, manual switch under Advanced, no implicit writes (%s)", async language => {
    const f = await fixture({ language }); await until(() => f.p.root.querySelector("#hubCompanyAddress"));
    expect(f.p.root.querySelectorAll("section.card")).toHaveLength(1); expect(f.p.root.querySelector("#hub-membership")).toBeNull();
    expect(f.p.root.querySelector(".hub-connection-manual #hubMemberEnabled")).toBeTruthy(); expect(f.p.root.querySelector("#hubAddress")).toBeNull();
    expect(f.p.root.textContent).not.toContain("hubConnection."); expect(f.calls.every(c => !c.init.method || c.init.method === "GET")).toBe(true);
    expect(f.c.pairing).not.toHaveBeenCalled(); expect(f.c.setExposed).not.toHaveBeenCalled();
  });
  it("a retired prior join does not hide a new sign-in or claim an absent binding is Connected", async () => {
    const f = await fixture({ operation: { operationId: id, state: "saved", link: "online", issued: true, outcomeKnown: true } });
    await until(() => f.p.root.querySelector("#hubCompanyAddress"));
    expect(f.p.root.querySelector("#hub-connection").getAttribute("data-state")).toBe("unconnected");
    expect(f.p.root.textContent).not.toContain("Fleet connected"); expect(f.calls.filter(c => c.init.method)).toEqual([]);
  });
  it("connected: readonly summary, Open/Pause and immediate opt-in Agent selection, without auto-share", async () => {
    const f = await fixture({ enabled: true, pairing: paired() }); await until(() => f.p.root.querySelector(".hub-exposure-main"));
    expect(f.p.root.querySelectorAll("section.card")).toHaveLength(1); expect(f.p.root.querySelector("#hub-connection").getAttribute("data-state")).toBe("connected");
    expect(f.p.root.textContent).toContain("Example Hub"); expect(f.p.root.querySelector("#hubCompanyAddress")).toBeNull(); expect(f.p.root.querySelector("#hubAddress")).toBeNull();
    expect(f.p.root.querySelector('a[href="https://hub.example.test/ui/hub"]')).toBeTruthy(); expect(f.c.setExposed).not.toHaveBeenCalled();
    const input = f.p.root.querySelector('.hub-exposure-main input'); expect(input.checked).toBe(false); input.checked = true; fire(input, "change"); await settle(15);
    expect(f.c.setExposed).toHaveBeenCalledOnce(); expect(f.c.setExposed.mock.calls[0]).toMatchObject(["atlas", true, 0, { dataViewId: "agent" }]);
  });
  it("Pause uses only the existing boolean write, keeps the saved binding and physically removes active share reads", async () => {
    const f = await fixture({ enabled: true, pairing: paired() }); await until(() => button(f.p, "Pause connection")); await click(f.p, "Pause connection");
    await until(() => f.p.root.querySelector("#hub-connection").getAttribute("data-state") === "paused");
    expect(f.p.root.textContent).toContain("Example Hub"); expect(f.p.root.textContent).toContain("existing conversations are kept");
    expect(f.p.root.querySelector(".hub-exposures")).toBeNull(); expect(f.off).toHaveBeenCalled();
    const writes = f.calls.filter(c => c.init.method); expect(writes).toHaveLength(1); expect(JSON.parse(writes[0].init.body)).toEqual({ enabled: false }); expect(f.c.disconnect).not.toHaveBeenCalled();
  });
  it("an acknowledged Pause followed by a failed read clears Connected and active controls; Retry reads without another write", async () => {
    const f = await fixture({ enabled: true, pairing: paired(), failedAfterWrite: 1 }); await until(() => f.p.root.querySelector(".hub-exposures"));
    await click(f.p, "Pause connection"); await until(() => f.p.root.textContent.includes("could not be read"));
    expect(f.p.root.querySelector("#hub-connection").getAttribute("data-state")).not.toBe("connected");
    expect(f.p.root.querySelector(".dot.ok")).toBeNull(); expect(f.p.root.querySelector(".hub-exposures")).toBeNull(); expect(f.off).toHaveBeenCalled();
    expect(f.p.document.body.dataset.hub).not.toBe("member");
    expect(button(f.p, "Pause connection")).toBeFalsy(); expect(f.calls.filter(c => c.init.method === "PUT")).toHaveLength(1);
    await click(f.p, "Try again"); await until(() => f.p.root.querySelector("#hub-connection").getAttribute("data-state") === "paused");
    expect(f.calls.filter(c => c.init.method === "PUT")).toHaveLength(1); expect(f.c.disconnect).not.toHaveBeenCalled(); expect(f.c.setExposed).not.toHaveBeenCalled();
  });
  it("a fresh paused page retains its Hub, starts no member client and resumes through confirmed membership", async () => {
    const f = await fixture({ pairing: paired("offline") }); expect(f.p.root.querySelector("#hub-connection").getAttribute("data-state")).toBe("paused");
    expect(f.c.pairing).not.toHaveBeenCalled(); expect(f.c.exposures).not.toHaveBeenCalled(); expect(f.p.root.textContent).toContain("Example Hub");
    await click(f.p, "Resume connection"); await until(() => f.c.pairing.mock.calls.length > 0); expect(JSON.parse(f.calls.find(c => c.init.method).init.body)).toEqual({ enabled: true });
    expect(f.c.setExposed).not.toHaveBeenCalled();
  });
  it("a saved but offline link never shows Connected or a green status", async () => {
    const f = await fixture({ enabled: true, pairing: paired("offline") }); await until(() => f.p.root.querySelector(".hub-exposures"));
    expect(f.p.root.querySelector("#hub-connection").getAttribute("data-state")).toBe("connecting"); expect(f.p.root.querySelector(".dot.ok")).toBeNull();
  });
  it.each([{ ok: false }, { ok: true, enabled: false, connectionCardV1: false, pairing: { state: "unpaired" } }, { ok: true, enabled: false, connectionCardV1: true, pairing: { state: "paired" } }])("unknown/incompatible reads never invent an unconnected form %j", async bad => {
    const f = await fixture({ bad }); expect(f.p.root.querySelector("form")).toBeNull(); expect(f.p.root.textContent).toContain("could not be read"); expect(f.calls.every(c => !c.init.method)).toBe(true);
  });
  it("an earlier host retains its original UI and sends no write", async () => {
    const f = await fixture({ legacy: true }); await until(() => f.p.root.querySelector("#hub-membership")); expect(f.calls.every(c => !c.init.method)).toBe(true);
  });
  it("public pages make no private read", async () => { const f = await fixture({ public: true }); expect(f.calls).toEqual([]); expect(f.p.root.textContent).toBe(""); });
  it("a late read after unmount cannot publish a member mark or connect", async () => {
    const d = deferred(), f = await fixture({ heldRead: d.promise }); await f.p.unmount(); d.resolve(response({ ok: true, enabled: true, connectionCardV1: true, pairing: paired() })); await settle(20);
    expect(f.p.document.body.dataset.hub).toBeUndefined(); expect(f.c.pairing).not.toHaveBeenCalled();
  });
  it("a failed Resume never reports Connected or retries a write automatically", async () => {
    const f = await fixture({ pairing: paired("offline"), write: Promise.resolve(response({ error: "unavailable" }, 503)) });
    await click(f.p, "Resume connection");
    expect(f.p.root.textContent).toContain("could not be verified"); expect(f.p.root.querySelector('[data-state="connected"]')).toBeNull();
    expect(f.c.pairing).not.toHaveBeenCalled(); expect(f.calls.filter(c => c.init.method === "PUT")).toHaveLength(1);
  });
  it("an unmounted pending write cannot start member reads or publish the new member mark", async () => {
    const d = deferred(), f = await fixture({ pairing: paired("offline"), write: d.promise });
    const before = f.calls.length; fire(button(f.p, "Resume connection"), "click"); await settle(4); await f.p.unmount();
    d.resolve(response({ ok: true, enabled: true })); await settle(20);
    expect(f.calls.slice(before).filter(c => !c.init.method)).toEqual([]); expect(f.c.pairing).not.toHaveBeenCalled();
    expect(f.p.document.body.dataset.hub).not.toBe("member");
  });
  it("one Resume remains pending until its exact shared confirmation applies in place", async () => {
    const f = await fixture({ pairing: paired("offline"), pending: true });
    const b = button(f.p, "Resume connection"); fire(b, "click"); fire(b, "click"); await until(() => f.p.root.querySelector('.pending-card[data-pending="'+pendingId+'"]'));
    expect(f.p.root.querySelector("#hub-connection").getAttribute("data-state")).toBe("paused"); expect(f.calls.filter(c => c.init.method === "PUT")).toHaveLength(1);
    const exact = f.p.root.querySelector('.pending-card[data-pending="'+pendingId+'"]'), scroll = vi.fn(), focus = vi.fn();
    exact.scrollIntoView = scroll; exact.querySelector("button,input,a").focus = focus;
    await click(f.p, "Review local confirmation"); expect(scroll).toHaveBeenCalledWith({ block: "center" }); expect(focus).toHaveBeenCalledOnce();
    await click(f.p, "Apply now"); await until(() => f.p.document.body.dataset.hub === "member");
    expect(f.calls.filter(c => c.init.method === "POST").map(c => c.path)).toEqual(["/api/settings/pending/"+pendingId+"/confirm"]); expect(f.c.setExposed).not.toHaveBeenCalled();
  });
});

describe("M-2921: the connected and held card (spec 1.1 / 1.3)", () => {
  const display = { v: 1, webOrigin: "https://hub.example.test", label: "build-box", hubName: "Acme Hub", ownerLabel: "王小明" };
  const held = (hold: string) => ({ state: "held", hold, memberOrigin: "https://member.example.test", hubId: id, binding: "b".repeat(64) });
  it("connected: titled by the Hub's name, with the owner line and this Fleet's name; 「移除這個連接」 asks once, then removes exactly this pairing", async () => {
    const f = await fixture({ enabled: true, pairing: paired(), display }); await until(() => f.p.root.querySelector(".hub-owner-line"));
    expect(f.p.root.querySelector(".hub-connection-summary").textContent).toContain("Acme Hub");
    expect(f.p.root.querySelector(".hub-owner-line").textContent).toBe("Connected with 王小明's company account \u00b7 This Fleet is called \u201cbuild-box\u201d");
    await click(f.p, "Remove this connection");
    expect(f.p.root.textContent).toContain("Remove the connection to \u201cAcme Hub\u201d? Agents you share will stop answering.");
    expect(f.calls.filter(c => c.path.endsWith("/remove"))).toEqual([]);
    await click(f.p, "Keep"); expect(f.p.root.textContent).not.toContain("Remove the connection to");
    await click(f.p, "Remove this connection"); await click(f.p, "Remove");
    const sent = f.calls.filter(c => c.path.endsWith("/company-join/remove"));
    expect(sent.map(c => JSON.parse(c.init.body))).toEqual([{ hubId: id, binding: "b".repeat(64), address: "https://hub.example.test" }]);
  });
  it("an older Hub (no owner or Hub name saved): no owner line; the address stands for the name", async () => {
    const f = await fixture({ enabled: true, pairing: paired(), display: { ...display, hubName: null, ownerLabel: null } }); await until(() => f.p.root.querySelector(".hub-connection-summary"));
    await settle(10);
    expect(f.p.root.querySelector(".hub-owner-line")).toBeNull();
  });
  it.each(["revoked", "rejected", "refused", "expired", "disconnected"])("held (%s): one primary 「重新連接」 for exactly this pairing and its saved address", async hold => {
    const f = await fixture({ enabled: true, pairing: held(hold), display }); await until(() => button(f.p, "Reconnect"));
    expect(button(f.p, "Reconnect").className).toContain("btn-primary");
    expect(f.p.root.querySelector(".hub-held").textContent).toContain("Acme Hub");
    expect(f.p.root.querySelector(".hub-held").textContent).not.toContain(":18602");
    await click(f.p, "Reconnect");
    expect(f.calls.filter(c => c.path.endsWith("/company-join/reconnect")).map(c => JSON.parse(c.init.body))).toEqual([{ hubId: id, binding: "b".repeat(64), address: "https://hub.example.test" }]);
  });
  it.each(["unsaved", "unknown_outcome"])("held (%s): no reconnect — that hold keeps its own recovery", async hold => {
    const f = await fixture({ enabled: true, pairing: held(hold), display }); await until(() => f.p.root.querySelector(".hub-held")); await settle(10);
    expect(button(f.p, "Reconnect")).toBeUndefined();
  });
  it("a pairing-code connection (no company-join record): 「重新連接」 opens 其他方式 instead of a request", async () => {
    const f = await fixture({ enabled: true, pairing: held("revoked") }); await until(() => button(f.p, "Reconnect"));
    await click(f.p, "Reconnect");
    expect(f.p.root.querySelector(".hub-connection-manual").open).toBe(true);
    expect(f.calls.filter(c => c.path.endsWith("/reconnect"))).toEqual([]);
  });
});

