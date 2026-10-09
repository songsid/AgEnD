---
section: Changed
---
- **Test: `ENGINES` constant must stay in sync across `package.json`, `scripts/preinstall-guard.cjs`, and `src/node-version-guard.ts`.** A new test reads `package.json` engines.node as the source of truth and asserts: (a) the `ENGINES` string in `preinstall-guard.cjs` is byte-for-byte identical, and (b) `isNodeCompatible()` returns true for the minimum version of each disjunction. Changing any one location without the others fails the test. (#1490 P3)
