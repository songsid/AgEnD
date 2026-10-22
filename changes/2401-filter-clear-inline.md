---
section: Fixed
---
- **Sidebar instance filter: Clear button no longer pushes the filter panel taller when a facet is active (#2401).** The Clear button was inside the wrapping facet-chip container and caused a new row to appear. It is now inline with the instance count and always reserves its layout space (using `visibility: hidden` when inactive), so the panel height never changes when a filter is applied or cleared.
