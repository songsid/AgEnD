/** Retain a pinned Hub's security notice before ACK. No notice grants local or Hub authority. */
import type Database from "better-sqlite3";
import type { HubMigration } from "../db.js";
import type { HubAuditStore } from "../audit/index.js";
import type { HubPairingNotice } from "../types.js";
import type { HubMemberLink } from "../client.js";
import { pairingNoticeSchema } from "../protocol.js";
import { HubProtocolError, parseStrictJson, validated } from "../validation.js";
import { randomUUID } from "node:crypto";

export const HUB_PAIRING_INBOX_MIGRATION: HubMigration = Object.freeze({ component: "s90-pairing-inbox", version: 1, up(db: Database.Database) {
  db.exec("CREATE TABLE hub_pairing_notice_inbox(id TEXT PRIMARY KEY, body TEXT NOT NULL)");
} });
export function createHubPairingNoticeInbox(options: {
  db: Database.Database; audit: Pick<HubAuditStore, "appendInTransaction">; current(): boolean; now(): number;
  /** Presentation notification after local retention; failure is retried and never acknowledged as shown. */
  changed?(): void;
}) {
  const check = () => { if (!options.current()) throw new HubProtocolError("unavailable"); };
  return {
    list(): HubPairingNotice[] {
      // Matches the retention cap: an acknowledged retained notice must remain reachable in Settings history.
      check(); return (options.db.prepare("SELECT body FROM hub_pairing_notice_inbox ORDER BY rowid DESC LIMIT 1024").all() as { body: string }[])
        .map(row => validated(pairingNoticeSchema, parseStrictJson(row.body)));
    },
    async receive(input: HubPairingNotice, link: HubMemberLink): Promise<void> {
      const notice = validated(pairingNoticeSchema, input); check();
      if (!link.current() || !link.features.has("welcome-caps-v1") || !link.features.has("pairing-notices-v1")) throw new HubProtocolError("incompatible");
      options.db.transaction(() => {
        check(); if (!link.current()) throw new HubProtocolError("stale");
        const prior = options.db.prepare("SELECT body FROM hub_pairing_notice_inbox WHERE id=?").get(notice.id) as { body: string } | undefined;
        if (prior) {
          const retained = validated(pairingNoticeSchema, parseStrictJson(prior.body));
          // A lost ACK can be replayed after the named fleet was revoked. Only that monotonic projection may change.
          if (JSON.stringify({ ...retained, revoked: notice.revoked }) !== JSON.stringify(notice)
            || (retained.revoked && !notice.revoked)) throw new HubProtocolError("conflict");
          if (retained.revoked === notice.revoked) return;
        }
        if (!prior && (options.db.prepare("SELECT count(*) n FROM hub_pairing_notice_inbox").get() as { n: number }).n >= 1024) throw new HubProtocolError("backpressure");
        const audit: unknown = options.audit.appendInTransaction({ id: randomUUID(), sequence: 0, at: options.now(), requestId: notice.id,
          actor: { kind: "local-host" }, action: prior ? "pairing.notice-updated" : "pairing.notice-retained", result: "completed", fleetId: notice.fleetId,
          policyVersion: link.revocationVersion }, options.db);
        if (audit && typeof (audit as { then?: unknown }).then === "function") {
          void Promise.resolve(audit).catch(() => undefined); throw new HubProtocolError("unavailable");
        }
        options.db.prepare("INSERT OR REPLACE INTO hub_pairing_notice_inbox VALUES(?,?)").run(notice.id, JSON.stringify(notice));
        check(); if (!link.current()) throw new HubProtocolError("stale");
      }).immediate();
      options.changed?.();
      check(); if (!link.current()) return;
      await link.send({ v: 1, type: "pairing.notice-ack", requestId: notice.id, linkEpoch: link.linkEpoch, payload: { id: notice.id } });
    },
  };
}
