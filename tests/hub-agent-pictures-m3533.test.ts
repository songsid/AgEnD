/**
 * M-3533 R2b (Hub side): a Fleet reports its shared agents' pictures (agent-pictures-v1), the Hub asks for the hashes it lacks,
 * takes them in chunks, keeps one copy per hash while a report names it, and serves an agent's disc or portrait only to the
 * members of a room holding that agent. A picture over its cap is reported as too large: only its owner's view says so.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { hubLinkCapabilities } from "../src/hub/compose/server.js";
import { hubWelcomeCapabilities } from "../src/hub/server.js";
import { HUB_FLEET_UPDATE_CAPABILITY, HUB_OPTIONAL_CAPABILITIES, parseMemberFrame, encodeMemberFrame } from "../src/hub/protocol.js";
import { HUB_PICTURES_SWEEP_MS } from "../src/hub/agent-pictures.js";
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

  // Prism (review of #4393): a picture is stored, and shown, only as its row declares it — its type and size, so the caps hold.
  it("a chunk must be the picture as its row declared it; a held file another row declares differently is never shown for it", async () => {
    const w = await world(), real = PNG(40_000, 11);
    // The row declares a 1,000-byte disc; the chunks carry the real 40,000 bytes under that hash.
    await w.send("agent.pictures", { revision: "b".repeat(64), agents: [{ exposureId: w.notes, disc: { sha256: sha(real), mime: "image/png", size: 1000 }, portrait: null }] });
    expect(await w.send("agent.picture", chunks(real, "image/png")[0])).toEqual({ ok: false, code: "not-wanted" });
    expect((await w.member(w.notes)).look?.disc).toBeUndefined();
    // A big picture held for one agent's portrait, then named as another's disc with a small size: not shown as that disc.
    const big = JPEG(HUB_PICTURE_CHUNK + 10_000, 12);
    await w.send("agent.pictures", { revision: "c".repeat(64), agents: [{ exposureId: w.notes, disc: null, portrait: ref(big, "image/jpeg") }] });
    for (const c of chunks(big, "image/jpeg")) await w.send("agent.picture", c);
    expect((await w.member(w.notes)).look.portrait).toBe(sha(big));
    const res = await w.send("agent.pictures", { revision: "e".repeat(64), agents: [{ exposureId: w.notes, disc: null, portrait: ref(big, "image/jpeg") },
      { exposureId: w.plan, disc: { sha256: sha(big), mime: "image/jpeg", size: 2000 }, portrait: null }] });
    expect(res).toEqual({ ok: true, need: [] });
    expect((await w.member(w.plan)).look?.disc).toBeUndefined();
    expect((await w.picture(w.a, w.plan, "disc")).status).toBe(404);
    expect((await w.member(w.notes)).look.portrait).toBe(sha(big));
  });

  // Prism (#4393 R1): naming a held picture with another size does not keep it alive beside a new one — one agent, one cap.
  it("a replacement that names the old picture with a wrong size frees it: one agent never holds more than 512 KB", async () => {
    const w = await world(), a = JPEG(512 * 1024, 16), b = JPEG(512 * 1024 - 1, 17);
    await w.send("agent.pictures", { revision: "1".repeat(64), agents: [{ exposureId: w.notes, disc: null, portrait: ref(a, "image/jpeg") }] });
    for (const c of chunks(a, "image/jpeg")) await w.send("agent.picture", c);
    expect((await w.member(w.notes)).look.portrait).toBe(sha(a));
    const next = await w.send("agent.pictures", { revision: "2".repeat(64), agents: [{ exposureId: w.notes, disc: { sha256: sha(a), mime: "image/jpeg", size: 1 }, portrait: ref(b, "image/jpeg") }] });
    expect(next).toEqual({ ok: true, need: [sha(b)] });
    for (const c of chunks(b, "image/jpeg")) await w.send("agent.picture", c);
    const held = r!.db.prepare("SELECT sha256, length(bytes) AS n FROM hub_agent_picture_files").all() as any[];
    expect(held).toEqual([{ sha256: sha(b), n: b.length }]);
    expect((await w.member(w.notes)).look).toEqual({ portrait: sha(b) });
  });

  // Prism (#4393 R2): the other order — the wrong-size reference comes first, before anyone holds the picture.
  it("a wrong-size reference made before the picture is held keeps nothing alive once its valid holder goes; valid sharers keep it", async () => {
    const w = await world(), a = JPEG(512 * 1024, 18), b = JPEG(512 * 1024 - 1, 19);
    const held = () => (r!.db.prepare("SELECT sha256, length(bytes) AS n FROM hub_agent_picture_files ORDER BY sha256").all() as any[]);
    // X (Notes) names A as a 1-byte disc beside its own portrait B, while nobody holds A.
    expect(await w.send("agent.pictures", { revision: "3".repeat(64), agents: [{ exposureId: w.notes, disc: { sha256: sha(a), mime: "image/jpeg", size: 1 }, portrait: ref(b, "image/jpeg") }] }))
      .toEqual({ ok: true, need: expect.arrayContaining([sha(a), sha(b)]) });
    // Y (Planner) reports A validly and uploads it; X uploads B.
    await w.send("agent.pictures", { revision: "4".repeat(64), agents: [{ exposureId: w.notes, disc: { sha256: sha(a), mime: "image/jpeg", size: 1 }, portrait: ref(b, "image/jpeg") },
      { exposureId: w.plan, disc: null, portrait: ref(a, "image/jpeg") }] });
    for (const c of [...chunks(a, "image/jpeg"), ...chunks(b, "image/jpeg")]) await w.send("agent.picture", c);
    expect(held().map((x) => x.sha256)).toEqual([sha(a), sha(b)].sort());
    expect([(await w.member(w.notes)).look, (await w.member(w.plan)).look]).toEqual([{ portrait: sha(b) }, { portrait: sha(a) }]);
    // Y is withdrawn: A goes with it — X's wrong-size reference does not keep it. X holds only its own B.
    await r!.http.receive(r!.frame("exposure.snapshot", { revision: 2, exposures: [w.ex(w.notes, "Notes"), w.ex(w.plan, "Planner", "withdrawn")] }, w.link) as never, w.link);
    expect(held()).toEqual([{ sha256: sha(b), n: b.length }]);
  });

  it("two agents naming one picture as it is: it stays while either does", async () => {
    const w = await world(), a = PNG(2500, 20);
    await w.send("agent.pictures", { revision: "5".repeat(64), agents: [{ exposureId: w.notes, disc: ref(a, "image/png"), portrait: null }, { exposureId: w.plan, disc: ref(a, "image/png"), portrait: null }] });
    await w.send("agent.picture", chunks(a, "image/png")[0]);
    await r!.http.receive(r!.frame("exposure.snapshot", { revision: 2, exposures: [w.ex(w.notes, "Notes"), w.ex(w.plan, "Planner", "withdrawn")] }, w.link) as never, w.link);
    expect([(r!.db.prepare("SELECT count(*) AS n FROM hub_agent_picture_files").get() as any).n, (await w.member(w.notes)).look]).toEqual([1, { disc: sha(a) }]);
  });

  it("withdrawn or revoked: swept without a report from that Fleet; a file another agent still shows is kept", async () => {
    const w = await world(), shared = PNG(1700, 13), own = PNG(1750, 14);
    // A second Fleet whose agent shows the same picture.
    const otherFleet = randomUUID(), other = randomUUID();
    r!.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, (state: any) => {
      state.fleets.push({ id: otherFleet, owner: r!.admin, generation: 1, credentialHash: null, status: "active", label: "Other fleet" }); });
    const otherLink = r!.link(otherFleet, r!.admin, 1, ["welcome-caps-v1", HUB_AGENT_PICTURES_CAPABILITY]);
    await r!.http.receive(r!.frame("exposure.snapshot", { revision: 1, exposures: [{ ...w.ex(other, "Other"), fleetId: otherFleet }] }, otherLink) as never, otherLink);
    await w.send("agent.pictures", { revision: "f".repeat(64), agents: [{ exposureId: w.notes, disc: ref(shared, "image/png"), portrait: null }, { exposureId: w.plan, disc: ref(own, "image/png"), portrait: null }] });
    await w.send("agent.picture", chunks(shared, "image/png")[0]); await w.send("agent.picture", chunks(own, "image/png")[0]);
    await r!.http.receive(r!.frame("agent.pictures", { revision: "f".repeat(64), agents: [{ exposureId: other, disc: ref(shared, "image/png"), portrait: null }] }, otherLink) as never, otherLink);
    const files = () => (r!.db.prepare("SELECT sha256 FROM hub_agent_picture_files ORDER BY sha256").all() as any[]).map((x) => x.sha256);
    const rows = () => (r!.db.prepare("SELECT exposure_id FROM hub_agent_pictures ORDER BY exposure_id").all() as any[]).map((x) => x.exposure_id);
    expect(files()).toEqual([sha(shared), sha(own)].sort());
    // Withdrawn: its snapshot sweeps it at once. The picture the other Fleet's agent shows stays.
    await r!.http.receive(r!.frame("exposure.snapshot", { revision: 2, exposures: [w.ex(w.notes, "Notes"), w.ex(w.plan, "Planner", "withdrawn")] }, w.link) as never, w.link);
    expect([rows().includes(w.plan), files()]).toEqual([false, [sha(shared), sha(own)].sort().filter((h) => h !== sha(own))]);
    // Revoked (no report comes from a revoked Fleet): hidden at once, gone at the next sweep; the shared file stays for the other.
    r!.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.revoke", result: "completed" }, (state: any) => {
      const f = state.fleets.find((x: any) => x.id === w.fleetId); f.status = "revoked"; f.generation++; });
    expect(rows()).toContain(w.notes);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await r!.restartHttp();
      vi.advanceTimersByTime(HUB_PICTURES_SWEEP_MS);
      expect([rows(), files()]).toEqual([[other], [sha(shared)]]);
    } finally { vi.useRealTimers(); }
  });

  it("refuses a chunk nobody asked for, a wrong hash, a type its bytes do not show, and a short chunk", async () => {
    const w = await world(), disc = PNG(1500, 5), other = PNG(1600, 6);
    // Planner's row declares a JPEG for bytes that are a PNG.
    await w.send("agent.pictures", { revision: "5".repeat(64), agents: [{ exposureId: w.notes, disc: ref(disc, "image/png"), portrait: null },
      { exposureId: w.plan, disc: ref(other, "image/jpeg"), portrait: null }] });
    const third = PNG(1500, 15);   // as long as the declared disc, other bytes
    expect(await w.send("agent.picture", chunks(third, "image/png")[0])).toEqual({ ok: false, code: "not-wanted" });
    const forged = { ...chunks(third, "image/png")[0], sha256: sha(disc) };
    expect(await w.send("agent.picture", forged)).toEqual({ ok: false, code: "invalid" });
    // Another type than its row declares: not wanted. The type its row declares, which its bytes do not show: refused.
    expect(await w.send("agent.picture", { ...chunks(disc, "image/png")[0], mime: "image/jpeg" })).toEqual({ ok: false, code: "not-wanted" });
    expect(await w.send("agent.picture", chunks(other, "image/jpeg")[0])).toEqual({ ok: false, code: "invalid" });
    expect((await w.member(w.plan)).look?.disc).toBeUndefined();
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

  it("not offered yet: the composed Hub leaves agent-pictures-v1 off until R2b-page draws the pictures", async () => {
    r = await s3bRig({ roomOffice: true });
    expect(r.http.agentPicturesV1).toBeUndefined();
    expect(hubLinkCapabilities(r.http)).not.toContain(HUB_AGENT_PICTURES_CAPABILITY);
    const f = { v: 1 as const, type: "agent.pictures" as const, requestId: randomUUID(), linkEpoch: 1, payload: { revision: "9".repeat(64), agents: [] } };
    expect(parseMemberFrame(encodeMemberFrame(f))).toEqual(f);
  });
});
