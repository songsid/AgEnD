import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { RoomDirectoryCandidates, roomPersonLabels } from "../src/hub/rooms/directory.js";

const person = { realm: "sample", objectId: "11111111-2222-4333-8444-555555555555" };
const people = [
  { kind: "person", id: "first", name: "Alex Sample", detail: "Project support · alex.one" },
  { kind: "person", id: "second", name: "Alex Sample", detail: "Project support · alex.two" },
  { kind: "person", id: "account", name: "Casey Sample", detail: "casey.sample" },
  { kind: "person", id: "empty", name: "Morgan Sample" },
  { kind: "person", id: "long", name: "Taylor Sample", detail: "A very long synthetic department for project coordination across several regions" },
];
const pages: AppPage[] = [];
let picker: any, words: any;
beforeAll(async () => { const pg = page(); picker = await import("/ui/js/hub-room-new.js"); words = await import("/assets/app-i18n.js"); pg.restore(); });
afterEach(async () => { for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } words.setLang("en", { store: false }); });

it.each(["en", "zh-TW"])("distinguishes people in result rows and keeps picked chips name-only (%s)", async lang => {
  const pg = page(); pages.push(pg); words.setLang(lang, { store: false });
  const change = vi.fn(), client = { roomCandidates: vi.fn(async (_q: string, kind: string) => ({ ok: true,
    candidates: [...people, { kind: "team", id: "team", name: "Sample team", people: 2 }].filter(row => row.kind === kind) })) };
  const props = { client, id: "people", kinds: ["person", "team"], picked: [], onChange: change, label: "People" };
  await pg.mount(h(picker.RoomPicker, props));
  const input = pg.root.querySelector("#people"); input.value = "Sa"; fire(input, "input");
  await new Promise(resolve => setTimeout(resolve, 250)); await settle(10);
  const rows = [...pg.root.querySelectorAll(".hub-room-result")];
  expect(rows.map((row: any) => row.querySelector(".hub-room-person-detail")?.textContent ?? "")).toEqual([
    "Project support · alex.one", "Project support · alex.two", "casey.sample", "", people[4]!.detail, "",
  ]);
  expect(rows[0].querySelector(".hub-room-person-name").getAttribute("title")).toBe("Alex Sample");
  expect(rows[4].querySelector(".hub-room-person-detail").getAttribute("title")).toBe(people[4]!.detail);
  expect(rows[0].getAttribute("aria-label")).toContain("alex.one");
  expect(rows[5].querySelector(".hub-room-person-label")).toBeNull();
  fire(rows[1], "click"); await settle(); expect(change).toHaveBeenCalledWith([people[1]]);
  await pg.mount(h(picker.RoomPicker, { ...props, picked: [people[1]] })); await settle();
  expect(pg.root.querySelector(".hub-room-tags").textContent).toBe("Alex Sample×");
  expect(client.roomCandidates).toHaveBeenCalledWith("Sa", "person");
});

it("sends accounts only when needed and omits an absent second line", () => {
  expect(roomPersonLabels([
    { id: "one", name: "Alex Sample", department: "Support", account: "alex.one" },
    { id: "two", name: "Alex Sample", department: "Support", account: "alex.two" },
    { id: "three", name: "Alex Sample", department: "Planning", account: "alex.three" },
    { id: "four", name: "Casey Sample", department: " ", account: "casey.sample" },
    { id: "five", name: "Morgan Sample" },
  ])).toEqual([
    { kind: "person", id: "one", name: "Alex Sample", detail: "Support · alex.one" },
    { kind: "person", id: "two", name: "Alex Sample", detail: "Support · alex.two" },
    { kind: "person", id: "three", name: "Alex Sample", detail: "Planning" },
    { kind: "person", id: "four", name: "Casey Sample", detail: "casey.sample" },
    { kind: "person", id: "five", name: "Morgan Sample" },
  ]);
});

it("requests bounded room-only presentation fields without weakening directory/session fences", async () => {
  const search = vi.fn(async () => ({ ok: true, truncated: false, people: [{ person, login: "alex.sample", displayName: "Alex Sample", department: "Project support" }] }));
  const directory = { realm: "sample", searchGrantPeople: search }, allowed = vi.fn();
  const core: any = { deps: { directory }, now: () => 1000, groupContext: () => ({}), readDirectory: async (_p: unknown, _c: unknown, read: () => unknown) => read() };
  const ctx: any = { current: async () => ({ kind: "directory", person, sessionId: "sample-session" }) };
  const candidates = new RoomDirectoryCandidates(core), me = `${person.realm}/${person.objectId}`;
  expect(await candidates.search(ctx, me, "Al", "person", allowed)).toEqual([{ kind: "person", id: me, name: "Alex Sample", detail: "Project support" }]);
  expect(search).toHaveBeenCalledWith("Al", { includeDepartment: true }); expect(allowed).toHaveBeenCalled();
  await expect(candidates.search(ctx, "sample/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "Al", "person", allowed)).rejects.toMatchObject({ code: "denied" });
  search.mockResolvedValueOnce({ ok: true, truncated: false, people: [{ person, login: "alex.sample", displayName: "Alex Sample", department: "x".repeat(257) }] });
  await expect(candidates.search(ctx, me, "Al", "person", allowed)).rejects.toBeDefined();
});
