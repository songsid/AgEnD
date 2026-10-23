---
section: Fixed
---
- **Muse 1.4.12's empty-composer hint no longer blocks delivery (#2520).** 1.4.12 paints a grey placeholder (`Type @ to search and insert workspace file paths`, and the other rotating catalog hints) in an empty box. AgEnD read that as typed-but-unsent text and refused to paste. The hint is now treated as empty; real typed text, a prefix of the hint, or extra characters after it still count as a draft.
