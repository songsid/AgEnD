# Hub administration navigation (M-3865)

On the scratch Hub, opening Administration and then Roles and permissions changed the selected tab and page title but kept the Overview counts on screen. Reloading the same address reached Roles. The shared lazy component loader retained the first component it loaded because its effect ran only on mount.

The loader now tracks the requested component name, loads again when it changes, and hides the old component while the new one is pending. Cleanup prevents a previous load from supplying the replacement. Inline loader functions do not trigger a reload on every render.

- [Roles after clicking from Overview](roles-after-navigation.png): the actual role list is displayed.
- [Create rooms in the custom-role editor](create-rooms-permission.png): the existing permission is reachable without a reload.

Captures come from real Hub UI/session/role-read routes, with private scratch state, synthetic people and an AD-group fixture. Role assignment was seeded for the room sweep; the captured editor does not submit a role-policy change. No live Hub/Fleet, directory, model or native agent was started.

The full-shell/router regression fails on the previous source because the Roles endpoint is never read after the query-only navigation. It now passes from Overview to Roles and back. The shell, role UI and overview suites pass together (55 tests). No labels, layout, role policy or permission checks change.
