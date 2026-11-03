---
section: Changed
---
- **Beta 先是候選版：發布到 npm `@rc`，只有升級後才會進入 `@beta`。** 以前 `vX.Y.Z-beta.N` tag 直接發布到 `@beta`，所有 beta 安裝的 `agend update` 和更新通知都會在它還沒在任何地方跑過時就拿到它。現在它發布到新的 `@rc` dist-tag。在測試主機上跑過之後（`agend update --rc`），新的 **Promote beta** workflow 會把 `@beta` 指向那個版本：不重新建置、beta 永遠不會倒退，並會驗證結果。在那之前 beta 使用者看不到任何變化。從 `@rc` 安裝的主機之後會重新跟著 `@beta`。穩定版（`@latest`）與 alpha（`@alpha`）的發布方式不變。(#2987)
