# First room brief: measured 2 KiB budget

The approved copy plus a 200-character Chinese purpose already exceeded the original round-number 1 KiB target. The PM corrected the whole-block budget to **2048 UTF-8 bytes**. Normal purposes stay intact. Only oversized purpose text is cut, at whole grapheme boundaries, with the exact localized full-purpose lookup hint; counts and handoff guidance stay unchanged.

The formatter now owns the existing content disclaimer too, so the byte measurement covers what the agent actually receives. Moving that line does not change normal prompt output. Binary search retains the longest whole-grapheme prefix that fits together with JSON escaping, marker and fixed copy. Structured/stored purpose and H5 lookup behavior are unchanged. No wire field, capability, cursor, migration or browser UI changes.

## Verification

Fail-first: six new cases fail on the merged H6 base (four oversize cases plus two tests pinning whole-block formatter ownership). After implementation, the budget, existing brief and earlier-context budget files pass **21/21**. Source and test typechecks pass.

```
npx vitest run tests/hub-room-brief-budget-m3300.test.ts tests/hub-room-brief-h4.test.ts tests/hub-room-context-budget-m3300.test.ts
npm run typecheck
npm run typecheck:tests
```

Normal EN/zh blocks compare byte-for-byte with fixtures recorded before the change. Two hundred ordinary emoji remain intact. Both locales pin exactly 2048 bytes intact and 2049 bytes cut, and also test a 200-grapheme family-emoji mix and a single large combining-mark grapheme, each valid under the existing structured brief schema. Tests measure the block extracted from the actual question prompt, retain all fixed lines, verify a whole-grapheme prefix and verify that input data was not mutated.

`measurements.json` records pure-renderer before/after byte counts for synthetic examples. `source-sha256.txt` binds the final source/tests. No CLI, model call, real account, network rig, live Fleet or browser campaign is needed for this formatter-only change; visible UI evidence remains in the preceding H1/H2/H3/H6 packets.

## Limits and rollback

The existing structured brief's 4 KiB purpose field and overall frame limits stay unchanged, preserving strict older peers. Very large stored grapheme sequences that cannot enter that existing wire shape retain its existing refusal; this change bounds successfully received first blocks rather than widening the protocol. H5's 8 KiB response/backpressure rule is unchanged. This follow-up itself is code-only and can be reverted without a schema or journal conversion; the parent H6's member-state rollback note still applies when reverting that feature too.
