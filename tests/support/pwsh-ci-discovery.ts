import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/** Static literal launches/imports only; computed executables require explicit review. */
export function discoverPwshSuites(root: string): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const files = walk(join(root, "tests")).filter(f => /\.[cm]?[jt]sx?$/.test(f));
  const graph = new Map<string, string[]>();
  const launches = new Set<string>();
  const launcherNames = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "has"]);
  const dependency = (file: string, specifier: string) => {
    if (!specifier.startsWith(".")) return undefined;
    const base = resolve(dirname(file), specifier);
    return [base, base.replace(/\.js$/, ".ts"), base + ".ts", base + ".js", join(base, "index.ts")]
      .find(p => existsSync(p) && statSync(p).isFile());
  };
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    graph.set(file, ts.preProcessFile(source, true, true).importedFiles
      .map(i => dependency(file, i.fileName)).filter((p): p is string => p !== undefined));
    // Avoid parsing every test body: only literal pwsh candidates need an AST.
    if (!/["'`]pwsh["'`]/.test(source)) continue;
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[0].text === "pwsh") {
        const name = ts.isIdentifier(node.expression) ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
        if (launcherNames.has(name)) launches.add(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const reachesLauncher = (file: string, seen = new Set<string>()): boolean => {
    if (seen.has(file)) return false;
    seen.add(file);
    return launches.has(file) || (graph.get(file) ?? []).some(f => reachesLauncher(f, seen));
  };
  // This filesystem-gate control launches only Node; retain it with the batch controls.
  const suites = files.filter(f => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) && reachesLauncher(f));
  suites.push(join(root, "tests/installer-ps-start.test.ts"));
  return [...new Set(suites.map(f => relative(root, f).replaceAll("\\", "/")))].sort();
}
