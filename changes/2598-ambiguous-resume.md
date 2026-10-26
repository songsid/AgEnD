---
section: Fixed
---
- A kiro startup error saying that the saved session id is ambiguous now keeps that session pinned instead of eventually discarding it and starting fresh. This protects conversations carried from classic when kiro 2.34 lists their UUID in both stores; resolving the duplicate store entry remains a separate recovery step (#2598).
