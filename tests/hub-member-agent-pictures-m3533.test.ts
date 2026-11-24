/**
 * M-3533 R2b (Fleet side): a published share's pictures reach the Hub as the Fleet shows them. A PNG is cut to the square the
 * Fleet shows (the disc centred, the card's portrait 18% down) and made 64 / 256 px; a JPEG goes as it is when it fits; over a
 * cap the picture is left out and reported as too large, the disc never the one dropped. The sender runs against the real
 * Hub store here (its exchanges go to the Hub's receive), so what a room member gets is checked end to end.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { decodePng, encodePng, type Rgba } from "../src/web-png.js";
import { reduceInProcess, reducePicture, squareOf } from "../src/hub-picture-reduce.js";
import { HubMemberAgentPictures, type MemberPictureSources } from "../src/hub/member/agent-pictures.js";
import { HUB_AGENT_PICTURES_CAPABILITY, HUB_PICTURE_AGENT_MAX, HUB_PICTURE_DISC_MAX } from "../src/hub/agent-pictures-model.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });

/** A w×h PNG: red above `split` of its height, blue below. */
function twoTone(w: number, h: number, split: number): Buffer {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(y < h * split ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * w + x) * 4);
  return encodePng({ width: w, height: h, data });
}
const px = (img: Rgba, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const JPEG = (n: number, seed = 2) => { const b = Buffer.alloc(n, seed); Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b); return b; };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("M-3533 R2b: the square the Fleet shows, made small", () => {
  it("the disc is centred, the portrait taken 18% down, each square and at most 64 / 256 px", () => {
    // 200×1000: the squares differ by where they start (disc: 400 down; portrait: 144 down). Red above 30%.
    const src = twoTone(200, 1000, 0.3);
    const disc = decodePng(reducePicture(src, "disc"), { maxSide: 4096 }), portrait = decodePng(reducePicture(src, "portrait"), { maxSide: 4096 });
    expect([disc.width, disc.height, portrait.width, portrait.height]).toEqual([64, 64, 200, 200]);
    // The disc's square (400..600) is all blue; the portrait's (144..344) is red to 300, blue below.
    expect([px(disc, 32, 0), px(disc, 32, 63)]).toEqual([[0, 0, 255, 255], [0, 0, 255, 255]]);
    expect([px(portrait, 100, 0), px(portrait, 100, 199)]).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);
    const big = decodePng(reducePicture(twoTone(1024, 1536, 0.5), "portrait"), { maxSide: 4096 });
    expect([big.width, big.height]).toEqual([256, 256]);
    const sq = squareOf({ width: 4, height: 2, data: new Uint8Array(32).map((_, i) => i) }, 0.5);
    expect([sq.width, sq.height, [...sq.data.subarray(0, 4)]]).toEqual([2, 2, [4, 5, 6, 7]]);
  });
  it("a picture it cannot read is not reduced", async () => {
    expect(await reduceInProcess(Buffer.from("not a png"), "disc")).toBe(null);
  });
});

async function world() {
  r = await s3bRig({ roomOffice: true });
  const alex = r.addPerson("alex", "Alex"), a = await r.signIn("alex"), admin = await r.signIn("admin");
  const fleetId = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, (state: any) => {
    state.fleets.push({ id: fleetId, owner: r!.admin, generation: 1, credentialHash: null, status: "active", label: "Admin fleet" }); });
  const hubSide = r.link(fleetId, r.admin, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", HUB_AGENT_PICTURES_CAPABILITY]);
  const notes = randomUUID(), plan = randomUUID();
  const ex = (id: string, name: string) => ({ id, fleetId, owner: r!.admin, displayName: name, revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [ex(notes, "Notes"), ex(plan, "Planner")] }, hubSide) as never, hubSide);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Room", people: [personKeyString(alex)], agents: [notes, plan] });
  const roomId = made.json.room.id as string;
  // The member's link: each exchange is the Hub's receive of that frame; every frame sent is kept.
  const frames: any[] = []; let refuseChunks = 0;
  const memberLink: any = { linkEpoch: 1, features: new Set([HUB_AGENT_PICTURES_CAPABILITY]), current: () => true,
    exchange: async (frame: any) => { frames.push(frame);
      if (frame.type === "agent.picture" && refuseChunks > 0) { refuseChunks--; return { type: "agent.picture-result", payload: { ok: false, code: "unavailable" } }; }
      return r!.http.receive(frame, hubSide); } };
  const sources = new Map<string, MemberPictureSources>();
  const sender = new HubMemberAgentPictures({ current: () => true, reduce: reduceInProcess,
    exposures: () => [{ id: notes, agent: "notes" }, { id: plan, agent: "plan" }], sources: (agent) => sources.get(agent) ?? { disc: null, portrait: null } });
  const look = async (id: string) => (await r!.call(a, "GET", `/hub/v1/rooms/${roomId}`)).json.members.find((m: any) => m.id === id).look;
  const mine = async () => (await r!.call(admin, "GET", "/hub/v1/me/agents")).json.fleets.find((f: any) => f.id === fleetId).picturesTooLarge ?? null;
  const served = async (id: string, slot: string) => { const res = await fetch(`${r!.base}/hub/v1/rooms/${roomId}/agents/${id}/picture/${slot}`, { headers: { Cookie: a.cookie } });
    return { status: res.status, type: res.headers.get("content-type"), bytes: Buffer.from(await res.arrayBuffer()) }; };
  const source = (key: string, bytes: Buffer) => ({ key, load: () => ({ bytes }) });
  return { sender, memberLink, frames, sources, look, mine, served, source, notes, plan, refuse: (n: number) => { refuseChunks = n; } };
}

