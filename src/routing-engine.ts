import type { FleetConfig } from "./types.js";
import { type RouteTarget } from "./fleet-context.js";

/**
 * Manages the topic→instance routing table.
 * All topic IDs are normalized to strings to avoid snowflake precision loss.
 */
export class RoutingEngine {
  private table = new Map<string, RouteTarget>();
  /**
   * #1085: every owner of a topic id. Telegram numbers topics per group, so two
   * Telegram fleet worlds can both have a topic 30; `table` keeps one (the last)
   * for the callers that resolve by id alone, while inbound Telegram routing
   * picks, from all owners, the one whose group the message came from.
   */
  private owners = new Map<string, RouteTarget[]>();

  /** Rebuild routing table from fleet config. Returns summary string for logging. */
  rebuild(config: FleetConfig): string {
    this.table.clear();
    this.owners.clear();
    for (const [name, inst] of Object.entries(config.instances)) {
      if (inst.topic_id != null) {
        this.register(inst.topic_id, {
          kind: inst.general_topic ? "general" : "instance",
          name,
        });
      }
    }
    return [...this.table.entries()].map(([tid, t]) => `#${tid}→${t.name}`).join(", ");
  }

  /** Resolve a thread ID to a route target. */
  resolve(threadId: string): RouteTarget | undefined {
    return this.table.get(threadId);
  }

  /**
   * Every target that owns `threadId` (#1085), including one set directly on
   * `map`. Callers that know the message's group choose among them.
   */
  resolveAll(threadId: string): RouteTarget[] {
    const all = [...(this.owners.get(threadId) ?? [])];
    const current = this.table.get(threadId);
    if (current && !all.some(t => t.name === current.name)) all.push(current);
    return all;
  }

  /** Register a new topic→instance mapping. */
  register(topicId: number | string, target: RouteTarget): void {
    const key = String(topicId);
    this.table.set(key, target);
    const list = (this.owners.get(key) ?? []).filter(t => t.name !== target.name);
    list.push(target);
    this.owners.set(key, list);
  }

  /**
   * Remove a topic from the routing table: one owner when `name` is given (the
   * others keep the topic id), every owner otherwise.
   */
  unregister(topicId: number | string, name?: string): void {
    const key = String(topicId);
    if (name === undefined) {
      this.table.delete(key);
      this.owners.delete(key);
      return;
    }
    const rest = (this.owners.get(key) ?? []).filter(t => t.name !== name);
    if (rest.length) this.owners.set(key, rest);
    else this.owners.delete(key);
    if (this.table.get(key)?.name === name) {
      const next = rest.at(-1);
      if (next) this.table.set(key, next);
      else this.table.delete(key);
    }
  }

  /** Iterate over all routes. */
  entries(): IterableIterator<[string, RouteTarget]> {
    return this.table.entries();
  }

  /** Get the underlying map (for FleetContext compatibility). */
  get map(): Map<string, RouteTarget> {
    return this.table;
  }

  get size(): number {
    return this.table.size;
  }
}
