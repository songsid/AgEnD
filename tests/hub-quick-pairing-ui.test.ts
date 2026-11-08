/** Mounted production Preact, inert Hub client: no HTTP/native operations. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let client: any, ui: any;
const mounted: AppPage[] = [];
const ID = "0f1e2d3c-4b5a-4968-8776-655443322110", FLEET = "1f1e2d3c-4b5a-4968-8776-655443322111", FP = "a".repeat(64);
const pending = { id: ID, state: "pending", fingerprint: FP, ownerConfirmed: false, expiresAt: Date.now() + 600_000, fleetId: FLEET, connected: false };
const notice = { id: ID, fleetId: FLEET, generation: 3, label: "<img src=x onerror=alert(1)>", source: "group", at: 100, revoked: false };
beforeAll(async () => {
  const p = page({ url: "http://127.0.0.1:19290/ui/hub", storage: { agend_lang: "en" } });
  client = await import("/ui/js/hub-client.js"); ui = await import("/ui/js/hub-quick-pairing.js"); p.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); vi.unstubAllGlobals(); });
function fake(over: Record<string, unknown> = {}): any {
  return {
    quickPairing: vi.fn(async () => ({ ok: true, attempt: null, memberOrigin: "https://hub.example.test:9443" })),
    createQuickPairing: vi.fn(async () => ({ ok: true, pairingId: ID, code: "abcdef123456", expiresAt: Date.now() + 600_000, memberOrigin: "https://hub.example.test:9443" })),
    stopQuickPairing: vi.fn(async () => ({ ok: true })), confirmPairing: vi.fn(async () => ({ ok: true })),
    pairingNotices: vi.fn(async () => ({ ok: true, notices: [notice] })), subscribePairingNotices: () => () => {},
    acknowledgePairingNotice: vi.fn(async () => ({ ok: true })), revokeOwnFleet: vi.fn(async () => ({ ok: true })), revokeFleet: vi.fn(async () => ({ ok: true })), ...over,
  };
}
async function mount(c: any, component = ui.QuickPairingGuide, props: any = { allowed: true }) {
  const p = page({ url: "http://127.0.0.1:19290/ui/hub", storage: { agend_lang: "en" } }); mounted.push(p);
  client.setHubClient(c); await p.mount(h(component, props)); await settle(20); return p;
}
const txt = (p: AppPage) => p.root.textContent || "";
const button = (p: AppPage, text: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === text);

describe("quick-pairing guide preserves each proof and user intent", () => {
  it("does not mint on entry; one submit shows the member port, code and local confirmation instructions", async () => {
    const c = fake(), p = await mount(c);
    expect(c.createQuickPairing).not.toHaveBeenCalled();
    const input = p.root.querySelector("input"); input.value = "My laptop"; fire(input, "input"); await settle(5);
    fire(p.root.querySelector("form"), "submit"); await settle(20);
    expect(c.createQuickPairing).toHaveBeenCalledExactlyOnceWith("My laptop");
    expect(txt(p)).toContain("https://hub.example.test:9443"); expect(txt(p)).toContain("abcdef123456");
    expect(txt(p)).toContain("Confirm the local prompt there"); expect(txt(p)).not.toContain("Connected");
  });
  it("requires an explicit fingerprint match, then waits for the pinned connection rather than promising success", async () => {
    const c = fake({ quickPairing: vi.fn(async () => ({ ok: true, attempt: pending })) }), p = await mount(c);
    expect(c.confirmPairing).not.toHaveBeenCalled(); expect(txt(p)).toContain("aaaa aaaa");
    c.quickPairing.mockResolvedValue({ ok: true, attempt: { ...pending, ownerConfirmed: true } });
    fire(button(p, "They match"), "click"); await settle(20);
    expect(c.confirmPairing).toHaveBeenCalledExactlyOnceWith(ID, FP); expect(txt(p)).toContain("Waiting for your fleet's pinned connection");
    expect(txt(p)).not.toContain("Connected"); expect(button(p, "They match")).toBeUndefined();
  });
  it("mismatch stops the exact offer with no match or extra confirmation click", async () => {
    const c = fake({ quickPairing: async () => ({ ok: true, attempt: pending }) }), p = await mount(c);
    fire(button(p, "They differ"), "click"); await settle(20);
    expect(c.stopQuickPairing).toHaveBeenCalledExactlyOnceWith(ID); expect(c.confirmPairing).not.toHaveBeenCalled();
    expect(txt(p)).toContain("Pairing is stopped"); expect(button(p, "They match")).toBeUndefined();
  });
  it("an unknown lookup presents retry without cached permission or a successful pairing claim", async () => {
    const c = fake({ quickPairing: async () => ({ ok: false, code: "unavailable" }) }), p = await mount(c, ui.QuickPairingGuide, { allowed: false });
    expect(txt(p)).toContain("can't confirm whether pairing finished"); expect(c.createQuickPairing).not.toHaveBeenCalled();
    expect(p.root.querySelector("form")).toBe(null); expect(txt(p)).not.toContain("Connected");
  });
  it("renders Connected only for a ready link and keeps publication permission separate", async () => {
    const c = fake({ quickPairing: async () => ({ ok: true, attempt: { ...pending, state: "claimed", connected: true } }) });
    const p = await mount(c, ui.QuickPairingGuide, { allowed: false, publishAllowed: false });
    expect(txt(p)).toContain("Connected"); expect(txt(p)).toContain("Sharing new agents is not included");
    expect(c.confirmPairing).not.toHaveBeenCalled(); expect(p.root.querySelector("form")).toBe(null);
  });
  it("can start another allowed fleet without replaying the completed attempt", async () => {
    const c = fake({ quickPairing: async () => ({ ok: true, attempt: { ...pending, state: "claimed", connected: true } }) });
    const changed = vi.fn(), p = await mount(c, ui.QuickPairingGuide, { allowed: true, onConnected: changed });
    expect(changed).toHaveBeenCalledOnce(); fire(button(p, "Connect another fleet"), "click"); await settle(10);
    expect(p.root.querySelector("form")).not.toBe(null); expect(c.createQuickPairing).not.toHaveBeenCalled();
  });
});

describe("security notices and exact owner narrowing", () => {
  it("uses a snapshot-capable notice stream for bootstrap without a duplicate authenticated GET", async () => {
    const off = vi.fn(), subscribe = vi.fn((fn: (rows: unknown[]) => void) => { queueMicrotask(() => fn([notice])); return off; });
    const c = fake({ pairingNoticeSnapshotV1: true, subscribePairingNotices: subscribe });
    const p = await mount(c, ui.PairingNotices, {});
    expect(subscribe).toHaveBeenCalledOnce(); expect(c.pairingNotices).not.toHaveBeenCalled();
    expect(txt(p)).toContain("A new fleet was connected");
    await p.unmount(); mounted.splice(mounted.indexOf(p), 1); p.restore(); expect(off).toHaveBeenCalledOnce();
  });
  it("keeps the notice EventSource on the separate Hub workspace and uses only the member's existing private poll", async () => {
    const streams:any[]=[];
    class Stream {
      handlers:Record<string,(e:any)=>void>={};close=vi.fn();
      constructor(readonly path:string){streams.push(this);}
      addEventListener(name:string,fn:(e:any)=>void){this.handlers[name]=fn;}
    }
    vi.stubGlobal("EventSource",Stream);
    const seen=vi.fn(),hub=client.createHubWebClient(),off=hub.subscribePairingNotices(seen);
    expect(streams.map(s=>s.path)).toEqual(["/hub/v1/notices/events"]); expect(hub.pairingNoticeSnapshotV1).toBe(true);
    streams[0].handlers.notices({data:JSON.stringify({notices:[notice]})});expect(seen).toHaveBeenCalledWith([notice]);
    off();expect(streams[0].close).toHaveBeenCalledOnce();
    const api=vi.fn(async()=>({ok:true,body:{pairing:{state:"unpaired"},notices:[notice]}}));
    const timers={setTimeout:vi.fn(()=>1),clearTimeout:vi.fn()};
    const member=client.createMemberClient({confirm:{api},timers,doc:{hidden:false}});
    await member.pairing();expect(api).toHaveBeenCalledExactlyOnceWith("/api/hub/member/pairing");
    expect(member.pairingNotices()).toEqual([notice]);const stop=member.subscribe(()=>{});stop();
    expect(streams).toHaveLength(1);expect(timers.clearTimeout).toHaveBeenCalledOnce();
  });
  it("falls back to the authenticated notice GET when EventSource is unavailable", async () => {
    vi.stubGlobal("EventSource", undefined);
    const hub = client.createHubWebClient();
    expect(hub.pairingNoticeSnapshotV1).toBe(false);
    const c = fake({ pairingNoticeSnapshotV1: hub.pairingNoticeSnapshotV1,
      subscribePairingNotices: hub.subscribePairingNotices });
    const p = await mount(c, ui.PairingNotices, {});
    expect(c.pairingNotices).toHaveBeenCalledOnce(); expect(txt(p)).toContain("A new fleet was connected");
  });
  it("reveals older history in bounded batches and ACKs it only when shown", async () => {
    const rows=Array.from({length:201},(_,i)=>({...notice,id:`history-${i}`,label:`History ${i}`}));
    const c=fake({pairingNotices:async()=>({ok:true,notices:rows})}),p=await mount(c,ui.PairingNotices,{});
    expect(c.acknowledgePairingNotice.mock.calls).toEqual([["history-0"]]);
    const details=p.root.querySelector("details");details.open=true;fire(details,"toggle");await settle(30);
    expect(p.root.querySelectorAll("[data-pairing-notice]")).toHaveLength(100);
    expect(button(p,"Show older notices")).not.toBeUndefined();
    fire(button(p,"Show older notices"),"click");await settle(30);
    expect(p.root.querySelectorAll("[data-pairing-notice]")).toHaveLength(200);
    fire(button(p,"Show older notices"),"click");await settle(30);
    expect(p.root.querySelectorAll("[data-pairing-notice]")).toHaveLength(201);expect(txt(p)).toContain("History 200");
    expect(button(p,"Show older notices")).toBeUndefined();
    expect(c.acknowledgePairingNotice).toHaveBeenCalledWith("history-200");
  });
  it("renders an untrusted label as text and revokes only the displayed fleet/generation in one click", async () => {
    const c = fake(), p = await mount(c, ui.PairingNotices, {});
    expect(txt(p)).toContain(notice.label); expect(p.root.querySelector("img")).toBe(null);
    expect(c.acknowledgePairingNotice).toHaveBeenCalledExactlyOnceWith(ID);
    fire(button(p, "Revoke this fleet"), "click"); await settle(20);
    expect(c.revokeOwnFleet).toHaveBeenCalledExactlyOnceWith(FLEET, 3); expect(c.revokeFleet).not.toHaveBeenCalled();
    expect(p.root.querySelector("[role=dialog]")).toBe(null);
  });
  it("uses the existing admin revoke route only for the admin notice", async () => {
    const c = fake(), p = await mount(c, ui.PairingNotices, { admin: true });
    fire(button(p, "Revoke this fleet"), "click"); await settle(20);
    expect(c.revokeFleet).toHaveBeenCalledExactlyOnceWith(FLEET); expect(c.revokeOwnFleet).not.toHaveBeenCalled();
  });
  it("owner narrowing remains available without any self-service permission", async () => {
    const c = fake(), done = vi.fn(), p = await mount(c, ui.OwnedFleetRevoke, { fleet: { id: FLEET, generation: 7, status: "suspended" }, onRevoked: done });
    fire(button(p, "Revoke this fleet"), "click"); await settle(20);
    expect(c.revokeOwnFleet).toHaveBeenCalledExactlyOnceWith(FLEET, 7); expect(done).toHaveBeenCalledOnce();
  });
});
