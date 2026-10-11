# Kiro conversation adoption after an upgrade

The launch ledger was introduced in 2.1.11 (#1171). An upgrade from 2.1.10 or earlier, or an instance that has not
launched since then, can have a conversation but no ledger entry. #1624 permits a one-time adoption when:

- kiro-cli supports per-instance agents (2.21+, with `--agent` and `--resume-id`);
- there is no identity state and no launch record for this instance;
- no other configured Kiro instance in fleet.yaml **or** classicBot.yaml shares its canonical cwd, including stopped
  instances and symlink aliases;
- the newest conversation in the selected engine's store is unclaimed.

The normal identity state, exclusive claim and launch ledger are then recorded. Later launches resume that exact ID.
Existing pre-agent ledger entries still use the original adoption path, including a host upgrading Kiro past 2.21
after upgrading AgEnD. Older Kiro versions run as before. An unreadable/damaged ledger is not proof of absence.
Ambiguous ownership starts durably fresh and reports why once. It does not modify Kiro's conversations.

An existing fresh record, an explicit fresh start, or a change of engine/cwd/credential profile is **not** an upgrade
fallback. The existing evidence-only rules still govern any later take-up. A missing Classic/TUI store on its own
cannot authorize cross-engine adoption; V3's identity policy is unchanged.

## If beta.1 already recorded a fresh identity

There is no automatic repair: overwriting a recorded identity could discard a conversation the user chose to start.
For an operator who has positively identified the original conversation:

1. Stop the fleet and confirm it is stopped, then back up `AGEND_HOME/kiro-identity/` and `kiro-engine-ledger.json`.
   Keep a backup of Kiro's store too. Never edit its live database to recover AgEnD ownership.
2. Identify the instance's state file under `kiro-identity/instances/`: its filename is the first 32 hex characters
   of SHA256(instance name), followed by `.json`. Check the file's `instance` field and exact `keys` entry
   `[engine, canonical cwd, credential profile]`. Read the original ID from the same engine/profile store; for
   Classic the `conversations_v2` metadata (`key`, `conversation_id`, `updated_at`) is enough. Do not infer an ID
   from a different engine or somebody else's history.
3. Verify `kiro-identity/claims/<engine>/<original-id>` is absent. A sibling's, incomplete or abandoned claim is a
   reason to stop; do not overwrite it. The original ID must not be listed as abandoned in the selected record.
4. Create the original ID's claim **exclusively**, mode 0600, containing the instance name and a final newline.
   In the selected record set `id` to that exact ID and `agentConfirmed` to `false`; preserve the other keys and
   history fields. Keep the directory mode 0700. If replacing an already owned newer ID, retain its claim as
   abandoned (`<instance>\nabandoned\n`) and add it to that record's `abandoned` list; never release it for siblings.
   If a write fails, restore the backup before starting anything.
5. Start the fleet. The command should contain `--resume-id '<original-id>'`. The normal verified `/agent swap`
   runs before delivery; check that the instance answers in the intended conversation.

These are manual, offline ownership edits for a known ID, not a migration or a live-downgrade promise.
