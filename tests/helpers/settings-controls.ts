/**
 * Settings → Shared agent settings draws a few fields as a segmented choice (a radio group) or an on/off switch (a
 * checkbox with role="switch") instead of a <select>. These read and drive them the way the page's own events do.
 */
import { fire } from "./mini-dom.js";
import { settle } from "./app-harness.js";

const radios = (seg: any): any[] => seg.querySelectorAll("input[type=radio]");
/** The value of the segmented choice (the option that is on), or null. */
export const segValue = (seg: any): string | null => radios(seg).find((r) => r.checked)?.value ?? null;
/** The values the segmented choice offers, in order. */
export const segOptions = (seg: any): string[] => radios(seg).map((r) => r.value);
/** Pick one option of a segmented choice. */
export async function pickSeg(seg: any, value: string) {
  const radio = radios(seg).find((r) => r.value === value);
  if (!radio) throw new Error(`no option ${value} in ${segOptions(seg).join(", ")}`);
  radio.checked = true; fire(radio, "change"); await settle();
}
