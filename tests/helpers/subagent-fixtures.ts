import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SubagentArtifact, SubagentProjection } from "../../src/subagent-records.js";
const root = join(import.meta.dirname, "../fixtures/subagents-m2739");
const records = (name: string) => readFileSync(join(root, name), "utf8").trim().split("\n").map(line => JSON.parse(line));
export function subagentFixture(backend: SubagentProjection["backend"]): SubagentProjection {
  const children = new Map<string, SubagentArtifact>();
  if (backend === "claude-code") {
    for (const id of ["ab5b36ac3f402d58b", "a9947907a82e086d7"]) children.set(id, {
      records: records(`claude-agent-${id}.jsonl`), meta: JSON.parse(readFileSync(join(root, `claude-agent-${id}.meta.json`), "utf8")),
    });
    return { backend, sessionId: "60fe0b33-f528-4141-ab28-208166c3315d", cwd: "$RIG/work", parent: records("claude-parent.jsonl"), children, now: Date.parse("2026-11-09T07:12:42Z"), live: true };
  }
  for (const file of readdirSync(root).filter(n => n.includes("15-18-36"))) {
    const r = records(file); children.set(r[0].payload.id, { records: r });
  }
  return { backend, sessionId: "01a1bf2c-0674-7b81-be8e-36e9fc503cc7", cwd: "$RIG/work",
    parent: records("codex-rollout-2026-11-09T15-18-16-01a1bf2c-0674-7b81-be8e-36e9fc503cc7.jsonl"), children, now: Date.parse("2026-11-09T07:18:47Z"), live: true };
}
