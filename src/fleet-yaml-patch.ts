/**
 * Leaf-edit fleet.yaml the way Settings does: patch the raw YAML document, keep
 * comments and a legacy `channel:`, then fsync+rename after the result still
 * loads. CLI `topic bind/unbind` used to `yaml.dump` the defaults-expanded
 * config (#1490 row 54).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isScalar, parseDocument } from "yaml";
import { atomicWriteFileSync } from "./atomic-write.js";
import { loadFleetConfig } from "./config.js";
import { validateFleetConfig } from "./config-validator.js";
import type { RawConfigPatch } from "./settings-api.js";

function sameLeaf(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true;
  if (before === undefined && after === undefined) return true;
  try { return JSON.stringify(before) === JSON.stringify(after); } catch { return false; }
}

function leafValue(node: unknown): unknown {
  return isScalar(node) ? node.value : node;
}

function savedFleetYamlProblem(currentPath: string, candidate: string): string | null {
  let after;
  try { after = validateFleetConfig(loadFleetConfig(candidate)); }
  catch (err) { return `Refusing to save fleet.yaml: the result would not load (${(err as Error).message})`; }
  let had = new Set<string>();
  try {
    if (existsSync(currentPath)) {
      had = new Set(validateFleetConfig(loadFleetConfig(currentPath)).errors.map(e => `${e.path}\u0000${e.message}`));
    }
  } catch { /* the current file does not load: every error of the result counts as new */ }
  const introduced = after.errors.filter(e => !had.has(`${e.path}\u0000${e.message}`));
  return introduced.length
    ? `Refusing to save fleet.yaml: it would be invalid (${introduced.map(e => `${e.path}: ${e.message}`).join("; ")})`
    : null;
}

/** Apply explicit leaf patches to the on-disk YAML document. No-op when nothing changes. */
export function applyFleetYamlPatches(configPath: string, patches: RawConfigPatch[]): void {
  if (!existsSync(configPath)) throw new Error(`fleet.yaml not found: ${configPath}`);
  const source = readFileSync(configPath, "utf-8");
  const document = parseDocument(source, { keepSourceTokens: true });
  if (document.errors.length > 0) {
    throw new Error(`Refusing to overwrite invalid fleet.yaml: ${document.errors[0]!.message}`);
  }

  let changed = false;
  for (const patch of patches) {
    if (patch.remove) {
      if (!document.hasIn(patch.path)) continue;
      document.deleteIn(patch.path);
      changed = true;
      continue;
    }
    const before = leafValue(document.getIn(patch.path, true));
    if (sameLeaf(before, patch.value)) continue;
    const currentNode = document.getIn(patch.path, true);
    if (isScalar(currentNode) && (patch.value === null || typeof patch.value !== "object")) {
      currentNode.value = patch.value;
    } else {
      document.setIn(patch.path, patch.value !== null && typeof patch.value === "object"
        ? document.createNode(patch.value)
        : patch.value);
    }
    changed = true;
  }
  if (!changed) return;

  atomicWriteFileSync(configPath, String(document), {
    mode: statSync(configPath).mode,
    beforeRename: (tempPath) => {
      const refusal = savedFleetYamlProblem(configPath, tempPath);
      if (refusal) throw new Error(refusal);
    },
  });
}
