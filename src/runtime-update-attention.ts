/** Display-only failed-build notices, derived from the authenticated machine reports already in memory. */
import type { RuntimeMachine } from "./runtime-protocol.js";
import type { RuntimeUpdateAttentionInput } from "./needs-you.js";
export function runtimeUpdateAttention(machines: readonly RuntimeMachine[], t: (key: string, ...args: Array<string | number>) => string,
  owner?: string): RuntimeUpdateAttentionInput[] {
  return machines.flatMap(machine => {
    const report = machine.updateReport;
    if (machine.status === "revoked" || report?.status.state !== "failed") return [];
    const target = report.status.target;
    return [{ key: `${machine.id}:${target.bundleSha256}`, owner, since: report.reportedAt,
      detail: t("runtime.update.failed", machine.name, target.version, target.bundleSha256.slice(0, 8)) }];
  });
}
