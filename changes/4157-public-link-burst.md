---
section: Fixed
---
- Public link: a page that asks for many files at once no longer risks some of them failing (#4157 follow-up). Since the web dashboard requests a page's modules all at once, a tunnel could open more connections to AgEnD than its limit of 32. Each connection past the limit was cut, and a page could show "could not be loaded". A connection past the limit now waits briefly for a free slot. A flood of connections is still refused.
