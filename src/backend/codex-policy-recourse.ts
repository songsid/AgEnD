import { selectionCard } from "../selection-card.js";

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
      const body = rows.slice(i + n, -1).filter(row => row.trim());
      let selected = 0, count = 0;
      const valid = body.every(row => {
        const m = row.match(/^\s*([›❯>])?\s*(\d+)\.\s+\S.*$/);
        if (m) {
          if (m[1]) selected++;
          return Number(m[2]) === ++count;
        }
        // Native wrapped labels are deeper-indented continuations, never another prompt/footer.
        return count > 0 && /^ {4,}[^\s›❯>•■]/.test(row);
      });
      if (valid && count >= 3 && count <= 5 && selected === 1) return true;
    }
  }
  return false;
}

/** Keep the CLI's own labels and binding; only a signed-in person's explicit choice may answer it. */
export function codexPolicyRecourseCard(pane: string) {
  if (!codexPolicyRecourseVisible(pane)) return null;
  const card = selectionCard(pane, "Codex");
  return card ? { ...card, humanOnly: true as const, policyRecourse: true as const } : null;
}
