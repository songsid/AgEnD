---
section: Changed
---
- **Web: the org canvas's lines find their own way (#2182).** Delegations between teams were hard to follow on the Fleet → Org chart canvas: lines shared one stub, hugged a team's border, and ran the full width of the gap to stop at a box's edge. Each line is now routed from card to card:
  - around the other cards, entering a team through a gap in its border, never running along a border or across a team's name;
  - by the shortest clear way; lines that share a stretch are drawn apart (in a crowded gap they can run closer), and an arrowhead never sits on a border; several messages between the same two cards are still one line marked ×N;
  - the work lines behave as before: a delegation stays until its `report_result`, a message fades for 12 s.
  - The router is libavoid (Adaptagrams), through the `libavoid-js` 0.4.5 npm package (LGPL-2.1-or-later), served unmodified. It runs in a worker of its own — the only part of the dashboard allowed to run WebAssembly, and it can reach nothing; the dashboard's security policy is unchanged. Zoomed out, or in a browser that can't run it, the lines follow the gaps between teams as before.
  - Team boxes are a little roomier on a desktop (wider gaps between cards and teams), so lines have space; a phone keeps its tighter packing.
