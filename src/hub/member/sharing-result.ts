import { exposureRequestResultSchema, exposureUndoSchema, type HubExposurePointer, type HubExposureRequestResult, type HubExposureUndo } from "../agent-catalog-model.js";
import { hubSharingNoticeSchema, type HubSharingNotice } from "../../hub-sharing-notice.js";
import { validated, HubProtocolError } from "../validation.js";
import type { SharingRecord } from "./sharing-journal.js";
const pointer = (value: NonNullable<SharingRecord["rows"][number]["after"]>): HubExposurePointer => ({
  id: value.exposure.id, revision: value.exposure.revision, state: value.exposure.state,
});
export function sharingResult(record: SharingRecord): HubExposureRequestResult {
  if (!record.finalNoticeDurable || record.noticeAt === null || record.undoUntil === null) throw new HubProtocolError("unavailable");
  const results = record.rows.map(row => {
    const target = row.action === "share" ? { instance: row.target } : { exposureId: row.target };
    if (!row.outcome) throw new HubProtocolError("unavailable");
    return row.outcome.ok ? { ...target, ok: true, before: row.before ? pointer(row.before) : null, after: pointer(row.after!) }
      : { ...target, ...row.outcome };
  });
  return validated(exposureRequestResultSchema, { noticeAt: record.noticeAt, undoUntil: record.undoUntil, results });
}
export function sharingUndo(record: SharingRecord): HubExposureUndo {
  if (!record.undoId || record.noticeAt === null || !record.undoNoticeDurable) throw new HubProtocolError("unavailable");
  const results = record.rows.flatMap((row, index) => {
    if (!row.outcome?.ok) return [];
    if (!row.undoOutcome) throw new HubProtocolError("unavailable");
    return [row.undoOutcome.ok ? { index, ok: true, before: pointer(row.after!), after: pointer(row.undoAfter!) }
      : { index, ...row.undoOutcome }];
  });
  return validated(exposureUndoSchema, { originalRequestId: record.id, noticeAt: record.noticeAt, results });
}
export function sharingNotice(record: SharingRecord, hubName: string): HubSharingNotice {
  if (record.noticeAt === null || record.undoUntil === null) throw new HubProtocolError("unavailable");
  return validated(hubSharingNoticeSchema, {
    key: record.noticeKey, hubName, byName: record.request.byName ?? "Hub owner", at: record.noticeAt, undoUntil: record.undoUntil,
    version: 1 + record.rows.filter(row => row.outcome !== null).length + (record.undoId ? 100 + record.rows.filter(row => row.undoOutcome !== null).length : 0),
    state: record.undoId ? record.rows.every(row => !row.outcome?.ok || row.undoOutcome !== null) ? "undone" : "undoing" : record.rows.every(row => row.outcome !== null) ? "complete" : "pending",
    rows: record.rows.map(row => ({ name: row.name, kind: row.kind, action: row.action,
      state: row.undoOutcome ? row.undoOutcome.ok ? "undone" : "changed" : !row.outcome ? "pending" : !row.outcome.ok ? "refused" : row.action === "share" ? "shared" : "stopped",
      ...((row.undoOutcome && !row.undoOutcome.ok ? row.undoOutcome.code : row.outcome && !row.outcome.ok ? row.outcome.code : null) ? {
        code: row.undoOutcome && !row.undoOutcome.ok ? row.undoOutcome.code : (row.outcome as { code: string }).code } : {}) })),
  });
}
