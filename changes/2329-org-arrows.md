---
section: Fixed
---
- **Web: the org chart's arrowheads are small and stop short of the cards (#2329).** A head is now under 3 stroke widths long (7 px on a message line, down from 17.5), a slim head in the line's own colour whose tip ends a few px before the card instead of on its border. libavoid no longer ends a line on a card side that faces a narrow gutter (where the head was squeezed between two cards). It moves the line's last turn out so the head has a straight run to sit on, and a line with no room for a head draws none. On the fallback lane route, lines into one side of a card enter a head's width apart.
