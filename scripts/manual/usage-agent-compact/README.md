# Compact agent usage acceptance (M-3033 / S-130)

The agent MCP/CLI boundary projects a full shared snapshot into one row per account. The web dashboard, CSV, `/usage`, provider readers, cache and report scope checks retain their existing paths. No CLI launches or vendor/account changes are part of this check.

Two actual read-only fleet-tool calls were captured on 2026-11-13 (subscription snapshot `2026-11-13T04:51:32.960Z`, 11 accounts). Replaying these same JSON values through the candidate's agent-only projections, without a second vendor fetch:

| Tool | Existing UTF-8 bytes | Compact UTF-8 bytes | Reduction |
| --- | ---: | ---: | ---: |
| get_usage | 14,759 | 2,455 | 83.4% |
| get_usage_report | 8,587 | 6,309 | 26.5% |

Both `detail:true` outputs roundtrip to the complete original tool objects. The report capture already includes its `top` cutoff; the replay retains its existing `more` value. It removes only the tool-added per-row basis to recreate the pre-projection report input. Private raw responses remain in owned, ignored scratch; no account names or actual usage rows are published here. Character count differs from UTF-8 bytes (subscription response: 14,679 characters).

With your own saved tool JSON (no secrets required):

```
node --import tsx scripts/manual/usage-agent-compact/measure.mts /owned/get_usage.json /owned/get_usage_report.json
```

Compact subscription rows retain name/profile, plan, all metric values and relative reset/expiry times, explicit vendor binding markers, stale/cache/error hints, unlimited entitlement, Codex reset tickets and credits. Percentages use one decimal, dollars two; unknown/reset-passed readings are never zero. Pool names stay in window labels. A missing binding marker means not reported, not a guess from the highest percentage. Capacity statistics and localization twins are detail-only; their fleet-only footnote appears once in compact output. CLI `usage --detail` now prints the full JSON instead of suppressing it behind `formatted`. Flags may appear in either order with `--force`.

Fail-first: the new compact handler and report tests on the original implementation fail four assertions (two default rows, schema detail type, repeated basis/speed). Shared snapshot/chat and detail controls pass. Focused tests also cover actual CLI argv/stdout against a loopback peer, stale/reset/expiry/unknown data, pool labels, errors and unlimited plans. The old explicit full-response CLI test now requests detail. No timeouts or existing authorization assertions are loosened.

Rollback: revert the slice; no stored data/schema migration. Existing agent clients expecting raw metrics must opt into detail; the bundled skills and tool descriptions explain that change. The new CLI can print a legacy daemon's JSON, and an old CLI falls back to printing a new compact response when `formatted` is absent. There is no web layout change or screenshot claim.

Six independent reversals were assertion-red and restored: remove full-detail return; make MCP default full; retain report speed; bypass report own-row refusal; drop CLI detail forwarding; drop pool names. No product mutation remains.

Final focused run: seven files,125/125 tests, no skips, `vitest run --maxWorkers=2`. Files: usage-agent-compact, agent-cli-usage-flags, usage-report-2122, agent-cli-usage, usage-slash-mcp, profile-aware-usage, usage-capacity-3066. Native TypeScript source and test checks pass;160 changelog fragments validate; diff check passes. The report ownership check is exercised in both compact and detail modes.
