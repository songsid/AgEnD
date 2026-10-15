---
section: Changed
---
- Chat `/update` failures now use the fleet's language for fixed explanations and recovery instructions. The next action and full-log location appear before the raw diagnostic so the existing 300-character progress marker keeps useful guidance. Update execution, stages, logs and retry behavior are unchanged; raw tool errors may remain in their original language.
