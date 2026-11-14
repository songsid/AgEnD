**Superseded by wording-r5:** the attempted exact-literal exceptions below are withdrawn; the current guard is byte-identical to6c03 and the final UI wording avoids the banned terms. This file records the historical repair attempt only.

# Wording gate compatibility

Exact CI43539850500 failed only named-link-test-2906's global visible-copy scan (plus its aggregate). It incorrectly classified the two explicitly approved Team directory placeholders as network marketing: “Search by name (whole company)” and 「輸入姓名搜尋（全公司）」. Lumen's delivered wording decision is xmsg-1794615667903-3mdihf. The Company/network ban still applies elsewhere.

The gate now exempts only those two exact literals in src/ui/hub-teams-strings.js. It does not exempt the dictionary, another path, corporate wording, or any other company/network sentence. Product source, tests for Team behavior, harness and PNGs are unchanged from6c03. The affected wording group passes10/10;49 unrelated cases are deliberately unselected. No local baseline repeat, mutation/browser/native campaign or current full-gallery claim. Fresh exact-head CI is required.

Leader's delivered release instruction xmsg-1794619772579-o7oa1k holds alpha merges for the alpha.4 rehearsal; this PR waits for release clearance.
