/**
 * Hub rooms, invitations on the owner's side (docs/design/hub-rooms-ux.md section 8; seam 3), against the seam-1 fixture
 * (tests/support/hub-rooms-fixture.ts): the left list's 「邀請 · n」 row and the list itself, 同意 / 不要, an answer or a
 * lapse seen from another tab (invitation.changed), and the refusals.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let clientModule: any, inv: any, i18n: any;
const mounted: AppPage[] = [];
const realEventSource = (globalThis as any).EventSource;
beforeAll(async () => {
  const pg = page();
  clientModule = await import("/ui/js/hub-client.js"); inv = await import("/ui/js/hub-invitations.js"); i18n = await import("/assets/app-i18n.js");
  pg.restore();
});
afterEach(async () => {
  for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); }
  (globalThis as any).EventSource = realEventSource; i18n.setLang("en", { store: false });
});

async function fixture(lang: "en" | "zh-TW" = "zh-TW", over: (path: string, init: any) => any = () => null) {
  const fx = createHubRoomsFixture(), calls: Array<{ path: string; method: string }> = [];
  const fetchImpl = async (path: string, init: any = {}) => {
    calls.push({ path, method: init.method ?? "GET" });
    const forced = over(path, init);
    if (forced) return { ok: forced.status < 400, status: forced.status, headers: { get: () => null }, json: async () => forced.body ?? {} };
    return fx.fetch(path, init);
  };
  const pg = page({ url: "http://127.0.0.1:19443/ui/hub" }); mounted.push(pg);
  (globalThis as any).EventSource = fx.EventSource;
  i18n.setLang(lang, { store: false });
  const client = clientModule.createHubWebClient({ fetchImpl });
  await client.session();
  return { fx, client, calls, pg };
}
const text = (pg: AppPage) => pg.root.textContent ?? "";
const button = (pg: AppPage, label: string) => [...pg.root.querySelectorAll("button")].find((b: any) => b.textContent === label);

describe("Hub room invitations, owner side (section 8)", () => {
  it("the row reads 「邀請 · 1」 and opens the list; the item names who, which agent and which room, and who will see it", async () => {
    const { pg, client } = await fixture();
    let opened = 0;
    const count = (await client.roomList()).invitations;
    await pg.mount(h("div", null, h(inv.InvitationsRow, { count, onOpen: () => { opened++; } }), h(inv.InvitationsList, { client }))); await settle(20);
    const row = pg.root.querySelector("button.hub-invitations-row");
    expect(row.textContent).toBe("邀請 · 1");
    fire(row, "click"); expect(opened).toBe(1);
    expect(pg.root.querySelector(".hub-invitation p").textContent).toBe("陳主任 邀請你的 Agent「my-notes」加入房間「產品規劃」");
    expect(pg.root.querySelector(".hub-invitation small").textContent).toBe("房間裡的 4 個人可以在那裡 @ 它；它的回答房間裡的人都看得到。");
    expect(button(pg, "同意")).toBeTruthy(); expect(button(pg, "不要")).toBeTruthy();
  });

  it.each([["Agree", "accept"], ["Decline", "decline"]])("%s answers once, and the invitation leaves the row and the list", async (label, verb) => {
    const { pg, client, calls } = await fixture("en");
    await pg.mount(h(inv.InvitationsList, { client })); await settle(20);
    expect(text(pg)).toContain("陳主任 invited your agent “my-notes” to the room “產品規劃”");
    fire(button(pg, label), "click"); await settle(20);
    expect(calls.filter(c => c.method === "POST").map(c => c.path)).toEqual([`/hub/v1/invitations/inv-in-0001/${verb}`]);
    expect(pg.root.querySelector(".hub-invitation")).toBeNull();
  });

  it("the row is nothing at 0 and reads the shell's count otherwise", async () => {
    const { pg } = await fixture("en");
    await pg.mount(h("div", null, h(inv.InvitationsRow, { count: 0 }), h(inv.InvitationsRow, { count: 3 }))); await settle(5);
    expect([...pg.root.querySelectorAll("button.hub-invitations-row")].map((b: any) => b.textContent)).toEqual(["Invitations · 3"]);
  });

  it("an answer from another tab, or a new invitation, reaches this one by the stream", async () => {
    const { pg, client, fx } = await fixture();
    await pg.mount(h(inv.InvitationsList, { client })); await settle(20);
    fx.invitations.push({ id: "inv-in-0002", room: { id: "room-x", name: "研發例會", people: 1 }, agent: { exposureId: "exp-mine-1", name: "my-notes" }, by: { name: "吳小安" }, at: 1 });
    fx.emit("invitation.changed", {}); await settle(20);
    expect(pg.root.querySelectorAll(".hub-invitation")).toHaveLength(2);
    expect(pg.root.querySelectorAll(".hub-invitation small")[1].textContent).toBe("房間裡的 1 個人可以在那裡 @ 它；它的回答房間裡的人都看得到。");
    fx.invitations.splice(0); fx.emit("invitation.changed", {}); await settle(20);
    expect(pg.root.querySelector(".hub-invitation")).toBeNull();
  });

  it("an invitation already gone (404) says so and leaves; a failed answer keeps it with a retry note", async () => {
    let mode: "gone" | "fail" = "fail";
    const { pg, client, fx } = await fixture("zh-TW", (path, init) => init.method === "POST" && path.endsWith("/accept") ? mode === "fail" ? { status: 500, body: { error: "unavailable" } } : { status: 404, body: { error: "not-found" } } : null);
    await pg.mount(h(inv.InvitationsList, { client })); await settle(20);
    fire(button(pg, "同意"), "click"); await settle(20);
    expect(pg.root.querySelector(".hub-invitation [role=alert]").textContent).toBe("沒有送出，請再試一次。");
    expect(button(pg, "同意").disabled).toBe(false);
    mode = "gone"; fx.invitations.splice(0);
    fire(button(pg, "同意"), "click"); await settle(20);
    expect(pg.root.querySelector(".hub-invitation")).toBeNull();
    expect(pg.root.querySelector("[role=status]").textContent).toBe("這個邀請已經不在了。");
  });

  it("while an answer is on its way, neither button can be pressed again", async () => {
    let release!: () => void; const held = new Promise<void>(r => { release = r; });
    const { pg, client, calls } = await fixture();
    const slow = { ...client, acceptInvitation: async (id: string) => { await held; return client.acceptInvitation(id); } };
    await pg.mount(h(inv.InvitationsList, { client: slow })); await settle(20);
    fire(button(pg, "同意"), "click"); await settle(5);
    expect(button(pg, "同意").disabled).toBe(true); expect(button(pg, "不要").disabled).toBe(true);
    fire(button(pg, "同意"), "click"); release(); await settle(20);
    expect(calls.filter(c => c.method === "POST")).toHaveLength(1);
  });

  it("a list that cannot be read says so, with a retry; nothing shows when there are none", async () => {
    let failing = true;
    const { pg, client, fx } = await fixture("en", (path, init) => failing && path === "/hub/v1/invitations" && (init.method ?? "GET") === "GET" ? { status: 500, body: {} } : null);
    await pg.mount(h(inv.InvitationsList, { client })); await settle(20);
    expect(pg.root.querySelector("[role=alert]").textContent).toContain("Invitations could not be loaded.");
    failing = false; fx.invitations.splice(0);
    fire(button(pg, "Try again"), "click"); await settle(20);
    expect(pg.root.textContent).toBe("");
  });

  it("「在這些房間裡」 on an agent's page: its rooms with people; 退出這個房間 removes exactly that agent member; nothing when in none", async () => {
    const { pg, client, calls, fx } = await fixture();
    await pg.mount(h("div", null, h(inv.AgentRoomsSection, { client, exposureId: "exp-02" }), h(inv.AgentRoomsSection, { client, exposureId: "exp-mine-1" }))); await settle(20);
    const items = () => [...pg.root.querySelectorAll(".hub-agent-rooms li span")].map((x: any) => x.textContent);
    expect(pg.root.querySelectorAll(".hub-agent-rooms")).toHaveLength(1);
    expect(pg.root.querySelector(".hub-agent-rooms h4").textContent).toBe("在這些房間裡");
    expect(items()).toEqual(["研一主管週會 · 3 人", "研發例會 · 2 人"]);
    fire(button(pg, "退出這個房間"), "click"); await settle(20);
    expect(calls.filter(c => c.method === "DELETE").map(c => c.path)).toEqual(["/hub/v1/rooms/room-weekly/members/exp-02"]);
    expect(items()).toEqual(["研發例會 · 2 人"]);
    fx.rooms.find((r: any) => r.id === "room-rd")!.members.push({ id: "exp-mine-1", kind: "agent", name: "my-notes", owner: { name: "王經理" }, role: "member", presence: "idle" });
    fx.emit("member.changed", { roomId: "room-rd" }); await settle(20);
    expect(pg.root.querySelectorAll(".hub-agent-rooms")).toHaveLength(2);
  });
});
