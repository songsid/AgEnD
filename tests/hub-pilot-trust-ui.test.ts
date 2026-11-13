/** Production Preact and Settings client, owned in-memory DOM and fake local HTTP responses. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let fleet: any, pilot: any, i18n: any;
const mounted: AppPage[] = [], calls: Array<{ path: string; init: any }> = [];
beforeAll(async () => {
  const p = page({ storage: { agend_lang: "en" } });
  i18n = await import("/assets/app-i18n.js");
  fleet = await import("/ui/js/settings-hub-company-join.js"); pilot = await import("/ui/js/hub-pilot-trust.js"); p.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } vi.unstubAllGlobals(); calls.length = 0; });
const fingerprint = "b".repeat(64), previous = "a".repeat(64);
const button = (p: AppPage, text: string) => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === text);
async function world(answer: any, lang = "en") {
  vi.stubGlobal("open", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: any = {}) => {
    calls.push({ path, init });
    const body = path.endsWith("/probe") ? answer : path.endsWith("/start") ? { ok: true, operation: { operationId: "0f1e2d3c-4b5a-4968-8776-655443322110", state: "awaiting-sign-in", issued: false, outcomeKnown: true, hubOrigin: "https://pilot.example.test" } } : { ok: true, operation: null };
    return { ok: body.ok !== false, status: 200, json: async () => body };
  }));
  const p = page({ url: "http://localhost:19290/settings/hub", storage: { agend_lang: lang } }); mounted.push(p); i18n.setLang(lang, { store: false });
  await p.mount(h(fleet.CompanyJoinSettings)); await settle(10);
  const address = p.root.querySelector("#hubCompanyAddress"); address.value = "pilot.example.test ABCD-EFGH"; fire(address, "input"); await settle(4); fire(address, "blur"); await settle(10);
  return p;
}
describe("self-signed Hub trust in the one address box", () => {
  it.each(["en", "zh-TW"])("%s: shows the fingerprint, keeps the code and starts with one explicit press", async lang => {
    const p = await world({ ok: false, reason: "certificate", selfSigned: true, trust: { fingerprint, previous: null } }, lang);
    const trust = lang === "en" ? "Trust this Hub and continue" : "信任這個 Hub 並繼續";
    expect(button(p, trust)).toBeTruthy(); expect(calls.filter(c => c.path.endsWith("/start"))).toEqual([]);
    fire(button(p, lang === "en" ? "Show the full fingerprint" : "顯示完整指紋"), "click"); await settle(3);
    expect(p.root.textContent).toContain(fingerprint.match(/.{2}/g)!.join(":"));
    fire(p.root.querySelector("#hubCompanyAddress"), "blur"); await settle(2);
    expect(button(p, trust).disabled).toBe(false);
    fire(button(p, trust), "click"); await settle(12);
    const writes = calls.filter(c => c.path.endsWith("/start")); expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.init.body)).toMatchObject({ address: "https://pilot.example.test", code: "ABCD-EFGH", trust: { fingerprint, previous: null } });
    expect(globalThis.open).toHaveBeenCalledOnce();
  });
  it("changed certificates ask for explicit re-trust; Cancel sends no start", async () => {
    const p = await world({ ok: false, reason: "certificate", selfSigned: true, trust: { fingerprint, previous } });
    expect(button(p, "Trust again and continue")).toBeTruthy(); expect(p.root.textContent).toContain("different from the one you trusted");
    fire(button(p, "Cancel"), "click"); await settle(5);
    expect(p.root.querySelector("#hubCompanyAddress").value).toBe(""); expect(calls.filter(c => c.path.endsWith("/start"))).toEqual([]);
  });
  it.each([{ ok: false, reason: "certificate" }, { ok: false, reason: "certificate", selfSigned: true }])("ordinary failure or the setting off offers no trust action (%j)", async answer => {
    const p = await world(answer);
    expect(p.root.querySelector(".hub-pilot-trust")).toBeNull();
    expect(button(p, "Sign in with company account").disabled).toBe(true);
    if ("selfSigned" in answer && answer.selfSigned) expect(p.root.textContent).toContain("doesn't allow trusting one");
    else expect(p.root.textContent).toContain("certificate");
  });
  it("shows the testing hint only when the probe actually used the saved pin", async () => {
    const p = await world({ ok: true, hubName: "Pilot", companyJoin: true, identity: "known", separateHosts: true, suggestedLabel: "Fleet", features: [], pilotTrusted: true });
    expect(p.root.textContent).toContain("You trusted this Hub's self-signed certificate (for testing).");
    expect(p.root.querySelector(".hub-pilot-trust")).toBeNull(); expect(button(p, "Sign in with company account").disabled).toBe(false);
  });
});
