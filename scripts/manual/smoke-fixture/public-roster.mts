/** Explicitly synthetic identities for public screenshot refreshes. No live Fleet-derived labels. */
import type { FixtureInstance } from "./data.mts";
export function publicRoster(count = 6): FixtureInstance[] {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("invalid public fixture size");
  return Array.from({ length: count }, (_, i) => ({
    name: i === 0 ? "general" : `example-agent-${String(i).padStart(2, "0")}`,
    backend: i % 2 === 0 ? "claude-code" as const : "codex" as const,
    displayName: i === 0 ? "General" : i % 3 === 0 ? `示範文件與長名稱版面測試助理 ${i}` : `Example agent ${i}`,
    ...(i === 0 ? { general: true } : {}), status: "running" as const,
  }));
}
