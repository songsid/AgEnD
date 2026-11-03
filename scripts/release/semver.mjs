// SemVer 2.0.0 precedence, shared by the release scripts (scripts/npm-dist-tag.mjs, scripts/release/promote-beta.mjs).

const NUM = "(0|[1-9]\\d*)";
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/** SemVer 2.0.0 precedence (build metadata ignored); null when either does not parse. */
export function compareSemver(a, b) {
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

