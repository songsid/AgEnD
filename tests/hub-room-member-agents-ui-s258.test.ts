import { afterEach, beforeAll, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let ui: any, members: any, i18n: any;
const mounted: AppPage[] = [];
beforeAll(async () => {
  const pg = page(); ui = await import("/ui/js/hub-room-settings.js"); members = await import("/ui/js/hub-room-members.js"); i18n = await import("/assets/app-i18n.js"); pg.restore();
});
afterEach(async () => { for (const pg of mounted.splice(0)) { await pg.unmount(); pg.restore(); } i18n.setLang("en", { store: false }); });
const detail = (on = false, role = "member") => ({ room: { id: "room-one", name: "Example room", archived: false }, me: { id: "member-one", role }, members: [], settings: { membersCanAddOwnAgents: on, allMention: true, historyForNew: "since-join" } });
const mount = async (component: any, props: any) => { const pg = page(); mounted.push(pg); i18n.setLang("en", { store: false }); await pg.mount(h(component, props)); await settle(15); return pg; };
it("saves the manager opt-in and restores the switch after refusal", async () => {
  const writes: unknown[] = []; let changed = 0;
  const client = { roomList: async () => ({ ok: true }), updateRoom: async (id: string, body: unknown) => { writes.push([id, body]); return { ok: false }; } };
  const pg = await mount(ui.RoomSettings, { client, roomId: "room-one", detail: detail(false, "manager"), onChanged: () => changed++ });
  const input = pg.root.querySelector("#hubRoomMemberAgents") as any;
  expect(input.checked).toBe(false); input.checked = true; fire(input, "change"); await settle(10);
  expect(writes).toEqual([["room-one", { membersCanAddOwnAgents: true }]]); expect(input.checked).toBe(false); expect(changed).toBe(0);
});
it.each([false, true])("member add entry follows opt-in=%s without exposing manager settings", async on => {
  let opened = 0;
  const pg = await mount(members.RoomMembersPanel, { compact: false, client: { roomOwnAgentCandidates: async () => ({ ok: true, candidates: [] }) }, roomId: "room-one", detail: detail(on), onAddAgents: () => opened++ });
  expect(pg.root.querySelector(".hub-room-settings-link")).toBeNull();
  const button = pg.root.querySelector(".hub-room-own-agents-link"); expect(!!button).toBe(on);
  if (button) { fire(button, "click"); expect(opened).toBe(1); }
});
it("scopes member search to the room and adds its owned candidate through the existing endpoint", async () => {
  const calls: unknown[] = []; let changed = 0, closed = 0;
  const client = { roomOwnAgentCandidates: async (...args: unknown[]) => { calls.push(["search", ...args]); return { ok: true, candidates: [{ id: "own-agent", name: "Example Helper", kind: "agent", mine: true }] }; },
    addRoomMember: async (...args: unknown[]) => { calls.push(["add", ...args]); return { ok: true }; } };
  const pg = await mount(ui.OwnRoomAgents, { client, roomId: "room-one", detail: detail(true), onChanged: () => changed++, onClose: () => closed++ });
  const input = pg.root.querySelector("#hubRoomOwnAgents") as any; input.value = "Example"; fire(input, "input");
  await new Promise(r => setTimeout(r, 300)); await settle(10);
  const row = pg.root.querySelector('[role="option"]'); expect(row).toBeTruthy(); fire(row, "click"); await settle(10);
  expect(calls).toEqual([["search", "room-one", "Example"], ["add", "room-one", { kind: "agent", id: "own-agent" }]]); expect(changed).toBe(1); expect(closed).toBe(1);
});
