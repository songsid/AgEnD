/** #3226 D at the room level (createHubHttp + member receiver): a link that loses attachments-v1, and room scoping. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import type { HubExposure, PersonKey } from "../src/hub/types.js";

type Rig = Awaited<ReturnType<typeof s3bRig>>;
let rig: Rig | null = null;
afterEach(async () => { await rig?.close(); rig = null; });
const exposure = (fleetId: string, owner: PersonKey, name: string): HubExposure => ({ id: randomUUID(), fleetId, owner, displayName: name, revision: 1, state: "published",
  dataViewId: "v", allowedTools: [], policyDigest: "b".repeat(64) });
async function world(r: Rig, names = ["Sales"]) {
  const owner = r.addPerson("olivia", "Olivia"); r.addPerson("alex", "Alex");
  const fleetId = randomUUID(), link = r.link(fleetId, owner, 1, ["attachments-v1"]), es = names.map(n => exposure(fleetId, owner, n));
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: es }, link) as never, link);
  const o = await r.signIn("olivia"), a = await r.signIn("alex"), rooms: string[] = [], grants: string[] = [];
  for (const e of es) {
    const g = await r.call(o, "POST", "/hub/v1/grants", { exposureId: e.id, exposureRevision: 1, login: "alex", days: 7 });
    grants.push(g.json.grant.id);
    rooms.push((await r.call(a, "POST", "/hub/v1/rooms", { exposureId: e.id, grantId: g.json.grant.id })).json.room.id);
  }
  const upload = async (roomId: string, name: string, body: string) => {
    const res = await fetch(`${r.base}/hub/v1/rooms/${roomId}/files`, { method: "POST", body, headers: { Origin: "https://hub.example.test", Cookie: a.cookie, "X-AgEnD-Hub-CSRF": a.csrf, "X-File-Name": name } });
    return { status: res.status, json: await res.json() as any };
  };
  return { owner, fleetId, link, es, o, a, rooms, grants, upload };
}

it("a link that loses attachments-v1: a new question with files is refused, and a queued one fails visibly instead of being sent without them", async () => {
  rig = await s3bRig({ attachments: true }); const w = await world(rig);
  rig.setTransport(false);
  const one = await w.upload(w.rooms[0]!, "one.txt", "first"), two = await w.upload(w.rooms[0]!, "two.txt", "second");
  expect([one.status, two.status]).toEqual([200, 200]);
  const asked = await rig.call(w.a, "POST", `/hub/v1/rooms/${w.rooms[0]}/messages`, { idempotencyKey: randomUUID(), text: "with a file", files: [one.json.file.id] });
  expect(asked.status).toBe(200);
  // The member reconnects as an older build: its new link has no optional features.
  w.link.alive = false;
  const older = rig.link(w.fleetId, w.owner, 2);
  await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: w.es }, older) as never, older);
  expect((await rig.call(w.a, "GET", "/hub/v1/rooms")).json.rooms[0].features).toEqual([]);
  const refused = await rig.call(w.a, "POST", `/hub/v1/rooms/${w.rooms[0]}/messages`, { idempotencyKey: randomUUID(), text: "another", files: [two.json.file.id] });
  expect(refused.status).toBe(400); expect(refused.json.code).toBe("incompatible");
  rig.setTransport(true);
  await rig.http.receive(rig.frame("reconcile", { afterReceiptSequence: 0, messages: [] }, older) as never, older);
  await vi.waitFor(() => expect(rig!.db.prepare("SELECT stage, reason_code FROM hub_messages").get()).toEqual({ stage: "failed", reason_code: "incompatible" }));
  expect(rig.sent.filter(s => s.frame.type === "question")).toHaveLength(0);
  expect(rig.audits.some(x => x.action === "question.failed" && x.reasonCode === "incompatible")).toBe(true);
});

it("a file belongs to its room: another room of the same asker cannot serve or attach it", async () => {
  rig = await s3bRig({ attachments: true }); const w = await world(rig, ["Sales", "Support"]);
  const f = await w.upload(w.rooms[0]!, "a.txt", "room one");
  expect((await rig.call(w.a, "GET", f.json.file.url)).status).toBe(200);
  expect((await rig.call(w.a, "GET", `/hub/v1/rooms/${w.rooms[1]}/files/${f.json.file.id}`)).status).toBe(404);
  expect((await rig.call(w.a, "POST", `/hub/v1/rooms/${w.rooms[1]}/messages`, { idempotencyKey: randomUUID(), text: "x", files: [f.json.file.id] })).status).toBe(404);
});

// ── Prism R1 on #3247 ────────────────────────────────────────────────────────────────────────────────────────────────

/** A question with one file, sent to the fleet; returns how to pull its first chunk. */
async function sentWithFile(r: Rig) {
  const w = await world(r);
  const f = await w.upload(w.rooms[0]!, "secret.txt", "private question file");
  const asked = await r.call(w.a, "POST", `/hub/v1/rooms/${w.rooms[0]}/messages`, { idempotencyKey: randomUUID(), text: "see file", files: [f.json.file.id] });
  expect(asked.status).toBe(200);
  await r.http.receive(r.frame("reconcile", { afterReceiptSequence: 0, messages: [] }, w.link) as never, w.link);
  await vi.waitFor(() => expect(r.sent.some(s => s.frame.type === "question")).toBe(true));
  const get = () => r.http.receive(r.frame("attachment.get", { id: f.json.file.id, offset: 0 }, w.link) as never, w.link) as Promise<any>;
  return { ...w, fileId: f.json.file.id, get };
}
it("P1: every chunk is a fresh disclosure — a permitted pull works; after a grant revoke, an exposure withdrawal or a disabled person it is refused", async () => {
  for (const change of ["none", "revoke", "withdraw", "disable-asker", "disable-owner"] as const) {
    rig = await s3bRig({ attachments: true }); const w = await sentWithFile(rig);
    if (change === "revoke") expect((await rig.call(w.o, "DELETE", `/hub/v1/grants/${w.grants[0]}?revision=1`)).status).toBe(200);   // the real catalog path
    if (change === "withdraw") await rig.http.receive(rig.frame("exposure.snapshot", { revision: 2, exposures: [] }, w.link) as never, w.link);
    if (change === "disable-asker") rig.setEligible("alex", false);
    if (change === "disable-owner") rig.setEligible("olivia", false);
    if (change === "none") expect(Buffer.from((await w.get()).payload.data, "base64").toString()).toBe("private question file");
    else await expect(w.get(), change).rejects.toThrow();
    await rig.close(); rig = null;
  }
});
it("P1: a revocation that lands while the eligibility check is held stops that very chunk", async () => {
  rig = await s3bRig({ attachments: true }); const w = await sentWithFile(rig);
  const real = rig.directory.checkEligibility.bind(rig.directory);
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  rig.directory.checkEligibility = async (key) => { await held; return real(key); };
  const pending = w.get();
  await new Promise(r => setTimeout(r, 20));
  await rig.http.receive(rig.frame("exposure.snapshot", { revision: 2, exposures: [] }, w.link) as never, w.link);
  release();
  await expect(pending).rejects.toThrow();
});

