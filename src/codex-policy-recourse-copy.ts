/** Provider labels stay verbatim; only explanation counts are interpreted. */
export function policyRecourseChoices(labels: readonly string[]) {
  const titles = labels.map(s => s.replace(/^\d+\.\s+/, ""));
  return { count: titles.filter(s => s !== "Give feedback" && s !== "Enable Daybreak").length,
    feedback: titles.at(-1) === "Give feedback" };
}
