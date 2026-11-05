/**
 * #2861: who was talked to, for an Office share link's dialogue box — when a person's message reached an instance
 * ("heard") and when it answered ("answered"). Never what was said, nor who said it: a share shows names and states only,
 * so its box says "Received a message" and "Replied" with the agent's portrait. In memory only (a restart forgets it),
 * the last of each kind per instance, and only what is younger than TALK_MAX_AGE_MS is ever handed out.
 */
export const TALK_MAX_AGE_MS = 120_000;
/** At most this many instances are remembered (the oldest go). */
const MAX_INSTANCES = 500;

export type TalkKind = "heard" | "answered";
export interface TalkItem { instance: string; kind: TalkKind; at: number }

export class OfficeTalk {
  private readonly last = new Map<string, { heard?: number; answered?: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** A chat message as the stream sends it: a person's (role "user") is heard, the agent's reply (role "agent") answers. */
  noteMessage(m: unknown): void {
    if (!m || typeof m !== "object") return;
    const { instance, role } = m as { instance?: unknown; role?: unknown };
    if (typeof instance !== "string" || !instance) return;
    if (role === "user") this.note(instance, "heard");
    else if (role === "agent") this.note(instance, "answered");
  }

  note(instance: string, kind: TalkKind): void {
    const had = this.last.get(instance);
    this.last.delete(instance);
    this.last.set(instance, { ...had, [kind]: this.clock() });
    while (this.last.size > MAX_INSTANCES) this.last.delete(this.last.keys().next().value as string);
  }

  /** What a share may show: `scope`'s instances only, events younger than TALK_MAX_AGE_MS, oldest first. */
  recent(scope: ReadonlySet<string>): { now: number; items: TalkItem[] } {
    const now = this.clock(), items: TalkItem[] = [];
    for (const [instance, e] of this.last) {
      if (!scope.has(instance)) continue;
      for (const kind of ["heard", "answered"] as const) {
        const at = e[kind];
        if (at !== undefined && now - at <= TALK_MAX_AGE_MS && at <= now) items.push({ instance, kind, at });
      }
    }
    return { now, items: items.sort((a, b) => a.at - b.at) };
  }
}
