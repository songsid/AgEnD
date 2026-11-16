Preparatory slice: preserve the newer T1 allowed-list rules before activating the existing role model.

The inactive converter handled only AD-group rules. The new fail-first person/team cases both returned deny/zero quota after conversion, while the current T1 policy returned allow with its stored quota. The role document now retains those bounded self-use rules using the shared T1 schemas; evaluation unions them with role assignments. The operational reader supplies owned local team snapshots, and a roster change invalidates an earlier decision. These fields do not introduce team-scoped role grants (T7). Ordinary role writes cannot alter carried rules as a side channel; the later allowed-list adapter must own those changes and their authority.

A separate fail-first case showed that an administrator could remove its own self-use denial through a control-field edit. The delegation check now refuses that increase for both the configured root and another administrator; narrowing remains allowed. The once-only root-self-use operation does not remove denies.

Validation:

- Before fixes: two T1 conversion tests red; the self-denial clearing test red.
- Focused T1/role regression group: 84/84 across eight files.
- All fifteen `tests/hub-roles-*.test.ts` files: 308/308, maxWorkers=2, started below load 10.
- `npm run typecheck` and `npm run typecheck:tests`: exit 0.

No role startup cutover, new HTTP route, UI, timer or migration registration is enabled by this slice. The UI and complete production activation stay on M-3223; their real-Hub before/after PNGs come with the mounted feature. Skill update N/A for this preparatory inactive model change, following the original inactive series; the visible UI slice updates the Hub skill.

Rollback before activation: revert this unmounted compatibility preparation. After production cutover lands, use the new build's forward-only roles-off operation; never restore the old policy/floor as a permissions rollback. Binary downgrade is a separate database/schema backup procedure.
