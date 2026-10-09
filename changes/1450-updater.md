---
section: Changed
---
- **`agend update` owns the npm prefix while it runs, and verifies the new release on the Node that release will use
  (#1450).**
  - Before npm runs, the update takes a lock next to the installed package (`<npm prefix>/.agend-install.lock`). A
    second `agend update` into the same prefix, from any fleet, refuses instead of colliding. A lock left by an update
    that died is reclaimed.
  - Only the update's own npm child may install while it holds the lock: the package's install script refuses any
    other install into that prefix, and npm rolls it back. Run one install at a time.
  - A release that brings its own Node is verified on that Node: the update asks the installed release which Node it
    selected, then opens a database with it in the main thread and in a worker. Whatever Node runs the update does not
    count.
  - Chat `/update` runs the `agend` that npm installed, found through npm and checked to be that package, by its full
    path. If that cannot be confirmed, `/update` refuses and says to run `agend update` from a shell. It never falls
    back to whichever `agend` comes first on PATH.
