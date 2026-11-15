/** M-3180: Grok's one-shot switch contract captured on retained1.0.70 with a netless mock. */
import { compareVersions, versionOf } from "../cli-audited.js";
export const GROK_INLINE_MODEL_MIN = "1.0.70"; // oldest complete captured inline model+effort contract
export type GrokSwitchWant = { model: string | null; effort: string | null };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/+\[\]=-]{0,127}$/;
const EFFORT = /^(?:low|medium|high|xhigh)$/;
export function grokSupportsInlineModel(version: string | null | undefined): boolean {
  const v = versionOf(version ?? null); return v !== null && compareVersions(v, GROK_INLINE_MODEL_MIN) >= 0;
}
export function grokSwitchCommand(want: GrokSwitchWant): string | null {
  if (want.model !== null && !ID.test(want.model) || want.effort !== null && !EFFORT.test(want.effort)) return null;
  if (want.model === null) return want.effort !== null ? `/effort ${want.effort}` : null;
  return `/model ${want.model}${want.effort !== null ? ` ${want.effort}` : ""}`;
}
type Answer = { line: string; model?: string; effort?: string | null; refused?: true };
function answers(pane: string): Answer[] {
  const result: Answer[] = []; let fenced = false;
  for (const line of pane.replace(/\r/g, "").split("\n")) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^     Switched to (\S+)(?: \((low|medium|high|xhigh) effort\))?\s*$/.exec(line);
    if (m) result.push({ line, model: m[1]!, effort: m[2] ?? null });
    else if (/^     (?:Unknown model:|unknown effort level |current model does not support reasoning effort|no active model to apply effort to)/.test(line)) result.push({ line, refused: true });
  }
  return result;
}
export function grokSwitchVerdict(want: GrokSwitchWant, before: string, after: string): { outcome: "switched"; confirmed: true; shown: string } | { outcome: "mismatch"; answered: true; shown: string } | null {
  const old = answers(before), next = answers(after), newest = next.at(-1);
  if (!newest || next.filter(a => a.line === newest.line).length <= old.filter(a => a.line === newest.line).length) return null;
  // Grok's transient notices can replace the previous notice, so freshness is per exact answer, not total row count.
  if (newest.refused) return { outcome: "mismatch", answered: true, shown: newest.line.trim() };
  const fits = (want.model === null || newest.model === want.model) && (want.effort === null || newest.effort === want.effort);
  return fits ? { outcome: "switched", confirmed: true, shown: newest.line.trim() } : { outcome: "mismatch", answered: true, shown: newest.line.trim() };
}
