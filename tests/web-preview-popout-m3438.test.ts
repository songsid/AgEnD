import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error app JS
import { createPopoutTransport, receivePopoutDraft, POPOUT_DEADLINE_MS } from "../src/ui/chat-popout-transport.js";
const name = "example-agent", scope = "example-session", nonce = "11111111-2222-4333-8444-555555555555";
const message = (type: string, extra: any = {}) => ({ channel: "agend-preview-popout-v1", type, name, scope, ...extra });
function winDouble() {
  const events = new Map<string, Set<Function>>();
  return {
    location: { origin: "https://fleet.example", href: "https://fleet.example/ui/chat/example-agent?presentation=preview" }, crypto: { randomUUID: () => nonce },
    closed: false, opener: null as any, postMessage: vi.fn(), open: vi.fn(),
    addEventListener(k: string, f: Function) { if (!events.has(k)) events.set(k, new Set()); events.get(k)!.add(f); },
    removeEventListener(k: string, f: Function) { events.get(k)?.delete(f); },
    fire(k: string, e: any = {}) { for (const f of [...events.get(k) ?? []]) f(e); },
  };
}
afterEach(() => vi.useRealTimers());
describe("M-3438 bounded preview pop-out", () => {
  it("opens in the click stack with only an existing authenticated route; locator crosses only exact ready/ACK", () => {
    vi.useFakeTimers(); const win = winDouble(), child = winDouble(); win.open.mockReturnValue(child);
    const complete = vi.fn(() => true), notify = vi.fn();
    const owner = createPopoutTransport({ win, scope, notify, kind: "preview" });
    const payload = { msgKey: "example-1", n: 0 };
    owner.open({ name, payload, current: () => true, complete });
    expect(win.open).toHaveBeenCalledWith("/ui/chat/example-agent?presentation=preview", "_blank", "popup,width=760,height=800");
    win.fire("message", { source: child, origin: "https://other.example", data: message("ready") });
    win.fire("message", { source: {}, origin: win.location.origin, data: message("ready") });
    win.fire("message", { source: child, origin: win.location.origin, data: message("ready", { scope: "other" }) });
    expect(child.postMessage).not.toHaveBeenCalled();
    win.fire("message", { source: child, origin: win.location.origin, data: message("ready") });
    expect(child.postMessage).toHaveBeenCalledWith(message("locator", { nonce, payload }), win.location.origin);
    win.fire("message", { source: child, origin: win.location.origin, data: message("received", { nonce: "wrong" }) });
    expect(complete).not.toHaveBeenCalled();
    win.fire("message", { source: child, origin: win.location.origin, data: message("received", { nonce }) });
    win.fire("message", { source: child, origin: win.location.origin, data: message("received", { nonce }) });
    expect(complete).toHaveBeenCalledOnce(); owner.close();
  });
  it("keeps a cryptographic nonce on an HTTP LAN browser without randomUUID", () => {
    vi.useFakeTimers(); const win: any = winDouble(), child = winDouble(); win.open.mockReturnValue(child);
    win.crypto = { getRandomValues: (bytes: Uint8Array) => { bytes.fill(7); return bytes; } };
    const owner = createPopoutTransport({ win, scope, kind: "preview" });
    expect(() => owner.open({ name, payload: { msgKey: "example-1", n: 0 }, current: () => true, complete: () => true })).not.toThrow();
    expect(win.open).toHaveBeenCalledOnce();
    win.fire("message", { source: child, origin: win.location.origin, data: message("ready") });
    expect(child.postMessage.mock.calls[0][0].nonce).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    owner.close();
  });
  it.each(["current", "timeout"])("waits for the child's own asynchronous read and refuses a stale %s before ACK", async reason => {
    vi.useFakeTimers(); const win = winDouble(), parent = winDouble(); win.opener = parent;
    let live = true, resolve!: (v: boolean) => void;
    const accept = vi.fn(() => new Promise<boolean>(r => { resolve = r; }));
    const stop = receivePopoutDraft({ win, name, scope, kind: "preview", ready: () => true, current: () => live, accept });
    win.fire("message", { source: parent, origin: win.location.origin, data: message("locator", { nonce, payload: { msgKey: "example-1", n: 0 } }) });
    expect(accept).toHaveBeenCalledOnce();
    expect(parent.postMessage).toHaveBeenCalledTimes(1); // READY only
    if (reason === "current") live = false; else vi.advanceTimersByTime(POPOUT_DEADLINE_MS + 1);
    resolve(true); await Promise.resolve(); await Promise.resolve();
    expect(parent.postMessage).toHaveBeenLastCalledWith(message("refused", { nonce }), win.location.origin); stop();
  });
});

