/**
 * #2163: the skills AgEnD ships (general-knowledge/skills/<name>/SKILL.md, next to this file in src/ and dist/), read
 * on demand. Where a CLI has no skill folder, or a workspace AgEnD does not manage gets none published, an agent still
 * reads one with `agend-agent skill <name>`. Read-only and local: no fleet call, nothing written. A skill is
 * documentation shipped in the package, so any instance may read any of them (no role gate: nothing to protect).
 * Experimental guidance follows the current feature switch; reading a skill never enables a feature.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "general-knowledge", "skills");
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EXPERIMENTAL_GUIDANCE = new Set(["web-appearance", "web-dashboard"]);

/** #2275: managed publishers call this only after their normal ownership checks. Enabled
 * guidance remains byte-for-byte the shipped SKILL.md; unrelated skills have no alternate.
 * A damaged package missing required off guidance refuses rather than advertise the feature. */
export function bundledSkillContents(skillDir: string, canvasWorker = false): string {
  const disabled = join(skillDir, "SKILL.canvas-worker-off.md");
  return readFileSync(canvasWorker !== true && EXPERIMENTAL_GUIDANCE.has(basename(skillDir)) ? disabled : join(skillDir, "SKILL.md"), "utf-8");
}

/** The bundled skills: name and the description from their current frontmatter. */
export function listBundledSkills(dir: string = BUNDLED_SKILLS_DIR, canvasWorker = false): Array<{ name: string; description: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => NAME.test(n) && existsSync(join(dir, n, "SKILL.md"))).sort().map(name => {
    const head = bundledSkillContents(join(dir, name), canvasWorker).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const description = head.match(/^description:[ \t]*(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    return { name, description };
  });
}

/** One bundled skill's SKILL.md, whole; or why not (a name that is not one of them). */
export function readBundledSkill(name: string, dir: string = BUNDLED_SKILLS_DIR, canvasWorker = false): { ok: true; text: string } | { ok: false; error: string } {
  const known = listBundledSkills(dir, canvasWorker).map(s => s.name);
  if (!NAME.test(name) || !known.includes(name)) return { ok: false, error: `no bundled skill "${name.slice(0, 64)}" — one of: ${known.join(", ")}` };
  return { ok: true, text: bundledSkillContents(join(dir, name), canvasWorker) };
}
