/** Model ids are backend-specific, including backends that accept arbitrary ids. */
export function scopedDefaultModel(
  backend: string | undefined,
  defaults: { backend?: string; model?: string } | undefined,
): string | undefined {
  return (backend || "claude-code") === (defaults?.backend || "claude-code")
    ? defaults?.model?.trim() || undefined : undefined;
}
