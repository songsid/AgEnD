/** Display-only, versioned translations. The original strings remain the confirmation/chat record. */
import { t } from "./locale.js";
export type SettingsSummaryPart = string | { key: string; args: readonly (string | number)[] };
export interface SettingsSummaryLine { text: string; parts: readonly SettingsSummaryPart[] }
export interface SettingsSummaryDescriptor { v: 1; fallback: string; parts: readonly SettingsSummaryPart[] }
export type SettingsSummaryPresentation = readonly (SettingsSummaryDescriptor | null)[];
/** Callers pass only values already safe for the rendered diff: escaped labels, public facts or fingerprints. */
export const summaryMessage = (key: string, ...args: (string | number)[]): SettingsSummaryPart => ({ key, args });
export const summaryLine = (text: string, ...parts: SettingsSummaryPart[]): SettingsSummaryLine => ({ text, parts });
export const translatedSummary = (key: string, ...args: (string | number)[]): SettingsSummaryLine => summaryLine(t(key, ...args), summaryMessage(key, ...args));
export function settingsSummary(lines: readonly (string | SettingsSummaryLine)[]): { summary: string[]; summary_i18n: SettingsSummaryPresentation } {
  return { summary: lines.map(line => typeof line === "string" ? line : line.text),
    summary_i18n: lines.map(line => typeof line === "string" ? null : { v: 1, fallback: line.text, parts: line.parts }) };
}

/** Copy before notification awaits. Malformed/future metadata loses only its display enhancement. */
export function copySettingsSummary(summary: readonly string[], input: SettingsSummaryPresentation | undefined): SettingsSummaryPresentation | undefined {
  if (!Array.isArray(input) || input.length !== summary.length || input.length > 32) return undefined;
  let units = 0;
  const copied = input.map((line, index): SettingsSummaryDescriptor | null => {
    if (!line || line.v !== 1 || line.fallback !== summary[index] || !Array.isArray(line.parts) || !line.parts.length || line.parts.length > 64) return null;
    units += line.fallback.length;
    if (units > 16_384) return null;
    const parts: SettingsSummaryPart[] = [];
    for (const part of line.parts) {
      if (typeof part === "string") { units += part.length; parts.push(part); }
      else if (part && typeof part.key === "string" && part.key.length <= 128 && Array.isArray(part.args) && part.args.length <= 8
        && part.args.every((arg: unknown) => typeof arg === "string" || typeof arg === "number" && Number.isFinite(arg))) {
        units += part.key.length + part.args.reduce((sum: number, arg: string | number) => sum + String(arg).length, 0);
        parts.push({ key: part.key, args: [...part.args] });
      } else return null;
      if (units > 16_384) return null;
    }
    return { v: 1, fallback: line.fallback, parts };
  });
  return copied.some(Boolean) ? copied : undefined;
}
