import { afterEach, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
const mounted: AppPage[] = [];
const until = async (test: () => unknown) => { for (let i = 0; i < 120 && !test(); i++) await settle(3); };
const held = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
afterEach(async () => {
  const c = await import("/ui/js/settings-confirm.js"); c.resetConfirmations();
  for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); }
});
async function fixture(o: { language?: string; enabled?: boolean; public?: boolean; memberMark?: boolean; getStatus?: number; pending?: boolean; write?: Promise<any> } = {}) {
  const pg = page({ url: "http://127.0.0.1:19280/settings/access", storage: { agend_tour_done: "1" } }); mounted.push(pg);
  if (o.public) pg.document.body.dataset.publicLink = "1";
  if (o.memberMark) pg.document.body.dataset.hub = "member";
  let enabled = o.enabled ?? false, getStatus = o.getStatus ?? 200;
  const calls: Array<{ path: string; options: any }> = [];
  (globalThis as any).fetch = async (path: string, options: any = {}) => {
    calls.push({ path, options });
    if (path === "/api/settings/hub/membership") {
      if (!options.method) return response({ ok: getStatus === 200, enabled }, getStatus);
      if (o.write) return o.write;
      if (o.pending) return response({ result: "pending_confirmation", pending_change: { id: "m".repeat(32), state: "pending", remaining_ms: 60000 } }, 202);
      enabled = JSON.parse(options.body).enabled; return response({ ok: true, enabled });
    }
    return response({ ok: true, pairing: { state: "unpaired" } });
  };
  const i18n = await import("/assets/app-i18n.js"); i18n.setLang(o.language ?? "en", { store: false });
  const module = await import("/ui/js/settings-hub-membership.js");
  await pg.mount(h(module.HubMembershipSettings, {})); await until(() => o.public || !!pg.root.querySelector("input"));
  await settle(5);
  return { pg, calls, state(v: boolean) { enabled = v; }, status(v: number) { getStatus = v; } };
}
const change = (pg: AppPage, enabled: boolean) => { const input: any = pg.root.querySelector("input"); input.checked = enabled; fire(input, "change"); };
describe("off-default lazy Hub membership Settings", () => {
  it.each(["en", "zh-TW"])("shows localized owner guidance while off (%s), saves only the boolean, then asks for a page refresh", async language => {
    const { pg, calls } = await fixture({ language });
    expect(pg.root.textContent).toContain(language === "en" ? "Hub membership" : "Hub 成員功能");
    expect(pg.root.textContent).toContain(language === "en" ? "does not pair a Hub or share an agent" : "不會自動配對 Hub 或分享代理");
    expect(pg.root.textContent).not.toContain("hubMembership.");
    expect((pg.root.querySelector("input") as any).checked).toBe(false);
    expect(calls.map(c => c.path)).toEqual(["/api/settings/hub/membership"]);
    change(pg, true); await until(() => calls.length === 3);
    expect(calls[1]!.options.method).toBe("PUT"); expect(JSON.parse(calls[1]!.options.body)).toEqual({ enabled: true });
    expect(calls[1]!.options.headers["Idempotency-Key"]).toBeTruthy();
    await until(() => (pg.root.querySelector("input") as any).checked);
    expect(pg.root.textContent).toContain(language === "en" ? "Reload page" : "重新整理頁面");
    expect(pg.root.querySelector("#hubAddress")).toBeNull(); // an old off-marked page never selects the stub pairing client
    expect(calls.every(c => !c.path.startsWith("/api/hub/member/"))).toBe(true);
  });
  it("holds the displayed persisted state and one write through pending owner confirmation", async () => {
    const f = await fixture({ pending: true });
    change(f.pg, true); change(f.pg, true);
    await until(() => f.pg.root.textContent.includes("Waiting for owner confirmation"));
    expect(f.calls.filter(c => c.options.method)).toHaveLength(1);
    expect((f.pg.root.querySelector("input") as any).checked).toBe(false);
    expect((f.pg.root.querySelector("input") as any).disabled).toBe(true);
    f.state(true);
    const c = await import("/ui/js/settings-confirm.js"); await c.track({ id: "m".repeat(32), state: "applied", outcome: { result: { ok: true } } }, "Hub membership");
    await until(() => !(f.pg.root.querySelector("input") as any).disabled);
    expect((f.pg.root.querySelector("input") as any).checked).toBe(true);
    expect(f.calls.filter(c => !c.options.method && c.path === "/api/settings/hub/membership")).toHaveLength(2);
  });
  it("unknown or failed reads disable changes; an older host can be checked again without a mutation", async () => {
    const f = await fixture({ getStatus: 404 });
    await until(() => f.pg.root.textContent.includes("unavailable"));
    expect((f.pg.root.querySelector("input") as any).disabled).toBe(true);
    change(f.pg, true); await settle(); expect(f.calls).toHaveLength(1);
    f.status(200); fire(f.pg.root.querySelector("button")!, "click"); await until(() => !(f.pg.root.querySelector("input") as any).disabled);
    expect((f.pg.root.querySelector("input") as any).checked).toBe(false); expect(f.calls.every(c => !c.options.method)).toBe(true);
  });
  it("an ambiguous write becomes unknown rather than success and needs a fresh read before retry", async () => {
    const f = await fixture({ write: Promise.resolve(response({ result: "pending_confirmation" }, 202)) });
    change(f.pg, true); await until(() => f.pg.root.textContent.includes("could not be verified"));
    expect((f.pg.root.querySelector("input") as any).disabled).toBe(true);
    expect(f.pg.root.textContent).not.toContain("Reload page");
    expect(f.calls).toHaveLength(2);
    fire(f.pg.root.querySelector("button")!, "click"); await until(() => f.calls.length === 3);
    expect(f.calls[2]!.options.method).toBeUndefined();
  });
  it("a late older retry cannot overwrite the newer membership read", async () => {
    const f = await fixture({ getStatus: 404 }), older = held<any>(), newer = held<any>(); let reads = 0;
    await until(() => f.pg.root.textContent.includes("unavailable"));
    (globalThis as any).fetch = () => ++reads === 1 ? older.promise : newer.promise;
    const retry = f.pg.root.querySelector("button")!; fire(retry, "click"); fire(retry, "click");
    expect(reads).toBe(2);
    newer.resolve(response({ ok: true, enabled: false })); await until(() => !(f.pg.root.querySelector("input") as any).disabled);
    older.resolve(response({ ok: true, enabled: true })); await settle(10);
    expect((f.pg.root.querySelector("input") as any).checked).toBe(false);
    expect(f.pg.root.textContent).not.toContain("Reload page");
  });
  it("does not start a readback after the card unmounts during a held write", async () => {
    const write = held<any>(), f = await fixture({ write: write.promise });
    change(f.pg, true); await until(() => f.calls.length === 2); await f.pg.unmount();
    write.resolve(response({ ok: true, enabled: true })); await settle(10);
    expect(f.calls).toHaveLength(2); expect(f.pg.root.textContent).toBe("");
  });
  it("a public-link page loads no membership data or control", async () => {
    const f = await fixture({ public: true, enabled: true, memberMark: true }); await settle(10);
    expect(f.calls).toEqual([]); expect(f.pg.root.textContent).toBe(""); expect(f.pg.root.querySelector("input")).toBeNull();
  });
});
