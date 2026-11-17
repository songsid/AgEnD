CI R1: changelog filename repair

The exact pull-request CI on a22501f841bc738e098976b2e7cf26db5e426ffb rejected the two fragments because their names started with a card prefix rather than an issue number. The local validator reproduces both errors. Renaming them to `4091-compact-name.md` and `4091-compact-name.zh-TW.md` preserves their bytes and passes the read-only validator: 601 fragments OK.

No runtime, UI, test or smoke source changed. The initial source clearance and scoped local evidence carry. No browser/native/test campaign is repeated. Fresh exact-head CI and formal approval are still required.
