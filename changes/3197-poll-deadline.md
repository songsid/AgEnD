---
section: Fixed
---
- **Poll deadlines keep running while earlier message edits are delayed (#3197).** A slow countdown edit, closed-poll tally or reply-button update no longer prevents other polls from closing and handing their results to the agent on time. The web view closes immediately while each poll's platform edits retain their order. Late results report the delay without claiming AgEnD was stopped.
