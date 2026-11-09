---
section: Added
---
- **Fleet → Usage now shows how fast each model writes.** A Speed column, and a "Speed by model" card, give output tokens per second of the model's own generation, without the time tools run. The card also says how many requests were timed and, from 30 timed responses, the p10–p90 range. `get_usage_report` returns it as `speed` per row, in the totals and in `speedByModel`.
  - **What gets timed.** A Claude Code response is timed from its first token when it opens with a thinking block. A Codex response is timed over its response window, from the item clocks that Codex 0.147 and later records; the rollout does not mark the first token, so the window may include some of the wait for it.
  - **Method and credit.** It follows [tokdash](https://github.com/JingbiaoMei/tokdash) (MIT, Jingbiao Mei), credited in `THIRD_PARTY_NOTICES.md`. (#3066)
