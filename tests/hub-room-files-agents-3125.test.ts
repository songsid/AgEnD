/**
 * M-3125 PR2, the Hub side (room files: room-answer-buttons-v1 + attachments-v1), on the actual Hub HTTP/SQLite/audit with inert Fleet links:
 * - a person's @agent post with files sends a room.ask that names them, to a link that negotiated room files only;
 * - that fleet (and only a fleet holding the delivery) pulls the file's chunks;
 * - the agent's answer names files it staged; they bind to the answer post and members read them;
 * - an answer with files from an older link is refused; a member whose floor hides the question cannot read the answer's files
 *   (the listing's lineage rule: Ridge, M-3118).
 */
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { personKeyString } from "../src/hub/identity.js";
import type { HubExposure, HubRoomAsk } from "../src/hub/types.js";

let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const BASE = ["welcome-caps-v1", "room-ask-v1", "room-post-v1", "attachments-v1"];

async function world(caps = [...BASE, "room-answer-buttons-v1"]) {
  r = await s3bRig({ realAudit: true, attachments: true });
  const alexKey = r.addPerson("alex", "Alex"), beaKey = r.addPerson("bea", "Bea");
  const alex = await r.signIn("alex"), bea = await r.signIn("bea"), admin = await r.signIn("admin");
  const fleetId = randomUUID(), link = r.link(fleetId, r.admin, 1, caps);
  const notes: HubExposure = { id: randomUUID(), fleetId, owner: r.admin, displayName: "Notes", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) };
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [notes] }, link) as never, link);
  const room = await r.call(admin, "POST", "/hub/v1/rooms", { name: "Weekly", people: [personKeyString(alexKey)] }); const id = room.json.room.id as string;
  expect((await r.call(admin, "POST", `/hub/v1/rooms/${id}/members`, { kind: "agent", id: notes.id })).status).toBe(200);
  const upload = async (name: string, body: string) => {
    const res = await fetch(`${r!.base}/hub/v1/rooms/${id}/files`, { method: "POST", body, headers: { Origin: "https://hub.example.test", Cookie: alex.cookie, "X-AgEnD-Hub-CSRF": alex.csrf, "X-File-Name": name } });
    return (await res.json() as any).file;
  };
  const asks = () => r!.sent.filter(s => s.frame.type === "room.ask").map(s => s.frame.payload as HubRoomAsk);
  const ask = async (files: string[] = []) => {
    const out = await r!.call(alex, "POST", `/hub/v1/rooms/${id}/messages`, { text: "@Notes look", mentions: [notes.id], files, idempotencyKey: randomUUID() });
    expect(out.status).toBe(200); await vi.waitFor(() => expect(asks().length).toBeGreaterThan(0)); return asks().at(-1)!;
  };
  const stage = async (bytes: Buffer) => {
    const fid = randomUUID(), sha256 = createHash("sha256").update(bytes).digest("hex");
    await r!.http.receive(r!.frame("attachment.put", { id: fid, offset: 0, total: bytes.length, sha256, data: bytes.toString("base64") }, link) as never, link);
    return { id: fid, size: bytes.length, sha256 };
  };
  const answer = (a: HubRoomAsk, text: string, attachments?: unknown[], via = link) => r!.http.receive(r!.frame("room.answer", {
    messageId: a.messageId, roomId: id, exposureId: a.exposureId, answerId: randomUUID(), text, ...(attachments ? { attachments } : {}) }, via) as never, via);
  const page = async (who = alex) => (await r!.call(who, "GET", `/hub/v1/rooms/${id}/messages`)).json.messages as any[];
  return { r: r!, id, alex, bea, beaKey, admin, link, fleetId, notes, upload, ask, stage, answer, page };
}

it("an @agent post's files travel on its room.ask, and only the asked fleet pulls them", async () => {
  const w = await world(), f = await w.upload("plan.txt", "the plan");
  const sent = await w.ask([f.id]);
  expect(sent.attachments).toEqual([{ id: f.id, name: "plan.txt", size: 8, mime: "text/plain", sha256: createHash("sha256").update("the plan").digest("hex") }]);
  const chunk = await w.r.http.receive(w.r.frame("attachment.get", { id: f.id, offset: 0 }, w.link) as never, w.link) as any;
  expect(Buffer.from(chunk.payload.data, "base64").toString()).toBe("the plan");
  const other = w.r.link(randomUUID(), w.r.admin, 1, [...BASE, "room-answer-buttons-v1"]);
  await expect(w.r.http.receive(w.r.frame("attachment.get", { id: f.id, offset: 0 }, other) as never, other)).rejects.toThrow();
});

it("an older link (no room-answer-buttons-v1) gets the words only", async () => {
  const w = await world(BASE), f = await w.upload("plan.txt", "the plan");
  const sent = await w.ask([f.id]);
  expect(sent).not.toHaveProperty("attachments");
});

it("an answer's staged files bind to the answer post, which members see and read", async () => {
  const w = await world(), a = await w.ask();
  const staged = await w.stage(Buffer.from("x,y\n1,2\n"));
  await w.answer(a, "here is the table", [{ ...staged, name: "table.csv", mime: "text/csv" }]);
  const reply = (await w.page()).find(m => m.answerTo && m.text === "here is the table");
  expect(reply.files).toEqual([{ id: staged.id, name: "table.csv", size: staged.size, mime: "text/csv", url: `/hub/v1/rooms/${w.id}/files/${staged.id}` }]);
  expect((await w.r.call(w.alex, "GET", reply.files[0].url)).status).toBe(200);
});

it("an answer naming files from a link without room files (no room-answer-buttons-v1) is refused", async () => {
  const w = await world(BASE), a = await w.ask(), staged = await w.stage(Buffer.from("data"));
  await expect(w.answer(a, "files", [{ ...staged, name: "a.txt", mime: "text/plain" }])).rejects.toMatchObject({ code: "incompatible" });
});

it("a member whose floor hides the question cannot read the answer's files (lineage audience)", async () => {
  const w = await world(), a = await w.ask();
  expect((await w.r.call(w.admin, "POST", `/hub/v1/rooms/${w.id}/members`, { kind: "person", id: personKeyString(w.beaKey) })).status).toBe(200);
  const staged = await w.stage(Buffer.from("late"));
  await w.answer(a, "answer", [{ ...staged, name: "late.txt", mime: "text/plain" }]);
  const url = `/hub/v1/rooms/${w.id}/files/${staged.id}`;
  expect((await w.r.call(w.alex, "GET", url)).status).toBe(200);
  expect((await w.r.call(w.bea, "GET", url)).status).toBe(404);
});
