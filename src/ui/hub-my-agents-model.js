/** Presentation only. A private local pointer or an accepted request is never publication authority. */
export function shareRows(fleet, mine) {
  const seen = new Set();
  const rows = (fleet.catalog?.agents || []).map(row => {
    const exposure = row.exposure ? mine.find(x => x.id === row.exposure.id && x.fleetId === fleet.id) : null;
    if (exposure) seen.add(exposure.id);
    return { ...row, current: exposure, shared: !!exposure && exposure.state !== "withdrawn" };
  });
  for (const x of mine) if (x.fleetId === fleet.id && !seen.has(x.id)) rows.push({ instance: null, displayName: x.displayName, description: "", current: x, shared: x.state !== "withdrawn", shareable: false, reason: "old", general: false, kind: "agent" });
  return rows.sort((a, b) => Number(a.general) - Number(b.general) || a.displayName.localeCompare(b.displayName));
}
export function rowAvailability(fleet, row, publish, sharedCount) {
  if (!fleet.connected) return "offline";
  if (!fleet.catalogSupported || !fleet.catalog?.requests) return "old";
  if (!fleet.catalog.enabled) return "off";
  if (!row.instance) return "old";
  if (fleet.policyState === "suspended" || fleet.policyState === "revoked") return fleet.policyState;
  if (fleet.policyState === "unknown") return "unknown";
  if (row.shared) return null;
  if (publish?.state !== "allow") return publish?.state === "deny" ? "denied" : "unknown";
  if (!row.shareable) return row.reason === "remote-windows" ? "remote" : "unavailable";
  return sharedCount >= 64 ? "limit" : null;
}
export const rowKey = (fleet, row) => `${fleet.id}:${row.instance || row.current?.id}`;
export function reconcileSharing(operation, fleets, mine, now = Date.now()) {
  const fleet = fleets.find(f => f.id === operation.input.fleetId), results = operation.response?.result?.results || [];
  const rows = operation.rows.map(row => {
    const share = !!row.instance, result = results.find(r => share ? r.instance === row.instance : r.exposureId === row.id);
    const local = fleet?.catalog?.agents.find(a => share ? a.instance === row.instance : a.exposure?.id === row.id);
    const pointer = result?.ok ? result.after : local?.exposure;
    const current = mine.find(x => x.id === (share ? pointer?.id : row.id) && x.fleetId === operation.input.fleetId);
    const changed = pointer && pointer.revision > (row.before?.revision || 0);
    const done = share ? changed && current?.revision >= pointer.revision && ["published", "paused"].includes(current.state)
      : !current && changed && pointer.state === "withdrawn";
    if (done) return { ...row, state: "done", current: share ? current : null };
    if (result?.ok === false) return { ...row, state: "refused", code: result.code };
    const expired = ["expired", "revoked"].includes(operation.response?.state);
    if (expired && fleet?.catalog?.at > operation.at && (share ? !current : current?.revision === row.before?.revision)) return { ...row, state: "closed" };
    return { ...row, state: now - operation.at >= 30_000 ? "uncertain" : "pending" };
  });
  return { rows, settled: rows.every(r => ["done", "refused", "closed"].includes(r.state)) };
}
