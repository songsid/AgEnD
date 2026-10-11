/**
 * #1620: the two #1620 parts of a PUT /api/settings/fleet/web body, read the same way by the confirmation gate's
 * projection (settings-effect.ts) and by the handler (settings-api.ts) — so neither proposes nor writes what the other
 * would refuse. `null` puts a value back to its default (the key leaves fleet.yaml); null overall = nothing to change.
 * The session hours' bounds are the validator's, run on the whole result; the terminal's minutes are checked here (the
 * loader clamps an out-of-range value to 1..20, so the validator never sees one — Settings must not write one).
 */
export const WEB_TERMINAL_TTL_MINUTES = { min: 1, max: 20 } as const;

/** `session`: `{ local: { absolute_hours?, idle_hours? } }` with numbers or null — the local limits only. */
export function webSessionPatch(raw: unknown): Record<string, number | null> | null | "invalid" {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  if (Object.keys(raw).some(k => k !== "local")) return "invalid";
  const local = (raw as { local?: unknown }).local;
  if (local === undefined) return null;
  if (!local || typeof local !== "object" || Array.isArray(local)) return "invalid";
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(local)) {
    if ((k !== "absolute_hours" && k !== "idle_hours") || !(v === null || (typeof v === "number" && Number.isFinite(v)))) return "invalid";
    out[k] = v as number | null;
  }
  return Object.keys(out).length ? out : null;
}

/** `web_terminal`: `{ enabled?: boolean | null, ttl_minutes?: 1..20 | null }` — nothing else (bind, tunnel: fleet.yaml). */
export function webTerminalPatch(raw: unknown): Record<string, boolean | number | null> | null | "invalid" {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const out: Record<string, boolean | number | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "enabled" && (v === null || typeof v === "boolean")) out[k] = v;
    else if (k === "ttl_minutes" && (v === null || (typeof v === "number" && Number.isInteger(v)
      && v >= WEB_TERMINAL_TTL_MINUTES.min && v <= WEB_TERMINAL_TTL_MINUTES.max))) out[k] = v;
    else return "invalid";
  }
  return Object.keys(out).length ? out : null;
}
