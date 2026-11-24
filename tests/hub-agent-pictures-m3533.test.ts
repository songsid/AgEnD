/**
 * M-3533 R2b (Hub side): a Fleet reports its shared agents' pictures (agent-pictures-v1), the Hub asks for the hashes it lacks,
 * takes them in chunks, keeps one copy per hash while a report names it, and serves an agent's disc or portrait only to the
 * members of a room holding that agent. A picture over its cap is reported as too large: only its owner's view says so.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { hubLinkCapabilities } from "../src/hub/compose/server.js";
import { hubWelcomeCapabilities } from "../src/hub/server.js";
import { HUB_FLEET_UPDATE_CAPABILITY, HUB_OPTIONAL_CAPABILITIES, parseMemberFrame, encodeMemberFrame } from "../src/hub/protocol.js";
import { HUB_AGENT_PICTURES_CAPABILITY, HUB_PICTURE_CHUNK, HUB_PICTURE_DISC_MAX, agentPicturesRowSchema, sniffPicture } from "../src/hub/agent-pictures-model.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });

const PNG = (n: number, seed = 1) => { const b = Buffer.alloc(n, seed); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); return b; };
const JPEG = (n: number, seed = 2) => { const b = Buffer.alloc(n, seed); Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b); return b; };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ref = (b: Buffer, mime: string) => ({ sha256: sha(b), mime, size: b.length });
const chunks = (b: Buffer, mime: string) => { const count = Math.ceil(b.length / HUB_PICTURE_CHUNK);
  return Array.from({ length: count }, (_, index) => ({ sha256: sha(b), mime, size: b.length, index, count, data: b.subarray(index * HUB_PICTURE_CHUNK, (index + 1) * HUB_PICTURE_CHUNK).toString("base64") })); };

async function world() {
  r = await s3bRig({ roomOffice: true });
  const alex = r.addPerson("alex", "Alex"); r.addPerson("blake", "Blake");
  const a = await r.signIn("alex"), b = await r.signIn("blake"), admin = await r.signIn("admin");
  const fleetId = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, (state: any) => {
    state.fleets.push({ id: fleetId, owner: r!.admin, generation: 1, credentialHash: null, status: "active", label: "Admin fleet" }); });
  const link = r.link(fleetId, r.admin, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", HUB_AGENT_PICTURES_CAPABILITY]);
  const notes = randomUUID(), plan = randomUUID();
  const ex = (id: string, name: string, state = "published") => ({ id, fleetId, owner: r!.admin, displayName: name, revision: 1, state, dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [ex(notes, "Notes"), ex(plan, "Planner")] }, link) as never, link);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Room", people: [personKeyString(alex)], agents: [notes, plan] });
  const send = async (type: string, payload: unknown) => ((await r!.http.receive(r!.frame(type, payload, link) as never, link)) as any)?.payload;
  const picture = async (who: { cookie: string; csrf: string }, exposureId: string, slot: string, v = "") => {
    const res = await fetch(`${r!.base}/hub/v1/rooms/${made.json.room.id}/agents/${exposureId}/picture/${slot}${v ? `?v=${v}` : ""}`, { headers: { Cookie: who.cookie } });
    return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), bytes: Buffer.from(await res.arrayBuffer()) };
  };
  const member = async (exposureId: string) => (await r!.call(a, "GET", `/hub/v1/rooms/${made.json.room.id}`)).json.members.find((m: any) => m.id === exposureId);
  const office = async (exposureId: string) => (await r!.call(a, "GET", `/hub/v1/rooms/${made.json.room.id}/office/state`)).json.instances.find((i: any) => i.name === exposureId);
  return { a, b, admin, link, fleetId, notes, plan, ex, roomId: made.json.room.id as string, send, picture, member, office };
}

describe("M-3533 R2b: agent pictures on the Hub", () => {
  it("a report asks for the missing hashes; chunks complete a picture; members get it, others do not", async () => {
    const w = await world(), disc = PNG(3000), portrait = JPEG(HUB_PICTURE_CHUNK + 5000);
    const rev = "d".repeat(64);
    const first = await w.send("agent.pictures", { revision: rev, agents: [{ exposureId: w.notes, disc: ref(disc, "image/png"), portrait: ref(portrait, "image/jpeg") }, { exposureId: w.plan, disc: null, portrait: null }] });
    expect(first).toEqual({ ok: true, need: expect.arrayContaining([sha(disc), sha(portrait)]) });
    expect(first.need).toHaveLength(2);
    // Nothing shows until the Hub holds the picture.
    expect((await w.member(w.notes)).look?.disc).toBeUndefined();
    expect(await w.send("agent.picture", chunks(disc, "image/png")[0])).toEqual({ ok: true, stored: true });
    const parts = chunks(portrait, "image/jpeg");
    expect(parts).toHaveLength(2);
    expect(await w.send("agent.picture", parts[0])).toEqual({ ok: true, stored: false });
    expect(await w.send("agent.picture", parts[1])).toEqual({ ok: true, stored: true });
    expect((await w.member(w.notes)).look).toMatchObject({ disc: sha(disc), portrait: sha(portrait) });
    expect((await w.office(w.notes)).picture).toEqual({ disc: sha(disc), portrait: sha(portrait) });
    expect((await w.member(w.plan)).look).toBeUndefined();
    const got = await w.picture(w.a, w.notes, "disc", sha(disc));
    expect([got.status, got.type, got.bytes.equals(disc), got.cache]).toEqual([200, "image/png", true, "private, max-age=86400"]);
    const big = await w.picture(w.a, w.notes, "portrait");
    expect([big.status, big.type, big.bytes.equals(portrait), big.cache]).toEqual([200, "image/jpeg", true, "private, no-cache"]);
    // Not in the room: refused. An agent with no picture, or one not in the room: not found.
    expect((await w.picture(w.b, w.notes, "disc")).status).toBe(403);
    expect((await w.picture(w.a, w.plan, "disc")).status).toBe(404);
    expect((await w.picture(w.a, randomUUID(), "disc")).status).toBe(404);
    // A second report naming the same pictures needs nothing.
    expect(await w.send("agent.pictures", { revision: "e".repeat(64), agents: [{ exposureId: w.notes, disc: ref(disc, "image/png"), portrait: ref(portrait, "image/jpeg") }] })).toEqual({ ok: true, need: [] });
  });

  it("a changed or removed picture follows; the old copy is dropped; unsharing removes it", async () => {
    const w = await world(), one = PNG(2000, 3), two = PNG(2100, 4);
    await w.send("agent.pictures", { revision: "1".repeat(64), agents: [{ exposureId: w.notes, disc: ref(one, "image/png"), portrait: null }] });
    await w.send("agent.picture", chunks(one, "image/png")[0]);
    expect((await w.member(w.notes)).look.disc).toBe(sha(one));
    expect((await w.send("agent.pictures", { revision: "2".repeat(64), agents: [{ exposureId: w.notes, disc: ref(two, "image/png"), portrait: null }] })).need).toEqual([sha(two)]);
    // Until the new one arrives the old is not shown (no stale picture), and its copy is gone.
    expect((await w.member(w.notes)).look?.disc).toBeUndefined();
    expect(r!.db.prepare("SELECT count(*) n FROM hub_agent_picture_files").get()).toEqual({ n: 0 });
    await w.send("agent.picture", chunks(two, "image/png")[0]);
    expect((await w.member(w.notes)).look.disc).toBe(sha(two));
    // Removed on the Fleet.
    await w.send("agent.pictures", { revision: "3".repeat(64), agents: [{ exposureId: w.notes, disc: null, portrait: null }] });
    expect((await w.member(w.notes)).look?.disc).toBeUndefined();
    expect((await w.picture(w.a, w.notes, "disc")).status).toBe(404);
    // Shown again, then the agent is no longer shared: gone, without a new report.
    await w.send("agent.pictures", { revision: "4".repeat(64), agents: [{ exposureId: w.notes, disc: ref(two, "image/png"), portrait: null }] });
    await w.send("agent.picture", chunks(two, "image/png")[0]);
    expect((await w.member(w.notes)).look.disc).toBe(sha(two));
    await r!.http.receive(r!.frame("exposure.snapshot", { revision: 2, exposures: [w.ex(w.notes, "Notes", "withdrawn"), w.ex(w.plan, "Planner")] }, w.link) as never, w.link);
    expect((await w.picture(w.a, w.notes, "disc")).status).toBe(404);
  });

  it("a picture that lands tells the room's open pages to read its members again", async () => {
    const w = await world(), disc = PNG(1800, 9);
    const abort = new AbortController();
    const response = await fetch(r!.base + "/hub/v1/rooms/events", { headers: { Cookie: w.a.cookie }, signal: abort.signal });
    const reader = response.body!.getReader(), seen: string[] = [];
    const until = async (want: string) => { for (let i = 0; i < 20 && !seen.join("").includes(want); i++) seen.push(new TextDecoder().decode((await reader.read()).value)); return seen.join(""); };
    try {
      await reader.read();
      await w.send("agent.pictures", { revision: "a".repeat(64), agents: [{ exposureId: w.notes, disc: ref(disc, "image/png"), portrait: null }] });
      await w.send("agent.picture", chunks(disc, "image/png")[0]);
      expect(await until("event: member.changed")).toContain(`"roomId":"${w.roomId}"`);
    } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  });

  it("refuses a chunk nobody asked for, a wrong hash, a type its bytes do not show, and a short chunk", async () => {
    const w = await world(), disc = PNG(1500, 5), other = PNG(1600, 6);
    await w.send("agent.pictures", { revision: "5".repeat(64), agents: [{ exposureId: w.notes, disc: ref(disc, "image/png"), portrait: null }] });
    expect(await w.send("agent.picture", chunks(other, "image/png")[0])).toEqual({ ok: false, code: "not-wanted" });
    const forged = { ...chunks(other, "image/png")[0], sha256: sha(disc) };
    expect(await w.send("agent.picture", forged)).toEqual({ ok: false, code: "invalid" });
    const asJpeg = { ...chunks(disc, "image/png")[0], mime: "image/jpeg" };
    expect(await w.send("agent.picture", asJpeg)).toEqual({ ok: false, code: "invalid" });
    const short = { ...chunks(disc, "image/png")[0], data: disc.subarray(0, 100).toString("base64") };
    expect(await w.send("agent.picture", short)).toEqual({ ok: false, code: "invalid" });
    expect((await w.member(w.notes)).look?.disc).toBeUndefined();
    expect(await w.send("agent.picture", chunks(disc, "image/png")[0])).toEqual({ ok: true, stored: true });
  });

  it("another Fleet's agent, or one not published, is skipped; a link without the feature is refused", async () => {
    const w = await world(), disc = PNG(1200, 7);
    const res = await w.send("agent.pictures", { revision: "6".repeat(64), agents: [{ exposureId: randomUUID(), disc: ref(disc, "image/png"), portrait: null }] });
    expect(res).toEqual({ ok: true, need: [] });
    const old = r!.link(randomUUID(), r!.admin, 1, ["welcome-caps-v1"]);
    await expect(r!.http.receive(r!.frame("agent.pictures", { revision: "7".repeat(64), agents: [] }, old) as never, old)).rejects.toMatchObject({ code: "incompatible" });
  });

  it("too large: only the owner's own view says which picture; members see the agent as before", async () => {
    const w = await world();
    await w.send("agent.pictures", { revision: "8".repeat(64), agents: [{ exposureId: w.notes, disc: null, portrait: null, tooLarge: ["disc", "portrait"] }] });
    const mine = await r!.call(w.admin, "GET", "/hub/v1/me/agents");
    expect(mine.json.fleets.find((f: any) => f.id === w.fleetId).picturesTooLarge).toEqual({ [w.notes]: ["disc", "portrait"] });
    expect((await w.member(w.notes)).look).toBeUndefined();
    expect(JSON.stringify((await r!.call(w.a, "GET", `/hub/v1/rooms/${w.roomId}`)).json)).not.toContain("tooLarge");
  });

  it("the model: caps, tooLarge only for a missing picture, and the types told by their bytes", () => {
    const ok = { exposureId: randomUUID(), disc: { sha256: "a".repeat(64), mime: "image/png", size: HUB_PICTURE_DISC_MAX }, portrait: null };
    expect(agentPicturesRowSchema.safeParse(ok).success).toBe(true);
    expect(agentPicturesRowSchema.safeParse({ ...ok, disc: { ...ok.disc, size: HUB_PICTURE_DISC_MAX + 1 } }).success).toBe(false);
    expect(agentPicturesRowSchema.safeParse({ ...ok, tooLarge: ["disc"] }).success).toBe(false);
    expect(agentPicturesRowSchema.safeParse({ ...ok, tooLarge: ["portrait"] }).success).toBe(true);
    expect(agentPicturesRowSchema.safeParse({ ...ok, portrait: { sha256: "b".repeat(64), mime: "image/jpeg", size: 512 * 1024 } }).success).toBe(false);
    expect([sniffPicture(PNG(16)), sniffPicture(JPEG(16)), sniffPicture(Buffer.from("RIFF0000WEBPVP8 ")), sniffPicture(Buffer.from("GIF89a....")), sniffPicture(Buffer.from("<svg>"))])
      .toEqual(["image/png", "image/jpeg", "image/webp", "image/gif", null]);
  });

  it("negotiation: offered to a member that takes a 32-name welcome; frames parse; an old member is not offered it", () => {
    const caps = hubLinkCapabilities({ agentPicturesV1: true, features: [HUB_FLEET_UPDATE_CAPABILITY] });
    expect(caps).toContain(HUB_AGENT_PICTURES_CAPABILITY);
    expect(HUB_OPTIONAL_CAPABILITIES).not.toContain(HUB_AGENT_PICTURES_CAPABILITY);
    expect(hubWelcomeCapabilities(caps, HUB_OPTIONAL_CAPABILITIES)).not.toContain(HUB_AGENT_PICTURES_CAPABILITY);
    expect(hubWelcomeCapabilities(caps, [...HUB_OPTIONAL_CAPABILITIES, HUB_FLEET_UPDATE_CAPABILITY])).toContain(HUB_AGENT_PICTURES_CAPABILITY);
    expect(hubLinkCapabilities({ features: [] })).not.toContain(HUB_AGENT_PICTURES_CAPABILITY);
  });

  it("offered: the composed Hub offers agent-pictures-v1 now that the room page draws the pictures (R2b-page)", async () => {
    r = await s3bRig({ roomOffice: true });
    expect(r.http.agentPicturesV1).toBe(true);
    expect(hubLinkCapabilities(r.http)).toContain(HUB_AGENT_PICTURES_CAPABILITY);
    const f = { v: 1 as const, type: "agent.pictures" as const, requestId: randomUUID(), linkEpoch: 1, payload: { revision: "9".repeat(64), agents: [] } };
    expect(parseMemberFrame(encodeMemberFrame(f))).toEqual(f);
  });
});
