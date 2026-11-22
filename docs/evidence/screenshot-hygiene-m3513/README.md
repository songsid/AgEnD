# Screenshot privacy sweep (M-3513)

The original main inventory contains71 PNG paths and65 distinct image blobs introduced before the end of November19, a conservative superset of the requested pre-November19/#4198 boundary. Every original was visually checked using native-size segmented views and deduplication by blob. Local OCR supplemented visual checks. The current audited retained set contains69 paths and62 distinct images.

- 53 observation screenshots were replaced with current-app captures using explicitly synthetic labels; all53 replacements were visually checked. The long synthetic team heading preserves prior UI-gate fixture coverage.
- 4 current Settings desktop screenshots were recaptured after review found the remediation mapping omitted4 visually flagged rows. Current-only rendering/locale/immutability checks completed8 cases; no historical comparison is claimed.
- 2 obsolete Settings comparison screenshots were withdrawn after their original historical control-size comparison no longer reproduced; its README records the attempt and limitations.
- 12 other visually checked original Settings screenshots remain. Their confirmation IDs/fingerprints come from dummy values and an owned fixture store, not live credentials.

[main-inventory.json](main-inventory.json) records source blobs, dates, visual flags and dispositions. [replacement-visual-check.json](replacement-visual-check.json) binds57 replacement files. The known-blob guard rejects affected originals left under any path; it does not detect fresh private content or replace visual review. The original base is a failing control; the remediated tree must contain zero known affected blobs. Broader dev work is separate. M-3217 was handled in#4332 outside this docs/evidence scope. Git history is not rewritten. No product behavior changes.
