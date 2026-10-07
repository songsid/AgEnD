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

const NUM = "(0|[1-9]\\d*)";
const STABLE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const PRERELEASE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}-(alpha|beta)\\.${NUM}$`);

function fail(message) {
  process.stderr.write(`npm-dist-tag: ${message}\n`);
  process.exit(1);
}

/** -1, 0 or 1 for two X.Y.Z versions, numerically at any size. */
function compareStable(a, b) {
  const pa = STABLE.exec(a).slice(1).map(BigInt);
  const pb = STABLE.exec(b).slice(1).map(BigInt);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

const [version = "", latest = ""] = process.argv.slice(2);
const pre = PRERELEASE.exec(version);
if (pre) {
  process.stdout.write(`${pre[4]}\n`);
} else if (STABLE.test(version)) {
  const current = latest.trim();
  if (STABLE.test(current) && compareStable(version, current) < 0) {
    fail(`${version} is older than the current latest (${current}); publishing it would move latest backwards`);
  }
  process.stdout.write("latest\n");
} else {
  fail(`"${version}" is not X.Y.Z, X.Y.Z-beta.N or X.Y.Z-alpha.N; refusing to guess a dist-tag`);
}
