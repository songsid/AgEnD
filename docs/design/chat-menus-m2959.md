# Chat menus and favourites (M-2959)

The pane menu and sidebar row menu use the existing `Menu`, `Icon` and theme tokens. Pane actions are grouped as pane, agent, appearance and delete. There is one Split action. A single Model and effort row shows the current value and opens the existing Agent Settings runtime category through that pane's guarded navigation.

Each sidebar row reserves one action slot. A favourite shows a filled star at rest; hover or keyboard focus reveals the menu button. Other rows leave the slot empty at rest. On a touch device the menu remains visible. The first action adds or removes the favourite. Reordering stays in Edit and uses the same menu; the existing fifty-item cap, own-account preferences and read-only restrictions remain. When a row moves between groups, focus returns to its new menu button; a folded destination returns focus to Edit.

Sidebar menus use the browser's top layer so the scrolling list cannot clip them. Placement is bounded by the viewport and is retired when the menu closes. A CSS capability mark keeps new JavaScript with retained CSS on the ordinary Menu path and gives it one ordinary ⋯ trigger. Retained JavaScript can ignore the additive Menu options; no new shared named export is required.

Favourite rows use a straight four-pixel identity bar, as requested by the owner. Light-theme name shades also account for selected, hovered and recent-reply backgrounds. The palette and saved choices stay the same; shading moves toward black along the existing colour's RGB ratio. Dark-theme shading is unchanged.

Both selected-text quote options have the same quote icon, regular-weight label and padding. The other pane uses its agent's display name. Long labels truncate with the full label available on hover. The existing exact-pane continuation and composer insertion own the action; quoting does not send a message.

No endpoints, authority checks or pairing paths change. Reverting the PR restores the prior presentation; favourite preferences remain compatible.
