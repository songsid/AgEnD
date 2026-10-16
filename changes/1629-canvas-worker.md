---
section: Changed
---

- Replace the unshipped HTML effect primitive with a Canvas Worker runtime: effect code gets no DOM, editable element or focus API. Startup hangs and disposal terminate the Worker. This is foundation work for 2.3; effects remain unmounted until the library, registry and safety limits are ready.
