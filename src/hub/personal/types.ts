import type Database from "better-sqlite3";
import type { HubOperationPermit } from "../http/core.js";
import type { HubPersonalExposure, HubTx } from "../types.js";

export interface PersonalJob {
  id: string; personal_agent_id: string; direct_message_id: string|null; room_delivery_id: string|null;
  machine_id: string; machine_generation: number|null; owner: string; exposure_revision: number;
  state: "queued"|"working"|"answered"|"failed"; reason: string|null;
  created_at: number; started_at: number|null; finished_at: number|null;
}
export type PersonalOutcome = { text: string } | { reason: string };
/** Each conversation retains its own audience, consent and audit checks. No Runtime ACK proves an answer. */
export interface PersonalQuestionAdapter {
  prepare(job: PersonalJob): Promise<{ prompt: string; permit: HubOperationPermit }>;
  settle(db: Database.Database, tx: HubTx, job: PersonalJob, outcome: PersonalOutcome): void;
  changed(job: PersonalJob): void;
}
export interface HubPersonalPort {
  assertSource(db: Database.Database, exposure: HubPersonalExposure): void;
  enqueue(db: Database.Database, exposure: HubPersonalExposure, source: { direct: string }|{ room: string }): void;
  presence(exposureId: string): "idle"|"working"|"paused"|"offline"|"later";
  wake(): void;
}
