/** Reads a built Windows Runtime bundle for the references its modules make to files it does not carry (tests/runtime-bundle-closed.test.ts). */
/** What one module names: `import … from`, `import "…"`, `export … from`, `import("…")`, and `new URL("…", import.meta.url)` (how a module starts another as a child process). */
const REFERENCE = /(?:^|\n)[ \t]*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bnew URL\(\s*["'](\.\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)|(?:^|\n)[ \t]*import\s*["']([^"']+)["']/g;

/** The references of `modules` (name → compiled source) that nothing in the bundle satisfies, as "module → reference". */
export function bundleGaps(modules: ReadonlyMap<string, string>, listed: readonly string[], packages: readonly string[]): string[] {
  const gaps: string[] = [];
  for (const [name, code] of modules) {
    for (const found of code.matchAll(REFERENCE)) {
      const target = (found[1] ?? found[2] ?? found[3] ?? found[4])!;
      if (target.startsWith("node:")) continue;
      if (target.startsWith("./")) { if (!listed.includes(target.slice(2))) gaps.push(`${name} → ${target}`); continue; }
      if (!packages.some(p => target === p || target.startsWith(`${p}/`))) gaps.push(`${name} → ${target}`);
    }
  }
  return gaps;
}
