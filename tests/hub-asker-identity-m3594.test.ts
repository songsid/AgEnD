/**
 * M-3594: a shared agent can tell which person asked. A 1:1 question carries the asker's display name from the Hub's own
 * directory (asker-name-v1, the source room asks use), and an agent's room-member lookup returns each person's stable Hub id
 * (realm/objectId, the same id a 1:1 question's asker has). Actual Hub HTTP/SQLite with inert member links; fixture names only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { hubRig } from "./helpers/hub-rig.js";
import * as protocol from "../src/hub/protocol.js";
import { HubProtocolError } from "../src/hub/validation.js";
import { personKeyString } from "../src/hub/identity.js";
import { HUB_ASKER_NAME_CAPABILITY, HUB_FLEET_UPDATE_CAPABILITY, HUB_OPTIONAL_CAPABILITIES, questionSchema } from "../src/hub/protocol.js";
import { hubWelcomeCapabilities } from "../src/hub/server.js";
import { hubLinkCapabilities } from "../src/hub/compose/server.js";
import { createMemberReceive } from "../src/hub/compose/member.js";
import { HubAskerNames } from "../src/hub/representative.js";
import type { HubExposure, HubQuestion } from "../src/hub/types.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let r: Rig | undefined;
const linkRigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { await r?.close(); r = undefined; for (const x of linkRigs.splice(0)) await x.close(); vi.restoreAllMocks(); });

/** alex asks olivia's shared agent in a 1:1; the member link offers `features`. */
async function oneToOne(features: string[], directoryName?: string) {
  r = await s3bRig();
  const owner = r.addPerson("olivia", "Olivia Example"), alex = r.addPerson("alex", "Alex Chen");
  const fleetId = randomUUID(), link = r.link(fleetId, owner, 1, features);
  const exposure: HubExposure = { id: randomUUID(), fleetId, owner, displayName: "Desk", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
  const o = await r.signIn("olivia"), a = await r.signIn("alex");
  const grant = await r.call(o, "POST", "/hub/v1/grants", { exposureId: exposure.id, exposureRevision: 1, login: "alex", days: 7 });
  if (directoryName) r.db.prepare("UPDATE hub_people SET display_name=? WHERE person=?").run(directoryName, personKeyString(alex));
  const room = (await r.call(a, "POST", "/hub/v1/rooms", { exposureId: exposure.id, grantId: grant.json.grant.id })).json.room.id as string;
  const asked = await r.call(a, "POST", `/hub/v1/rooms/${room}/messages`, { idempotencyKey: randomUUID(), text: "Which report is mine?" });
  expect(asked.status).toBe(200);
  await vi.waitFor(() => expect(r!.sent.some(s => s.frame.type === "question")).toBe(true));
  const question = r.sent.find(s => s.frame.type === "question")!.frame.payload as HubQuestion;
  return { alex, question };
}

describe("M-3594 1:1 questions carry the asker's Hub display name", () => {
  it("a link that enabled asker-name-v1 gets the directory display name beside the signed asker id", async () => {
    const { alex, question } = await oneToOne([HUB_ASKER_NAME_CAPABILITY]);
    expect(question.askerName).toBe("Alex Chen");
    expect(question.identity.asker).toEqual(alex);
    expect(questionSchema.safeParse(question).success).toBe(true);
  });
  it("a link without it (an older member) gets the question exactly as before, without the field", async () => {
    const { question } = await oneToOne([]);
    expect("askerName" in question).toBe(false);
  });
  it("the name is the one the Hub's directory holds for the asker at send time", async () => {
    const { question } = await oneToOne([HUB_ASKER_NAME_CAPABILITY], "Alex C. (Directory)");
    expect(question.askerName).toBe("Alex C. (Directory)");
  });
});

describe("M-3594 negotiation", () => {
  it("the Hub offers asker-name-v1 only in a 32-name welcome (beside fleet-update-v1); a legacy member hello stays at 16 names", () => {
    const configured = hubLinkCapabilities({});
    expect(configured).toContain(HUB_ASKER_NAME_CAPABILITY);
    expect(hubWelcomeCapabilities(configured, [HUB_FLEET_UPDATE_CAPABILITY, HUB_ASKER_NAME_CAPABILITY])).toContain(HUB_ASKER_NAME_CAPABILITY);
    expect(hubWelcomeCapabilities(configured, [...HUB_OPTIONAL_CAPABILITIES])).not.toContain(HUB_ASKER_NAME_CAPABILITY);
    expect(HUB_OPTIONAL_CAPABILITIES).not.toContain(HUB_ASKER_NAME_CAPABILITY);
  });
});

describe("M-3594 negotiation over a real member link", () => {
  const oldMember = [...HUB_OPTIONAL_CAPABILITIES, "room-ask-v1", "room-post-v1"];
  const hub = [...HUB_OPTIONAL_CAPABILITIES, "room-ask-v1", "room-post-v1", HUB_FLEET_UPDATE_CAPABILITY, HUB_ASKER_NAME_CAPABILITY];
  it("a modern member and Hub both enable asker-name-v1", async () => {
    const x = await hubRig({ serverCapabilities: hub, clientCapabilities: [...oldMember, HUB_FLEET_UPDATE_CAPABILITY, HUB_ASKER_NAME_CAPABILITY] }); linkRigs.push(x);
    await x.pair(); const c = x.client(); await c.value.start();
    expect(c.state.link!.features.has(HUB_ASKER_NAME_CAPABILITY)).toBe(true);
  });
  it("an older 16-name Hub: the one legacy retry drops asker-name-v1 with fleet-update-v1, back to the exact 16-name offer", async () => {
    const original = protocol.parseMemberFrame, hellos: string[][] = [];
    vi.spyOn(protocol, "parseMemberFrame").mockImplementation(input => {
      const f = original(input);
      if (f.type === "hello") { hellos.push([...f.payload.capabilities]); if (f.payload.capabilities.length > 16) throw new HubProtocolError(); }
      return f;
    });
    const x = await hubRig({ serverCapabilities: [...oldMember, "fleet-info-v1"], clientCapabilities: [...oldMember, HUB_FLEET_UPDATE_CAPABILITY, HUB_ASKER_NAME_CAPABILITY] }); linkRigs.push(x);
    await x.pair(); const c = x.client(); await c.value.start();
    expect(hellos.map(h => h.length)).toEqual([18, 16]);
    expect(hellos[1]).toEqual(hellos[0]!.filter(n => n !== HUB_FLEET_UPDATE_CAPABILITY && n !== HUB_ASKER_NAME_CAPABILITY));
    expect(c.state.link!.features.has(HUB_ASKER_NAME_CAPABILITY)).toBe(false);
  });
});

describe("M-3594 the member keeps the name in memory, never in the journal", () => {
  it("the receiver strips askerName before admission and remembers it by message id", async () => {
    const admitted: HubQuestion[] = [], names = new HubAskerNames();
    const receive = createMemberReceive({ admission: { admit: async (q: HubQuestion) => { admitted.push(q); return { messageId: q.identity.messageId, contentDigest: "c".repeat(64), stage: "queued", sequence: 1, at: 1 } as never; }, fence: () => {} } as never,
      journal: { acknowledge: () => {} } as never, live: () => true, log: () => {}, askerNames: names });
    const messageId = randomUUID(), sent: unknown[] = [];
    const link = { current: () => true, linkEpoch: 1, send: async (f: unknown) => { sent.push(f); } };
    await receive({ v: 1, type: "question", requestId: randomUUID(), linkEpoch: 1, payload: { text: "hi", askerName: "Alex Chen", identity: { messageId } as never } } as never, link as never);
    expect(admitted).toHaveLength(1);
    expect("askerName" in admitted[0]!).toBe(false);
    expect(names.get(messageId)).toBe("Alex Chen");
    expect(sent).toHaveLength(1);
  });
  it("the in-memory names are bounded, oldest first", () => {
    const names = new HubAskerNames(2);
    names.remember("a", "A"); names.remember("b", "B"); names.remember("c", "C");
    expect([names.get("a"), names.get("b"), names.get("c")]).toEqual([undefined, "B", "C"]);
  });
});

describe("M-3594 room members carry each person's stable Hub id", () => {
  async function group(modern: boolean) {
    r = await s3bRig({ realAudit: true });
    const alex = r.addPerson("alex", "Alex Chen"), admin = await r.signIn("admin"); await r.signIn("alex");
    const fleetId = randomUUID(), caps = ["welcome-caps-v1", "room-ask-v1", "room-post-v1", ...(modern ? ["room-context-v1", "room-brief-v1", "room-members-v2"] : [])];
    const link = r.link(fleetId, r.admin, 1, caps);
    const exposure: HubExposure = { id: randomUUID(), fleetId, owner: r.admin, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
    await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [exposure] }, link) as never, link);
    const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alex)] });
    const roomId = made.json.room.id as string;
    expect((await r.call(admin, "POST", `/hub/v1/rooms/${roomId}/members`, { kind: "agent", id: exposure.id })).status).toBe(200);
    const members = async (extra: object = {}) => ((await r!.http.receive(r!.frame("room.members", { exposureId: exposure.id, room: roomId, ...extra }, link) as never, link)) as any).payload;
    return { alex, members };
  }
  it("the legacy list: a person's id is realm/objectId, not the room's membership row", async () => {
    const w = await group(false), out = await w.members();
    const person = out.members.find((m: any) => m.name === "Alex Chen");
    expect(person).toMatchObject({ kind: "person", id: personKeyString(w.alex) });
    expect(r!.db.prepare("SELECT COUNT(*) n FROM hub_room_members WHERE id=?").get(person.id)).toEqual({ n: 0 });
  });
  it("the bounded (v2) list: the same stable id, matching a 1:1 question's asker id", async () => {
    const w = await group(true), out = await w.members({ v2: true, kind: "person" });
    expect(out.ok).toBe(true);
    expect(out.members.find((m: any) => m.name === "Alex Chen")).toMatchObject({ kind: "person", id: personKeyString(w.alex) });
  });
});
