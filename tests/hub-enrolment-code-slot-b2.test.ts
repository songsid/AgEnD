/** Real U2 step + actual lazy B2 module, inert client only. No browser/container campaign. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let steps: any, hooks: any, i18n: any;
const mounted: AppPage[] = [], ID = "11111111-1111-4111-8111-111111111111";
beforeAll(async () => { const p = page(); steps = await import("/ui/js/hub-join-steps.js"); hooks = await import("/assets/app-html.js"); i18n = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } vi.restoreAllMocks(); });
const named = (p: AppPage, label: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === label);
function rig(rows: any[] = []) {
  let codes = rows;
  const row = { id: ID, state: "live", code: "1234-ABCD", expiresAt: Date.now() + 3600000, maxUses: 30, uses: 0, inFlight: 0, perPersonFleets: 1, scope: { kind: "directory" }, recent: [] };
  const changed = vi.fn();
  const client = { enrolmentCodeV1: true, enrolmentCodes: vi.fn(async () => ({ ok: true, codes })),
    createEnrolmentCode: vi.fn(async () => { codes = [row]; return { ok: true, ...row, freeFleetRows: 256 }; }),
    revokeEnrolmentCode: vi.fn(async () => { codes = codes.map(r => ({ ...r, state: "revoked", code: null })); return { ok: true }; }) };
  function Harness({ enabled = true }: { enabled?: boolean }) {
    const [, rerender] = hooks.useState(0);
    return h(steps.JoinStep3, { webOrigin: "https://hub.example.test:443", step1: enabled, step2: codes.some(c => c.state === "live"), features: ["enrolment-code-v1"], client,
      onChanged: () => { changed(); rerender((n: number) => n + 1); } });
  }
  return { client, changed, Harness, row };
}
async function mount(component: any, props = {}, lang = "en") {
  const p = page({ url: "https://hub.example.test/ui/hub/admin" }); mounted.push(p); i18n.setLang(lang, { store: false });
  await p.mount(h(component, props)); await settle(25); return p;
}
describe("U2 and B2 compose without an injected stand-in component", () => {
  it.each([
    ["en", "Create join code", "End this code now", "Copy these instructions"],
    ["zh-TW", "建立加入碼", "立即停用這組碼", "複製這段說明"],
  ])("the complete U2 card re-reads saved codes after create and revoke (%s)", async (lang, create, end, copy) => {
    const r = rig(), policy = { realm: "example", generation: "g1", revision: 1, state: "never-enabled", groups: [], denies: [] };
    const groupPolicy = vi.fn(async () => ({ ok: true, supported: true, binding: "ready", policy }));
    const client = { ...r.client, groupPolicy, searchGroups: vi.fn() };
    const p = await mount(steps.HubJoinCard, { client, groups: true, features: ["enrolment-code-v1"], view: { enabled: true }, webOrigin: "https://hub.example.test:443" }, lang);
    expect(p.root.querySelector('li[data-step="2"]').classList.contains("done")).toBe(false);
    expect(named(p, copy).disabled).toBe(true);
    const reads = r.client.enrolmentCodes.mock.calls.length, policies = groupPolicy.mock.calls.length;
    fire(named(p, create), "click"); await settle(10); fire(p.root.querySelector("#hubEnrolmentCreate"), "submit"); await settle(25);
    expect(r.client.createEnrolmentCode).toHaveBeenCalledExactlyOnceWith({ expires: "today", maxUses: 30, perPersonFleets: 1, scope: { kind: "directory" } });
    expect(r.client.enrolmentCodes.mock.calls.length).toBeGreaterThan(reads);
    expect(groupPolicy.mock.calls.length).toBeGreaterThan(policies);
    expect(p.root.querySelector('li[data-step="2"]').classList.contains("done")).toBe(true);
    expect(named(p, copy).disabled).toBe(false);
    expect(p.root.querySelector("#hubEnrolmentCodeSlot").textContent).toContain("1234-ABCD");
    fire(named(p, end), "click"); await settle(25);
    expect(r.client.revokeEnrolmentCode).toHaveBeenCalledExactlyOnceWith(ID);
    expect(p.root.querySelector('li[data-step="2"]').classList.contains("done")).toBe(false);
    expect(named(p, copy).disabled).toBe(true);
    expect(p.root.textContent).not.toContain("1234-ABCD");
    expect(client.searchGroups).not.toHaveBeenCalled();
  });
  it("the first live code enables step 2 through onChanged and unlocks the outer instructions", async () => {
    const r = rig(), p = await mount(r.Harness);
    expect(p.root.querySelector("#hubEnrolmentCodeSlot [data-enrolment-codes=v1]")).not.toBeNull();
    expect(named(p, "Copy these instructions").disabled).toBe(true); expect(named(p, "Create join code").disabled).toBe(false);
    fire(named(p, "Create join code"), "click"); await settle(10); fire(p.root.querySelector("#hubEnrolmentCreate"), "submit"); await settle(20);
    expect(r.client.createEnrolmentCode).toHaveBeenCalledExactlyOnceWith({ expires: "today", maxUses: 30, perPersonFleets: 1, scope: { kind: "directory" } });
    expect(r.changed).toHaveBeenCalledOnce(); expect(named(p, "Copy these instructions").disabled).toBe(false);
    expect(p.root.textContent).toContain("enter hub.example.test and this code"); expect(p.root.textContent).toContain("1234-ABCD");
  });
  it("company join off disables creation and outer instructions, while an existing code can still be ended", async () => {
    const r = rig(), p = await mount(r.Harness);
    fire(named(p, "Create join code"), "click"); await settle(5); fire(p.root.querySelector("form"), "submit"); await settle(15);
    await p.mount(h(r.Harness, { enabled: false })); await settle(10);
    expect(named(p, "Create join code").disabled).toBe(true); expect(named(p, "Copy these instructions").disabled).toBe(true);
    fire(named(p, "End this code now"), "click"); await settle(15);
    expect(r.client.revokeEnrolmentCode).toHaveBeenCalledExactlyOnceWith(ID); expect(p.root.textContent).not.toContain("1234-ABCD");
  });
  it("the actual module stays inert with a held older client", async () => {
    const client = { enrolmentCodes: vi.fn() }, p = await mount(steps.JoinStep3, { webOrigin: "https://hub.example.test", step1: true, step2: true, features: ["enrolment-code-v1"], client });
    expect(p.root.querySelector("#hubEnrolmentCodeSlot")).not.toBeNull(); expect(p.root.querySelector("[data-enrolment-codes]")).toBeNull();
    expect(client.enrolmentCodes).not.toHaveBeenCalled();
  });
});
