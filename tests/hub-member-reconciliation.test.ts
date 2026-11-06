/** Public journal metadata and reconnect semantics; no provider, directory or account. */
import Database from "better-sqlite3";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { HubMemberJournal, migrateHubMemberJournal } from "../src/hub/member-journal.js";
import { issuerKeyId, operationDigest, sha256, signAsker } from "../src/hub/identity.js";
import type { HubAuthorizationRequest, HubQuestion } from "../src/hub/types.js";
const databases: Database.Database[] = []; afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new Database(":memory:"); databases.push(db); migrateHubMemberJournal(db);
  db.exec("CREATE TABLE restricted_sources(source TEXT PRIMARY KEY, id TEXT)");
  let floor = 0; const now = 1_800_000_000_000, hubId = randomUUID(), keys = generateKeyPairSync("ed25519"), owner = { realm: "directory", objectId: randomUUID() };
  const options = { hubId, encryptionKey: randomBytes(32), floor: { read: () => floor, raise: (value: number) => { floor = value; } },
    outbox: { insert: (tx: Database.Database, _q: HubQuestion, source: string) => { const id = randomUUID(); tx.prepare("INSERT INTO restricted_sources VALUES(?,?)").run(source, id); return id; },
      lookup: (tx: Database.Database, _q: HubQuestion, source: string) => (tx.prepare("SELECT id FROM restricted_sources WHERE source=?").get(source) as { id: string } | undefined)?.id ?? null }, now: () => now };
  const journal = new HubMemberJournal(db, options); journal.initialize(); const fence = { current: () => true, linkEpoch: 1, revocationVersion: 0 };
  const lease = (r: HubAuthorizationRequest) => ({ decisionId: randomUUID(), messageId: r.messageId, operationId: r.operationId, phase: r.phase, operationDigest: operationDigest(r), revocationVersion: 0, exposureRevision: 1, linkEpoch: 1, expiresAt: now + 5000 });
  const queued = () => {
    const text = "PRIVATE-RECONCILIATION-TEXT", q = { text, identity: signAsker({ v: 1, issuer: hubId, issuerKeyId: issuerKeyId(keys.publicKey), messageId: randomUUID(), asker: owner, owner, destinationFleetId: randomUUID(), exposureId: randomUUID(), roomId: randomUUID(), grantId: randomUUID(), grantRevision: 1, exposureRevision: 1, revocationVersion: 0, contentDigest: sha256(text), issuedAt: now, expiresAt: now + 120000, nonce: randomBytes(32).toString("hex") }, keys.privateKey) };
    const prepared = journal.prepare(q), request = { messageId: q.identity.messageId, operationId: prepared.operationId, exposureRevision: 1, phase: "admit" as const };
    return { q, receipt: journal.commitAdmission(q, request, lease(request), fence) };
  };
  return { db, options, journal, queued, lease, fence, floor: () => floor };
}
it("pages all known IDs and only unacknowledged receipts without plaintext, mutation or omission", () => {
  const f = fixture(), rows = Array.from({ length: 130 }, () => f.queued()); f.journal.acknowledge(rows[1].receipt);
  const before = f.floor(), ids: string[] = []; let cursor: string | undefined;
  do {
    const page = f.journal.knownMessages({ afterMessageId: cursor, limit: 37 }); expect(page.messages.length).toBeLessThanOrEqual(37);
    expect(JSON.stringify(page)).not.toContain("PRIVATE-RECONCILIATION-TEXT");
    ids.push(...page.messages.map(x => x.messageId)); cursor = page.nextAfterMessageId ?? undefined;
  } while (cursor);
  expect(ids).toEqual(rows.map(x => x.q.identity.messageId).sort()); expect(new Set(ids).size).toBe(130);
  const receipts: number[] = []; let afterSequence = 0;
  for (;;) { const page = f.journal.unackedReceipts({ afterSequence, limit: 31 }); receipts.push(...page.receipts.map(x => x.sequence)); if (!page.more) break; expect(page.nextAfterSequence).toBeGreaterThan(afterSequence); afterSequence = page.nextAfterSequence; }
  expect(receipts).toEqual(rows.filter((_x, i) => i !== 1).map(x => x.receipt.sequence)); expect(f.floor()).toBe(before);
  for (const limit of [0, -1, 129, NaN, [1], "1"]) {
    expect(() => f.journal.knownMessages({ limit: limit as never })).toThrow(); expect(() => f.journal.unackedReceipts({ limit: limit as never })).toThrow();
  }
});
it("ignores delayed older ACKs without writes or downgrades, and refuses unknown/future/conflicting ACKs", () => {
  const f = fixture(), { q, receipt } = f.queued();
  const begin = { messageId: q.identity.messageId, operationId: randomUUID(), exposureRevision: 1, phase: "begin" as const };
  f.journal.markInputIntent(q.identity.messageId, begin, f.lease(begin), f.fence); const delivered = f.journal.recordEvidence(q.identity.messageId, "delivered"), before = f.floor();
  expect(() => f.journal.acknowledge(receipt)).not.toThrow(); expect(f.floor()).toBe(before);
  expect(f.journal.unackedReceipts({}).receipts).toEqual([delivered]);
  expect(() => f.journal.acknowledge({ ...receipt, contentDigest: "a".repeat(64) })).toThrow();
  expect(() => f.journal.acknowledge({ ...delivered, sequence: delivered.sequence + 1 })).toThrow();
  expect(() => f.journal.acknowledge({ ...delivered, messageId: randomUUID() })).toThrow();
  f.journal.acknowledge(delivered); const acked = f.floor(); f.journal.acknowledge(delivered); expect(f.floor()).toBe(acked);
  expect(f.journal.unackedReceipts({}).receipts).toEqual([]); expect(f.journal.knownMessages({}).messages).toHaveLength(1);
});
it("durably observes a primitive monotonic revocation version across reopening, with no reset or same-version write", () => {
  const f = fixture(); expect(f.journal.revocationVersion()).toBe(0); f.journal.observeRevocationVersion(3); const before = f.floor();
  const reopened = new HubMemberJournal(f.db, f.options); expect(reopened.revocationVersion()).toBe(3); reopened.observeRevocationVersion(3); expect(f.floor()).toBe(before);
  for (const version of [2, -1, NaN, [4], "4"]) expect(() => reopened.observeRevocationVersion(version as never)).toThrow();
  expect(reopened.revocationVersion()).toBe(3); expect(f.floor()).toBe(before); expect(() => reopened.initialize()).toThrow();
});

