import type { FleetConfig } from "./types.js";
import { settingsChangeDiff } from "./settings-change.js";
import { settingsFingerprint } from "./settings-transaction.js";

/** Server-owned effect scope. A delivery General is never an authority member. */
export interface SettingsChangeAuthority {
  readonly connections: readonly string[];
  readonly primaryGeneral: boolean;
  readonly unknown: boolean;
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => settingsFingerprint(a) === settingsFingerprint(b);
const sensitive = (a: unknown, b: unknown): boolean => settingsChangeDiff(a, b, { operation: "authority" }) !== null;
const channels = (cfg: FleetConfig | null): readonly any[] => cfg?.channels ?? (cfg?.channel ? [cfg.channel] : []);
const idOf = (ch: any): string | undefined => object(ch) && typeof (ch.id ?? ch.type) === "string" && (ch.id ?? ch.type) ? ch.id ?? ch.type : undefined;
const own = (obj: any, key: string): any => object(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;

/** Classify the normalized effect, independently of the prompt exclusion list. */
export function settingsEffectAuthority(before: FleetConfig | null, after: FleetConfig | null,
  oldClassic: Record<string, any>, newClassic: Record<string, any>): SettingsChangeAuthority {
  const targets = new Set<string>(), oldChannels = channels(before), newChannels = channels(after);
  let primaryGeneral = false, unknown = false;
  const known = (id: unknown): id is string => typeof id === "string" && !!id && oldChannels.filter(ch => idOf(ch) === id).length === 1;
  const add = (id: unknown): void => { if (known(id)) targets.add(id); else unknown = true; };
  const primary = (cfg: FleetConfig | null): string | undefined => idOf(channels(cfg)[0]);
  const oldIds = oldChannels.map(idOf), newIds = newChannels.map(idOf);
  if ([...oldIds, ...newIds].some(id => !id) || new Set(oldIds).size !== oldIds.length || new Set(newIds).size !== newIds.length) unknown = true;
  if (!same(oldIds, newIds)) primaryGeneral = true;
  for (const id of new Set([...oldIds, ...newIds])) {
    if (!id) continue;
    const old = oldChannels.find(ch => idOf(ch) === id), next = newChannels.find(ch => idOf(ch) === id);
    // An id retained across a platform replacement has no shared user-id
    // namespace. Even an unchanged numeric admin id is not cross-platform proof.
    if (old && next && old.type !== next.type) unknown = true;
    // Keep the complete classifier context, including named-map keys.
    if (!sensitive({ channels: old ? [old] : [] }, { channels: next ? [next] : [] })) continue;
    if (old) add(id); else primaryGeneral = true;
  }
  // A legacy /ui/config effect can update the primary alias independently.
  if (sensitive({ channel: before?.channel }, { channel: after?.channel })) {
    if (before?.channel && after?.channel) add(idOf(before.channel));
    else if (!before?.channels && !after?.channels) primaryGeneral = true;
  }
  const owner = (entry: any, cfg: FleetConfig | null, isNew: boolean): void => {
    if (!object(entry)) { unknown = true; return; }
    const id = own(entry, "channel_id") ?? primary(cfg);
    if (known(id)) add(id);
    else if (isNew && channels(cfg).filter(ch => idOf(ch) === id).length === 1) primaryGeneral = true;
    else unknown = true;
  };
  const oldInstances = before?.instances ?? {}, newInstances = after?.instances ?? {};
  for (const name of new Set([...Object.keys(oldInstances), ...Object.keys(newInstances)])) {
    const old = own(oldInstances, name), next = own(newInstances, name);
    if (!sensitive({ instances: { [name]: old } }, { instances: { [name]: next } })) continue;
    if (old !== undefined) owner(old, before, false);
    if (next !== undefined) owner(next, after, true);
  }
  const rest = (cfg: FleetConfig | null): unknown => cfg && Object.fromEntries(Object.entries(cfg)
    .filter(([key]) => !["channel", "channels", "instances"].includes(key)));
  if (sensitive(rest(before), rest(after))) primaryGeneral = true;
  const oldRows = oldClassic.channels ?? {}, newRows = newClassic.channels ?? {};
  if (!object(oldRows) || !object(newRows)) unknown = true;
  else for (const key of new Set([...Object.keys(oldRows), ...Object.keys(newRows)])) {
    const old = own(oldRows, key), next = own(newRows, key);
    if (!sensitive({ classic: { channels: { [key]: old } } }, { classic: { channels: { [key]: next } } })) continue;
    const classicOwner = (row: any, cfg: FleetConfig | null): void => {
      if (!object(row)) { unknown = true; return; }
      // A legacy row's platform migration can choose a non-primary adapter.
      // Multiple configured owners without a persisted id are not proof.
      if (own(row, "adapterId") === undefined && oldChannels.length !== 1) { unknown = true; return; }
      add(own(row, "adapterId") ?? primary(cfg));
    };
    if (old !== undefined) classicOwner(old, before);
    if (next !== undefined) classicOwner(next, after);
  }
  const classicRest = (cfg: Record<string, any>): unknown => Object.fromEntries(Object.entries(cfg).filter(([key]) => key !== "channels"));
  if (sensitive({ classic: classicRest(oldClassic) }, { classic: classicRest(newClassic) })) primaryGeneral = true;
  // Force-confirmed operations with no classified old target retain the
  // approved fleet/new authority; absent metadata itself is handled as unknown.
  if (!targets.size && !unknown) primaryGeneral = true;
  return { connections: [...targets], primaryGeneral, unknown };
}

/** Verified secret targets include aliases of the same persisted env key. */
export function settingsSecretAuthority(config: FleetConfig | null, target: string | undefined, envKey: string): SettingsChangeAuthority {
  const list = channels(config), ids = new Set<string>(); let unknown = false;
  if (target) ids.add(target);
  for (const ch of list) if (ch.bot_token_env === envKey) { const id = idOf(ch); if (id) ids.add(id); else unknown = true; }
  for (const id of ids) if (list.filter(ch => idOf(ch) === id).length !== 1) unknown = true;
  return { connections: [...ids], primaryGeneral: !target, unknown };
}
