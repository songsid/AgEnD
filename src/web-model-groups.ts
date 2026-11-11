/**
 * The model list Web Settings shows (AGEND-158 PR 3): the same catalog the CLI env probe cached, shaped so that every
 * entry is one the person can pick.
 *
 * - claude-code: only the account's own model list (`GET /v1/models`) — no aliases (`default`, `opus`, …), no CLI list
 *   and no `[1m]` variant; a person who wants one types it under "Other…", and a saved one still shows as the current
 *   value. One group, so a flat list. When no account list could be read, the documentation's `claude-*` ids are all
 *   there is, grouped as `unverified` (named by the documentation, not seen in this account); aliases are not listed.
 * - other backends: `common` (the quick-pick tier) then `more` (the account catalog behind "more models") when a
 *   backend has both; a backend with a single tier carries no groups at all.
 * - antigravity: `agy models` lists one slug per effort level; the levels of one model are one entry, and the level is
 *   the effort dropdown's (PR 2). The entry's value is a real catalog slug (the medium slug, else the first one the
 *   catalog lists for that model), so a configuration is always something `agy --model` takes; `aliases` are the other
 *   slugs it stands for, so a saved `…-high` still shows as that entry.
 *
 * Pure: no I/O. Telegram's `/model` and the chat chip read the unshaped catalog and are not changed by this.
 */
import type { ModelOption } from "./backend/types.js";
import { agyVariantOf } from "./backend/effort-metadata.js";

export type WebModelGroup = "common" | "more" | "unverified";
export interface WebModelOption extends ModelOption {
  group?: WebModelGroup;
  /** Other catalog slugs this entry stands for (antigravity: the model's other effort levels). */
  aliases?: string[];
}

const withoutLevel = (label: string): string => label.replace(/\s*\((?:low|medium|high|xhigh|max)\)\s*$/i, "").trim() || label;

/** One entry per antigravity model: its effort levels (≥ 2 of them) become the one entry, the medium slug (else the first the catalog lists) standing for it. */
export function mergeAntigravityLevels(models: readonly WebModelOption[]): WebModelOption[] {
  const families = new Map<string, WebModelOption[]>();
  for (const m of models) {
    const v = agyVariantOf(m.id);
    if (v) families.set(v.base, [...(families.get(v.base) ?? []), m]);
  }
  const out: WebModelOption[] = [];
  const done = new Set<string>();
  for (const m of models) {
    const v = agyVariantOf(m.id);
    const members = v ? families.get(v.base)! : null;
    if (!v || !members || members.length < 2) { out.push(m); continue; }
    if (done.has(v.base)) continue;
    done.add(v.base);
    const rep = members.find(x => agyVariantOf(x.id)?.level === "medium") ?? members[0]!;
    const { description: _description, ...rest } = rep;
    out.push({ ...rest, label: withoutLevel(rep.label), aliases: [v.base, ...members.map(x => x.id)] });
  }
  return out;
}

/**
 * `common`: the quick-pick tier (aliases, the CLI's own list); `more`: the account catalog behind "more models".
 * claude-code answers the account catalog alone (without its `[1m]` variants), as one flat list; any other backend whose
 * catalog has only the first tier answers a flat list (no `group`).
 */
export function shapeWebModelCatalog(backend: string, common: readonly ModelOption[], more: readonly ModelOption[] = []): WebModelOption[] {
  const seen = new Set<string>();
  const out: WebModelOption[] = [];
  const claude = backend === "claude-code";
  const tiered = !claude && more.length > 0;
  const add = (m: ModelOption, group: WebModelGroup | undefined) => {
    if (!m || typeof m.id !== "string" || seen.has(m.id)) return;
    if (claude && m.id.endsWith("[1m]")) return;
    seen.add(m.id);
    out.push(group ? { ...m, group } : { ...m });
  };
  if (!claude) for (const m of common) add(m, tiered ? "common" : undefined);
  for (const m of more) add(m, tiered ? "more" : undefined);
  // claude without an account catalog is the empty list: the caller's documented fallback (shapeDocumentedClaudeModels).
  return backend === "antigravity" ? mergeAntigravityLevels(out) : out;
}

/**
 * The documentation-only fallback (no account catalog could be read): the explicit `claude-*` ids the documentation
 * names, marked unverified — they were not seen in this account. Aliases (`opus`, `sonnet`, …) are not listed.
 */
export function shapeDocumentedClaudeModels(models: readonly ModelOption[]): WebModelOption[] {
  return models.filter(m => m.id.startsWith("claude-")).map((m): WebModelOption => ({ ...m, group: "unverified" }));
}
