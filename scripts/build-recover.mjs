// M-3770 2.1c: bundle the update recovery kit's program into one file, dist/recover.cjs (design update-transaction
// §6.1). It must run on the kit's own Node with the package missing: node built-ins only, nothing external.
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = process.argv[2] ?? join(root, "dist", "recover.cjs");
await build({
  entryPoints: [join(root, "src", "update-recovery", "recover-main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)],
  legalComments: "none",
  logLevel: "warning",
});
