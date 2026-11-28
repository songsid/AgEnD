/** Administration aggregates only. Never reads content refs, audit content, or returns person/room identities. */
import type Database from "better-sqlite3";
import type { HubHttpMigration } from "./http/schema.js";
import type { HubCore } from "./http/core.js";
import type { HubFleetVersions } from "./fleet-versions.js";
import type { HubVersionRecommendations } from "./recommendations.js";
import { personKeyString } from "./identity.js";
import { HubProtocolError } from "./validation.js";
import { exposureOf,readExposure } from "./catalog.js";

export const HUB_ADMIN_DASHBOARD_MIGRATION: HubHttpMigration = Object.freeze({ component: "s3-admin-dashboard", version: 1, up(db: Database.Database) {
  // Do not manufacture historical answer times from mutable stage_at or a placeholder's creation time.
  db.exec(`ALTER TABLE hub_messages ADD COLUMN answered_at INTEGER;
ALTER TABLE hub_room_deliveries ADD COLUMN answered_at INTEGER;
CREATE TABLE hub_chain_stop_counts(bucket INTEGER NOT NULL,reason TEXT NOT NULL CHECK(reason IN ('depth','rate')),count INTEGER NOT NULL CHECK(count>0),PRIMARY KEY(bucket,reason));
INSERT INTO hub_chain_stop_counts SELECT (p.created_at/60000)*60000,s.reason,COUNT(*) FROM hub_room_agent_stops s
 JOIN hub_room_posts p ON p.id=s.post_id WHERE s.reason IN ('depth','rate') GROUP BY (p.created_at/60000)*60000,s.reason;
CREATE INDEX hub_dashboard_direct_created ON hub_messages(created_at);
CREATE INDEX hub_dashboard_room_created ON hub_room_deliveries(created_at);
CREATE INDEX hub_dashboard_posts_created ON hub_room_posts(created_at);`);
} });

/** Called only after inserting a new coalesced stop, inside that same transaction. No room/agent/person key is retained. */
export function countChainStop(db: Database.Database, reason: string, now: number): void {
  if (reason !== "depth" && reason !== "rate") return;
  db.prepare(`INSERT INTO hub_chain_stop_counts VALUES(?,?,1) ON CONFLICT(bucket,reason) DO UPDATE SET count=count+1`)
    .run(Math.floor(now / 60_000) * 60_000, reason);
  db.prepare("DELETE FROM hub_chain_stop_counts WHERE bucket<?").run(now - 9 * 86_400_000);
}

