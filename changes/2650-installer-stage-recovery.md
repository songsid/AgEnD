---
section: Fixed
---
- Windows installer steps now have operation and no-progress deadlines, stop only their own jobs, and retain uncertain cancellation receipts. Reruns verify installed resources and retry missing backends; installation is reported ready only after version, dependencies, service and dashboard checks pass (#2650).
