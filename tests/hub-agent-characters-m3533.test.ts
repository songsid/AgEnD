/**
 * M-3533 R2c (Lumen's decisions 1–6): an agent's own character from its owner's skin pack, in the Hub's room offices.
 * - Its own: the set its owner gave it by name (`byInstance`) in the first office of the owner's order holding it whose pack
 *   names it, else the "All" office's pack; never a pack's `default`.
 * - The poses a room shows, each cut into its own PNG (nothing else on a shared sheet crosses); a missing one filled inside
 *   the set (stand, else idle); a picture that is not a PNG, or does not cut: no set at all.
 * - The whole set or none, in what the avatar and portrait leave of 512 KB (dropped first; the owner is told).
 * - Only to a Hub that offers agent-characters-v1; served to the room's members only.
 * - The page draws it at most CHARACTER_FIT, wholly or not at all; an agent named "default" is nobody's fallback.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import { decodePng, encodePng } from "../src/web-png.js";
import { cropCharacter, cropInProcess, reduceInProcess } from "../src/hub-picture-reduce.js";
import { HubMemberAgentPictures, type MemberPictureSources } from "../src/hub/member/agent-pictures.js";
import { characterPlan, ownCharacter } from "../src/hub-character-plan.js";
import { hubLinkCapabilities } from "../src/hub/compose/server.js";
import { hubWelcomeCapabilities } from "../src/hub/server.js";
import { HUB_FLEET_UPDATE_CAPABILITY } from "../src/hub/protocol.js";
import { HUB_AGENT_CHARACTERS_CAPABILITY, HUB_AGENT_PICTURES_CAPABILITY, HUB_PICTURE_AGENT_MAX, agentPicturesRowSchema } from "../src/hub/agent-pictures-model.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const W = 8, H = 12;
/** A sheet of `cols` × `rows` cells of W × H, each one flat colour: row `y`, column `x` is [40·x, 100 + 50·y, 7, 255]. */
function sheet(cols: number, rows: number): Buffer {
  const width = cols * W, height = rows * H, data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([40 * Math.floor(x / W), 100 + 50 * Math.floor(y / H), 7, 255], (y * width + x) * 4);
  return encodePng({ width, height, data });
}
/** A strip of `frames` cells of the shared sheet, from row `row` (a pack's sheet form, as checkStrip leaves it). */
const strip = (row: number, frames = 2, extra: Record<string, unknown> = {}) => ({ src: "chars.png", frames, w: W, h: H, fps: 4, ax: W / 2, ay: H, dw: W * 2, dh: H * 2, row, col: 0, ...extra });
/** Row 0 is Notes's own character, row 1 someone else's on the same sheet. */
const OWN_SET = { idle: strip(0), working: strip(0, 3), stand: strip(0, 1), walk: strip(0, 2), needs: strip(0), eat: strip(0), dragged: strip(0), prop: strip(0) };

