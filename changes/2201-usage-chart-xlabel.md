---
section: Fixed
---
- **Fleet → Usage: x-axis date labels no longer overlap (#2201).** The 7-day trend chart showed all 7 date labels at 14 px spacing, but labels are ~28 px wide — every adjacent pair overlapped. Labels are now thinned by estimated width (`thinXLabels`): the step is calculated from the estimated label width so no two consecutive labels are closer than their own width apart. The first and last dates are always kept unless they would overlap each other (e.g. a 2-day range), in which case only the last (most recent) is shown.
