---
section: Added
---
- **The usage dialog now shows how much 100% of each weekly quota is, measured.** Under an account's weekly bar it reads, for example, "100% ≈ $412 ($378–$455) · ≈ 31.0M tokens · from 3 weeks". The figure is what this account's agents used while the vendor's weekly percent moved, divided by how far it moved. `get_usage` returns it as `capacity` on each weekly metric.
  - **When it shows.** A number appears only once a week's percent has moved at least 10 points; until then the dialog says how far it has got. The range covers the vendors' whole-percent steps and the hourly usage records.
  - **What it means.** The estimate is given as the API-equivalent at list price and as tokens. After three weeks, the dialog names the measure that stayed steadiest, which is likely how the vendor counts. Per-model weekly limits (for example "Sonnet (weekly)") count only that model.
  - **Always stated:** only this fleet's agents are counted, so using the same account elsewhere makes the estimate low. A week where the measures disagree is marked. (#3066)
