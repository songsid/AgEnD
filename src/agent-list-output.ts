/** Agent-only rendering; stores and dashboard readers keep their existing shapes. */
import type { Schedule, Task, TaskCompact } from "./scheduler/types.js";

export interface ListOptions {
  detail?: unknown;
  limit?: unknown;
  cursor?: unknown;
  full?: unknown;
  verbose?: unknown;
}

export function listOptions(opts: ListOptions): { limit: number; cursor?: string } {
  if (opts.detail !== undefined && typeof opts.detail !== "boolean") throw new Error("detail must be boolean");
  if (opts.limit !== undefined && (typeof opts.limit !== "number" || !Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 100)) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  if (opts.cursor !== undefined && (typeof opts.cursor !== "string" || !opts.cursor || opts.cursor.length > 128)) {
    throw new Error("cursor is invalid; restart the list");
  }
  if ((opts.detail === true || opts.full === true || opts.verbose === true) && (opts.limit !== undefined || opts.cursor !== undefined)) {
    throw new Error("detail returns the legacy answer; omit limit and cursor");
  }
  return { limit: opts.limit as number | undefined ?? 20, ...(opts.cursor !== undefined ? { cursor: opts.cursor as string } : {}) };
}

/** Resolve a cursor only among the already-filtered visible records. No hidden/missing distinction. */
export function pageRows<T extends { id: string }>(rows: readonly T[], opts: ListOptions): { rows: T[]; next_cursor?: string } {
  const { limit, cursor } = listOptions(opts);
  const index = cursor === undefined ? -1 : rows.findIndex(row => row.id === cursor);
  if (cursor !== undefined && index < 0) throw new Error("cursor is invalid for this list; restart with the same filters");
  const page = rows.slice(index + 1, index + 1 + limit);
  return {
    rows: page,
    ...(index + 1 + page.length < rows.length && page.length ? { next_cursor: page.at(-1)!.id } : {}),
  };
}

export function scheduleListAnswer(rows: Schedule[], opts: ListOptions): unknown {
  listOptions(opts);
  if (opts.detail === true) return rows;
  const { rows: page, ...more } = pageRows(rows, opts);
  return {
    schedules: page.map(row => ({
      id: row.id,
      title: row.label || row.message.replace(/\s+/g, " ").slice(0, 80),
      target: row.target,
      enabled: row.enabled,
      ...(row.at ? { at: row.at } : { cron: row.cron, timezone: row.timezone }),
    })),
    ...more,
  };
}

export function taskTitle(task: Task | TaskCompact): TaskCompact {
  return {
    id: task.id, code: task.code, title: task.title, status: task.status,
    assignee: task.assignee, priority: task.priority, updated_at: task.updated_at,
  };
}

export function taskListAnswer(rows: (Task | TaskCompact)[], opts: ListOptions): unknown {
  const { rows: page, ...more } = pageRows(rows, opts);
  return { tasks: page.map(taskTitle), ...more };
}
