#!/usr/bin/env node
// #1450 runtime acceptance: turn this checkout into the 2.2 candidate the matrix installs — packed, never published.
// Usage: prepare-candidate.mjs <runtime packages dir> <out dir> <pinned Node x.y.z> <candidate version>
//   - packs every @songsid/agend-node-* package that build-runtime-packages.mjs built (signed, verified) into <out>;
//   - packs @songsid/agend at <candidate version>, with optionalDependencies pinning each runtime package exactly, as a
//     release would;
//   - writes <out>/candidate.json: { version, pin, tarballs }.
// The checkout's package.json is put back afterwards. Run after `npm run build` (npm pack does not build).
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [runtimeDir, outArg, pin, version] = process.argv.slice(2);
if (!runtimeDir || !outArg || !/^\d+\.\d+\.\d+$/.test(pin ?? "") || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: prepare-candidate.mjs <runtime packages dir> <out dir> <pinned Node x.y.z> <candidate version>");
  process.exit(2);
}
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pack = (dir) => JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", out], { cwd: dir, encoding: "utf8" }))[0].filename;

const tarballs = [];
const pins = {};
for (const name of readdirSync(runtimeDir).sort()) {
  const dir = join(runtimeDir, name);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (!manifest.name.startsWith("@songsid/agend-node-") || manifest.version !== pin) throw new Error(`${dir}: ${manifest.name}@${manifest.version} is not a runtime package of Node ${pin}`);
  pins[manifest.name] = manifest.version;
  tarballs.push(pack(dir));
}
if (Object.keys(pins).length !== 4) throw new Error(`expected the 4 shipped runtime packages, found ${Object.keys(pins).join(", ")}`);

const manifestPath = resolve("package.json");
const original = readFileSync(manifestPath, "utf8");
try {
  const manifest = JSON.parse(original);
  if (manifest.name !== "@songsid/agend") throw new Error("run from the AgEnD checkout");
  manifest.version = version;
  manifest.optionalDependencies = { ...(manifest.optionalDependencies ?? {}), ...pins };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  tarballs.push(pack(process.cwd()));
} finally {
  writeFileSync(manifestPath, original);
}
writeFileSync(join(out, "candidate.json"), JSON.stringify({ version, pin, tarballs }, null, 2) + "\n");
console.log(`candidate @songsid/agend@${version}, runtime Node ${pin}:\n  ${tarballs.join("\n  ")}`);
