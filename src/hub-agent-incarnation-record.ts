/** Durable lifecycle evidence, colocated with the current Hub incarnation. Never a contact approval. */
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
const retired = z.strictObject({ id: z.uuid(), fp: z.string().regex(/^[a-f0-9]{64}$/), at: z.number().int().nonnegative() });
const record = z.strictObject({
 id: z.uuid().optional(), fp: z.string().regex(/^[a-f0-9]{64}$/).optional(), classic: z.boolean().optional(),
 retired: z.array(retired).max(8).optional(), requestWork: z.enum(["pending", "registered"]).optional(),
}).superRefine((value, ctx) => {
 if (!!value.id !== !!value.fp || !value.id && (!value.retired?.length || value.requestWork)) ctx.addIssue({ code: "custom", message: "Invalid incarnation record" });
 const ids = [value.id, ...(value.retired ?? []).map(item => item.id)].filter(Boolean);
 if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Duplicate incarnation evidence" });
});
export type HubAgentIncarnationRecord = z.infer<typeof record>;
export function readHubAgentIncarnationRecord(value: unknown): HubAgentIncarnationRecord { return record.parse(value); }
export function hubAgentIncarnationToken(agent: string, id: string): string {
 return createHash("sha256").update(JSON.stringify(["agend-hub-agent-v2", agent, z.uuid().parse(id)])).digest("hex");
}
export function rotateHubAgentIncarnation(previous: unknown | undefined, fp: string, classic: boolean, now = Date.now()): HubAgentIncarnationRecord {
 const old = previous === undefined ? undefined : readHubAgentIncarnationRecord(previous);
 return readHubAgentIncarnationRecord({ id: randomUUID(), fp, ...(classic ? { classic: true } : {}), requestWork: "pending",
  retired: [...(old?.retired ?? []), ...(old?.id ? [{ id: old.id, fp: old.fp!, at: now }] : [])].slice(-8) });
}
export function forgetHubAgentIncarnation(previous: unknown, now = Date.now()): HubAgentIncarnationRecord {
 const old = readHubAgentIncarnationRecord(previous);
 return readHubAgentIncarnationRecord({ ...(old.classic ? { classic: true } : {}),
  retired: [...(old.retired ?? []), ...(old.id ? [{ id: old.id, fp: old.fp!, at: now }] : [])].slice(-8) });
}
/** Missing or evicted history is unavailable, never evidence that a missing work row is new. */
export function requestWorkRegistrationEvidence(agent: string, value: unknown, incarnation: string, previous: string | null): "resume" | "birth" | "successor" {
 const row = readHubAgentIncarnationRecord(value);
 if (!row.id || hubAgentIncarnationToken(agent, row.id) !== incarnation) throw Error("Request work registration evidence unavailable");
 if (previous === incarnation) return "resume";
 if (!row.requestWork) throw Error("Request work registration evidence unavailable");
 if (row.requestWork !== "pending") throw Error("Request work registration evidence consumed");
 if (previous === null && !(row.retired?.length)) return "birth";
 if (previous && row.retired?.some(item => hubAgentIncarnationToken(agent, item.id) === previous)) return "successor";
 throw Error("Request work predecessor is unavailable");
}
