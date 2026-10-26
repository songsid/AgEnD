---
section: Security
---
- **zod is now 4.6.7 and body-parser 2.4.0, which close two high-severity advisories (#2670).** zod 4.3.6 had GHSA-mrhx-c7xc-m3w5. body-parser 2.3.0 had GHSA-27r3-jxmh-p828, through the MCP SDK's express. The tool schemas agents see are unchanged. A one-shot schedule time still works without seconds, like `2026-07-26T14:00+08:00`: zod 4.6 rejects that form, so AgEnD keeps its own check.
