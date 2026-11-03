---
section: Changed
---
- **A beta is a release candidate first: it publishes to npm `@rc`, and reaches `@beta` only when it is promoted.** A `vX.Y.Z-beta.N` tag used to publish straight to `@beta`, so every beta install's `agend update` and update notice picked it up before it had run anywhere. It now publishes to the new `@rc` dist-tag. After it has run on a test host (`agend update --rc`), the new **Promote beta** workflow moves `@beta` to that exact version: nothing is rebuilt, beta never moves backwards, and the move is verified. Beta users see nothing until then. A host that installed from `@rc` follows `@beta` again afterwards. Stable (`@latest`) and alpha (`@alpha`) publishing is unchanged. (#2987)
