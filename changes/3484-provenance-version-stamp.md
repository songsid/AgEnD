---
section: Fixed
---
- **Published packages no longer show "modified" (含未提交變更) in Settings (#3484).** The release stamps its version into package.json before `npm publish` rebuilds, and that rebuild recorded the stamp as an uncommitted change, so every published build read "modified". The version stamp no longer counts; any other change to the tree still does.