describe("M-3533 R2c: which character is its own, and what of it is sent", () => {
  it("only the poses a room shows; a missing one filled inside the set (stand, else idle); none to fill from, or too many frames: no set", () => {
    const plan = characterPlan(OWN_SET as never)!;
    expect(Object.keys(plan.poses).sort()).toEqual(["idle", "paused", "stand", "walk", "working"]);
    expect(plan.poses.paused!.cut.cells, "paused: the set's stand").toEqual(plan.poses.stand!.cut.cells);
    expect(plan.poses.working!.cut.cells).toEqual([0, 1, 2].map(col => ({ file: "chars.png", col, row: 0 })));
    expect(plan.sources).toEqual(["chars.png"]);
    expect(Object.keys(characterPlan({ working: strip(0), stand: strip(0, 1) } as never)!.poses).sort()).toEqual(["idle", "paused", "stand", "working"]);
    expect(characterPlan({ idle: strip(0) } as never)!.poses.stand!.cut.cells, "stand: else idle").toEqual(characterPlan({ idle: strip(0) } as never)!.poses.idle!.cut.cells);
    expect(characterPlan({ working: strip(0), walk: strip(0) } as never), "neither idle nor stand").toBeNull();
    expect(characterPlan({ idle: strip(0, 33) } as never), "a strip longer than a room strip").toBeNull();
  });

  it("its own set: the first office of the owner's order holding it whose pack names it; never a default; else the All office's pack", () => {
    const pack = (byInstance: Record<string, string>, sets: string[]) => ({ byInstance, characters: Object.fromEntries([...sets, "default"].map(s => [s, OWN_SET])) }) as never;
    const packs: Record<string, unknown> = { plain: pack({}, []), mine: pack({ notes: "sage" }, ["sage"]), other: pack({ notes: "knight" }, ["knight"]), auto: pack({ notes: "auto" }, ["auto"]) };
    const o = (offices: Array<{ skin: string; members: string[] }>, autoSkin: string | null = null) => ({ offices, autoSkin, pack: (id: string) => (packs[id] as never) ?? null,
      holds: (office: { members: readonly string[] }, agent: string) => !office.members.length || office.members.includes(agent) });
    // The first office holds it but its pack gives it only a default: not its own — the next naming it is.
    expect(ownCharacter(o([{ skin: "plain", members: [] }, { skin: "mine", members: ["notes"] }, { skin: "other", members: [] }]), "notes")).toEqual({ packId: "mine", set: "sage" });
    // An office not holding it is skipped, whatever its pack names.
    expect(ownCharacter(o([{ skin: "other", members: ["plan"] }, { skin: "mine", members: [] }]), "notes")).toEqual({ packId: "mine", set: "sage" });
    expect(ownCharacter(o([{ skin: "plain", members: [] }], "auto"), "notes")).toEqual({ packId: "auto", set: "auto" });
    expect(ownCharacter(o([{ skin: "plain", members: [] }], "plain"), "notes"), "a default is nobody's own").toBeNull();
    expect(ownCharacter(o([{ skin: "cozy", members: [] }]), "notes"), "a built-in style").toBeNull();
  });

  it("each pose cut into its own PNG: frames side by side, only its own cells of the shared sheet", () => {
    const plan = characterPlan(OWN_SET as never)!;
    const out = cropCharacter(new Map([["chars.png", sheet(3, 2)]]), Object.values(plan.poses).map(p => p!.cut));
    const working = decodePng(out.get("working")!, { maxSide: 512 });
    expect([working.width, working.height]).toEqual([3 * W, H]);
    const greens = new Set<number>();
    for (let i = 0; i < working.data.length; i += 4) greens.add(working.data[i + 1]!);
    expect([...greens], "row 0's colour only: nothing of row 1's character").toEqual([100]);
    expect([working.data[0], working.data[(W * 2) * 4]]).toEqual([0, 80]);
    expect(() => cropCharacter(new Map([["chars.png", sheet(1, 1)]]), [plan.poses.working!.cut]), "a cell outside its picture").toThrow();
  });

  it("the protocol: offered by the Hub with the pictures, only in a 32-name welcome; a row's character is whole, within 512 KB with the rest", () => {
    const caps = hubLinkCapabilities({ agentPicturesV1: true, agentCharactersV1: true });
    expect(caps).toEqual(expect.arrayContaining([HUB_AGENT_PICTURES_CAPABILITY, HUB_AGENT_CHARACTERS_CAPABILITY]));
    expect(hubLinkCapabilities({ agentCharactersV1: true })).not.toContain(HUB_AGENT_CHARACTERS_CAPABILITY);
    expect(hubWelcomeCapabilities(caps, ["welcome-caps-v1"])).not.toContain(HUB_AGENT_CHARACTERS_CAPABILITY);
    expect(hubWelcomeCapabilities(caps, ["welcome-caps-v1", HUB_FLEET_UPDATE_CAPABILITY])).toContain(HUB_AGENT_CHARACTERS_CAPABILITY);
    const st = (size: number, h = "a") => ({ sha256: h.repeat(64), mime: "image/png", size, frames: 1, w: 8, h: 12, fps: 4, ax: 4, ay: 12, dw: 16, dh: 24 });
    const row = (character: unknown, extra = {}) => agentPicturesRowSchema.safeParse({ exposureId: randomUUID(), disc: null, portrait: null, character, ...extra }).success;
    expect(row({ working: st(10), idle: st(10), paused: st(10), stand: st(10) })).toBe(true);
    expect(row({ working: st(10), idle: st(10), paused: st(10) }), "stand missing").toBe(false);
    expect(row({ working: st(10), idle: st(10), paused: st(10), stand: st(10), needs: st(10) }), "a pose a room does not show").toBe(false);
    // One hash named by four poses counts once: 4 × 300 KB is one 300 KB picture.
    expect(row({ working: st(300 * 1024), idle: st(300 * 1024), paused: st(300 * 1024), stand: st(300 * 1024) })).toBe(true);
    expect(row({ working: st(300 * 1024), idle: st(300 * 1024, "b"), paused: st(10, "c"), stand: st(10, "c") }), "over 512 KB").toBe(false);
    expect(row({ working: st(300 * 1024), idle: st(10), paused: st(10, "c"), stand: st(10, "c") }), "one hash, two sizes").toBe(false);
    expect(row(null, { tooLarge: ["character"] })).toBe(true);
    expect(row({ working: st(10), idle: st(10), paused: st(10), stand: st(10) }, { tooLarge: ["character"] }), "sent and too large").toBe(false);
  });
});

