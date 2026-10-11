---
section: Fixed
---
- **Web on a phone: the no-zoom fix covers every text field, including future ones (#1615).** Follow-up to #1611: a text field that takes its size from the text around it (rather than setting its own) is now also at least 16 px on a touch screen or the phone layout, so iOS never zooms the page in on focusing it. Larger fields keep their size; the desktop look is unchanged.
