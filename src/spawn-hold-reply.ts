import { AsyncLocalStorage } from "node:async_hooks";
import { t } from "./locale.js";

interface ActionReply { active: boolean; told: boolean; reply: (text: string) => Promise<unknown>; }
const replies = new AsyncLocalStorage<ActionReply>();

/** A reply belongs to this user action, never to a background recovery or General. */
export async function withSpawnHoldReply<T>(reply: ActionReply["reply"], action: () => Promise<T>): Promise<T> {
  const owner: ActionReply = { active: true, told: false, reply };
  try { return await replies.run(owner, action); }
  finally { owner.active = false; }
}

/** Capture at enqueue: pumping another request must not choose its reply recipient. */
export function captureSpawnHoldReply(current: () => boolean): (() => void) | undefined {
  const owner = replies.getStore();
  if (!owner) return undefined;
  return () => {
    if (!owner.active || owner.told) return;
    owner.told = true;
    // Reporting never delays admission or changes the queued operation's outcome.
    void Promise.resolve().then(() => owner.active && current() ? owner.reply(t("memory.action_held")) : undefined).catch(() => {});
  };
}