describe("M-3533 R2b: the Fleet sends its shared agents' pictures", () => {
  it("a PNG disc is reduced, a JPEG portrait goes as it is; a room member is served both; an unchanged tick sends nothing", async () => {
    const w = await world(), png = twoTone(512, 512, 0.5), jpeg = JPEG(300 * 1024);
    w.sources.set("notes", { disc: w.source("profile:1", png), portrait: w.source("card:p1", jpeg) });
    w.sender.connected(w.memberLink); await w.sender.refresh();
    const disc = await w.served(w.notes, "disc"), portrait = await w.served(w.notes, "portrait");
    expect([disc.status, disc.type, decodePng(disc.bytes, { maxSide: 64 }).width]).toEqual([200, "image/png", 64]);
    expect([portrait.status, portrait.type, portrait.bytes.equals(jpeg)]).toEqual([200, "image/jpeg", true]);
    expect(await w.look(w.notes)).toMatchObject({ disc: sha(disc.bytes), portrait: sha(jpeg) });
    expect(w.frames.filter((f) => f.type === "agent.picture").map((f) => f.payload.index)).toEqual([0, 0, 1]);
    const before = w.frames.length; await w.sender.refresh();
    expect(w.frames.length, "nothing changed: nothing sent").toBe(before);
    w.sender.close();
  });

  it("a replaced picture follows with only the new one sent; a removed one goes", async () => {
    const w = await world(), one = twoTone(64, 64, 0.2), two = twoTone(64, 64, 0.8);
    w.sources.set("notes", { disc: w.source("profile:1", one), portrait: null });
    w.sender.connected(w.memberLink); await w.sender.refresh();
    const first = (await w.look(w.notes)).disc;
    w.sources.set("notes", { disc: w.source("profile:2", two), portrait: null }); w.frames.length = 0;
    await w.sender.refresh();
    expect((await w.look(w.notes)).disc).not.toBe(first);
    expect(w.frames.map((f) => f.type)).toEqual(["agent.pictures", "agent.picture"]);
    w.sources.set("notes", { disc: null, portrait: null });
    await w.sender.refresh();
    expect(await w.look(w.notes)).toBeUndefined();
    w.sender.close();
  });

  it("too large: a JPEG disc over 64 KB and a portrait over what is left are left out and reported; the disc is kept first", async () => {
    const w = await world();
    w.sources.set("notes", { disc: w.source("bot:1", JPEG(HUB_PICTURE_DISC_MAX + 1)), portrait: w.source("card:1", JPEG(HUB_PICTURE_AGENT_MAX + 1)) });
    // Planner: each fits alone, not both — the portrait is the one left out.
    w.sources.set("plan", { disc: w.source("bot:2", JPEG(HUB_PICTURE_DISC_MAX, 3)), portrait: w.source("card:2", JPEG(HUB_PICTURE_AGENT_MAX - HUB_PICTURE_DISC_MAX + 1, 4)) });
    w.sender.connected(w.memberLink); await w.sender.refresh();
    expect(await w.mine()).toEqual({ [w.notes]: ["disc", "portrait"], [w.plan]: ["portrait"] });
    expect(await w.look(w.notes)).toBeUndefined();
    expect(await w.look(w.plan)).toEqual({ disc: expect.any(String) });
    w.sender.close();
  });

  it("a refused chunk is not taken as sent: the next tick sends again", async () => {
    const w = await world();
    w.sources.set("notes", { disc: w.source("profile:1", twoTone(64, 64, 0.5)), portrait: null });
    w.refuse(1); w.sender.connected(w.memberLink); await w.sender.refresh();
    expect((await w.look(w.notes))?.disc).toBeUndefined();
    await w.sender.refresh();
    expect((await w.look(w.notes)).disc).toEqual(expect.any(String));
    w.sender.close();
  });

  it("a Hub that does not offer pictures is sent nothing", async () => {
    const w = await world();
    w.sources.set("notes", { disc: w.source("profile:1", twoTone(64, 64, 0.5)), portrait: null });
    w.sender.connected({ ...w.memberLink, features: new Set() }); await w.sender.refresh();
    expect(w.frames).toEqual([]);
    w.sender.close();
  });
});
