---
section: Fixed
---
- **`agend ls` columns now align correctly when names contain CJK, emoji or Latin Extended characters (#2273).** The Name column was padded using JS string length (code units), so CJK and emoji names — which take 2 terminal columns each — pushed every following column to the right. All column padding and width measurement now uses a Unicode EAW-aware `displayWidth` function that gives Wide/Fullwidth characters 2 columns and Narrow/Neutral characters (including accented Latin like é and č) 1 column. The same fix applies to the `agend attach` interactive picker and ambiguity list.
