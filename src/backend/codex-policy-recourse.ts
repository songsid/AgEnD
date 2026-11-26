/** Codex 0.169 provider-policy picker. Match the live bottom region, never transcript mentions or suggestions. */
export const CODEX_POLICY_RECOURSE_TITLE = "You can choose a rewrite to start a new chat with your earlier context:";

export function codexPolicyRecourseVisible(pane: string): boolean {
  const rows = pane.replace(/\r/g, "").split("\n").map(row => row.trimEnd());
  while (rows.length && !rows.at(-1)!.trim()) rows.pop();
  if (!/^\s*enter select · esc back\s*$/.test(rows.at(-1) ?? "")) return false;
  // A narrow terminal can wrap the fixed title, but never more than three rows.
  for (let i = Math.max(0, rows.length - 28); i < rows.length - 2; i++) {
    for (let n = 1; n <= 3; n++) {
      if (rows.slice(i, i + n).map(row => row.trim()).join(" ") !== CODEX_POLICY_RECOURSE_TITLE) continue;
      const options = rows.slice(i + n, -1).filter(row => row.trim());
      if (options.length < 3 || options.length > 5) continue;
      let selected = 0;
      const valid = options.every((row, index) => {
        const m = row.match(/^\s*([›❯>])?\s*(\d+)\.\s+\S.*$/);
        if (m?.[1]) selected++;
        return !!m && Number(m[2]) === index + 1;
      });
      if (valid && selected === 1) return true;
    }
  }
  return false;
}
