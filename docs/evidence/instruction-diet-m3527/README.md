Restricted Classic guidance and Hub first brief (M-3527)

The display-name nudge was unconditional, and all Classic rooms received the same four managed skills. Restricted rooms cannot use the appearance mutation tools. Their full MCP and CLI launch prompts now omit the missing-display-name nudge, and managed skill publication omits `persona-emoji` and `web-appearance`. Legacy Classic rooms and Fleet workers keep their existing behavior. Existing managed copies are retired on the next startup; user-owned skills and files remain untouched. This changes guidance, not permissions or tool enforcement, and does not rewrite a conversation already in progress.

The first Hub room brief now adds one line: “@-hand-offs are for rooms; use delegate_task for Fleet work.” The zh-TW version says “@ 轉交只用於房間內；Fleet 工作請用 delegate_task。” Later membership deltas remain unchanged. The 2,048-byte first-brief limit stays fixed; long purposes are still the only text truncated, on grapheme boundaries. Updated locale fixtures include the new line; boundary tests account for byte parity rather than assuming an even overhead.

Measured with tiktoken 0.12.0, `o200k_base`:

| Synthetic text | Before | After | Delta |
|---|---:|---:|---:|
| Unnamed restricted prompt + published skill catalogue | 2,627 | 2,520 | −107 |
| Named restricted prompt + published skill catalogue | 2,620 | 2,533 | −87 |
| Missing-name nudge component | 2,370 | 2,350 | −20 |
| Restricted skill catalogue | 257 | 170 | −87 |
| First Hub brief, English | 120 | 135 | +15 |
| First Hub brief, zh-TW | 156 | 174 | +18 |
| Legacy prompt/catalogue, worker prompt, later room deltas | — | — | 0 |

These are fixed synthetic, workflow-disabled prompts and skill name/description catalogues, not provider billing or a whole launch-context total. On-demand skill bodies and backend-specific catalogue wrappers/paths are excluded. Combined rows were tokenized as combined text. Exact fixture hashes and the baseline/source heads are in [tokens.json](tokens.json); code/test bindings are in [verification.json](verification.json).

Validation: the corrected baseline gives nine new assertion failures and 50 passes. An earlier local dependency-loader setup failure is excluded. After the fix, four focused files pass 67 cases; two adjacent cross-backend skill/Classic guard files pass 39 more (106 distinct cases across six files). Source and test type-checking reports zero errors. Tests cover restricted and legacy prompts, MCP/CLI launch wiring, two backend skill folders, retirement of managed copies, preservation of user-owned files, both brief locales, later deltas and the unchanged byte/grapheme budget. No live Fleet, provider, native or browser campaign.

Reproduce snapshots with `tsx scripts/manual/measure-instruction-diet-m3527.mts OUTPUT.json` in each source checkout. Copy that helper into the baseline checkout if absent; its imports then resolve against that checkout. Use the same dependency setup for both. Count with `python3 scripts/manual/measure-instruction-diet-m3527.py BEFORE.json AFTER.json OUTPUT.json` using tiktoken 0.12.0. The helper uses a temporary managed workspace, invokes the real skill publisher without starting a CLI or service, and removes its own scratch directory. The counter asserts the intended restricted omissions and unchanged legacy/worker/delta texts.

Dev-only: the approved restricted-Classic/Hub instruction cleanup. Rollback reverts these guidance filters and brief line; it does not change access policy. AgEnD-managed skills repopulate on the next normal start; user-owned copies are never removed.
