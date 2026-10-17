/** CW1 effect manifests are metadata, never placement authority. Widgets are host-rendered elsewhere. */
import { z } from "zod";
import { canonicalText } from "./web-theme.js";
export const WEB_EFFECT_ID = /^[0-9a-f]{32}$/;
export const WEB_EFFECT_REGIONS = ["chat", "sidebar", "header", "page", "box"] as const;
export const WEB_EFFECT_WANTS = ["pointer", "state", "reply", "mention", "theme"] as const;
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
function text(max: number, min: number) {
  return z.string().max(max * 10).transform((value, ctx) => {
    const result = min === 0 && value === "" ? "" : canonicalText(value, Math.max(1, min), max);
    if (result === null) {
      ctx.addIssue({ code: "custom", message: "Invalid display text" });
      return z.NEVER;
    }
    return result;
  });
}
const finite = z.number().finite().min(-1e9).max(1e9);
const numeric = z.strictObject({ type: z.literal("number"), min: finite, max: finite, step: z.number().finite().positive().max(2e9).optional(), default: finite });
const integer = z.strictObject({ type: z.literal("int"), min: finite.int(), max: finite.int(), default: finite.int() });
const param = z.discriminatedUnion("type", [
  numeric, integer, z.strictObject({ type: z.literal("bool"), default: z.boolean() }),
  z.strictObject({ type: z.literal("enum"), values: z.array(slug).min(1).max(16), default: slug }),
  z.strictObject({ type: z.literal("color"), default: z.string().regex(/^#[0-9a-fA-F]{6}$/).transform(value => value.toLowerCase()) }),
]).refine(d => {
  if (d.type === "enum")
    return new Set(d.values).size === d.values.length && d.values.includes(d.default);
  if (d.type === "number" || d.type === "int")
    return d.min <= d.max && d.default >= d.min && d.default <= d.max && (d.type !== "number" || d.step === undefined || aligned(d.default, d.min, d.step));
  return true;
});
function aligned(value: number, min: number, step: number): boolean {
  const distance = (value - min) / step;
  return Number.isFinite(distance) && Math.abs(distance - Math.round(distance)) <= 1e-8;
}
const manifest = z.strictObject({
  v: z.literal(1), kind: z.literal("effect").default("effect"), runtime: z.literal("canvas-worker-v1"), worker: z.literal("worker.js"),
  name: slug, title: text(40, 1), description: text(200, 0).optional(), poster: z.literal("poster.png").optional(),
  regions: z.array(z.enum(WEB_EFFECT_REGIONS)).min(1).max(5).refine(v => new Set(v).size === v.length),
  layer: z.enum(["behind", "front"]),
  box: z.strictObject({ anchor: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"]), width: z.number().int().min(32).max(480), height: z.number().int().min(32).max(480), offset: z.number().int().min(0).max(64) }).optional(),
  cursor: z.strictObject({ hotspot: z.tuple([z.number().int().min(0).max(63), z.number().int().min(0).max(63)]) }).optional(),
  wants: z.array(z.enum(WEB_EFFECT_WANTS)).max(5).refine(v => new Set(v).size === v.length),
  params: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), param).refine(v => Object.keys(v).length <= 16).optional(),
});
export type WebEffectManifest = z.infer<typeof manifest>;
export type EffectParamValue = string | number | boolean;
/** Bounded data only. Do not invoke getters or interpret unreadable values as an absent field. */
function plainData(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 1024 || depth > 8)
      return false;
    if (value === null || typeof value === "string" || typeof value === "boolean")
      continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        return false;
      continue;
    }
    if (typeof value !== "object")
      return false;
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 33 || array && value.length > 32)
      return false;
    for (const key of keys) {
      if (typeof key !== "string")
        return false;
      if (array && key === "length")
        continue;
      const field = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in field))
        return false;
      pending.push({ value: field.value, depth: depth + 1 });
    }
  }
  return true;
}
export function parseWebEffectManifest(value: unknown): {
  ok: true;
  manifest: WebEffectManifest;
} | {
  ok: false;
  error: "invalid_manifest";
} {
  try {
    if (!plainData(value))
      return { ok: false, error: "invalid_manifest" };
    const result = manifest.safeParse(value);
    return result.success ? { ok: true, manifest: result.data } : { ok: false, error: "invalid_manifest" };
  }
  catch {
    return { ok: false, error: "invalid_manifest" };
  }
}
/**
 * #2017: whether an effect can be placed in a chat — its manifest's regions include `chat` (else it is saved but never
 * plays there). Only a NEW chat placement is checked (agent tool, person's route, a mod's theme.effects); an older one
 * stays as it is (filtered at run time) and can be removed. A non-chat effect stays a valid upload and personal choice.
 */
export function chatCompatible(manifest: { regions?: readonly string[] }): boolean {
  return Array.isArray(manifest.regions) && manifest.regions.includes("chat");
}
/** #2017: the same test on an effect's files (its effect.json), for a mod export: an unreadable manifest is not chat. */
export function filesPlayInChat(files: ReadonlyMap<string, Uint8Array>): boolean {
  const raw = files.get("effect.json");
  if (!raw) return false;
  try { return chatCompatible(JSON.parse(Buffer.from(raw).toString("utf8")) as { regions?: readonly string[] }); } catch { return false; }
}
export const EFFECT_REGION: Readonly<{ error: "effect_region"; message: string }> = Object.freeze({ error: "effect_region", message: "This effect's regions do not include chat." });

/** Defaults and overrides are resolved together before a placement or mod commit can write. */
export function resolveEffectParams(input: WebEffectManifest, overrides: unknown = {}): {
  ok: true;
  values: Record<string, EffectParamValue>;
  overrides: Record<string, EffectParamValue>;
} | {
  ok: false;
  error: "invalid_params";
} {
  try {
    if (!plainData(overrides) || !overrides || Array.isArray(overrides) || typeof overrides !== "object")
      return { ok: false, error: "invalid_params" };
    const schema = input.params ?? {};
    for (const key of Object.keys(overrides))
      if (!Object.hasOwn(schema, key))
        return { ok: false, error: "invalid_params" };
    const values: Record<string, EffectParamValue> = Object.create(null), changed: Record<string, EffectParamValue> = Object.create(null);
    for (const [name, d] of Object.entries(schema)) {
      let value: unknown = Object.hasOwn(overrides, name) ? (overrides as Record<string, unknown>)[name] : d.default;
      if (d.type === "number" || d.type === "int") {
        if (typeof value !== "number" || !Number.isFinite(value) || value < d.min || value > d.max || d.type === "int" && !Number.isSafeInteger(value) || d.type === "number" && d.step !== undefined && !aligned(value, d.min, d.step))
          return { ok: false, error: "invalid_params" };
      }
      else if (d.type === "bool") {
        if (typeof value !== "boolean")
          return { ok: false, error: "invalid_params" };
      }
      else if (d.type === "enum") {
        if (typeof value !== "string" || !d.values.includes(value))
          return { ok: false, error: "invalid_params" };
      }
      else {
        if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value))
          return { ok: false, error: "invalid_params" };
        value = value.toLowerCase();
      }
      values[name] = value as EffectParamValue;
      if (value !== d.default)
        changed[name] = value as EffectParamValue;
    }
    return { ok: true, values, overrides: changed };
  }
  catch {
    return { ok: false, error: "invalid_params" };
  }
}
