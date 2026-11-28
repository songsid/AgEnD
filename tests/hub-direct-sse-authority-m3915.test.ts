import { afterEach, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { HubRoomsService } from "../src/hub/rooms.js";
import { HubProtocolError } from "../src/hub/validation.js";
import { advanceHubSessionEpoch } from "../src/hub/session-epoch.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await r?.close(); r = undefined; });
async function world() {
  r = await s3bRig(); const owner = r.addPerson("owner", "Owner"), asker = r.addPerson("asker", "Asker");
  const fleetId = randomUUID(), exposureId = randomUUID(), link = r.link(fleetId, owner);
  await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId, owner, displayName: "Synthetic", revision: 1, state: "published", dataViewId: "v", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
  const o = await r.signIn("owner"), a = await r.signIn("asker");
  const granted = await r.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "asker", days: 7 });
  const opened = await r.call(a, "POST", "/hub/v1/rooms", { exposureId, grantId: granted.json.grant.id }); expect(opened.status).toBe(200);
  const text = "protected direct event", asked = await r.call(a, "POST", `/hub/v1/rooms/${opened.json.room.id}/messages`, { text, idempotencyKey: randomUUID() }); expect(asked.status).toBe(200);
  const receipt = () => r!.http.receive(r!.frame("receipt", { messageId: asked.json.id, contentDigest: createHash("sha256").update(text).digest("hex"), stage: "delivered", sequence: 1, at: Date.now() }, link) as never, link);
  return { o, a, asker, grantId: granted.json.grant.id, roomId: opened.json.room.id, messageId: asked.json.id, receipt, text };
}
async function openedStream(cookie: string) {
  const stop = new AbortController(), deadline = setTimeout(() => stop.abort(), 3000);
  const response = await fetch(`${r!.base}/hub/v1/rooms/events`, { headers: { Cookie: cookie }, signal: stop.signal }); expect(response.status).toBe(200);
  const reader = response.body!.getReader(), first = await reader.read(); expect(first.done).toBe(false);
  return { reader, cleanup() { clearTimeout(deadline); stop.abort(); } };
}
it.each(["grant-revoked", "grant-expired", "room-held", "grant-inactive", "asker-disabled", "owner-disabled", "session-epoch"] as const)("a message event after %s emits no protected data and closes naturally", async change => {
  const w = await world(), stream = await openedStream(w.a.cookie);
  try {
    switch (change) {
      case "grant-revoked": expect((await r!.call(w.o, "DELETE", `/hub/v1/grants/${w.grantId}?revision=1`)).status).toBe(200); break;
      case "grant-expired": r!.db.prepare("UPDATE hub_grants SET expires_at=0 WHERE id=?").run(w.grantId); break;
      case "room-held": r!.db.prepare("UPDATE hub_rooms SET state='held' WHERE id=?").run(w.roomId); break;
      case "grant-inactive": r!.db.prepare("UPDATE hub_grants SET state='revoked' WHERE id=?").run(w.grantId); break;
      case "asker-disabled": r!.setEligible("asker", false); break;
      case "owner-disabled": r!.setEligible("owner", false); break;
      case "session-epoch": break; // Advance while the queued message projection awaits eligibility below.
    }
    // Durable peer receipt evidence must not revive a viewer's authority. It generates the actual message branch.
    if (change === "session-epoch") {
      let entered!: () => void, release!: () => void;
      const inside = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
      const eligibility = r!.directory.checkEligibility.bind(r!.directory); let once = false;
      r!.directory.checkEligibility = async key => { if (key.objectId === w.asker.objectId && !once) { once = true; entered(); await blocked; } return eligibility(key); };
      const receipt = w.receipt();
      try { await inside; r!.db.transaction(() => advanceHubSessionEpoch(r!.db, 0)).immediate(); }
      finally { release(); }
      await receipt;
    } else await w.receipt();
    let output = "", ended = false;
    while (true) { const chunk = await stream.reader.read(); if (chunk.done) { ended = true; break; } output += new TextDecoder().decode(chunk.value); }
    expect(ended).toBe(true); expect(output).not.toContain(w.text); expect(output).not.toMatch(/event: message\.(?:added|updated)/);
  } finally { stream.cleanup(); }
});
it.each([false, true])("the exact-message reader stays inside the existing bounded backpressure retry: %s", async persistent => {
  const w = await world(), stream = await openedStream(w.a.cookie);
  const original = HubRoomsService.prototype.readPage; let calls = 0;
  vi.spyOn(HubRoomsService.prototype, "readPage").mockImplementation(async function (this: HubRoomsService, ...args: Parameters<typeof original>) {
    if (args[4]?.messageId === w.messageId) { calls++; if (persistent || calls === 1) throw new HubProtocolError("backpressure"); }
    return original.apply(this, args);
  });
  try {
    await w.receipt(); let output = "", ended = false;
    while (!output.includes(w.text)) { const chunk = await stream.reader.read(); if (chunk.done) { ended = true; break; } output += new TextDecoder().decode(chunk.value); }
    if (persistent) { expect(ended).toBe(true); expect(calls).toBe(4); expect(output).not.toContain(w.text); }
    else { expect(ended).toBe(false); expect(calls).toBe(2); expect(output).toContain("event: message.updated"); }
  } finally { stream.cleanup(); }
});
it("keeps one canonical room proof for a message and a separate fresh view for unread", async () => {
  const w = await world(), stream = await openedStream(w.a.cookie);
  const original = HubRoomsService.prototype.view; let views = 0;
  vi.spyOn(HubRoomsService.prototype, "view").mockImplementation(function (this: HubRoomsService, ...args: Parameters<typeof original>) { views++; return original.apply(this, args); });
  try {
    await w.receipt(); let output = "";
    while (!output.includes("event: unread.changed")) { const chunk = await stream.reader.read(); expect(chunk.done).toBe(false); output += new TextDecoder().decode(chunk.value); }
    expect(output).toContain("event: message.updated"); expect(output).toContain(w.text);
    expect(views).toBe(2); // readCurrent's own view, then the unread branch; no unused pre-read proof.
  } finally { stream.cleanup(); }
});
