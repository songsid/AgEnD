import type {TurnReplyRouteLease} from "./turn-reply-guard.js";
import { RequestContextV1Schema } from "./request-context-protocol.js";
import type { RequestContextTurnSnapshot } from "./request-context-turns.js";
import { requestContextDigest } from "./request-context-store.js";
import { z } from "zod";

/** Server-private captured call scope, not a tool argument, bearer file or human authority. */
export interface RequestContextCallLease {
  readonly snapshot: RequestContextTurnSnapshot;
  readonly snapshotSha256: string;
  current(): boolean;
}
export type RequestContextCallAdmission = { coverage: "covered"; lease: RequestContextCallLease }
  | { coverage: "not-covered"; reason: "interrupted-launch" | "unbound-input" };
/** In-process owner of an opaque local IPC call id. The full snapshot never goes on that wire. */
export interface RequestContextLocalCall {
  readonly id: string;
  readonly admission: RequestContextCallAdmission;
  readonly replyRoute?:TurnReplyRouteLease;
  readonly waitForReplyRoute?:(budgetMs:number)=>Promise<void>;
  current(): boolean;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Capture exactly once. The callback checks THIS snapshot against the real owner; it cannot substitute a later context. */
export function captureRequestContextCall(snapshot: RequestContextTurnSnapshot,
  stillCurrent: (captured: RequestContextTurnSnapshot) => boolean): RequestContextCallLease {
  const stored = structuredClone(snapshot);
  RequestContextV1Schema.parse(stored.context);
  if (stored.context.source.instance !== stored.owner.instance || stored.context.source.incarnation !== stored.owner.incarnation
    || !z.uuid().safeParse(stored.token).success || !/^[a-f0-9]{64}$/.test(stored.wireSha256)
    || typeof stored.inputId !== "string" || !stored.inputId.length || stored.inputId.length > 512
    || ![stored.owner.instance, stored.owner.incarnation, stored.owner.workGeneration, stored.owner.daemonBootId]
      .every(value => typeof value === "string" && value.length > 0 && value.length <= 256)
    || ![stored.owner.spawnGeneration, stored.owner.launchFenceEpoch, stored.owner.deliveryEpoch]
      .every(value => Number.isSafeInteger(value) && value >= 0)) throw Error("Request context call owner is unavailable");
  freeze(stored);
  const current = (): boolean => { try { return stillCurrent(stored) === true; } catch { return false; } };
  if (!current()) throw Error("Request context turn is no longer current");
  return Object.freeze({ snapshot: stored, snapshotSha256: requestContextDigest(stored), current });
}
