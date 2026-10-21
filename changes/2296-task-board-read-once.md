---
section: Fixed
---
- **The task board is built once per change for every open Tasks tab (#2296).** Every open Fleet › Tasks page reads the board again after each change, and any agent's task claim or done is a change. Each tab's read used to rebuild the same board on the fleet's loop: 3.8 MB and about 80 ms each, at 6,000 cards. The dashboard now builds it once per revision and serves that build to every tab. 20 tabs reading the same change went from 1.8 s of loop time (longest block 123 ms) to 0.7 s (longest block 59 ms).
