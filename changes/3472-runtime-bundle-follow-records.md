---
section: Fixed
---
- **A Windows Runtime can start its pane host again (#3472).** Since #3281, the Runtime bundle's `transcript-records.js` imports two files, `workspace-follow-records.js` and `workspace-follow-parse.js`, that the bundle did not carry. The pane service stopped with `ERR_MODULE_NOT_FOUND` before it wrote its descriptor, so opening a pane failed with `Pane host startup was not confirmed`. The bundle now carries both files, and a test checks that every file its modules import or start is in it. Update the Runtime to get the fix; its build id changes. This affects `release/2.3.5-alpha` only.
