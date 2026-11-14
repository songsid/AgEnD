import { expect, it } from "vitest";
// @ts-expect-error browser module
import { createHubWebClient } from "../src/ui/hub-client.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

const response = (value: unknown, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => value });
it("offers Teams only for the current session and clears it on sign-out or a 401", async () => {
  let status = 200, features = ["teams-v1"];
  const c = createHubWebClient({ fetchImpl: async () => response({ signedIn: true, features }, status) });
  expect(typeof c.teamsLive).toBe("function"); expect(c.teamsLive()).toBe(false);
  await c.session(); expect(c.teamsLive()).toBe(true);
  await c.signOut(); expect(c.teamsLive()).toBe(false);
  await c.signIn("admin", "test"); expect(c.teamsLive()).toBe(true);
  status = 401; await c.teams(); expect(c.teamsLive()).toBe(false);
  status = 200; features = []; await c.session(); expect(c.teamsLive()).toBe(false);
});

it("keeps the worked Teams fixture compatible through CRUD and feedback without changing the room seed", async () => {
  const fx = createHubRoomsFixture({ features: ["rooms-v1", "teams-v1"], teamLead: true });
  const c = createHubWebClient({ fetchImpl: fx.fetch }); await c.session();
  const before = await c.roomMessages("room-weekly", { limit: 100 });
  expect((await c.teams()).teams[0].lead).toBe(FIXTURE_ME.id);
  const people = await c.teamSuggestions("person", "wang"); expect(people.candidates[0]).toMatchObject({ name: FIXTURE_ME.name, login: "wang" });
  const created = await c.createTeam({ name: "Project", department: "group-rd1", lead: FIXTURE_ME.id });
  expect(created.team.memberInfo).toHaveLength(1);
  const updated = await c.updateTeam(created.team.id, { revision: 1, name: "Renamed" }); expect(updated.team.name).toBe("Renamed");
  expect((await c.team(created.team.id)).team.name).toBe("Renamed");
  expect(await c.deleteTeam(created.team.id)).toMatchObject({ ok: true });
  expect(await c.team(created.team.id)).toMatchObject({ ok: false, status: 404 });
  expect((await c.roomMessages("room-weekly", { limit: 100 })).messages).toEqual(before.messages);
});

it("encodes Team feedback queries and quietly retires an aborted search", async () => {
  const calls: { path: string; init: any }[] = [];
  let release!: () => void;
  const c = createHubWebClient({ fetchImpl: async (path: string, init: any) => {
    calls.push({ path, init });
    if (path.includes("Held")) await new Promise<void>(r => { release = r; });
    return response({ candidates: [{ kind: "person", id: "person", name: "Riley", login: "riley" }] });
  } });
  expect(typeof c.teamSuggestions).toBe("function");
  const teamId = "team /&";
  const out = await c.teamSuggestions("person", "Riley & 王", teamId);
  expect(calls[0]!.path).toBe("/hub/v1/teams/candidates?kind=person&q=Riley+%26+%E7%8E%8B&teamId=team+%2F%26");
  expect(out.candidates[0].login).toBe("riley");
  const controller = new AbortController(), held = c.teamSuggestions("person", "Held", undefined, controller.signal);
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  controller.abort(); release();
  expect(await held).toMatchObject({ ok: false, status: 0 });
  expect(calls[1]!.init.signal.aborted).toBe(true);
});