/** Upload with a body that never ends (a held connection). Resolves with the status, or "pending" if none came in time. */
async function heldUpload(r: Rig, b: { cookie: string; csrf: string }, roomId: string, length = 1_000_000) {
  const { request } = await import("node:http");
  const url = new URL(`${r.base}/hub/v1/rooms/${roomId}/files`);
  return new Promise<number | "pending">((resolve) => {
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { Origin: "https://hub.example.test", Cookie: b.cookie,
      "X-AgEnD-Hub-CSRF": b.csrf, "X-File-Name": "big.txt", "Content-Length": String(length) } }, (res) => { resolve(res.statusCode ?? 0); res.resume(); });
    req.on("error", () => resolve(0));
    req.write(Buffer.alloc(1024, 97));                                   // a first piece, then nothing more
    setTimeout(() => { resolve("pending"); req.destroy(); }, 1500);
  });
}
it("P2: an upload is refused before its body is read — unknown room, no feature, missing length — and held bodies are capped per session", async () => {
  rig = await s3bRig({ attachments: true }); const w = await world(rig);
  expect(await heldUpload(rig, w.a, randomUUID())).toBe(404);              // answered while the body is still open
  const plain = await fetch(`${rig.base}/hub/v1/rooms/${w.rooms[0]}/files`, { method: "POST", headers: { Origin: "https://hub.example.test", Cookie: w.a.cookie, "X-AgEnD-Hub-CSRF": w.a.csrf, "X-File-Name": "a.txt" },
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("abc")); c.close(); } }), duplex: "half" } as RequestInit);
  expect(plain.status).toBe(411);
  // Two bodies held open for this session, a third is refused at once (429), and capacity returns when they end.
  const a = heldUpload(rig, w.a, w.rooms[0]!), b = heldUpload(rig, w.a, w.rooms[0]!);
  await new Promise(r => setTimeout(r, 200));
  expect(await heldUpload(rig, w.a, w.rooms[0]!)).toBe(429);
  expect([await a, await b]).toEqual(["pending", "pending"]);
  await new Promise(r => setTimeout(r, 200));
  expect((await w.upload(w.rooms[0]!, "ok.txt", "fine")).status).toBe(200);
  // A link without the feature: refused before reading.
  w.link.alive = false; const older = rig.link(w.fleetId, w.owner, 2);
  await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: w.es }, older) as never, older);
  expect(await heldUpload(rig, w.a, w.rooms[0]!)).toBe(400);
});