async function world(o: { hubCharacters?: boolean } = {}) {
  r = await s3bRig({ roomOffice: true });
  const alex = r.addPerson("alex", "Alex"); r.addPerson("blake", "Blake");
  const a = await r.signIn("alex"), b = await r.signIn("blake"), admin = await r.signIn("admin");
  const fleetId = randomUUID();
  r.store.mutate({ requestId: randomUUID(), at: Date.now(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, (state: any) => {
    state.fleets.push({ id: fleetId, owner: r!.admin, generation: 1, credentialHash: null, status: "active", label: "Admin fleet" }); });
  const hubSide = r.link(fleetId, r.admin, 1, ["welcome-caps-v1", "room-ask-v1", "agent-catalog-v1", HUB_AGENT_PICTURES_CAPABILITY, ...(o.hubCharacters === false ? [] : [HUB_AGENT_CHARACTERS_CAPABILITY])]);
  const notes = randomUUID(), plan = randomUUID();
  const ex = (id: string, name: string) => ({ id, fleetId, owner: r!.admin, displayName: name, revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [ex(notes, "Notes"), ex(plan, "Planner")] }, hubSide) as never, hubSide);
  const made = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Room", people: [personKeyString(alex)], agents: [notes, plan] });
  const roomId = made.json.room.id as string;
  const frames: any[] = []; let refuseChunks = 0;
  const memberLink: any = { linkEpoch: 1, features: new Set([HUB_AGENT_PICTURES_CAPABILITY, HUB_AGENT_CHARACTERS_CAPABILITY]), current: () => true,
    exchange: async (frame: any) => { frames.push(frame);
      if (frame.type === "agent.picture" && refuseChunks > 0) { refuseChunks--; return { type: "agent.picture-result", payload: { ok: false, code: "unavailable" } }; }
      return r!.http.receive(frame, hubSide); } };
  const sources = new Map<string, MemberPictureSources>();
  const sender = new HubMemberAgentPictures({ current: () => true, reduce: reduceInProcess, crop: cropInProcess,
    exposures: () => [{ id: notes, agent: "notes" }, { id: plan, agent: "plan" }], sources: (agent) => sources.get(agent) ?? { disc: null, portrait: null } });
  const office = async (id: string) => (await r!.call(a, "GET", `/hub/v1/rooms/${roomId}/office/state`)).json.instances.find((i: any) => i.name === id);
  const member = async (id: string) => (await r!.call(a, "GET", `/hub/v1/rooms/${roomId}`)).json.members.find((m: any) => m.id === id);
  const mine = async () => (await r!.call(admin, "GET", "/hub/v1/me/agents")).json.fleets.find((f: any) => f.id === fleetId).picturesTooLarge ?? null;
  const served = async (who: { cookie: string }, id: string, pose: string) => { const res = await fetch(`${r!.base}/hub/v1/rooms/${roomId}/agents/${id}/character/${pose}`, { headers: { Cookie: who.cookie } });
    return { status: res.status, type: res.headers.get("content-type"), bytes: Buffer.from(await res.arrayBuffer()) }; };
  const character = (key: string, set: Record<string, unknown> = OWN_SET, pictures = new Map([["chars.png", sheet(3, 2) as Uint8Array]])) =>
    ({ key, load: () => { const p = characterPlan(set as never); return p ? { plan: p, pictures } : null; } });
  return { a, b, sender, memberLink, frames, sources, office, member, mine, served, character, notes, plan, hubSide, refuse: (n: number) => { refuseChunks = n; } };
}
const JPEG = (n: number, seed = 2) => { const b = Buffer.alloc(n, seed); Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b); return b; };

