/** Resolve only current room labels, ignoring quoted code, escapes and email addresses. */
export interface MentionMember { id: string; kind: string; subject: string; name: string; login?: string }
export interface MentionResolution { people: string[]; agents: string[]; ambiguous: string[]; all: boolean }
const folded = (s: string) => s.toLocaleLowerCase("en-US");
export function resolveRoomMentions(text: string, members: readonly MentionMember[], source: string): MentionResolution {
  const labels = new Map<string, { label: string; members: MentionMember[] }>();
  for (const m of members) for (const label of [m.name, ...(m.kind === "person" && m.login ? [m.login] : [])]) {
    if (!label || label.length > 256) continue;
    const key = folded(label), entry = labels.get(key) ?? { label, members: [] };
    if (!entry.members.some(row => row.id === m.id)) entry.members.push(m);
    labels.set(key, entry);
  }
  const all = ["All agents", "所有 Agent", "all"], choices = [...new Set([...labels.keys(), ...all.map(folded)])].sort((a, b) => b.length - a.length);
  const result: MentionResolution = { people: [], agents: [], ambiguous: [], all: false };
  // Mask code without shifting offsets. Both single-line and fenced backtick/tilde spans are ordinary text here.
  const visible = text.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)|`[^`\n]*`/g, s => " ".repeat(s.length));
  const input = folded(visible);
  for (let at = 0; at < input.length; at++) {
    if (input[at] !== "@" || at > 0 && /[\p{L}\p{N}_@\\]/u.test(input[at - 1]!)) continue;
    const match = choices.find(label => input.startsWith(label, at + 1) && !/[\p{L}\p{N}_-]/u.test(input[at + label.length + 1] ?? ""));
    if (!match) continue;
    at += match.length;
    if (all.some(label => folded(label) === match)) { result.all = true; continue; }
    const entry = labels.get(match)!;
    if (entry.members.length !== 1) { if (!result.ambiguous.includes(entry.label)) result.ambiguous.push(entry.label); continue; }
    const m = entry.members[0]!;
    if (m.kind === "agent" && m.subject !== source && !result.agents.includes(m.subject)) result.agents.push(m.subject);
    if (m.kind === "person" && !result.people.includes(m.id)) result.people.push(m.id);
  }
  return result;
}
