/**
 * Hub UX U2 (spec 1.2, S2): the group-search picker. Input feedback only — the hit goes to the caller, who resolves its DN.
 * 2–64 characters after trimming, no control characters; 300 ms after typing stops; only the newest answer for the text in the
 * box; limited / unknown / unsupported each say so (unsupported hands over to the caller's DN input once).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let gs: any;
const mounted: AppPage[] = [];
beforeAll(async () => { const p = page({ storage: { agend_lang: "en" } }); gs = await import("/ui/js/hub-group-search.js"); p.restore(); });
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } vi.useRealTimers(); });
const hit = (cn: string, id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") => ({ objectId: id, cn, dn: `CN=${cn},DC=example,DC=test` });

describe("searchGroups(client, q)", () => {
  it.each(["", " a ", "x".repeat(65), "ab\u0000", "ab\ncd"])("%j is refused here, without a request", async q => {
    const client = { searchGroups: vi.fn() };
    expect(await gs.searchGroups(client, q)).toEqual({ ok: false, reason: "invalid" });
    expect(client.searchGroups).not.toHaveBeenCalled();
  });
  it("trims, asks once, and keeps only well-formed rows (at most 20)", async () => {
    const client = { searchGroups: vi.fn(async () => ({ ok: true, groups: [hit("Owners"), { cn: 1 }, ...Array.from({ length: 25 }, (_, i) => hit("G" + i, `${i}`))], truncated: true })) };
    const r = await gs.searchGroups(client, "  own ");
    expect(client.searchGroups).toHaveBeenCalledWith("own");
    expect(r).toMatchObject({ ok: true, truncated: true }); expect(r.groups).toHaveLength(20); expect(r.groups[0]).toEqual(hit("Owners"));
  });
  it.each([
    [{ ok: false, status: 429, code: "failed", retryAfter: 60 }, { ok: false, reason: "limited", retryAfter: 60 }],
    [{ ok: false, reason: "unsupported" }, { ok: false, reason: "unsupported" }],
    [{ ok: false, reason: "unknown", failure: "timeout" }, { ok: false, reason: "unknown", failure: "timeout" }],
    [{ ok: false, status: 400, code: "invalid" }, { ok: false, reason: "invalid" }],
    [{ ok: false, status: 0, code: "unreachable" }, { ok: false, reason: "unknown" }],
  ])("server answer %j → %j", async (answer, out) => {
    expect(await gs.searchGroups({ searchGroups: async () => answer }, "own")).toEqual(out);
  });
  it("an older client without the method: unsupported (the DN input stays)", async () => {
    expect(await gs.searchGroups({}, "own")).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("<GroupSearch>", () => {
  async function mount(client: any, props: any = {}) {
    const p = page({ url: "https://hub.example.test/ui/hub/admin", storage: { agend_lang: "en" } }); mounted.push(p);
    await p.mount(h(gs.GroupSearch, { client, ...props })); await settle(6); return p;
  }
  const type = async (p: AppPage, v: string) => { const i = p.root.querySelector("#hubGroupSearch"); i.value = v; fire(i, "input"); await settle(4); };
  const wait = () => new Promise(r => setTimeout(r, 330));
  it("asks 300 ms after typing stops, once for the final text; the chosen hit goes to the caller as is", async () => {
    const client = { searchGroups: vi.fn(async (q: string) => ({ ok: true, groups: [hit("Owners"), hit("Ownership", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")], truncated: false })) };
    const onPick = vi.fn(); const p = await mount(client, { onPick, exclude: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] });
    await type(p, "o"); await type(p, "ow"); await type(p, "own");
    expect(client.searchGroups).not.toHaveBeenCalled();
    await wait(); await settle(8);
    expect(client.searchGroups.mock.calls).toEqual([["own"]]);
    const buttons = [...p.root.querySelectorAll(".hub-group-hits button")];
    expect(buttons.map((b: any) => [b.textContent, b.disabled])).toEqual([["Add", false], ["Added", true]]);   // already chosen: shown, not addable
    fire(buttons[0], "click"); expect(onPick).toHaveBeenCalledWith(hit("Owners"));
  });
  it("only the newest answer counts: a slow answer for older text is dropped", async () => {
    const held: any[] = [];
    const client = { searchGroups: vi.fn((q: string) => q === "own" ? new Promise(r => held.push(r)) : Promise.resolve({ ok: true, groups: [hit("Engineers")], truncated: false })) };
    const p = await mount(client);
    await type(p, "own"); await wait(); await settle(4);
    await type(p, "eng"); await wait(); await settle(8);
    held[0]({ ok: true, groups: [hit("Owners")], truncated: false }); await settle(8);
    expect(p.root.querySelector(".hub-group-hits").textContent).toContain("Engineers");
    expect(p.root.querySelector(".hub-group-hits").textContent).not.toContain("Owners");
  });
  it("none, more, limited and unknown say so; unsupported hands over to the caller once and hides the box", async () => {
    const answers: any[] = [{ ok: true, groups: [], truncated: false }, { ok: true, groups: [hit("A")], truncated: true }, { ok: false, status: 429, retryAfter: 60 }, { ok: false, reason: "unknown" }, { ok: false, reason: "unsupported" }];
    const client = { searchGroups: vi.fn(async () => answers.shift()) }, onUnsupported = vi.fn();
    const p = await mount(client, { onUnsupported });
    const note = () => p.root.querySelector("#hubGroupSearchNote")?.textContent;
    await type(p, "zz"); await wait(); await settle(8); expect(note()).toBe("No group starts with “zz”.");
    await type(p, "aa"); await wait(); await settle(8); expect(note()).toBe("More groups match. Type more of the name.");
    await type(p, "ab"); await wait(); await settle(8); expect(note()).toBe("Too many searches. Try again in 60 seconds.");
    await type(p, "ac"); await wait(); await settle(8); expect(note()).toContain("could not be searched");
    await type(p, "ad"); await wait(); await settle(8);
    expect(onUnsupported).toHaveBeenCalledTimes(1); expect(p.root.querySelector("#hubGroupSearch")).toBeNull();
  });
  it("two pickers on one page (U2's step 2 under B2's scope dialog): each takes its own id; its label and note follow it", async () => {
    expect(gs.groupSearchIdV1).toBe(true);
    const client = { searchGroups: vi.fn(async () => ({ ok: true, groups: [], truncated: false })) };
    const p = page({ url: "https://hub.example.test/ui/hub/admin", storage: { agend_lang: "en" } }); mounted.push(p);
    await p.mount(h("div", null, h(gs.GroupSearch, { client }), h(gs.GroupSearch, { client, id: "hubEnrolmentScopeSearch" }))); await settle(6);
    expect([...p.root.querySelectorAll("input[type=search]")].map((i: any) => i.id)).toEqual(["hubGroupSearch", "hubEnrolmentScopeSearch"]);
    expect([...p.root.querySelectorAll("label.field")].map((l: any) => l.getAttribute("for"))).toEqual(["hubGroupSearch", "hubEnrolmentScopeSearch"]);
    const second = p.root.querySelector("#hubEnrolmentScopeSearch"); second.value = "zz"; fire(second, "input"); await settle(4);
    await new Promise(r => setTimeout(r, 330)); await settle(8);
    expect(second.getAttribute("aria-describedby")).toBe("hubEnrolmentScopeSearchNote");
    expect(p.root.querySelector("#hubEnrolmentScopeSearchNote")?.textContent).toBe("No group starts with “zz”.");
    expect(p.root.querySelector("#hubGroupSearchNote")).toBeNull();
  });
});