describe("M-3438 locator is resolved from the child's own authorized history", () => {
  async function modelModule() {
    const harness = await import("./helpers/app-harness.js");
    const pg = harness.page();
    const model = await import("../src/ui/preview-popout.js" as string);
    return { model, restore: () => pg.restore() };
  }
  const fence = String.fromCharCode(96).repeat(3);
  const row = () => ({ instance: name, role: "agent", boot: "example", id: 7, sender: "example-helper", ts: "2026-01-01T00:00:00Z",
    text: fence + "html\n<title>Own history</title><h1>Example</h1>\n" + fence });
  it("carries no HTML, sender, URLs or authority; reads the locator before reconstructing content", async () => {
    const { model, restore } = await modelModule();
    try {
      const r = row(), state = { msgs: { [name]: [] as any[] } };
      const findQuoted = vi.fn(async () => { state.msgs[name] = [r]; return true; });
      const chat = { store: { state, findQuoted } }, locator = { msgKey: "example-7", n: 0 };
      expect(model.previewLocator({ kind: "html", instance: name, ...locator, code: "not transferred", sender: "not transferred" })).toEqual(locator);
      expect(await model.readPreviewSpec(chat, name, { ...locator, code: "injected" }, () => true)).toBeNull();
      expect(findQuoted).not.toHaveBeenCalled();
      const spec = await model.readPreviewSpec(chat, name, locator, () => true);
      expect(findQuoted).toHaveBeenCalledWith(name, "example-7");
      expect(spec).toMatchObject({ sender: r.sender, key: "example-7:f0" });
      expect(spec.code).toContain("<title>Own history</title>");
      for (const changed of [{ ...r, instance: "other-agent" }, { ...r, role: "user" }, { ...r, text: fence + "html\nunfinished" }]) {
        expect(model.previewSpecFromHistory(name, locator, [changed])).toBeNull();
      }
    } finally { restore(); }
  });
  it("reads only an owned HTML attachment through the existing same-origin loader and refuses missing or oversized files", async () => {
    const { model, restore } = await modelModule();
    const previousFetch = globalThis.fetch;
    try {
      const id = "a".repeat(32), html = "<h1>Owned example file</h1>";
      const r = { ...row(), attachments: [{ id, name: "example.html", size: 64, contentType: "text/html" }] };
      const chat = { store: { state: { msgs: { [name]: [r] } }, findQuoted: vi.fn(async () => true) } };
      const fetchFile = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(html).buffer }));
      globalThis.fetch = fetchFile as any;
      const spec = await model.readPreviewSpec(chat, name, { msgKey: "example-7", attachmentId: id }, () => true);
      expect(spec).toMatchObject({ code: html, att: { id, name: "example.html", size: 64 } });
      expect(spec).not.toHaveProperty("anyway"); // Reading is not consent to launch an oversized frame.
      expect(fetchFile).toHaveBeenCalledWith("/ui/file/" + id, { credentials: "same-origin", cache: "no-store" });
      fetchFile.mockClear();
      expect(await model.readPreviewSpec(chat, name, { msgKey: "example-7", attachmentId: "b".repeat(32) }, () => true)).toBeNull();
      r.attachments[0].size = 50 * 1024 * 1024 + 1;
      expect(await model.readPreviewSpec(chat, name, { msgKey: "example-7", attachmentId: id }, () => true)).toBeNull();
      expect(fetchFile).not.toHaveBeenCalled();
      r.attachments[0].size = 64;
      fetchFile.mockResolvedValue({ ok: false, status: 404 } as any);
      expect(await model.readPreviewSpec(chat, name, { msgKey: "example-7", attachmentId: id }, () => true)).toBeNull();
    } finally { globalThis.fetch = previousFetch; restore(); }
  });
  it("refuses a superseded own-history read before returning a displayable spec", async () => {
    const { model, restore } = await modelModule();
    try {
      let live = true, release!: () => void;
      const chat = { store: { state: { msgs: { [name]: [row()] } }, findQuoted: () => new Promise<void>(r => { release = r; }) } };
      const answer = model.readPreviewSpec(chat, name, { msgKey: "example-7", n: 0 }, () => live);
      live = false; release();
      expect(await answer).toBeNull();
    } finally { restore(); }
  });
});

it("M-3438 child waits for its own status and mounted preview host before sending READY", async () => {
  const harness = await import("./helpers/app-harness.js"), pg = harness.page();
  const previousAuth = (globalThis as any).AgendAuth;
  const win: any = winDouble(), parent = winDouble(); win.opener = parent;
  win.history = { state: null, replaceState: vi.fn() };
  (globalThis as any).AgendAuth = { sessionHandle: async () => scope, sessionEnded: () => false, onSessionEnd: () => () => {} };
  const { appStore } = await import("/assets/app-store.js" as string);
  const panel = await import("/assets/preview-panel.js" as string);
  const model = await import("../src/ui/preview-popout.js" as string);
  const stamp = { route: { panel: "chat", instance: name } };
  const nav = { navStore: { get: () => stamp, subscribe: () => () => {} } };
  let owner: any;
  try {
    appStore.set({ ready: false, instances: [] });
    const pending = model.installPreviewWindow({ nav, chat: {}, win });
    const css: any = pg.document.head.querySelector('link[href="/assets/preview-popout.css"]');
    expect(css).not.toBeNull(); css.onload();
    owner = await pending;
    expect(parent.postMessage).not.toHaveBeenCalled();
    appStore.set({ ready: true, instances: [{ name }] });
    await pg.mount(harness.h(panel.PreviewPanel, {
      name, split: { current: pg.root }, msgs: () => [], subscribe: () => () => {}, keyOf: (m: any) => m.boot + "-" + m.id,
      reveal() {}, download() {},
    }));
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalledWith(message("ready"), win.location.origin));
  } finally {
    owner?.close(); await pg.unmount(); pg.restore();
    if (previousAuth === undefined) delete (globalThis as any).AgendAuth; else (globalThis as any).AgendAuth = previousAuth;
    appStore.set({ ready: false, instances: [] });
  }
});
