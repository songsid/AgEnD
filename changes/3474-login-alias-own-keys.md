---
section: Fixed
---
- **`/login` no longer takes `__proto__` or `constructor` for a backend (#3474).** The words typed after `/login` are looked up only among AgEnD's own backend names and aliases. `/login __proto__` used to resolve to a built-in object and answer "[object Object] has no credential profiles". It now gets the ordinary "no such backend" answer that names the word typed.
