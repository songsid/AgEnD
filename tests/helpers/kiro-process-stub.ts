import { afterAll } from "vitest";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import type * as ChildProcess from "node:child_process";

/** Factory-only metadata tests: no installed Kiro is executed. */
export function installKiroCompatibilityFixture(): void {
  const native = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;
  const original = native.execFileSync;
  const help = readFileSync(join(import.meta.dirname, "..", "fixtures", "kiro-help", "chat-help-2.27.0.txt"), "utf8");
  native.execFileSync = ((file: string, args?: string[], options?: unknown) => {
    if (basename(file) !== "kiro-cli") return (original as any)(file, args, options);
    if (args?.[0] === "--version") return "kiro-cli 2.27.1\n";
    if (args?.join(" ") === "chat --help") return help;
    throw new Error("unexpected Kiro invocation in metadata fixture");
  }) as typeof original;
  syncBuiltinESMExports();
  afterAll(() => { native.execFileSync = original; syncBuiltinESMExports(); });
}
