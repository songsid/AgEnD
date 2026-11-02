/**
 * Documented Claude Code choices when no account catalog is available.
 * These are CLI choices, not a promise that an account/provider can access them.
 * https://code.claude.com/docs/en/model-config
 * https://support.claude.com/en/articles/11940350-claude-code-model-configuration
 * Checked 2026-11-02. Explicit 5.5 models need the corresponding CLI releases.
 * Built-ins only: also imported by the native Windows worker.
 */
export interface CatalogModelOption { id: string; label: string; description?: string }

function atLeast(version: string | null | undefined, minimum: number): boolean {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(version ?? "");
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= minimum);
}

export function claudeDocumentedModels(version?: string | null): CatalogModelOption[] {
  const models: CatalogModelOption[] = [];
  for (const model of [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", minimum: 280 },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", minimum: 284 },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", minimum: 293 },
  ]) if (atLeast(version, model.minimum)) models.push({ id: model.id, label: model.label });
  models.push(
    { id: "opus", label: "Claude Opus", description: "Latest Opus alias" },
    { id: "sonnet", label: "Claude Sonnet", description: "Latest Sonnet alias" },
    { id: "haiku", label: "Claude Haiku", description: "Latest Haiku alias" },
    { id: "opusplan", label: "Opus Plan", description: "Opus for planning, Sonnet for execution" },
  );
  return models;
}