describe("M-3533 R2c: an agent's own character in the room office, end to end", () => {
  it("cut, sent and held whole: the room office names each pose; a member is served each strip, nobody else; the member list is unchanged", async () => {
    const w = await world();
    w.sources.set("notes", { disc: null, portrait: null, character: w.character("pack@1:sage") });
    w.sender.connected(w.memberLink); await w.sender.refresh();
    const got = (await w.office(w.notes)).character;
    expect(Object.keys(got).sort()).toEqual(["idle", "paused", "stand", "walk", "working"]);
    expect(got.working).toEqual({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), frames: 3, w: W, h: H, fps: 4, ax: W / 2, ay: H, dw: W * 2, dh: H * 2 });
    expect(got.paused.sha256, "filled from stand: one picture").toBe(got.stand.sha256);
    const strip = await w.served(w.a, w.notes, "working");
    expect([strip.status, strip.type, sha(strip.bytes)]).toEqual([200, "image/png", got.working.sha256]);
    expect(decodePng(strip.bytes, { maxSide: 512 }).width).toBe(3 * W);
    expect((await w.served(w.b, w.notes, "working")).status, "not in the room").toBe(403);
    expect((await w.served(w.a, w.notes, "needs")).status, "a pose not sent").toBe(404);
    expect((await w.served(w.a, w.plan, "idle")).status, "an agent with none").toBe(404);
    expect((await w.office(w.plan)).character).toBeUndefined();
    expect((await w.member(w.notes)).look ?? {}).not.toHaveProperty("character");
    // Only the pose strips crossed: no file name, no pack, no other set.
    const report = w.frames.find(f => f.type === "agent.pictures").payload.agents.find((x: any) => x.exposureId === w.notes);
    expect(JSON.stringify(report)).not.toMatch(/chars\.png|sage|pack@/);
    w.sender.close();
  });

  it("whole or nothing: until every strip is held the office draws none; a set that changes follows, and a set that goes is gone", async () => {
    const w = await world();
    w.sources.set("notes", { disc: null, portrait: null, character: w.character("pack@1:sage") });
    w.refuse(1); w.sender.connected(w.memberLink); await w.sender.refresh();
    expect((await w.office(w.notes)).character, "one strip missing").toBeUndefined();
    await w.sender.refresh();
    const first = (await w.office(w.notes)).character;
    expect(Object.keys(first)).toHaveLength(5);
    w.sources.set("notes", { disc: null, portrait: null, character: w.character("pack@2:sage", { ...OWN_SET, idle: strip(1) }) });
    await w.sender.refresh();
    expect((await w.office(w.notes)).character.idle.sha256).not.toBe(first.idle.sha256);
    w.sources.set("notes", { disc: null, portrait: null, character: null });
    await w.sender.refresh();
    expect((await w.office(w.notes)).character).toBeUndefined();
    expect((await w.served(w.a, w.notes, "idle")).status).toBe(404);
    w.sender.close();
  });

  it("whole or nothing on the Hub: three of four strips held show nothing; the fourth completes the set", async () => {
    const w = await world();
    const png = (n: number) => { const b = encodePng({ width: 1, height: 1, data: new Uint8Array([n, 0, 0, 255]) }); return { b, ref: { sha256: sha(b), mime: "image/png", size: b.length } }; };
    const [p1, p2, p3, p4] = [1, 2, 3, 4].map(png);
    const meta = { frames: 1, w: 1, h: 1, fps: 4, ax: 0, ay: 1, dw: 2, dh: 2 };
    const send = async (type: string, payload: unknown) => ((await r!.http.receive(r!.frame(type, payload, w.hubSide) as never, w.hubSide)) as any)?.payload;
    const reply = await send("agent.pictures", { revision: "f".repeat(64), agents: [{ exposureId: w.notes, disc: null, portrait: null,
      character: { working: { ...p1!.ref, ...meta }, idle: { ...p2!.ref, ...meta }, paused: { ...p3!.ref, ...meta }, stand: { ...p4!.ref, ...meta } } }] });
    expect(reply.need.sort()).toEqual([p1, p2, p3, p4].map(p => p!.ref.sha256).sort());
    const chunk = (p: { b: Buffer; ref: { sha256: string; mime: string; size: number } }) => ({ ...p.ref, index: 0, count: 1, data: p.b.toString("base64") });
    for (const p of [p1, p2, p3]) expect(await send("agent.picture", chunk(p!))).toEqual({ ok: true, stored: true });
    expect((await w.office(w.notes)).character, "three of four").toBeUndefined();
    expect((await w.served(w.a, w.notes, "working")).status, "nor any strip of it").toBe(404);
    await send("agent.picture", chunk(p4!));
    expect(Object.keys((await w.office(w.notes)).character).sort()).toEqual(["idle", "paused", "stand", "working"]);
  });

  it("dropped first, whole: what the avatar and portrait leave is too little — no set, and its owner is told", async () => {
    const w = await world();
    w.sources.set("notes", { disc: null, portrait: { key: "card:1", load: () => ({ bytes: JPEG(HUB_PICTURE_AGENT_MAX - 100) }) }, character: w.character("pack@1:sage") });
    w.sender.connected(w.memberLink); await w.sender.refresh();
    expect((await w.office(w.notes)).character).toBeUndefined();
    expect((await w.office(w.notes)).picture?.portrait).toEqual(expect.any(String));
    expect(await w.mine()).toEqual({ [w.notes]: ["character"] });
    w.sender.close();
  });

  it("a pack picture that is not a PNG, or that does not cut: no set and no note — never an uncut sheet", async () => {
    const w = await world();
    w.sources.set("notes", { disc: null, portrait: null, character: w.character("pack@1:sage", OWN_SET, new Map([["chars.png", JPEG(4000) as Uint8Array]])) });
    w.sources.set("plan", { disc: null, portrait: null, character: w.character("pack@1:sage", OWN_SET, new Map([["chars.png", sheet(1, 1) as Uint8Array]])) });
    w.sender.connected(w.memberLink); await w.sender.refresh();
    expect([(await w.office(w.notes)).character, (await w.office(w.plan)).character, await w.mine()]).toEqual([undefined, undefined, null]);
    expect(w.frames.filter(f => f.type === "agent.picture")).toEqual([]);
    w.sender.close();
  });

  it("a Hub that does not offer characters is sent none (its row has no such field); one that did not offer refuses a report naming one", async () => {
    const w = await world({ hubCharacters: false });
    w.sources.set("notes", { disc: null, portrait: null, character: w.character("pack@1:sage") });
    w.sender.connected({ ...w.memberLink, features: new Set([HUB_AGENT_PICTURES_CAPABILITY]) }); await w.sender.refresh();
    const sent = w.frames.find(f => f.type === "agent.pictures").payload.agents;
    expect(sent.every((x: any) => !("character" in x) && !x.tooLarge)).toBe(true);
    w.sender.close();
    // A member claiming it anyway: incompatible.
    const st = { sha256: "a".repeat(64), mime: "image/png", size: 10, frames: 1, w: 8, h: 12, fps: 4, ax: 4, ay: 12, dw: 16, dh: 24 };
    await expect(r!.http.receive(r!.frame("agent.pictures", { revision: "c".repeat(64), agents: [{ exposureId: w.notes, disc: null, portrait: null,
      character: { working: st, idle: st, paused: st, stand: st } }] }, w.hubSide) as never, w.hubSide)).rejects.toThrow("incompatible");
  });
});

