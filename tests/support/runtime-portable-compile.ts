/** Compile the producer's complete portable inventory, including libraries not yet in the CLI's import graph. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { RUNTIME_BUNDLE_MODULES } from "../../src/runtime-build-info.js";

export function compilePortableRuntime(directory: string): void {
  const sources = RUNTIME_BUNDLE_MODULES.filter(name => name.endsWith(".js")).map(name => `src/${name.slice(0, -3)}.ts`);
  execFileSync(process.execPath, [resolve("node_modules/@typescript/native/bin/tsc"), "--ignoreConfig", "--target", "ES2022", "--module", "Node16",
    "--moduleResolution", "Node16", "--strict", "--esModuleInterop", "--skipLibCheck", "--outDir", directory, ...sources],
    { cwd: process.cwd(), stdio: "pipe", timeout: 30_000 });
}
