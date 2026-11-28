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
    await p.mount(h(RequestContextBlocked, { state: { phase: "blocked", attempted: false, everActivated: false, blockers: [{ id: "legacy-pending", kind: "legacy", labels: ["R1"], action: "inspect" }, working] }, onCheck: () => {} }));
    expect(p.root.querySelectorAll('a[href="/ui/fleet/authorizations"]').length).toBe(1);   // one link, for the earlier requests only
    await p.unmount();
    await p.mount(h(RequestContextBlocked, { state: { phase: "blocked", attempted: false, everActivated: false, blockers: [working] }, onCheck: () => {} }));
    expect(p.root.querySelectorAll('a[href="/ui/fleet/authorizations"]').length).toBe(0);   // busy agents: their own links, not Authorizations
    await p.unmount();
    await p.mount(h(RequestContextBlocked, { state: { phase: "off", attempted: false, everActivated: false, blockers: [] }, onCheck: () => {} }));
    expect(p.root.textContent).toBe("");                                                   // nothing in the way: nothing shown
    await p.unmount();
  });
  it("S-272: each earlier-ticket blocker says what settles it, in both languages; an older server's plain legacy keeps its line", () => {
    setLang("en");
    expect(requestContextBlockerText({ id: "legacy-pending", kind: "legacy", labels: ["R1"] })).toBe("Decide these earlier contact requests first, in Fleet → Authorizations: R1.");
    expect(requestContextBlockerText({ id: "legacy-inflight", kind: "legacy", labels: ["R2"] })).toMatch(/^These earlier approved messages are still being delivered: R2\. This clears by itself/);
    expect(requestContextBlockerText({ id: "legacy-unsettled", kind: "legacy", labels: ["R4", "R5"] })).toMatch(/can't tell whether they happened: R4, R5\. They can't be settled from this page yet/);
    expect(requestContextBlockerText({ id: "legacy-deliveries", kind: "legacy", labels: ["lead → worker"] })).toMatch(/^These earlier messages are being sent right now: lead → worker\./);
    expect(requestContextBlockerText({ id: "legacy", kind: "legacy", labels: ["R9"] })).toBe("Resolve these earlier held messages first: R9.");
    setLang("zh-TW");
    expect(requestContextBlockerText({ id: "legacy-unsettled", kind: "legacy", labels: ["R4", "R5"] })).toContain("R4、R5");
    expect(requestContextBlockerText({ id: "legacy-pending", kind: "legacy", labels: ["R1"] })).toBe("請先在「Fleet → 授權」決定這些先前的聯絡申請：R1。");
    setLang("en");
  });
  it("M-3897: Retire and Withdraw each name their item; being sent waits; uncertain says it can't be settled here", async () => {
    setLang("en");
    expect(requestContextBlockerText({ id: "legacy-retire:R4", kind: "legacy", labels: ["R4"], action: "retire" })).toBe("This earlier request has no readable delivery record, so AgEnD can't tell whether it happened: R4. Retire it to stop waiting for it.");
    expect(requestContextBlockerText({ id: "legacy-withdraw:d1", kind: "legacy", labels: ["lead → worker"], action: "withdraw" })).toBe("This earlier message is still waiting to be sent: lead → worker. Withdraw it, or wait until it is delivered.");
    expect(requestContextBlockerText({ id: "legacy-deliveries", kind: "legacy", labels: ["lead → worker"] })).toMatch(/^These earlier messages are being sent right now: lead → worker\. This clears by itself/);
    expect(requestContextBlockerText({ id: "legacy-uncertain", kind: "legacy", labels: ["lead → worker"] })).toMatch(/ended unconfirmed.*can't be settled from this page yet/);
    const p = page();
    await p.mount(h(RequestContextBlocked, { state: { phase: "blocked", attempted: false, everActivated: false, canChange: true,
      blockers: [{ id: "legacy-retire:R4", kind: "legacy", labels: ["R4"], action: "retire" }, { id: "legacy-withdraw:d1", kind: "legacy", labels: ["lead → worker"], action: "withdraw" }] },
      onCheck: () => {}, onResolve: () => {} }));
    expect([...p.root.querySelectorAll("button")].map((b: any) => b.textContent.trim())).toEqual(["Retire", "Withdraw", "Check again"]);
    await p.unmount();
    setLang("zh-TW");
    expect(requestContextBlockerText({ id: "legacy-retire:R4", kind: "legacy", labels: ["R4"], action: "retire" })).toBe("這筆先前的申請沒有可讀取的送出紀錄，AgEnD 無法判斷是否已經發生：R4。選「不再等候」就不會再等它。");
    setLang("en");
  });
  it("the blocked section renders them (it was blank)", async () => {
    setLang("en");
    const p = page();
    await p.mount(h(RequestContextBlocked, { state: { phase: "blocked", attempted: true, everActivated: false, blockers: [working] }, onCheck: () => {} }));
    expect(p.root.textContent).toContain("Finish the current work for these agents first: m1, m2.");
    await p.unmount();
  });
});
