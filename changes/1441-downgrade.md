---
section: Added
---
- Added a data-only downgrade compatibility check against published 2.1.12 on Node 20, with current stores on Node 22 before and after. The report separates additive database compatibility from lost web policies, pending approvals, scheduler retries and Kiro ownership protections; it does not promise a safe live downgrade (#1441, Part C).
