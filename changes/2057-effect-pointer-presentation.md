---
section: Fixed
---
- **Canvas Worker pointer-particle presentation (#2057).** Keep unchanged frame geometry paintable while checking fresh trust and actual geometry on every frame. Retain a fresh coalesced pointer sample until its next permitted send interval, without raising the 60/30Hz caps.
