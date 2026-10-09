#!/usr/bin/env node
// #1488: a 2.2 release ships its own Node ONLY through these pins. Published without them, npm installs no runtime
// package, every host runs AgEnD on whatever Node it has, and #1450 does nothing. So before `npm publish`, the PACKED
// manifest — what npm will actually publish — must:
//   - pin each runtime package AgEnD ships (launcher/runtime-platform.cjs SHIPPED) in optionalDependencies,
//   - with an exact version (no range), the same for all of them,
//   - and each `@songsid/agend-node-<id>@<version>` must already be on the registry.
// Usage: check-runtime-pins.mjs <packed .tgz | package.json>   Exit 1 with the reason otherwise.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { SHIPPED } = createRequire(import.meta.url)("../../launcher/runtime-platform.cjs");
const EXACT = /^\d+\.\d+\.\d+(-agend\.\d+)?$/;

/**
 * Does this manifest pin the bundled runtime a release needs? `published(name, version)` answers whether npm has that
 * exact version (true/false); a lookup that cannot answer throws, and so fails the check.
 */
export function judgePins(manifest, published, shipped = SHIPPED) {
  const deps = (manifest && typeof manifest === "object" && manifest.optionalDependencies) || {};
  const names = shipped.map(id => `@songsid/agend-node-${id}`);
  const missing = names.filter(name => typeof deps[name] !== "string");
  if (missing.length) return { ok: false, reason: `optionalDependencies does not pin ${missing.join(", ")}` };
  const extra = Object.keys(deps).filter(name => name.startsWith("@songsid/agend-node-") && !names.includes(name));
  if (extra.length) return { ok: false, reason: `optionalDependencies pins runtime packages AgEnD does not ship: ${extra.join(", ")}` };
  const ranged = names.filter(name => !EXACT.test(deps[name]));
  if (ranged.length) return { ok: false, reason: `not an exact version: ${ranged.map(n => `${n}@${deps[n]}`).join(", ")}` };
  const versions = [...new Set(names.map(name => deps[name]))];
  if (versions.length !== 1) return { ok: false, reason: `the runtime packages are pinned to different versions: ${versions.join(", ")}` };
  const unpublished = names.filter(name => !published(name, versions[0]));
  if (unpublished.length) return { ok: false, reason: `not on the registry: ${unpublished.map(n => `${n}@${versions[0]}`).join(", ")}` };
  return { ok: true, pin: versions[0] };
}

function readManifest(path) {
  const text = path.endsWith(".tgz")
    ? execFileSync("tar", ["-xzOf", path, "package/package.json"], { encoding: "utf8" })
    : readFileSync(path, "utf8");
  return JSON.parse(text);
}

/** npm view <name>@<version> version: that exact version, or nothing (E404). Any other failure throws. */
function onRegistry(name, version) {
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "version", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
    return out !== "" && JSON.parse(out) === version;
  } catch (err) {
    if (/E404|404 Not Found/.test(String(err.stderr ?? ""))) return false;
    throw new Error(`npm view ${name}@${version} failed: ${String(err.stderr ?? err.message).trim().split("\n").pop()}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) { console.error("usage: check-runtime-pins.mjs <packed .tgz | package.json>"); process.exit(2); }
  const manifest = readManifest(target);
  let verdict;
  try { verdict = judgePins(manifest, onRegistry); } catch (err) { verdict = { ok: false, reason: err.message }; }
  if (!verdict.ok) {
    console.error(`::error::${manifest.name}@${manifest.version} would ship without its bundled Node: ${verdict.reason}`);
    process.exit(1);
  }
  console.log(`${manifest.name}@${manifest.version} pins its bundled Node: ${SHIPPED.map(id => `@songsid/agend-node-${id}`).join(", ")} @ ${verdict.pin}, all on the registry`);
}
