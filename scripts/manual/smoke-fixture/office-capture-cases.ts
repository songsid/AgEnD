/** Pure selection/verdict shared by the owned Office screenshot harness and its controls. */
const officeCases = [
  { device: "desk", theme: "light", lang: "en", rm: false },
  { device: "desk", theme: "dark", lang: "zh-TW", rm: false },
  { device: "desk", theme: "light", lang: "en", rm: true },
  { device: "phone", theme: "light", lang: "en", rm: false },
] as const;

export function selectOfficeCaptureCases(selector?: string) {
  const selected = officeCases.filter(c => !selector || selector === `${c.device}-${c.theme}-${c.lang}${c.rm ? "-reduced" : ""}`);
  if (selected.length === 0) throw new Error(`Unknown Office capture case: ${selector}`);
  return selected;
}

export function officeCapturePassed(cases: Record<string, { failed?: unknown }>): boolean {
  const exercised = Object.values(cases);
  return exercised.length > 0 && exercised.every(result => !result.failed);
}
