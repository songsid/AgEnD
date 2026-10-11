---
section: Changed
---
- **`agend update` checks the new release can run here before it changes anything (#1441).** It reads the release's own Node requirements and works out which Node it would run on: AgEnD's bundled Node where the release ships one for this computer, otherwise the `node` on your PATH. If that Node doesn't fit, the update stops with "nothing was changed", says which Node the release needs and why the bundled one doesn't apply (for example on musl Linux), and tells you how to continue. It doesn't install anything, and it doesn't touch your system Node. A `/update` from chat reports the same reason. If the requirements can't be read, the update goes ahead as before, and the release's own install check still protects it.