import { vi } from "vitest";
import { createHubMemberHandshake, HUB_HANDSHAKE_LIMITS } from "../src/hub/member-reconciliation.js";
import type { HubMemberLink } from "../src/hub/client.js";
import type { HubMemberFrame, HubServerFrame } from "../src/hub/types.js";
function fakeLink(respond?: (frame: HubMemberFrame) => Promise<HubServerFrame>): HubMemberLink {
  return { linkEpoch: 1, revocationVersion: 0, profile: {} as HubMemberLink["profile"], features: new Set<string>(), current: () => true,
    send: async () => {}, exchange: respond ?? (async frame => {
      if (frame.type === "reconcile") return { ...frame, payload: { receipts: [], nextReceiptSequence: frame.payload.afterReceiptSequence, more: false } };
      if (frame.type === "receipt") return frame;
      throw Error("unexpected operation");
    }) };
}
it("handshakes in order: persist welcome floor, publish snapshot, page all IDs, then echo exact outstanding receipts", async () => {
  const f = fixture(), rows = Array.from({ length: 130 }, () => f.queued()), calls: HubMemberFrame[] = [];
  let published = false;
  const link = fakeLink(async frame => {
    expect(published).toBe(true); calls.push(frame);
    if (frame.type === "reconcile") return { ...frame, payload: { receipts: [], nextReceiptSequence: frame.payload.afterReceiptSequence, more: false } };
    if (frame.type === "receipt") return frame;
    throw Error("input replay");
  });
  await createHubMemberHandshake({ journal: f.journal, publishSnapshot: async l => { expect(l.revocationVersion).toBe(2); expect(f.journal.revocationVersion()).toBe(2); published = true; } })({ ...link, revocationVersion: 2 });
  expect(calls.filter(x => x.type === "reconcile").flatMap(x => x.payload.messages)).toHaveLength(130);
  expect(calls.filter(x => x.type === "receipt").map(x => x.payload)).toEqual(rows.map(x => x.receipt));
  expect(f.journal.unackedReceipts({}).receipts).toEqual([]);
  expect(calls.every(x => ["reconcile", "receipt"].includes(x.type))).toBe(true);
});
it("carries one global receipt cursor across history and known-ID pages, and never downgrades delayed evidence", async () => {
  const f = fixture(), rows = Array.from({ length: 130 }, () => f.queued()), cursors: number[] = [];
  let n = 0;
  const link = fakeLink(async frame => {
    if (frame.type === "receipt") return frame;
    if (frame.type !== "reconcile") throw Error();
    cursors.push(frame.payload.afterReceiptSequence);
    const receipts = n++ === 0 ? rows.slice(0, 100).map(x => x.receipt) : n === 2 ? rows.slice(100).map(x => x.receipt) : [];
    return { ...frame, payload: { receipts, nextReceiptSequence: receipts.at(-1)?.sequence ?? frame.payload.afterReceiptSequence, more: n === 1 } };
  });
  await createHubMemberHandshake({ journal: f.journal, publishSnapshot: async () => {} })(link);
  expect(cursors).toEqual([0, 100, 130]); expect(f.journal.unackedReceipts({}).receipts).toEqual([]);
});
it.each(["epoch", "request", "receipt", "cursor", "no-progress"])("refuses a %s mismatch and leaves unconfirmed receipts outstanding", async failure => {
  const f = fixture(); f.queued(); let exchanges = 0;
  const link = fakeLink(async frame => {
    exchanges++;
    if (frame.type === "receipt") return { ...frame, payload: { ...frame.payload, at: frame.payload.at + 1 } };
    if (frame.type !== "reconcile") throw Error();
    return { ...frame, ...(failure === "epoch" ? { linkEpoch: 2 } : {}), ...(failure === "request" ? { requestId: randomUUID() } : {}),
      payload: { receipts: [], nextReceiptSequence: failure === "cursor" ? 1 : 0, more: failure === "no-progress" } };
  });
  await expect(createHubMemberHandshake({ journal: f.journal, publishSnapshot: async () => {} })(link)).rejects.toThrow();
  expect(f.journal.unackedReceipts({}).receipts).toHaveLength(1);
  if (failure === "no-progress") expect(exchanges).toBe(1);
});
it.each(["current", "version"])("rechecks %s after a response before acknowledging", async field => {
  const f = fixture(), row = f.queued(); let current = true, version = 0;
  const link = fakeLink(async frame => {
    if (frame.type !== "reconcile") throw Error();
    if (field === "current") current = false; else version++;
    return { ...frame, payload: { receipts: [row.receipt], nextReceiptSequence: row.receipt.sequence, more: false } };
  });
  link.current = () => current; Object.defineProperty(link, "revocationVersion", { get: () => version });
  await expect(createHubMemberHandshake({ journal: f.journal, publishSnapshot: async () => {} })(link)).rejects.toThrow("stale");
  expect(f.journal.unackedReceipts({}).receipts).toHaveLength(1);
});
it("bounds a non-progressing deadline including a held snapshot callback", async () => {
  const f = fixture(); let clock = 0; const publish = vi.fn(async () => { clock = HUB_HANDSHAKE_LIMITS.timeoutMs; });
  await expect(createHubMemberHandshake({ journal: f.journal, publishSnapshot: publish, now: () => clock })(fakeLink())).rejects.toThrow("unavailable");
  vi.useFakeTimers();
  try {
    const pending = createHubMemberHandshake({ journal: f.journal, publishSnapshot: () => new Promise(() => {}) })(fakeLink());
    const assertion = expect(pending).rejects.toThrow("unavailable"); await vi.advanceTimersByTimeAsync(HUB_HANDSHAKE_LIMITS.timeoutMs); await assertion;
  } finally { vi.useRealTimers(); }
});
it("bounds even an endless advancing peer history without terminal input or tool dispatch", async () => {
  const f = fixture(), row = f.queued(); let n = 0;
  const journal = { ...f.journal, observeRevocationVersion: () => {}, knownMessages: () => ({ messages: [], nextAfterMessageId: null }), acknowledge: () => {} } as unknown as HubMemberJournal;
  const link = fakeLink(async frame => { n++; return { v: 1, type: "reconcile", requestId: frame.requestId, linkEpoch: 1,
    payload: { receipts: [{ ...row.receipt, sequence: n }], nextReceiptSequence: n, more: true } }; });
  await expect(createHubMemberHandshake({ journal, publishSnapshot: async () => {}, now: () => 0 })(link)).rejects.toThrow("backpressure");
  expect(n).toBe(HUB_HANDSHAKE_LIMITS.exchanges);
});
it("flushes a newly advanced receipt after an older in-flight ACK without acknowledging the newer stage", async () => {
  const f = fixture(), { q } = f.queued(); let advanced = false; const stages: string[] = [];
  const link = fakeLink(async frame => {
    if (frame.type === "reconcile") return { ...frame, payload: { receipts: [], nextReceiptSequence: 0, more: false } };
    if (frame.type !== "receipt") throw Error(); stages.push(frame.payload.stage);
    if (!advanced) {
      advanced = true; const r = { messageId: q.identity.messageId, operationId: randomUUID(), exposureRevision: 1, phase: "begin" as const };
      f.journal.markInputIntent(q.identity.messageId, r, f.lease(r), f.fence); f.journal.recordEvidence(q.identity.messageId, "delivered");
    }
    return frame;
  });
  await createHubMemberHandshake({ journal: f.journal, publishSnapshot: async () => {} })(link);
  expect(stages).toEqual(["queued", "delivered"]); expect(f.journal.unackedReceipts({}).receipts).toEqual([]);
});

