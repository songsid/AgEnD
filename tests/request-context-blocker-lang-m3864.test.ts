// M-3864 R3: a blocker that names agents ("Finish the current work for these agents first: m1") rendered the whole
// request-based approvals section blank — request-context-control.js joined the names with lang() it never imported.
import { describe, expect, it } from "vitest";
import { h, page } from "./helpers/app-harness.js";

const { setLang } = await import("/assets/app-i18n.js") as any;
const { RequestContextBlocked, requestContextBlockerText } = await import("/ui/js/request-context-control.js") as any;

const working = { id: "busy", kind: "owners", ownerCause: "work", labels: ["m1", "m2"], agents: [{ id: "m1", label: "m1" }, { id: "m2", label: "m2" }], action: "inspect" };

describe("M-3864 R3: the turn-on's blockers name their agents", () => {
  it("in each language, with its own list separator", () => {
    setLang("en");
    expect(requestContextBlockerText(working)).toBe("Finish the current work for these agents first: m1, m2. Wait for them to finish, or restart an agent that stays busy.");
    setLang("zh-TW");
    expect(requestContextBlockerText(working)).toContain("m1、m2");
    setLang("en");
  });

  it("S-272: before the first attempt the section says what an On would wait for (it showed nothing)", async () => {
    setLang("en");
    const p = page();
    await p.mount(h(RequestContextBlocked, { state: { phase: "blocked", attempted: false, everActivated: false, blockers: [working] }, onCheck: () => {} }));
    expect(p.root.textContent).toContain("Turning this on has to wait for these first:");
    expect(p.root.textContent).toContain("Wait for them to finish, or restart an agent that stays busy.");
    await p.unmount();
    await p.mount(h(RequestContextBlocked, { state: { phase: "off", attempted: false, everActivated: false, blockers: [] }, onCheck: () => {} }));
    expect(p.root.textContent).toBe("");                                                   // nothing in the way: nothing shown
    await p.unmount();
  });
  it("the blocked section renders them (it was blank)", async () => {
    setLang("en");
    const p = page();
    await p.mount(h(RequestContextBlocked, { state: { phase: "blocked", attempted: true, everActivated: false, blockers: [working] }, onCheck: () => {} }));
    expect(p.root.textContent).toContain("Finish the current work for these agents first: m1, m2.");
    await p.unmount();
  });
});