describe("M-3533 R2c (Prism #4421): a report fits one frame", () => {
  // 96 agents, each a nine-pose set of 32 frames with a duration each: their rows alone are over the link's 256 KiB.
  const POSES9 = ["idle", "working", "paused", "stand", "walk", "walkDown", "walkUp", "walkSide", "walkLeft"];
  const full = Object.fromEntries(POSES9.map((pose, row) => [pose, { src: "s.png", frames: 32, w: 1, h: 1, fps: 4, durations: Array.from({ length: 32 }, (_, i) => 59_000 + i), ax: 0, ay: 1, dw: 2, dh: 2, row, col: 0 }]));
  const sheetOf = (seed: number) => encodePng({ width: 32, height: 9, data: new Uint8Array(32 * 9 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7 + seed) & 255)) });
  async function run(n: number) {
    const { HUB_LIMITS } = await import("../src/hub/protocol.js");
    const frames: any[] = [];
    const link: any = { linkEpoch: 1, features: new Set([HUB_AGENT_PICTURES_CAPABILITY, HUB_AGENT_CHARACTERS_CAPABILITY]), current: () => true,
      exchange: async (frame: any) => { frames.push(frame); return frame.type === "agent.pictures" ? { type: "agent.pictures-result", payload: { ok: true, need: [] } } : { type: "agent.picture-result", payload: { ok: true, stored: true } }; } };
    const ids = Array.from({ length: n }, () => randomUUID());
    const disc = encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(200) });
    const sender = new HubMemberAgentPictures({ current: () => true, reduce: reduceInProcess, crop: cropInProcess,
      exposures: () => ids.map((id, i) => ({ id, agent: `a${i}` })),
      sources: (agent) => { const seed = Number(agent.slice(1)); return { disc: { key: `d${seed}`, load: () => ({ bytes: disc }) }, portrait: null,
        character: { key: `c${seed}`, load: () => ({ plan: characterPlan(full as never)!, pictures: new Map([["s.png", sheetOf(seed) as Uint8Array]]) }) } }; } });
    sender.connected(link); await sender.refresh(); sender.close();
    const report = frames.find(f => f.type === "agent.pictures");
    return { report, bytes: Buffer.byteLength(JSON.stringify(report)), limit: HUB_LIMITS.frame, ids };
  }
  it("96 nine-pose 32-frame sets: the report still fits; every row keeps its avatar; whole sets are left out from the end, never part of one", async () => {
    const { report, bytes, limit, ids } = await run(96);
    expect(bytes).toBeLessThanOrEqual(limit);
    const rows = report.payload.agents;
    expect(rows).toHaveLength(96);
    expect(rows.every((r: any) => r.disc)).toBe(true);
    const sent = rows.filter((r: any) => r.character);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(96);
    expect(sent.every((r: any) => Object.keys(r.character).length === 9), "a set is whole").toBe(true);
    // Left out from the last row back: the sent ones are a prefix of the report's order (by exposure id).
    const order = rows.map((r: any) => r.exposureId);
    expect(order).toEqual([...ids].sort());
    expect(rows.slice(0, sent.length).every((r: any) => r.character)).toBe(true);
    expect(rows.every((r: any) => !r.tooLarge), "not \"too large\": its own cap is not why").toBe(true);
    expect(agentPicturesRowSchema.safeParse(rows[0]).success).toBe(true);
  });
  it("a report that fits is sent whole (the control)", async () => {
    const { report, bytes, limit } = await run(4);
    expect(bytes).toBeLessThan(limit);
    expect(report.payload.agents.every((r: any) => r.disc && Object.keys(r.character).length === 9)).toBe(true);
  });
});

