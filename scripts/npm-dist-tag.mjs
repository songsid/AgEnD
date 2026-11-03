#!/usr/bin/env node
// Which npm dist-tag a release tag publishes to (#1259). Run by .github/workflows/publish.yml:
//
//   node scripts/npm-dist-tag.mjs <version> [<the version @latest points at now>]
//
// Prints the tag and exits 0, or names the problem and exits 1, which fails the job:
//   X.Y.Z          → latest  (refused if it would move latest backwards)
//   X.Y.Z-beta.N   → rc     (a candidate; promoted to beta by promote-beta.yml)
//   X.Y.Z-alpha.N  → alpha
//   anything else  → refused. A prerelease must never fall through to latest: every stable user's
//                    `agend update` would install it.
// Numbers are SemVer numeric identifiers (no leading zeros). The client side follows the same channels:
// src/update-check.ts installedChannel.
//
// #2987 (M-2295): a beta is a release CANDIDATE: it publishes to `rc`, and `beta` moves to it only when it is
// promoted (.github/workflows/promote-beta.yml). A beta user's `agend update` therefore never installs a candidate.
//
// The current latest is compared as full SemVer (a prerelease or build-tagged latest included, #1271 review).
// An empty one means the lookup failed and skips only that check; anything else that is not a version fails
// closed rather than letting a stable through unchecked.

import { compareSemver } from "./release/semver.mjs";

const NUM = "(0|[1-9]\\d*)";
const STABLE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const PRERELEASE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}-(alpha|beta)\\.${NUM}$`);
function fail(message) {
  process.stderr.write(`npm-dist-tag: ${message}\n`);
  process.exit(1);
}

const [version = "", latest = ""] = process.argv.slice(2);
const pre = PRERELEASE.exec(version);
if (pre) {
  process.stdout.write(`${pre[4] === "beta" ? "rc" : pre[4]}\n`);
} else if (STABLE.test(version)) {
  const current = latest.trim();
  if (current !== "") {
    const order = compareSemver(version, current);
    if (order === null) fail(`cannot read the current latest ("${current}"); refusing to publish ${version} to latest unchecked`);
    if (order < 0) fail(`${version} is older than the current latest (${current}); publishing it would move latest backwards`);
  }
  process.stdout.write("latest\n");
} else {
  fail(`"${version}" is not X.Y.Z, X.Y.Z-beta.N or X.Y.Z-alpha.N; refusing to guess a dist-tag`);
}