it.each(["equal", "decreasing"])("refuses a %s receipt sequence inside a page before acknowledging any row", async order => {
  const f = fixture(), a = f.queued(), b = f.queued(); let exchanges = 0;
  const link = fakeLink(async frame => {
    exchanges++;
    return { v: 1, type: "reconcile", requestId: frame.requestId, linkEpoch: 1,
      payload: { receipts: order === "equal" ? [a.receipt, { ...b.receipt, sequence: a.receipt.sequence }] : [b.receipt, a.receipt],
        nextReceiptSequence: a.receipt.sequence, more: false } };
  });
  await expect(createHubMemberHandshake({ journal: f.journal, publishSnapshot: async () => {} })(link)).rejects.toThrow("conflict");
  expect(exchanges).toBe(1); expect(f.journal.unackedReceipts({}).receipts).toEqual([a.receipt, b.receipt]);
});
it("the final barrier refuses a journal revocation floor changed independently of the captured link", async () => {
  const f = fixture();
  await expect(createHubMemberHandshake({ journal: f.journal, publishSnapshot: async () => { f.journal.observeRevocationVersion(1); } })(fakeLink())).rejects.toThrow("stale");
  expect(f.journal.revocationVersion()).toBe(1);
});
it("the final barrier refuses evidence that appears after the last empty outstanding-receipt read", async () => {
  const f = fixture(), read = f.journal.unackedReceipts.bind(f.journal); let first = true;
  vi.spyOn(f.journal, "unackedReceipts").mockImplementation(input => {
    const page = read(input);
    if (first) { first = false; f.queued(); } // another durable writer just advanced after this page's snapshot
    return page;
  });
  await expect(createHubMemberHandshake({ journal: f.journal, publishSnapshot: async () => {} })(fakeLink())).rejects.toThrow("stale");
  expect(read({}).receipts).toHaveLength(1);
});
