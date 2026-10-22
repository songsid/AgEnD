# TypeScript 7 evaluation (spike/ts7)

Evaluation only. Branch `spike/ts7` from origin/main `8fd5d7519`. Not for merge.

Host: Linux 6.6.114.1-microsoft-standard-WSL2 x86_64, 6 cores, Node v22.22.2.
Packages: typescript 5.9.3 (baseline) then 7.0.2 (this branch). tsx 4.23.15, vitest 4.1.12.

## Result

**Wait.** `npm run build` and `npm run typecheck` go green on 7.0.2 with no tsconfig edits, ~6–20× faster, and sampled `dist/` bytes match 5.9. `typecheck:tests` and every programmatic `import ts from "typescript"` fail because 7.0.2 does not ship the compiler API (deferred to 7.1). A single-package bump of `typescript` would red CI.

## Wall time (3 runs, seconds, median)

| Command | 5.9.3 | 7.0.2 | median speedup |
| --- | ---: | ---: | ---: |
| `npm run typecheck` (`tsc --noEmit`) | 123.542, 92.902, 26.238 → **92.902** | 4.487, 4.126, 5.785 → **4.487** | ~21× (vs fastest 5.9 run ~6×) |
| `npm run typecheck:tests` | 105.622, 203.880, 170.884 → **170.884** (exit 0) | 10.615, 11.021, 10.263 → **10.615** (exit 1) | n/a (7 fails) |
| `npx tsc` (emit only) | 44.983, 105.247, 36.775 → **44.983** | 5.485, 8.436, 7.467 → **7.467** | ~6× |
| `npm run build` (tsc + postbuild) | 37.360, 36.271, 36.025 → **36.271** | 13.508, 8.735, 7.689 → **8.735** | ~4× |

5.9 typecheck/emit wandered with host load (26–123 s). 7.0.2 was stable. Postbuild (tips HTML + copies) is a large constant on the build row.

## What broke

### `npm run typecheck` / `npm run build`

Pass. Postbuild `scripts/generate-tips-html.mjs` still imports `dist/tips.js` (compiled JS, not the TypeScript API). `node dist/cli.js --version` → `1.22.0`.

Sampled emit is byte-identical to 5.9 (`dist/cli.js`, `dist/tips.js`, `dist/service-plan.js`, `dist/cli.d.ts`). 328 `.d.ts` and 328 `.js.map` files. Target remains ES2022 / `module` Node16 — Node 22 can run it.

### `npm run typecheck:tests`

210 errors, 15 files, all from `import ts from "typescript"` resolving to `typescript/lib/version` (`version` / `versionMajorMinor` only).

| Code | Count | Meaning |
| ---: | ---: | --- |
| TS2339 | 152 | missing API properties (`createSourceFile`, `transpileModule`, `forEachChild`, `ScriptTarget`, `ModuleKind`, type guards, …) |
| TS2694 | 35 | missing API types (`Node`, `Block`, `MethodDeclaration`, …) |
| TS7006 | 23 | implicit `any` cascade after the missing types |

No src-type errors, no tsconfig-option-removed errors (TS5108/TS5102).

Files: `scripts/manual/cli-upstream-precheck/build-manifest.ts` (64, pulled in because `tests/cli-upstream-precheck.test.ts` imports it), `tests/i18n-ui-literals-2390.test.ts` (29), plus 13 other tests that parse or `transpileModule` CLI slices.

### tsx

`npx tsx src/cli.ts --version` works (esbuild transform, no compiler API).
`npx tsx scripts/manual/cli-upstream-precheck/build-manifest.ts --check` throws `Cannot read properties of undefined (reading 'Latest')` at `ts.ScriptTarget.Latest`.

### vitest

esbuild/vite path is fine: `tests/node-version-guard.test.ts` + `tests/changelog-fragments.test.ts` → 95 passed; `tests/carried-out-plan-2375.test.ts` passed on this branch.
`tests/i18n-ui-literals-2390.test.ts` → 5 failed, same `ts.ScriptTarget.Latest` TypeError (#2390 “reads with the TypeScript parser”).

### Programmatic API

`require("typescript")` / `import "typescript"`: `{ version: "7.0.2", versionMajorMinor }`.
`createSourceFile` / `transpileModule` are undefined.
Unstable exports exist (`typescript/unstable/ast`, `.../sync`, `.../async`) and are a different surface — not a drop-in for 5.9 `typescript`. Official 7.0 has no stable compiler API; 7.1 is expected to add a new one. Side-by-side path is `typescript` → `@typescript/typescript6` plus `@typescript/native` → `typescript@7`.

### Config

Our `tsconfig.json` already uses `target: ES2022`, `module`/`moduleResolution: Node16`, `strict: true`, `esModuleInterop: true`, `rootDir: src`, `skipLibCheck: true`. 7.0.2 `tsc --showConfig` accepted it. Nothing we set is in the 7.0 removed set (`target: es5`, `moduleResolution: node10`, `baseUrl`, `esModuleInterop: false`, …). Test config already lists `types: ["node", "vitest/globals"]` (7 default `types: []` would otherwise matter).

No config change is required for src build/typecheck. Tests need a TypeScript 6 API package, not a tsconfig flag.

### Website / docs renderer

`website/` has its own lockfile (Astro). Not bumped.
The tips/readme HTML generator is compiled JS after `tsc`; it is not a TypeScript parser user.

## Effort if we migrated for real

1. **Wait for 7.1** (recommended): no product PR. Re-run this spike when `typescript@7.1` exposes a stable API, or keep 5.9 until then.
2. **Partial / dual package** (small, 0.5–1 day): `typescript` aliased to `@typescript/typescript6` for tests/scripts; `@typescript/native` (or a second alias) for `tsc`. CI scripts must call the 7 binary explicitly. Risk: two compiler versions in one repo, easy to typecheck with the wrong one.
3. **Rewrite API users onto `typescript/unstable/ast`** (medium, several days): 15 files, no `transpileModule` equivalent proven here, unstable contract. Not worth it before 7.1.

Blocking for a single `typescript@7` bump: compiler API gone → `typecheck:tests` red, #2390 guard red, cli-upstream-precheck red, any `transpileModule` CLI-slice test red.

Not blocking: src emit, Node 22 runtime of `dist/`, tsx of app sources, vitest of tests that do not import `typescript`.

## Recommendation

**Wait.** Optionally a later **partial** dual-package experiment if CI typecheck time becomes painful. Do not merge this branch.
