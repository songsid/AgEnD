---
section: Fixed
---
- **Do not stop a session for collateral host OOMs.** A killed CLI now counts toward a session stop only when the kernel report positively shows its anonymous memory dominates RAM and the next-largest task. Confirmed collateral OOMs preserve the session and recover after memory pressure clears. Unknown causes keep the ordinary bounded crash budget and offer Resume/Fresh with an honest cause-unclear notice. Old unproven stop records are released with a log entry. Genuine self-caused stops show the evidence and offer Resume or Fresh session in General and Needs you.
