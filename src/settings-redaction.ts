import { SETTINGS_SECRET_KEY } from "./settings-change.js";

/**
 * #1490 (row 18): what Settings shows in place of a credential written inline in fleet.yaml (a hand-written
 * `bot_token`, say). #1496 keeps Settings from adding or changing one; this keeps it from reading one back out.
 */
export const REDACTED_SECRET = "[configured - redacted]";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A copy of `value` with every credential-named string replaced by REDACTED_SECRET. */
export function redactInlineSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => redactInlineSecrets(item)) as T;
  if (!record(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SETTINGS_SECRET_KEY.test(key) && typeof child === "string" && child !== ""
      ? REDACTED_SECRET : redactInlineSecrets(child);
  }
  return out as T;
}

/**
 * A write built from a redacted read carries REDACTED_SECRET back: put the value it stands for in its place, from
 * `previous` at the same path, so a save never writes the placeholder over a real credential. A placeholder with no
 * credential behind it (a new key, or one the save moved) is refused: `{ path }` names it.
 */
export function restoreRedactedSecrets<T>(next: T, previous: unknown): { value: T } | { path: string } {
  const walk = (value: unknown, before: unknown, at: string): { value: unknown } | { path: string } => {
    if (value === REDACTED_SECRET) {
      return typeof before === "string" && before !== "" ? { value: before } : { path: at || "(root)" };
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const [index, item] of value.entries()) {
        const step = walk(item, Array.isArray(before) ? before[index] : undefined, `${at}[${index}]`);
        if ("path" in step) return step;
        out.push(step.value);
      }
      return { value: out };
    }
    if (!record(value)) return { value };
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const step = walk(child, record(before) && Object.hasOwn(before, key) ? before[key] : undefined, at ? `${at}.${key}` : key);
      if ("path" in step) return step;
      out[key] = step.value;
    }
    return { value: out };
  };
  return walk(next, previous, "") as { value: T } | { path: string };
}
