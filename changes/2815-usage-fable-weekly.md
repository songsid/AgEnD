---
section: Changed
---
- **Claude usage cards show the per-model weekly again, and drop the capacity footnote (M-2815).** A Claude login's per-model weekly limit (such as **Fable (weekly)**) is listed on its card (in the compact view as one more bar, tagged with the model's name, under the 5h and 7d ones), in `/usage` and in `get_usage` even when it reads 0%; before, a 0% per-model limit was hidden. Another vendor's unused per-model limit stays hidden. The card no longer shows the measured capacity line (`100% ≈ …`) or its "counts only this fleet" note; `get_usage` still reports the capacity.
