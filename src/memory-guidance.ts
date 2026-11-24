/**
 * M-3523 / S-215 (instruction inventory rec 10): the memory guidance every Fleet agent receives, General included.
 * One place for soul.md: core-rules keeps only what is General's own (fleet decisions and bundled skills) and points here.
 */
export const MEMORY_SECTION = [
  "## Memory",
  "`soul.md` in your working directory is your long-form memory. AgEnD does not load it: read it when you resume work.",
  "- Parts: **Current state** (work, to-dos, decisions; rewrite it to describe now), **Rules** (actions, with reasons), **History index** (one line per finished task, with where to look).",
  "- Keep it near 30 KB: every line costs context, and stale cautions make you hesitate.",
  "- Update it after multi-step work that taught you something reusable and before compaction; routine work needs none.",
  "- None yet? After the first such task, ask the user once (with buttons if you can) whether to create it; on no, write `soul.declined` there and consider it answered.",
  "- Propose a skill for a workflow worth reusing.",
].join("\n");
