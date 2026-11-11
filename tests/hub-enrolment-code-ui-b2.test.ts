/** Production Preact in the real shared Dialog, with an inert Hub client. No directory/network operation. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let ui: any, i18n: any, notices: any, clients: any;
const mounted: AppPage[] = [], ID = "11111111-1111-4111-8111-111111111111", GROUP = "22222222-2222-4222-8222-222222222222";
const liveCode = () => ({ id: ID, code: "1234-ABCD", state: "live", uses: 2, maxUses: 30, inFlight: 1,
  expiresAt: Date.now() + 3600000, perPersonFleets: 1, scope: { kind: "directory" }, recent: [] });
beforeAll(async () => { const p = page(); ui = await import("/ui/js/hub-enrolment-code.js"); i18n = await import("/assets/app-i18n.js"); notices = await import("/ui/js/hub-quick-pairing.js"); clients = await import("/ui/js/hub-client.js"); p.restore(); });
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fake(over: Record<string, unknown> = {}): any {
  return { enrolmentCodeV1: true, enrolmentCodes: vi.fn(async () => ({ ok: true, codes: [] })),
    createEnrolmentCode: vi.fn(async () => ({ ok: true, ...liveCode(), freeFleetRows: 256 })),
    revokeEnrolmentCode: vi.fn(async () => ({ ok: true })),
    resolveGroup: vi.fn(async (dn: string) => ({ ok: true, realm: "corp", objectId: GROUP, dn })), ...over };
}
async function mount(client: any, props: any = {}, lang = "en") {
  const p = page({ url: "https://hub.example.test/ui/hub?view=admin", storage: { agend_lang: lang } }); mounted.push(p);
  i18n.setLang(lang, { store: false });
  await p.mount(h(ui.HubEnrolmentCode, { client, enabled: true, host: "hub.example.test", ...props })); await settle(15); return p;
}
const text = (p: AppPage) => p.root.textContent || "";
const buttons = (p: AppPage, name: string) => [...p.root.querySelectorAll("button")].filter((b: any) => b.textContent === name);
async function open(p: AppPage) { fire(buttons(p, "Create join code")[0], "click"); await settle(10); }
async function submit(p: AppPage) { fire(p.root.querySelector("#hubEnrolmentCreate"), "submit"); await settle(15); }
function input(p: AppPage, id: string, value: string, event = "input") { const el = p.root.querySelector(id); el.value = value; fire(el, event); }

describe("B2 code management: explicit configured-admin actions", () => {
  it("is a named opt-in slot and stays inert with a cached client", async () => {
    expect(ui.enrolmentCodeV1).toBe(true); expect(ui.HubEnrolmentCode).toBeTypeOf("function");
    const c = fake({ enrolmentCodeV1: undefined }), p = await mount(c);
    expect(text(p)).toBe(""); expect(c.enrolmentCodes).not.toHaveBeenCalled(); expect(c.createEnrolmentCode).not.toHaveBeenCalled();
  });
  it("entry only reads; the shared dialog submits the specified defaults once", async () => {
    const c = fake(), changed = vi.fn(), p = await mount(c, { onChanged: changed });
    expect(c.createEnrolmentCode).not.toHaveBeenCalled(); await open(p);
    expect(p.root.querySelector("dialog.dlg")).not.toBeNull(); expect(p.root.querySelector(".card .card")).toBeNull();
    expect(p.root.querySelector("#hubCodeExpires").value).toBe("today");
    await submit(p);
    expect(c.createEnrolmentCode).toHaveBeenCalledExactlyOnceWith({ expires: "today", maxUses: 30, perPersonFleets: 1, scope: { kind: "directory" } });
    expect(changed).toHaveBeenCalledOnce(); expect(p.root.querySelector("dialog")).toBeNull();
  });
  it.each(["0", "201", "2.5", ""])("refuses an invalid maximum (%s) without a write", async value => {
    const c = fake(), p = await mount(c); await open(p); input(p, "#hubCodeMax", value); await settle(3); await submit(p);
    expect(c.createEnrolmentCode).not.toHaveBeenCalled();
  });
  it.each(["0", "9", "1.5"])("refuses an invalid per-person maximum (%s)", async value => {
    const c = fake(), p = await mount(c); await open(p); input(p, "#hubCodePerPerson", value); await settle(3); await submit(p);
    expect(c.createEnrolmentCode).not.toHaveBeenCalled();
  });
  it("resolves the selected DN before sending its exact group identity", async () => {
    const c = fake(), p = await mount(c); await open(p); input(p, "#hubCodeScope", "group", "change"); await settle(5); await submit(p);
    expect(c.createEnrolmentCode).not.toHaveBeenCalled(); const dn = "CN=Developers,DC=example,DC=test";
    input(p, "#hubCodeGroupDn", dn); await settle(3); fire(buttons(p, "Find group")[0], "click"); await settle(10); await submit(p);
    expect(c.resolveGroup).toHaveBeenCalledExactlyOnceWith(dn);
    expect(c.createEnrolmentCode.mock.calls[0][0].scope).toEqual({ kind: "group", realm: "corp", objectId: GROUP, dn });
  });
  it("an unknown group does not enable creation", async () => {
    const c = fake({ resolveGroup: vi.fn(async () => ({ ok: true, reason: "unknown" })) }), p = await mount(c);
    await open(p); input(p, "#hubCodeScope", "group", "change"); await settle(5); input(p, "#hubCodeGroupDn", "CN=Unknown"); await settle(3);
    fire(buttons(p, "Find group")[0], "click"); await settle(10); await submit(p);
    expect(c.createEnrolmentCode).not.toHaveBeenCalled(); expect(text(p)).toContain("could not be verified");
  });
  it("creation disabled does not disable the narrowing revoke action", async () => {
    const c = fake({ enrolmentCodes: vi.fn(async () => ({ ok: true, codes: [liveCode()] })) }), changed = vi.fn();
    const p = await mount(c, { enabled: false, onChanged: changed }); expect(buttons(p, "Create join code")[0].disabled).toBe(true);
    fire(buttons(p, "End this code now")[0], "click"); await settle(15);
    expect(c.revokeEnrolmentCode).toHaveBeenCalledExactlyOnceWith(ID); expect(changed).toHaveBeenCalledOnce();
    expect(c.createEnrolmentCode).not.toHaveBeenCalled();
  });
  it("copies the displayed host and code only on a press, without changing the URL", async () => {
    const writeText = vi.fn(async () => {});
    const c = fake({ enrolmentCodes: async () => ({ ok: true, codes: [liveCode()] }) }), p = await mount(c);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(writeText).not.toHaveBeenCalled(); fire(buttons(p, "Copy")[0], "click"); await settle(5);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("In AgEnD Settings → Hub, enter hub.example.test and this code.\n1234-ABCD");
    expect(location.href).not.toContain("1234"); expect(text(p)).toContain("Copied");
  });
  it.each(["expired", "exhausted", "revoked"])("never renders or copies a retained %s code", async state => {
    const c = fake({ enrolmentCodes: async () => ({ ok: true, codes: [{ ...liveCode(), state }] }) }), p = await mount(c);
    expect(text(p)).not.toContain("1234-ABCD"); expect(buttons(p, "Copy")).toHaveLength(0); expect(buttons(p, "End this code now")).toHaveLength(0);
  });
  it("retains counters, bounded recent entries and untrusted names as text", async () => {
    const row = { ...liveCode(), recent: Array.from({ length: 51 }, () => ({ label: "<img src=x>", owner: { name: "<script>" }, at: 1000 })) };
    const p = await mount(fake({ enrolmentCodes: async () => ({ ok: true, codes: [row] }) }));
    expect(text(p)).toContain("Connected 2 / 30"); expect(text(p)).toContain("1 connections in progress");
    expect(p.root.querySelectorAll("li")).toHaveLength(50); expect(p.root.querySelector("img")).toBeNull(); expect(text(p)).toContain("<script>");
  });
  it("an uncertain write never loops or silently enables another code creation", async () => {
    const c = fake({ createEnrolmentCode: vi.fn(async () => ({ ok: false, code: "unreachable" })) }), p = await mount(c);
    await open(p); await submit(p); expect(c.createEnrolmentCode).toHaveBeenCalledOnce();
    expect(text(p)).toContain("Check the code list before creating another code");
    expect(buttons(p, "Create join code")[0].disabled).toBe(true);
    expect(p.root.querySelector("form")).toBeNull();
  });
  it("warns from the server's remaining capacity after creation", async () => {
    const c = fake({ createEnrolmentCode: vi.fn(async () => ({ ok: true, ...liveCode(), freeFleetRows: 2 })) }), p = await mount(c);
    await open(p); await submit(p); expect(text(p)).toContain("Only 2 Fleet spaces remain"); expect(text(p)).toContain("up to 30");
  });
  it("two same-turn submit events make one write", async () => {
    let release!: (value: any) => void; const c = fake({ createEnrolmentCode: vi.fn(() => new Promise(resolve => { release = resolve; })) }), p = await mount(c);
    await open(p); const form = p.root.querySelector("form"); fire(form, "submit"); fire(form, "submit"); await settle(3);
    expect(c.createEnrolmentCode).toHaveBeenCalledOnce(); release({ ok: true }); await settle(10);
  });
  it("a session end clears codes and suppresses a held write's callback", async () => {
    let signedOut!: () => void, release!: (value: any) => void;
    const c = fake({ onSignedOut: (fn: any) => { signedOut = fn; return () => {}; },
      enrolmentCodes: async () => ({ ok: true, codes: [liveCode()] }), revokeEnrolmentCode: vi.fn(() => new Promise(resolve => { release = resolve; })) });
    const changed = vi.fn(), p = await mount(c, { onChanged: changed }); fire(buttons(p, "End this code now")[0], "click"); await settle(3);
    signedOut(); await settle(5); expect(text(p)).not.toContain("1234-ABCD");
    release({ ok: true }); await settle(10); expect(changed).not.toHaveBeenCalled(); expect(text(p)).not.toContain("1234-ABCD");
  });
  it("a held old read cannot resurrect the code after revoke", async () => {
    let release!: (value: any) => void, read = 0;
    const c = fake({ enrolmentCodes: vi.fn(() => ++read === 2 ? new Promise(resolve => { release = resolve; })
      : Promise.resolve({ ok: true, codes: [{ ...liveCode(), ...(read >= 3 ? { state: "revoked", code: null } : {}) }] })) });
    const timers: Array<() => void> = [], original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms: any, ...args: any[]) => ms === 5000 ? (timers.push(fn), 123 as any) : original(fn, ms, ...args));
    const p = await mount(c); timers.shift()!(); await settle(3); fire(buttons(p, "End this code now")[0], "click"); await settle(10);
    release({ ok: true, codes: [liveCode()] }); await settle(10);
    expect(text(p)).not.toContain("1234-ABCD"); expect(text(p)).toContain("Ended");
  });
  it("reads at five seconds only while the document is visible", async () => {
    const timers: Array<() => void> = [], original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms: any, ...args: any[]) => ms === 5000 ? (timers.push(fn), 123 as any) : original(fn, ms, ...args));
    const c = fake(), p = await mount(c); expect(c.enrolmentCodes).toHaveBeenCalledOnce();
    Object.defineProperty(p.document, "visibilityState", { value: "hidden", configurable: true }); timers.shift()!(); await settle(3); expect(c.enrolmentCodes).toHaveBeenCalledOnce();
    Object.defineProperty(p.document, "visibilityState", { value: "visible", configurable: true }); timers.shift()!(); await settle(5); expect(c.enrolmentCodes).toHaveBeenCalledTimes(2);
  });
  it("an offscreen card pauses reads and observes again without starting a second polling loop", async () => {
    let observe!: (entries: any[]) => void; const disconnect = vi.fn();
    class Observer { constructor(fn: any) { observe = fn; } observe() { observe([{ isIntersecting: false }]); } disconnect = disconnect; }
    vi.stubGlobal("IntersectionObserver", Observer);
    const timers: Array<() => void> = [], original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms: any, ...args: any[]) => ms === 5000 ? (timers.push(fn), 123 as any) : original(fn, ms, ...args));
    const c = fake(), p = await mount(c); expect(c.enrolmentCodes).not.toHaveBeenCalled();
    timers.shift()!(); await settle(3); expect(c.enrolmentCodes).not.toHaveBeenCalled();
    observe([{ isIntersecting: true }]); await settle(5); expect(c.enrolmentCodes).toHaveBeenCalledOnce();
    await p.unmount(); p.restore(); mounted.splice(mounted.indexOf(p), 1); expect(disconnect).toHaveBeenCalledOnce();
    for (const tick of timers) tick(); await settle(3); expect(c.enrolmentCodes).toHaveBeenCalledOnce();
  });
  it("zh-TW uses the specified join-code vocabulary", async () => {
    const p = await mount(fake({ enrolmentCodes: async () => ({ ok: true, codes: [liveCode()] }) }), {}, "zh-TW");
    expect(text(p)).toContain("建立加入碼"); expect(text(p)).toContain("已加入 2 / 30"); expect(text(p)).toContain("立即停用這組碼");
    expect(text(p)).not.toMatch(/配對|連線|公開|組織帳號/);
  });
  it("a code notice states its actual approval source, without calling it group permission", async () => {
    const p = page({ storage: { agend_lang: "en" } }); mounted.push(p); i18n.setLang("en", { store: false });
    clients.setHubClient({});
    await p.mount(h(notices.PairingNotices, { memberNotices: [{ id: ID, fleetId: GROUP, generation: 1, label: "Fleet", source: "code", codeId: ID, at: 1000, revoked: true }] }));
    await settle(5); expect(text(p)).toContain("Approved with a join code by your Hub administrator"); expect(text(p)).not.toContain("Approved by your Hub's group policy.");
    clients.setHubClient(null);
  });
});
