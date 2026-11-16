# Personal migration registration

The prior default-factory regression failed because the standard plan contained zero personal components. Adding
`HUB_PERSONAL_AGENTS_MIGRATION` to the HTTP registry makes it pass: exactly one migration, default-off settings,
company session feature, admin and owner routes, disabled enrollment refusal, private Runtime absent while off,
browser Origin refusal after enable, native enrollment hello accepted, and the issuing company owner persisted.
Only archive packaging metadata is substituted; neither the personal factory nor Runtime is injected.

The personal HTTP/owner/turn/schema packet passes 28 tests. Fixtures now consume the registered schema once; the
retained-row upgrade test explicitly freezes the pre-personal registry and still proves old-plan downgrade refusal.
The two optional/partial role inventory controls pass on their historical pre-personal fixture. Both TypeScript
programs exit 0. The original native/browser/mutation campaigns retain their scopes; no duplicate campaign ran for
this registry entry.

The alpha sync preserves `role-settings-v1` beside the personal feature, both HTTP teardown owners, and MCP direct
question `bindMessage`/application attribution/content-audit ownership beside personal enqueue. The incoming
nullable-Fleet consumer delta adds no unguarded Fleet lookup; app attribution and audit actor parsing remain
unchanged. The earlier all-consumer audit is retained: catalog/policy/quota and room sources use the personal port;
Fleet publish/member/revoke/update paths remain Fleet-only; dashboard counts personal publications without a Fleet;
role inventory hashes all five authority tables or none and rejects partial schema; retention keeps real FKs.

Rollback: personal admission off with a schema-compatible binary. A hard downgrade requires the complete matching
pre-registration Hub database/content/audit/Runtime-journal backup and its matching binary/keys. Merely withdrawing
a personal publication cannot make retained NULL-Fleet messages safe for old readers. See the owner-model rollback
section. No migration-record deletion or fictional Fleet metadata is an accepted rollback.

## Existing migration fixture repair

The first exact registration CI exposed three failures in two historical fixture files: positional exposure
values encountered the newer personal columns, and a fixture omitting room-agent storage still included the
personal migration that depends on its delivery index. The local pre-repair run reproduces all three.

The fixtures now derive their historical starting registries from the pre-personal registry. Every upgrade
still runs the full current HTTP registry twice, including the personal migration, then keeps the original
retained-byte and older-registry refusal assertions. The room fixture helper also verifies personal schema v1
and default-off settings; the exposure fixture verifies retained Fleet identity plus the new source fields.
Both files plus the existing retained-row/FK personal upgrade suite pass 10/10. No product migration or runtime
source was changed. [Before](ci-fixtures-before.log), [after](ci-fixtures-after.log).
