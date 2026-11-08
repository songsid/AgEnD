---
section: Fixed
---
- **`/update` uses the npm of the AgEnD it updates (#3440).** On a host with AgEnD under nvm and a separate system npm, General's `/update` (also from the web chat, and slash `/update`) took the first npm on the fleet's PATH. That failed in the prepare stage with "…/usr/lib/node_modules/@songsid/agend is not an installed AgEnD package".
  - It now uses only an npm whose global root holds the running AgEnD: the one in that install's own `bin`, the one beside the Node running AgEnD, or PATH's.
  - The update runs with that npm's directory first on PATH, so its `npm` and `node` belong to the same install.
  - This holds even with a minimal service PATH.
  - When no npm on the host manages the running install, `/update` says so, naming the global root it expected and what each npm answered.
