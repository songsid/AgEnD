---
section: Fixed
---
- **A poll no longer stays open past its deadline when the deadline timer fires a moment early (#3197).** Now and then a poll closed minutes late, only when a later poll's deadline came, even though nothing else was going on. Its timer could be dropped at the deadline itself; it is now kept until the poll has closed.
