#!/usr/bin/env node
// #2987 (M-2295): may `beta` move to this release candidate? Run by .github/workflows/promote-beta.yml:
//
//   node scripts/release/promote-beta.mjs <X.Y.Z-beta.N> [<the version @beta points at now>]
//
// Prints `promote` (move beta to it) or `already` (beta is on it: nothing to do) and exits 0, or names the problem
// and exits 1, which fails the job before any dist-tag moves:
//   - only an X.Y.Z-beta.N is promoted to beta (a stable goes to latest and an alpha to alpha when published);
//   - beta never moves backwards: an older candidate than the current @beta is refused;
//   - a current @beta that is not a version fails closed. An empty one (the lookup failed, or no beta yet) skips only
//     the backwards check, as scripts/npm-dist-tag.mjs does for latest.
import { compareSemver } from "./semver.mjs";

const NUM = "(0|[1-9]\\d*)";
const BETA = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}-beta\\.${NUM}$`);

function fail(message) {
  process.stderr.write(`promote-beta: ${message}\n`);
  process.exit(1);
}

const [version = "", currentBeta = ""] = process.argv.slice(2);
if (!BETA.test(version)) fail(`"${version}" is not X.Y.Z-beta.N; only a beta candidate is promoted to beta`);
const current = currentBeta.trim();
if (current !== "") {
  const order = compareSemver(version, current);
  if (order === null) fail(`cannot read the current beta ("${current}"); refusing to move beta unchecked`);
  if (order < 0) fail(`${version} is older than the current beta (${current}); promoting it would move beta backwards`);
  if (order === 0) { process.stdout.write("already\n"); process.exit(0); }
}
process.stdout.write("promote\n");
