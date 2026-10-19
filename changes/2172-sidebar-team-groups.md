---
section: Fixed
---
- **The sidebar groups an agent under its team (#2172).** With no filter, an agent in a fleet.yaml team was listed under its first tag: an agend-dev member tagged `wiki` showed under "wiki". Now an agent in a team is listed under that team (the first one, if it's in several). An agent in no team is still listed under its first tag, a ClassicBot room under **Classic**, and the rest under **Other**. Teams come first, and each heading shows what it is: a team's icon, or **#** before a tag. **Settings → Agents** groups the same way. Guests don't see team names.
