/** M-3180: one-shot agy switches, proved on retained 1.4.7 and 1.5.9 binaries in a netless mock rig. */
import { compareVersions, versionOf } from "../cli-audited.js";
import { agyVariantOf } from "./effort-metadata.js";
import { resolveAgyLaunch } from "./launch-effort.js";
export const AGY_INLINE_MODEL_MIN = "1.4.7"; // oldest captured command+verification contract, not the claimed introduction date
export type AgySwitchWant = { model: string | null; effort: string | null };
export type AgySwitchModel = { id: string; label: string };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const LEVEL = /^(?:minimal|low|medium|high|xhigh|max|ultra)$/;
export function agySupportsInlineModel(version: string | null | undefined): boolean {
  const v = versionOf(version ?? null); return v !== null && compareVersions(v, AGY_INLINE_MODEL_MIN) >= 0;
}
/** Resolve the same model variant a restart launches. Display labels never become extra prompt arguments. */
export function agySwitchTarget(want: AgySwitchWant, models: readonly AgySwitchModel[]): AgySwitchModel | null {
  if (want.model === null || want.effort !== null && !LEVEL.test(want.effort)) return null;
  const entry = models.find(m => m.id === want.model) ?? models.find(m => m.label === want.model);
  if (!entry) return null;
  const launch = resolveAgyLaunch(entry.id, want.effort, models);
  const target = models.find(m => m.id === launch.model && ID.test(m.id)) ?? null;
  if (want.effort !== null && (!target || agyVariantOf(target.id)?.level !== want.effort)) return null;
  return target;
}
export function agySwitchCommand(want: AgySwitchWant, models: readonly AgySwitchModel[]): string | null {
  if (want.model !== null) { const target = agySwitchTarget(want, models); return target ? `/model ${target.id}` : null; }
  return want.effort !== null && LEVEL.test(want.effort) ? `/effort ${want.effort}` : null;
}
/** The CLI's own response rows, not a footer, user prose or a quoted older result. */
function answers(pane: string): Array<{ kind: "model" | "effort" | "refused"; text: string }> {
  const result: Array<{ kind: "model" | "effort" | "refused"; text: string }> = [];
  const rows = pane.replace(/\r/g, "").split("\n");
  let fenced = false;
  for (let i = 0; i < rows.length; i++) {
    if (/^\s*```/.test(rows[i]!)) { fenced = !fenced; continue; }
    if (fenced || !/^> \/(?:model|effort)$/.test(rows[i]!)) continue;
    const m = /^  ⎿  (Model set to (.+)|Effort set to (\S+)|((?:Invalid model|Invalid effort|Unknown effort|Error:).*))\s*$/.exec(rows[i + 1] ?? "");
    if (m) result.push({ kind: m[2] !== undefined ? "model" : m[3] !== undefined ? "effort" : "refused", text: (m[2] ?? m[3] ?? m[4])!.trimEnd() });
  }
  return result;
}
export function agySwitchVerdict(want: AgySwitchWant, before: string, after: string, models: readonly AgySwitchModel[]): { outcome: "switched"; confirmed: true; shown: string } | { outcome: "mismatch"; answered: true; shown: string } | null {
  const old = answers(before), next = answers(after);
  if (next.length <= old.length) return null;
  const newest = next.at(-1)!;
  if (newest.kind === "refused") return { outcome: "mismatch", answered: true, shown: newest.text };
  const target = want.model === null ? null : agySwitchTarget(want, models);
  const fits = want.model !== null ? newest.kind === "model" && !!target && newest.text === target.label
    : newest.kind === "effort" && newest.text === want.effort;
  return fits ? { outcome: "switched", confirmed: true, shown: newest.text } : { outcome: "mismatch", answered: true, shown: newest.text };
}
