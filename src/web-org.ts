/**
 * #1389: the fleet's org chart, as the web shows it (Fleet → Org chart). Presentation only (the user's Discord-first
 * rule): nothing here is a new source of truth. The structure is read from what already exists — fleet.yaml's
 * instances and teams, General (general_topic), each instance's world and thread — and the live state is not here at
 * all: the page takes it from the stream it already follows (status, activity, `needs`).
 */
import type { WorldPlace } from "./needs-you.js";

export interface OrgInstanceConfig {
  description?: unknown;
  tags?: unknown;
}

export interface OrgInput {
  /** Every instance the dashboard lists, in its order (fleet.yaml's, then ClassicBot rooms). */
  names: readonly string[];
  instances: Readonly<Record<string, OrgInstanceConfig | undefined>>;
  teams: Readonly<Record<string, { members?: unknown; description?: unknown } | undefined>> | undefined;
  isGeneral(name: string): boolean;
  isClassic(name: string): boolean;
  /** The platform and group of the world the instance lives in, when it has one. */
  place(name: string): WorldPlace | undefined;
  /** The instance's own thread/topic (or ClassicBot channel) id. */
  topic(name: string): string | undefined;
}

export interface OrgThread {
  platform: "discord" | "telegram";
  url: string;
}

export interface OrgInstance {
  description?: string;
  tags?: string[];
  general?: true;
  classic?: true;
  thread?: OrgThread;
}

export interface OrgTeam {
  name: string;
  description?: string;
  /** As configured, in order; a name the fleet no longer has is kept (the page shows it as missing). */
  members: string[];
}

export interface OrgChart {
  /** General instances (one per world at most, in practice): the top of the chart. */
  general: string[];
  teams: OrgTeam[];
  instances: Record<string, OrgInstance>;
}

const SNOWFLAKE = /^\d{5,25}$/;
const MAX_DESCRIPTION = 500;
const MAX_TAGS = 12;

/**
 * A browser link to an instance's thread: Discord's channel URL, Telegram's topic link. Undefined when the place or
 * the id is not one a link can be built from (Telegram's General topic, 1, has no topic link).
 */
export function threadUrl(place: WorldPlace | undefined, topicId: string | undefined): OrgThread | undefined {
  if (!place || !topicId) return undefined;
  if (place.type === "discord") {
    if (!place.groupId || !SNOWFLAKE.test(place.groupId) || !SNOWFLAKE.test(topicId)) return undefined;
    return { platform: "discord", url: `https://discord.com/channels/${place.groupId}/${topicId}` };
  }
  if (place.type === "telegram") {
    const m = /^-100(\d+)$/.exec(place.groupId ?? "");
    if (!m || !/^\d+$/.test(topicId) || topicId === "1") return undefined;
    return { platform: "telegram", url: `https://t.me/c/${m[1]}/${topicId}` };
  }
  return undefined;
}

const text = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? (s.length > MAX_DESCRIPTION ? `${s.slice(0, MAX_DESCRIPTION - 1)}…` : s) : undefined;
};

export function buildOrgChart(input: OrgInput): OrgChart {
  // Keyed by instance name, and any name the validators accept is a key — "__proto__" included (#1467 review): a
  // prototype-less map makes every assignment an own property, so JSON carries it like any other name.
  const instances = Object.create(null) as Record<string, OrgInstance>;
  const general: string[] = [];
  for (const name of input.names) {
    const cfg = input.instances[name];
    const entry: OrgInstance = {};
    const description = text(cfg?.description);
    if (description) entry.description = description;
    if (Array.isArray(cfg?.tags)) {
      const tags = cfg.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map(t => t.trim()).slice(0, MAX_TAGS);
      if (tags.length) entry.tags = tags;
    }
    if (input.isGeneral(name)) { entry.general = true; general.push(name); }
    if (input.isClassic(name)) entry.classic = true;
    const thread = threadUrl(input.place(name), input.topic(name));
    if (thread) entry.thread = thread;
    instances[name] = entry;
  }
  const teams: OrgTeam[] = [];
  for (const [name, team] of Object.entries(input.teams ?? {})) {
    if (!team) continue;
    const members = Array.isArray(team.members) ? [...new Set(team.members.filter((m): m is string => typeof m === "string" && m !== ""))] : [];
    const description = text(team.description);
    teams.push({ name, ...(description ? { description } : {}), members });
  }
  return { general, teams, instances };
}
