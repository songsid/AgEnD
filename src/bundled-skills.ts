/**
 * #2163: the skills AgEnD ships (general-knowledge/skills/<name>/SKILL.md, next to this file in src/ and dist/), read
 * on demand. Where a CLI has no skill folder, or a workspace AgEnD does not manage gets none published, an agent still
 * reads one with `agend-agent skill <name>`. Read-only and local: no fleet call, nothing written. A skill is
 * documentation shipped in the package, so any instance may read any of them (no role gate: nothing to protect).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "general-knowledge", "skills");
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The bundled skills: name and the description from its frontmatter. */
export function listBundledSkills(dir: string = BUNDLED_SKILLS_DIR): Array<{ name: string; description: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => NAME.test(n) && existsSync(join(dir, n, "SKILL.md"))).sort().map(name => {
    const head = readFileSync(join(dir, name, "SKILL.md"), "utf-8").match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const description = head.match(/^description:[ \t]*(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    return { name, description };
  });
}

/** One bundled skill's SKILL.md, whole; or why not (a name that is not one of them). */
export function readBundledSkill(name: string, dir: string = BUNDLED_SKILLS_DIR): { ok: true; text: string } | { ok: false; error: string } {
  const known = listBundledSkills(dir).map(s => s.name);
  if (!NAME.test(name) || !known.includes(name)) return { ok: false, error: `no bundled skill "${name.slice(0, 64)}" — one of: ${known.join(", ")}` };
  return { ok: true, text: readFileSync(join(dir, name, "SKILL.md"), "utf-8") };
}
