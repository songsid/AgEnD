/** Hub UX U2: step 3's sentence and copy (only once steps 1 and 2 are done) and B2's join-code slot contract. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let js: any; const mounted: AppPage[] = [];
beforeAll(async () => { const p = page({ storage: { agend_lang: "en" } }); js = await import("/ui/js/hub-join-steps.js"); p.restore(); });
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } vi.unstubAllGlobals(); });
async function mount(c: any, props: any, lang = "en") {
  const p = page({ url: "https://hub.example.test/ui/hub/admin", storage: { agend_lang: lang } }); mounted.push(p);
  (await import("/assets/app-i18n.js")).setLang(lang, { store: false });
  await p.mount(h(c, props)); await settle(10); return p;
}

describe("step 3 and the join-code slot", () => {
  it("the host people see: no https://, no :443; anything else stays", () => {
    expect(js.displayHost("https://hub.example.com")).toBe("hub.example.com");
    expect(js.displayHost("https://hub.example.com:443")).toBe("hub.example.com");
    expect(js.displayHost("https://hub.example.com:18601")).toBe("hub.example.com:18601");
    expect(js.displayHost("http://hub.example.com")).toBe("");
  });
  it.each([[false, false], [true, false], [false, true]])("step 1 %s, step 2 %s: the copy button is off and says why", async (s1, s2) => {
    const p = await mount(js.JoinStep3, { webOrigin: "https://hub.example.com", step1: s1, step2: s2 });
    const b = p.root.querySelector("li[data-step='3'] button");
    expect(b.disabled).toBe(true); expect(b.getAttribute("aria-describedby")).toBe("hubJoinStep3Off");
    expect(p.root.textContent).toContain("Finish steps 1 and 2 first.");
  });
  it.each([["en", "In AgEnD, open Settings → Hub, enter hub.example.com, then sign in with the company account."], ["zh-TW", "在 AgEnD 的「設定 → Hub」輸入 hub.example.com，再用公司帳號登入。"]])("steps done (%s): the sentence and its copy", async (lang, sentence) => {
    const p = await mount(js.JoinStep3, { webOrigin: "https://hub.example.com:443", step1: true, step2: true }, lang);
    const writeText = vi.fn(async () => {}); vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(p.root.querySelector(".hub-join-sentence").textContent).toBe(sentence);
    fire(p.root.querySelector("li[data-step='3'] button"), "click"); await settle(6);
    expect(writeText).toHaveBeenCalledWith(sentence);
  });
  it("the slot mounts B2's component only when the session offers enrolment-code-v1 and the module says enrolmentCodeV1; its props", async () => {
    const seen: any[] = [], onChanged = vi.fn(), client = { enrolmentCodeV1: true };
    const Code = (props: any) => { seen.push(props); return h("p", { class: "b2" }, "codes"); };
    const load = vi.fn(async () => ({ enrolmentCodeV1: true, HubEnrolmentCode: Code }));
    const p = await mount(js.EnrolmentCodeSlot, { features: ["company-join-v1", "enrolment-code-v1"], client, enabled: true, host: "hub.example.com", onChanged, load });
    expect(p.root.querySelector("#hubEnrolmentCodeSlot .b2")).toBeTruthy();
    expect(seen.at(-1)).toMatchObject({ client, enabled: true, host: "hub.example.com", onChanged });
  });
  it.each([
    ["not offered by the session", ["company-join-v1"], async () => ({ enrolmentCodeV1: true, HubEnrolmentCode: () => h("p", { class: "b2" }) })],
    ["an older module without the flag", ["enrolment-code-v1"], async () => ({ HubEnrolmentCode: () => h("p", { class: "b2" }) })],
    ["the module is not there (this Hub does not serve it)", ["enrolment-code-v1"], async () => { throw Error("404"); }],
  ])("%s: the slot is there and empty", async (_why, features, load) => {
    const p = await mount(js.EnrolmentCodeSlot, { features, load });
    expect(p.root.querySelector("#hubEnrolmentCodeSlot")).toBeTruthy(); expect(p.root.querySelector(".b2")).toBeNull();
  });
  it("step 3 passes step 1 (not step 1+2) as `enabled`: the first code can be made before any group is allowed", async () => {
    const seen: any[] = [];
    const load = async () => ({ enrolmentCodeV1: true, HubEnrolmentCode: (props: any) => { seen.push(props); return null; } });
    const p = await mount(js.JoinStep3, { webOrigin: "https://hub.example.com", step1: true, step2: false, features: ["enrolment-code-v1"], load });
    expect(seen.at(-1)).toMatchObject({ enabled: true, host: "hub.example.com" });
    expect(p.root.querySelector("li[data-step='3'] button").disabled).toBe(true);           // the sentence still waits for step 2
  });
});

describe("step 2: who can join", () => {
  const owners = { objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", cn: "Owners", dn: "CN=Owners,DC=example,DC=test" };
  const policy = (o: any = {}) => ({ realm: "example", generation: "g1", revision: 3, state: "never-enabled", groups: [], denies: [], ...o });
  function client(o: any = {}) {
    let saved = policy(o.policy);
    return {
      saved: () => saved,
      groupPolicy: vi.fn(async () => ({ ok: true, groupPolicyV1: true, supported: o.supported ?? true, binding: "ready", policy: saved, paused: [] })),
      searchGroups: vi.fn(async () => o.search ?? ({ ok: true, groups: [owners], truncated: false })),
      resolveGroup: vi.fn(async () => ({ ok: true, realm: "example", objectId: owners.objectId, dn: owners.dn })),
      previewGroupPolicy: vi.fn(async () => ({ ok: true, previewDigest: "d".repeat(64), expiresAt: Date.now() + 60000, policyRevision: 3, authorizationVersion: 1, impact: { losingActions: [], losingPublication: [], grandfathered: [], suspendedOnSave: [], adminLosesChat: false, held: [] } })),
      saveGroupPolicy: vi.fn(async (p: any) => { saved = { ...p, revision: p.revision + 1 }; return { ok: true, policyRevision: saved.revision, state: saved.state }; }),
      ...(o.codes ? { enrolmentCodes: vi.fn(async () => ({ ok: true, codes: o.codes })) } : {}),
    };
  }
  const typeSearch = async (p: AppPage, v: string) => { const i = p.root.querySelector("#hubGroupSearch"); i.value = v; fire(i, "input"); await settle(4); await new Promise(r => setTimeout(r, 330)); await settle(10); };
  it("a group found by search is resolved by the server and added letting its members join (chat + connect, 1 Fleet each)", async () => {
    const c = client(); const p = await mount(js.JoinStep2, { client: c });
    await typeSearch(p, "own");
    fire(p.root.querySelector(".hub-group-hits button"), "click"); await settle(10);
    expect(c.resolveGroup).toHaveBeenCalledWith(owners.dn);
    const row = p.root.querySelector(`li[data-group="${owners.objectId}"]`);
    expect(row.querySelector("input[type=number]").value).toBe("1");
    expect([...row.querySelectorAll("label.check input")].map((x: any) => x.checked)).toEqual([true, false]);   // chat on, share off
  });
  it("one 儲存: the check runs on the proposed policy (switched on, the group connects); Save applies exactly that check's digest", async () => {
    const c = client(), onSaved = vi.fn(); const p = await mount(js.JoinStep2, { client: c, onSaved });
    await typeSearch(p, "own"); fire(p.root.querySelector(".hub-group-hits button"), "click"); await settle(8);
    await new Promise(r => setTimeout(r, 450)); await settle(10);
    const proposed = (c.previewGroupPolicy.mock.calls as any[]).at(-1)[0];
    expect(proposed).toMatchObject({ state: "enabled", revision: 3, groups: [{ group: { realm: "example", objectId: owners.objectId }, dn: owners.dn, allow: ["ask_agents", "pair_fleet"], maxFleets: 1 }] });
    fire([...p.root.querySelectorAll("button")].find((b: any) => b.textContent === "Save"), "click"); await settle(12);
    expect(c.saveGroupPolicy).toHaveBeenCalledWith(proposed, "d".repeat(64));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(js.step2Done(c.saved(), null)).toBe(true);
  });
  it.each(["stale-preview", "expired"])("#3698 r1: a save refused as %s says so, runs the server's check again, and the next 儲存 carries the new digest", async (code) => {
    const c = client(); let n = 0;
    c.previewGroupPolicy.mockImplementation(async () => ({ ok: true, previewDigest: String(++n).repeat(64).slice(0, 64), expiresAt: Date.now() + 60000, policyRevision: 3, authorizationVersion: 1,
      impact: { losingActions: [], losingPublication: [], grandfathered: [], suspendedOnSave: [], adminLosesChat: false, held: [] } }));
    const saved = c.saveGroupPolicy.getMockImplementation()!;
    c.saveGroupPolicy.mockImplementationOnce((async () => ({ ok: false, code })) as any).mockImplementation(saved as any);
    const p = await mount(js.JoinStep2, { client: c });
    await typeSearch(p, "own"); fire(p.root.querySelector(".hub-group-hits button"), "click"); await settle(8);
    await new Promise(r => setTimeout(r, 450)); await settle(10);
    const save = () => [...p.root.querySelectorAll("button")].find((b: any) => b.textContent === "Save");
    fire(save(), "click"); await settle(10);
    expect(p.root.textContent).toContain("The check is out of date.");
    await new Promise(r => setTimeout(r, 450)); await settle(10);
    expect(c.previewGroupPolicy).toHaveBeenCalledTimes(2);                                   // checked again
    fire(save(), "click"); await settle(10);
    expect((c.saveGroupPolicy.mock.calls as any[]).map((a) => a[1])).toEqual(["1".repeat(64), "2".repeat(64)]);
  });
  it("each person's Fleet limit set to 0 drops connect for that group; above 0 brings it back", async () => {
    const c = client({ policy: { state: "enabled", groups: [{ group: { realm: "example", objectId: owners.objectId }, dn: owners.dn, allow: ["ask_agents", "pair_fleet"], maxFleets: 2 }] } });
    const p = await mount(js.JoinStep2, { client: c });
    const n = p.root.querySelector("input[type=number]"); n.value = "0"; fire(n, "input"); await settle(4); await new Promise(r => setTimeout(r, 450)); await settle(8);
    expect((c.previewGroupPolicy.mock.calls as any[]).at(-1)[0].groups[0]).toMatchObject({ allow: ["ask_agents"], maxFleets: 0 });
    n.value = "3"; fire(n, "input"); await settle(4); await new Promise(r => setTimeout(r, 450)); await settle(8);
    expect((c.previewGroupPolicy.mock.calls as any[]).at(-1)[0].groups[0]).toMatchObject({ allow: ["ask_agents", "pair_fleet"], maxFleets: 3 });
  });
  it("A-L13: the directory cannot search — the box goes, the distinguished-name form opens and still adds the group", async () => {
    const c = client({ search: { ok: false, reason: "unsupported" } }); const p = await mount(js.JoinStep2, { client: c });
    await typeSearch(p, "own");
    expect(p.root.querySelector("#hubGroupSearch")).toBeNull();
    const d = p.root.querySelector("details.hub-join-bydn"); expect(d.open).toBe(true);
    const i = d.querySelector("input"); i.value = owners.dn; fire(i, "input"); await settle(4); fire(d.querySelector("form"), "submit"); await settle(10);
    expect(c.resolveGroup).toHaveBeenCalledWith(owners.dn); expect(p.root.querySelector(`li[data-group="${owners.objectId}"]`)).toBeTruthy();
  });
  it("A-L11: step 2 is done only from saved state — on with a connecting group, or a live join code; off (suspended) un-ticks it", () => {
    const joining = [{ group: { realm: "example", objectId: owners.objectId }, dn: owners.dn, allow: ["pair_fleet"], maxFleets: 1 }];
    expect(js.step2Done(policy({ state: "enabled", groups: joining }), null)).toBe(true);
    expect(js.step2Done(policy({ state: "suspended", groups: joining }), null)).toBe(false);
    expect(js.step2Done(policy({ state: "enabled", groups: [{ ...joining[0], maxFleets: 0 }] }), null)).toBe(false);
    expect(js.step2Done(policy({ state: "enabled", groups: [{ ...joining[0], allow: ["ask_agents"] }] }), null)).toBe(false);
    expect(js.step2Done(null, [{ state: "expired" }])).toBe(false);
    expect(js.step2Done(null, [{ state: "live" }])).toBe(true);
  });
  it("the card: step 3 unlocks once step 1 is on and a saved group lets members join", async () => {
    const c = client({ policy: { state: "enabled", groups: [{ group: { realm: "example", objectId: owners.objectId }, dn: owners.dn, allow: ["pair_fleet"], maxFleets: 1 }] } });
    const p = await mount(js.HubJoinCard, { view: { enabled: true, revision: 4, companyLink: null }, groups: true, features: [], client: c, webOrigin: "https://hub.example.com" });
    await settle(10);
    expect([...p.root.querySelectorAll("li[data-step] .tag.ok")].length).toBe(2);
    expect(p.root.querySelector("li[data-step='3'] button").disabled).toBe(false);
    expect(p.root.querySelector(".hub-join-sentence").textContent).toBe("In AgEnD, open Settings → Hub, enter hub.example.com, then sign in with the company account.");
  });
});

