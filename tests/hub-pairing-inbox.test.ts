/** Real SQLite/local audit; inert negotiated links. No live member or native operations. */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubPairingNoticeInbox, HUB_PAIRING_INBOX_MIGRATION } from "../src/hub/member/pairing-notices.js";
import type { HubMemberLink } from "../src/hub/client.js";
import type { HubPairingNotice } from "../src/hub/types.js";

const dbs: Database.Database[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); });
function setup() {
  const db = new Database(":memory:"); dbs.push(db); HUB_PAIRING_INBOX_MIGRATION.up(db);
  let current = true;
  const audit = vi.fn(() => { if (!db.inTransaction) throw Error("audit outside transaction"); });
  const changed = vi.fn(() => { if (db.inTransaction) throw Error("notify before commit"); });
  const send = vi.fn(async () => { expect(db.inTransaction).toBe(false); expect(db.prepare("SELECT * FROM hub_pairing_notice_inbox").all()).toHaveLength(1); });
  const link: HubMemberLink = { current: () => current, features: new Set(["welcome-caps-v1", "pairing-notices-v1"]), linkEpoch: 1, revocationVersion: 1,
    profile: {} as HubMemberLink["profile"], exchange: async () => { throw Error("exchange not used"); }, send };
  const inbox = createHubPairingNoticeInbox({ db, current: () => current, now: () => 100, audit: { appendInTransaction: audit }, changed });
  const notice: HubPairingNotice = { id: randomUUID(), fleetId: randomUUID(), generation: 1, label: "<script>text</script>", at: 100, source: "group", revoked: false };
  return { db, audit, changed, send, link, inbox, notice, fence: () => { current = false; } };
}
describe("member security notice retention before acknowledgement", () => {
  it("keeps every retained notice reachable after ACK, including older history beyond one hundred", async () => {
    const w=setup();w.send.mockImplementation(async()=>{});
    for(let i=0;i<101;i++) await w.inbox.receive({...w.notice,id:randomUUID(),label:`History ${i}`},w.link);
    expect(w.send).toHaveBeenCalledTimes(101);expect(w.inbox.list()).toHaveLength(101);
    expect(w.inbox.list().at(-1)?.label).toBe("History 0");
  });
  it("retains once before ACK, safely replays a lost ACK and persists across reader reconstruction", async () => {
    const w = setup(); await w.inbox.receive(w.notice, w.link); await w.inbox.receive(w.notice, w.link);
    expect(w.send).toHaveBeenCalledTimes(2); expect(w.audit).toHaveBeenCalledOnce(); expect(w.changed).toHaveBeenCalledTimes(2);
    const reopened = createHubPairingNoticeInbox({ db: w.db, current: () => true, now: () => 100, audit: { appendInTransaction: w.audit } });
    expect(reopened.list()).toEqual([w.notice]);
    expect(w.send.mock.calls[0]).toEqual([{ v: 1, type: "pairing.notice-ack", requestId: w.notice.id, linkEpoch: 1, payload: { id: w.notice.id } }]);
  });
  it("only permits monotonic revocation in a replay, never a different fleet, label or restored authority", async () => {
    const w = setup(); await w.inbox.receive(w.notice, w.link);
    await w.inbox.receive({ ...w.notice, revoked: true }, w.link);
    expect(w.inbox.list()).toEqual([{ ...w.notice, revoked: true }]); expect(w.audit).toHaveBeenCalledTimes(2);
    for (const changed of [{ ...w.notice }, { ...w.notice, revoked: true, label: "different" }, { ...w.notice, revoked: true, fleetId: randomUUID() }]) {
      await expect(w.inbox.receive(changed, w.link)).rejects.toThrow("conflict");
    }
    expect(w.send).toHaveBeenCalledTimes(2);
  });
  it("requires both negotiated capabilities and a live link before retaining or ACKing", async () => {
    const w = setup();
    for (const features of [new Set<string>(), new Set(["pairing-notices-v1"]), new Set(["welcome-caps-v1"])]) {
      await expect(w.inbox.receive(w.notice, { ...w.link, features })).rejects.toThrow("incompatible");
    }
    w.fence(); await expect(w.inbox.receive(w.notice, w.link)).rejects.toThrow();
    expect(w.send).not.toHaveBeenCalled(); expect(w.audit).not.toHaveBeenCalled();
  });
  it("rolls retention back and sends no ACK if required audit or the final binding fence fails", async () => {
    const a = setup(); a.audit.mockImplementationOnce(() => { throw Error("audit unavailable"); });
    await expect(a.inbox.receive(a.notice, a.link)).rejects.toThrow("audit unavailable"); expect(a.inbox.list()).toEqual([]); expect(a.send).not.toHaveBeenCalled();
    const b = setup(); b.audit.mockImplementationOnce(b.fence);
    await expect(b.inbox.receive(b.notice, b.link)).rejects.toThrow();
    expect(b.db.prepare("SELECT * FROM hub_pairing_notice_inbox").all()).toEqual([]); expect(b.send).not.toHaveBeenCalled();
  });
});
