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