describe("M-3533 R2c: the page draws it", () => {
  it("characterSet: each pose fitted into the built-in figure's box (48 × 66), in proportion; never larger; a malformed strip: none", async () => {
    const { characterSet, CHARACTER_FIT } = await import("/ui/js/hub-room-office.js");
    const st = (dw: number, dh: number) => ({ sha256: "a".repeat(64), frames: 2, w: 32, h: 48, fps: 4, ax: 16, ay: 48, dw, dh });
    const src = (pose: string, h: string) => `/x/${pose}?v=${h}`;
    expect(CHARACTER_FIT).toEqual({ w: 48, h: 66 });
    const big = characterSet({ idle: st(128, 192) }, src)!.idle;
    expect([big.dw, big.dh, big.src]).toEqual([44, 66, `/x/idle?v=${"a".repeat(64)}`]);
    const wide = characterSet({ idle: st(176, 48) }, src)!.idle;
    expect([wide.dw, Math.round(wide.dh * 100) / 100]).toEqual([48, 13.09]);
    const small = characterSet({ idle: st(32, 48) }, src)!.idle;
    expect([small.dw, small.dh]).toEqual([32, 48]);
    expect(characterSet({ idle: { ...st(32, 48), frames: "2" } }, src)).toBeNull();
    expect(characterSet(null, src)).toBeNull();
  });

  it("Lumen R2c (b): fitted to 48 × 66 a head may reach an area's name in Studio (large)'s top rows, never its top edge (Studio and Studio (large))", async () => {
    const { CHARACTER_FIT } = await import("/ui/js/hub-room-office.js");
    const { STUDIO_PACK, STUDIO_LARGE_PACK } = await import("/ui/js/fleet-office-skin.js");
    const room = (pack: any) => Object.values(pack.areas).flatMap((a: any) => a.seats.map((st: any) => st.y - CHARACTER_FIT.h - a.rect.y));
    expect(Math.min(...room(STUDIO_PACK), ...room(STUDIO_LARGE_PACK)), "head top below the area's top edge").toBeGreaterThanOrEqual(0);
    // …while in Studio (large)'s top rows it reaches the name's box (areaTitleBox: 10 to 28 below the top), which the
    // scene then writes again over it (M-3539: by the person's box, the strip's for an own character).
    expect(Object.values(STUDIO_LARGE_PACK.areas).some((a: any) => a.seats.some((st: any) => st.y - CHARACTER_FIT.h < a.rect.y + 28))).toBe(true);
  });

  it("withCharacters: only people with a set are drawn from it; an agent named \"default\" is nobody's fallback; the rest is the style's", async () => {
    const { withCharacters } = await import("/ui/js/fleet-office-skin.js");
    const base: any = { id: "studio", drawCharacter: vi.fn(), charBox: vi.fn(() => ({ x: 0, y: 0, w: 1, h: 1 })), drawRoom: () => "the style's" };
    const im = { width: 16, height: 12 };
    const set = { idle: { src: "s", frames: 2, w: 8, h: 12, fps: 4, ax: 4, ay: 12, dw: 16, dh: 24 }, stand: { src: "s", frames: 1, w: 8, h: 12, fps: 4, ax: 4, ay: 12, dw: 16, dh: 24 } };
    const sk = withCharacters(base, { default: set }, new Map([["s", im]]));
    expect(sk.drawRoom).toBe(base.drawRoom);
    const ctx: any = { save() {}, restore() {}, translate() {}, scale() {}, drawImage: vi.fn(), imageSmoothingEnabled: true, globalAlpha: 1 };
    const d = { x: 0, y: 0, w: 88, h: 53, seat: { x: 44, y: 53 } };
    sk.drawCharacter(ctx, d, { name: "default", pose: "idle" }, 0, {});
    expect([ctx.drawImage.mock.calls.length, base.drawCharacter.mock.calls.length]).toEqual([1, 0]);
    sk.drawCharacter(ctx, d, { name: "someone", pose: "idle" }, 0, {});
    expect([ctx.drawImage.mock.calls.length, base.drawCharacter.mock.calls.length]).toEqual([1, 1]);
    expect(withCharacters(base, {}, new Map())).toBe(base);
  });
});
