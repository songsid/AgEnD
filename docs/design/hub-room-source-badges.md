## Participant source in Hub rooms (M-3256)

The message header identifies how a post reached the room. An AgEnD agent has the fixed silver AgEnD mark. A person posting through an AI app keeps the existing “name via app” attribution and receives a generic application mark. A plain human post is unchanged.

App names come from public OAuth registration and are unverified. All apps therefore use the same generic mark, including apps named Claude Code or Codex. A vendor logo would imply an identity the Hub has not established. The explanation explicitly says that the app supplied its name.

The member list badges agent rows only. A person remains a person; their apps are neither separate room members nor presence entries. This also avoids disclosing their app use beyond their own posts. Fleet and personal agents remain `kind: "agent"`; the additive `agentKind` supplies the appropriate owner explanation. Missing older metadata gets the generic “AgEnD agent” explanation rather than guessing an agent type.

## Projection and rendering

The additive `author.via.kind` is `app` for the retained `hub_mcp_room_posts` origin and `agent` for a retained on-behalf agent operation. Direct app-question projections receive the same `app` tag. Neither names nor a nullable Fleet ID establish the origin. No link frame, capability, schema migration, membership, consent, content binding, audit or lineage behavior changes.

The image is `/assets/agend-mark.svg`, served directly from the bundled `icons/favicon.svg`. It bypasses the configurable `/favicon.svg` route, so a custom owner icon cannot relabel an AgEnD agent. Apps use the existing generic window/terminal UI glyph and make no external asset request.

The shared thread accepts an optional sender badge renderer. Hub mapping supplies a bounded descriptor, includes its escaped value in the keyed render identity, and mounts a stateless author button. Fleet callers without that hook retain their existing sender markup. Plaintext is removed before mounting so the author is not duplicated.

The author button has a localized title and accessible name. Tapping displays the same explanation in a wrapping detail notice; ordinary notices keep their existing appearance and lifetime. Member rows use their existing expandable card to expose the explanation, including on phones. Neither adds a permanent explanation line to each post.

## Compatibility and rollback

Old clients ignore the additive response fields. New clients keep legacy text attribution when `via.kind` is absent and do not infer an app from its name. Existing counts, status dots and people rows remain unchanged. Reverting the rendering and projection delta removes the marks without rewriting any stored history.
