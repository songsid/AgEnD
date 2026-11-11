/** Actual U2 picker + B2 dialog, inert directory client. The missing-capability case models a held older module. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
const version = vi.hoisted(() => ({ ids: true }));
vi.mock("/ui/js/hub-group-search.js", async original => {
  const actual = await original<Record<string, unknown>>();
  return { ...actual, get groupSearchIdV1() { return version.ids; } };
});
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let codes: any, groups: any, i18n: any;
const mounted: AppPage[] = [], GROUP = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const hit = { cn: "Developers", dn: "CN=Developers,DC=example,DC=test", objectId: GROUP };
beforeAll(async () => { const p = page(); codes = await import("/ui/js/hub-enrolment-code.js"); groups = await import("/ui/js/hub-group-search.js"); i18n = await import("/assets/app-i18n.js"); p.restore(); });
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } version.ids = true; });
function fake(patch = {}): any {
  return { enrolmentCodeV1: true, enrolmentCodes: vi.fn(async () => ({ ok: true, codes: [] })),
    createEnrolmentCode: vi.fn(async () => ({ ok: true })), revokeEnrolmentCode: vi.fn(),
    searchGroups: vi.fn(async () => ({ ok: true, groups: [hit], truncated: false })),
    resolveGroup: vi.fn(async () => ({ ok: true, realm: "corp", objectId: GROUP, dn: hit.dn })), ...patch };
}
async function mount(client: any) {
  const p = page({ url: "https://hub.example.test/ui/hub/admin" }); mounted.push(p); i18n.setLang("en", { store: false });
  await p.mount(h("div", {}, h(groups.GroupSearch, { client, label: "U2 policy groups" }), h(codes.HubEnrolmentCode, { client, enabled: true, host: "hub.example.test" })));
  await settle(15); const create = [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === "Create join code");
  fire(create, "click"); await settle(10); const select = p.root.querySelector("#hubCodeScope"); select.value = "group"; fire(select, "change"); await settle(8);
  return p;
}
async function choose(p: AppPage) {
  const box = p.root.querySelector("#hubEnrolmentScopeSearch"); box.value = "Dev"; fire(box, "input");
  await new Promise(resolve => setTimeout(resolve, 330)); await settle(8);
  fire(p.root.querySelector("dialog .hub-group-hits button"), "click"); await settle(8);
}
describe("B2 scope uses U2's actual picker safely", () => {
  it("two pickers have separate labels; the selected hit is resolved before exact scope is sent", async () => {
    const c = fake(), p = await mount(c);
    expect(p.root.querySelectorAll("#hubGroupSearch")).toHaveLength(1); expect(p.root.querySelectorAll("#hubEnrolmentScopeSearch")).toHaveLength(1);
    expect(p.root.querySelector("dialog label[for=hubEnrolmentScopeSearch]")).not.toBeNull();
    await choose(p);
    expect(c.resolveGroup).toHaveBeenCalledExactlyOnceWith(hit.dn); expect(c.createEnrolmentCode).not.toHaveBeenCalled();
    fire(p.root.querySelector("#hubEnrolmentCreate"), "submit"); await settle(12);
    expect(c.createEnrolmentCode.mock.calls[0][0].scope).toEqual({ kind: "group", realm: "corp", objectId: GROUP, dn: hit.dn });
    expect(c.searchGroups).toHaveBeenCalledExactlyOnceWith("Dev");
  });
  it("a GUID changed by the resolver refuses the displayed hit, rather than sending a different scope", async () => {
    const c = fake({ resolveGroup: vi.fn(async () => ({ ok: true, realm: "corp", objectId: OTHER, dn: hit.dn })) }), p = await mount(c);
    await choose(p); fire(p.root.querySelector("form"), "submit"); await settle(5);
    expect(c.createEnrolmentCode).not.toHaveBeenCalled(); expect(p.root.textContent).toContain("The group could not be verified");
  });
  it("a held older picker without ID support uses the exact-DN fallback and creates no duplicate input ID", async () => {
    version.ids = false; const c = fake(), p = await mount(c);
    expect(p.root.querySelectorAll("#hubGroupSearch")).toHaveLength(1); expect(p.root.querySelector("#hubEnrolmentScopeSearch")).toBeNull();
    expect(p.root.querySelector("#hubCodeGroupDn")).not.toBeNull(); expect(c.searchGroups).not.toHaveBeenCalled();
  });
  it("the shared picker's unavailable hint has a working exact-DN alternative", async () => {
    const c = fake({ searchGroups: vi.fn(async () => ({ ok: false, reason: "unknown" })) }), p = await mount(c);
    const box = p.root.querySelector("#hubEnrolmentScopeSearch"); box.value = "Dev"; fire(box, "input");
    await new Promise(resolve => setTimeout(resolve, 330)); await settle(8); expect(p.root.textContent).toContain("could not be searched");
    fire([...p.root.querySelectorAll("button")].find((b: any) => b.textContent === "Use the group's distinguished name"), "click"); await settle(5);
    const dn = p.root.querySelector("#hubCodeGroupDn"); dn.value = hit.dn; fire(dn, "input"); await settle(3);
    fire([...p.root.querySelectorAll("button")].find((b: any) => b.textContent === "Find group"), "click"); await settle(8);
    fire(p.root.querySelector("form"), "submit"); await settle(8);
    expect(c.resolveGroup).toHaveBeenCalledExactlyOnceWith(hit.dn); expect(c.createEnrolmentCode.mock.calls[0][0].scope.objectId).toBe(GROUP);
  });
});
