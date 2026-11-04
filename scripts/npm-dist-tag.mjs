#!/usr/bin/env node
// Which npm dist-tag a release tag publishes to (#1259). Run by .github/workflows/publish.yml:
//
//   node scripts/npm-dist-tag.mjs <version> [<the version @latest points at now>]
//
// Prints the tag and exits 0, or names the problem and exits 1, which fails the job:
//   X.Y.Z          → latest  (refused if it would move latest backwards)
//   X.Y.Z-beta.N   → beta
//   X.Y.Z-alpha.N  → alpha
//   anything else  → refused. A prerelease must never fall through to latest: every stable user's
//                    `agend update` would install it.
// Numbers are SemVer numeric identifiers (no leading zeros). The client side follows the same channels:
// src/update-check.ts installedChannel.
//
// The current latest is compared as full SemVer (a prerelease or build-tagged latest included, #1271 review).
// An empty one means the lookup failed and skips only that check; anything else that is not a version fails
// closed rather than letting a stable through unchecked.

const NUM = "(0|[1-9]\\d*)";
const STABLE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const PRERELEASE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}-(alpha|beta)\\.${NUM}$`);
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

function fail(message) {
  process.stderr.write(`npm-dist-tag: ${message}\n`);
  process.exit(1);
}

/** SemVer 2.0.0 precedence (build metadata ignored); null when either does not parse. */
function compareSemver(a, b) {
  const pa = SEMVER.exec(a), pb = SEMVER.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const x = BigInt(pa[i]), y = BigInt(pb[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  const xa = pa[4] ? pa[4].split(".") : [], xb = pb[4] ? pb[4].split(".") : [];
  if (xa.length === 0 || xb.length === 0) return Math.sign(xb.length - xa.length);
  for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
    const x = xa[i], y = xb[i];
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(xa.length - xb.length);
}

const [version = "", latest = ""] = process.argv.slice(2);
const pre = PRERELEASE.exec(version);
if (pre) {
  process.stdout.write(`${pre[4]}\n`);
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
