import { AsyncLocalStorage } from "node:async_hooks";
import { t } from "./locale.js";

interface ActionReply { active: boolean; told: boolean; reply: (text: string) => Promise<unknown>; }
const replies = new AsyncLocalStorage<ActionReply | undefined>();

/** A reply belongs to this user action, never to a background recovery or General. */
export async function withSpawnHoldReply<T>(reply: ActionReply["reply"] | undefined, action: () => Promise<T>): Promise<T> {
  const owner: ActionReply | undefined = reply ? { active: true, told: false, reply } : undefined;
  try { return await replies.run(owner, action); }
  finally { if (owner) owner.active = false; }
}

/** A later pump must run this operation in its enqueue context, including an absent owner. */
export function bindSpawnHoldReply<T>(operation: () => Promise<T>): () => Promise<T> {
  const owner = replies.getStore();
  return () => replies.run(owner, operation);
}

/** Capture at enqueue: pumping another request must not choose its reply recipient. */
export function captureSpawnHoldReply(current: () => boolean): (() => void) | undefined {
  const owner = replies.getStore();
  if (!owner) return undefined;
  return () => {
    if (!owner.active || owner.told) return;
    owner.told = true;
    // Reporting never delays admission or changes the queued operation's outcome.
    void Promise.resolve().then(() => {
      if (!owner.active || !current()) { owner.told = false; return; }
      return owner.reply(t("memory.action_held"));
    }).catch(() => {});
  };
}