function calendar(now: number, timeZone: string) {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { throw new HubProtocolError("invalid"); }
  const date = (at: number) => {
    const parts = formatter.formatToParts(at), part = (name: string) => parts.find(p => p.type === name)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const today = date(now), day = Date.parse(`${today}T00:00:00Z`);
  const days = Array.from({ length: 7 }, (_, i) => new Date(day - (6 - i) * 86_400_000).toISOString().slice(0, 10));
  // Find local calendar midnight, including a 23/25-hour DST day, without a fixed-offset approximation.
  const start = (label: string) => {
    const nominal = Date.parse(`${label}T00:00:00Z`);
    let lo = nominal - 36 * 3_600_000, hi = nominal + 36 * 3_600_000;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (date(mid) < label) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const starts = days.map(start);
  return { days, starts, today: starts[6]!, week: starts[0]! };
}
type Reason = "offline" | "timedOut" | "permissionEnded" | "stoppedOrRefused" | "unknown";
function reasonGroup(reason: string | null): Reason {
  if (reason === "offline") return "offline";
  if (reason === "expired") return "timedOut";
  if (["revoked", "denied", "stale", "retired", "publication-changed"].includes(reason ?? "")) return "permissionEnded";
  if (["incompatible", "interrupted", "rejected", "stopped", "refused", "owner-stopped-sharing"].includes(reason ?? "")) return "stoppedOrRefused";
  // unavailable/uncertain do not prove that the Fleet was offline.
  return "unknown";
}
const typical = (values: number[]) => {
  if (values.length < 5) return { medianMs: null, p90Ms: null, samples: values.length };
  values.sort((a, b) => a - b);
  const n = values.length;
  return { medianMs: n % 2 ? values[Math.floor(n / 2)]! : (values[n / 2 - 1]! + values[n / 2]!) / 2,
    p90Ms: values[Math.ceil(n * .9) - 1]!, samples: n };
};
interface Question { exposure: string; created: number; answered: number; answered_at: number | null; terminal: number; reason: string | null }

export class HubAdminDashboard {
  constructor(private readonly core: HubCore, private readonly versions: HubFleetVersions, private readonly recommendations: HubVersionRecommendations) {}
  view(params: URLSearchParams, permit: { assertCurrent(): void }) {
    for (const key of params.keys()) if (!["range", "timeZone"].includes(key) || params.getAll(key).length !== 1) throw new HubProtocolError("invalid");
    const range = params.get("range") ?? "7d", timeZone = params.get("timeZone") ?? "UTC";
    if (!["today", "7d"].includes(range) || !timeZone || timeZone.length > 100) throw new HubProtocolError("invalid");
    const now = this.core.now(), cal = calendar(now, timeZone), start = range === "today" ? cal.today : cal.week;
    const recommendation = this.recommendations.settings(), fleets = this.core.deps.store.read().fleets.filter(f => f.status === "active");
    return this.core.atomic(db => {
      permit.assertCurrent();
      const fleetViews = fleets.map(f => this.versions.view(f.id, recommendation.recommendedVersion, db));
      const count = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;
      const active = (since: number) => count("SELECT COUNT(DISTINCT person) n FROM hub_sessions WHERE seen_at>=? AND seen_at<=?", since, now);
      const people = { total: count("SELECT COUNT(*) n FROM hub_people"), activeToday: active(cal.today), active7d: active(cal.week),
        joined7d: count("SELECT COUNT(*) n FROM (SELECT person,MIN(created_at) first_at FROM hub_sessions GROUP BY person) WHERE first_at>=? AND first_at<=?", cal.week, now),
        signedInNow: count(`SELECT COUNT(DISTINCT s.person) n FROM hub_sessions s JOIN hub_people p ON p.person=s.person
          WHERE s.state='active' AND p.status='active' AND s.directory_epoch=? AND s.expires_at>? AND s.seen_at>=? AND s.seen_at<=?`, this.core.directoryEpoch, now, now - 5 * 60_000, now) };
      const questions = db.prepare(`SELECT exposure_id exposure,created_at created,answer_id IS NOT NULL answered,answered_at,
          (stage IN ('rejected','cancelled','failed','uncertain') OR expires_at<=?) terminal,
          CASE WHEN stage NOT IN ('rejected','cancelled','failed','uncertain') AND expires_at<=? THEN 'expired' ELSE reason_code END reason
          FROM hub_messages WHERE created_at>=? AND created_at<=?
        UNION ALL SELECT exposure_id,created_at,state='answered',answered_at,(state IN ('retired','expired') OR expires_at<=?),
          CASE WHEN state='retired' THEN COALESCE(reason_code,'retired') WHEN state='expired' OR expires_at<=? THEN 'expired' ELSE NULL END
          FROM hub_room_deliveries WHERE created_at>=? AND created_at<=?`)
        .all(now, now, cal.week, now, now, now, cal.week, now) as Question[];
      const selected = questions.filter(q => q.created >= start), times: number[] = [];
      const reasons: Record<Reason, number> = { offline: 0, timedOut: 0, permissionEnded: 0, stoppedOrRefused: 0, unknown: 0 };
      const perDay = cal.days.map(date => ({ date, count: 0 }));
      for (const q of questions) {
        let index = cal.starts.length - 1; while (index >= 0 && q.created < cal.starts[index]!) index--;
        if (index >= 0) perDay[index]!.count++;
      }
      const agentCounts = new Map<string, { questions: number; notAnswered: number; times: number[] }>();
      for (const q of selected) {
        const failed = !q.answered && !!q.terminal;
        if (failed) reasons[reasonGroup(q.reason)]++;
        const ms = q.answered && q.answered_at !== null && q.answered_at >= q.created ? q.answered_at - q.created : null;
        if (ms !== null) times.push(ms);
        const agent = agentCounts.get(q.exposure) ?? { questions: 0, notAnswered: 0, times: [] };
        agent.questions++; if (failed) agent.notAnswered++; if (ms !== null) agent.times.push(ms); agentCounts.set(q.exposure, agent);
      }
      const waiting = db.prepare(`SELECT COUNT(*) n,MIN(created) oldest FROM (
        SELECT created_at created FROM hub_messages WHERE answer_id IS NULL AND stage NOT IN ('rejected','cancelled','failed','uncertain') AND expires_at>? AND created_at<=?
        UNION ALL SELECT created_at FROM hub_room_deliveries WHERE state IN ('queued','sent') AND expires_at>? AND created_at<=?)`).get(now, now, now, now) as { n: number; oldest: number | null };
      const exposures = db.prepare("SELECT e.id,e.display_name,e.owner,e.fleet_id,e.state,e.frozen_through,e.revision,p.display_name owner_name FROM hub_exposures e LEFT JOIN hub_people p ON p.person=e.owner").all() as
        { id: string; display_name: string; owner: string; owner_name: string | null; fleet_id: string|null; state: string; frozen_through: number; revision: number }[];
      const topAgents = [...agentCounts].sort((a, b) => b[1].questions - a[1].questions || a[0].localeCompare(b[0])).slice(0, 5).map(([id, a]) => {
        const e = exposures.find(e => e.id === id);
        return { id, name: e?.display_name ?? "Agent", ownerName: e?.owner_name ?? null, questions: a.questions,
          medianMs: typical(a.times).medianMs, notAnswered: a.notAnswered };
      });
      const posts = db.prepare(`SELECT p.author_kind,COUNT(*) n FROM hub_room_posts p JOIN hub_group_rooms r ON r.id=p.room_id
        WHERE r.assistant_for IS NULL AND p.author_kind<>'system' AND (p.stage IS NULL OR p.stage='answered') AND p.created_at>=? AND p.created_at<=? GROUP BY p.author_kind`).all(start, now) as { author_kind: string; n: number }[];
      const byAuthor = { people: posts.find(p => p.author_kind === "person")?.n ?? 0, agents: posts.find(p => p.author_kind === "agent")?.n ?? 0, assistant: posts.find(p => p.author_kind === "assistant")?.n ?? 0 };
      return { generatedAt: now, range, timeZone, start, end: now, people,
        questions: { asked: selected.length, perDay, answerTime: typical(times), waiting: waiting.n, longestWaitMs: waiting.oldest === null ? null : now - waiting.oldest,
          notAnswered: { total: Object.values(reasons).reduce((a, b) => a + b, 0), reasons } }, topAgents,
        sharedAgents: exposures.filter(e => {
          if(e.state!=="published"||e.frozen_through>=e.revision)return false;
          if(e.fleet_id!==null)return fleets.some(f=>f.id===e.fleet_id&&personKeyString(f.owner)===e.owner);
          const row=readExposure(db,e.id),personal=row&&exposureOf(row);
          if(!personal||personal.kind!=="personal"||!this.core.deps.personal)return false;
          try{this.core.deps.personal.assertSource(db,personal);return true;}catch{return false;}
        }).length,
        fleets: { total: fleets.length, connected: fleetViews.filter(f => f.connected).length, needsUpdate: fleetViews.filter(f => f.versionState === "needs-update").length,
          tooOldRooms: fleetViews.filter(f => f.versionState === "too-old-rooms").length, unknownVersion: fleetViews.filter(f => f.versionState === "unknown").length, recommendedVersion: recommendation.recommendedVersion },
        rooms: { total: count("SELECT COUNT(*) n FROM hub_group_rooms WHERE assistant_for IS NULL"),
          active: count(`SELECT COUNT(DISTINCT p.room_id) n FROM hub_room_posts p JOIN hub_group_rooms r ON r.id=p.room_id
            WHERE r.assistant_for IS NULL AND p.author_kind<>'system' AND (p.stage IS NULL OR p.stage='answered') AND p.created_at>=? AND p.created_at<=?`, start, now),
          created7d: count("SELECT COUNT(*) n FROM hub_group_rooms WHERE assistant_for IS NULL AND created_at>=? AND created_at<=?", cal.week, now),
          messages: Object.values(byAuthor).reduce((a, b) => a + b, 0), byAuthor,
          agentQuestions: count("SELECT COUNT(*) n FROM hub_room_deliveries WHERE created_at>=? AND created_at<=?", start, now),
          chainsStopped: count("SELECT COALESCE(SUM(count),0) n FROM hub_chain_stop_counts WHERE bucket>=? AND bucket<=?", start, now) } };
    }, permit);
  }
}
