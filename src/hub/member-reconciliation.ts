/** Metadata-only reconnect barrier. Never replays question text, answers, tools or provider input. */
import { randomUUID } from "node:crypto";
import { canonicalArguments } from "./identity.js";
import { serverFrameSchema } from "./protocol.js";
import { HubProtocolError, validated } from "./validation.js";
import type { HubMemberLink } from "./client.js";
import type { HubMemberJournal } from "./member-journal.js";
import type { HubMemberFrame, HubServerFrame } from "./types.js";
// The journal holds at most 4096 messages. Allow one receipt per row plus bounded history paging;
// a peer with excessive history or a changing local journal must retry rather than hang startup.
export const HUB_HANDSHAKE_LIMITS = Object.freeze({ exchanges: 8192, timeoutMs: 30_000 });
export interface HubMemberHandshakeOptions {
  journal: HubMemberJournal;
  /** S3c's complete current consent-ready snapshot. Use this link, not the ready-gated client. */
  publishSnapshot(link: HubMemberLink): Promise<void>;
  /** Monotonic clock, injectable for inert deadline tests. */
  now?: () => number;
}
export function createHubMemberHandshake(options: HubMemberHandshakeOptions): (link: HubMemberLink) => Promise<void> {
  return async link => {
    const now = options.now ?? (() => performance.now()), deadline = now() + HUB_HANDSHAKE_LIMITS.timeoutMs;
    const epoch = link.linkEpoch, version = link.revocationVersion; let exchanges = 0;
    const check = () => {
      if (!link.current() || link.linkEpoch !== epoch || link.revocationVersion !== version) throw new HubProtocolError("stale");
      if (now() >= deadline) throw new HubProtocolError("unavailable");
    };
    const bounded = async <T>(run: () => Promise<T>): Promise<T> => {
      check(); let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([run(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new HubProtocolError("unavailable")), Math.max(1, deadline - now())); timer.unref();
        })]); check(); return result;
      } finally { clearTimeout(timer); }
    };
    const exchange = async (frame: HubMemberFrame, type: HubServerFrame["type"]) => {
      check(); if (++exchanges > HUB_HANDSHAKE_LIMITS.exchanges) throw new HubProtocolError("backpressure");
      const response = validated(serverFrameSchema, await bounded(() => link.exchange(frame, type)));
      if (response.type !== type || response.requestId !== frame.requestId || response.linkEpoch !== epoch) throw new HubProtocolError("stale");
      return response;
    };
    check();
    // Welcome is a durable lower bound, not an authorization lease or a fabricated scoped revoke.
    options.journal.observeRevocationVersion(version);
    await bounded(() => options.publishSnapshot(link));
    let afterMessageId: string | undefined, afterReceiptSequence = 0;
    do {
      check(); const page = options.journal.knownMessages({ afterMessageId });
      for (;;) {
        const response = await exchange({ v: 1, type: "reconcile", requestId: randomUUID(), linkEpoch: epoch,
          payload: { afterReceiptSequence, messages: [...page.messages] } }, "reconcile");
        if (response.type !== "reconcile") throw new HubProtocolError();
        let next = afterReceiptSequence;
        // Hub history is global to this fleet, not filtered by this page's known IDs.
        for (const receipt of response.payload.receipts) {
          if (receipt.sequence <= next) throw new HubProtocolError("conflict");
          next = receipt.sequence;
        }
        if (response.payload.nextReceiptSequence !== next || response.payload.more && next === afterReceiptSequence) throw new HubProtocolError("conflict");
        for (const receipt of response.payload.receipts) { check(); options.journal.acknowledge(receipt); }
        afterReceiptSequence = next;
        if (!response.payload.more) break;
      }
      afterMessageId = page.nextAfterMessageId ?? undefined;
    } while (afterMessageId);
    let afterSequence = 0;
    for (;;) {
      check(); const page = options.journal.unackedReceipts({ afterSequence });
      if (!page.receipts.length) break;
      for (const receipt of page.receipts) {
        const response = await exchange({ v: 1, type: "receipt", requestId: randomUUID(), linkEpoch: epoch, payload: receipt }, "receipt");
        if (response.type !== "receipt" || canonicalArguments(response.payload) !== canonicalArguments(receipt)) throw new HubProtocolError("conflict");
        check(); options.journal.acknowledge(receipt);
      }
      // A newer local stage may have appeared during the await, even on the last original page.
      afterSequence = page.nextAfterSequence;
    }
    check();
    if (options.journal.revocationVersion() !== version || options.journal.unackedReceipts({}).receipts.length) throw new HubProtocolError("stale");
  };
}
