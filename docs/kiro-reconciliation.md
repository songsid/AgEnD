# Reconcile an interrupted Kiro carry

Use this only when a TUI fleet instance has its original carried conversation and a newer conversation with work. Automatic recovery deliberately holds instead of choosing between them.

`reconcile_kiro_instance` is available to full/coordinator tool profiles. It requests a fleet-admin **Confirm in General**; the tool call itself does not archive or change anything. It supports keeping the proven original carry, not selecting an arbitrary new session. The instance's CLI must already be stopped (a parked instance is accepted only if stopped-process proof also passes).

```json
{
  "name": "your-kiro-instance",
  "keep_session_id": "original-carried-uuid",
  "archive_session_id": "newer-uuid"
}
```

The prompt names the instance and both IDs. Cancel, expiry, a non-admin click, changed evidence or unavailable auditing prevents the operation. There is no force/confirmation-bypass parameter.

On Confirm, AgEnD reserves the instance against competing starts and deliveries, rechecks its configuration, ownership, complete carried history and stopped processes, and preserves **both** V2 file sets. It archives only the named alternative as an acknowledged conflict; third-session work still blocks. It repairs the original pin, uses the existing verified transaction to archive/remove that original's frozen classic duplicate, then verifies the same ID, model, transcript and forensic reader through an initial start and one ordinary restart. A failure holds/stops the instance; it never opens a fresh conversation or switches to classic. An unconfirmed cleanup stop is reported explicitly.

## Archive and audit

The native V2 `.json`, `.jsonl` and optional `.history` files are never rewritten, moved or deleted. Exact copies are kept under:

```text
<AGEND_HOME>/kiro-reconciliations/<first-32-hex-of-SHA256(instance)>/<receipt>/
```

Each file is private (`0600`), in private directories (`0700`). `manifest.json` contains file hashes, original size/timestamps, exact selection, confirming actor and previous AgEnD identity/claims. Both conversations remain readable locally in their original format; binary `.history` bytes are preserved as well. Archives are never automatically removed, including after rollback. Do not edit an archive or the retired native session: a changed archive/source holds a later launch.

`active.json` in the instance's reconciliation directory records its receipt and phase. General and the instance topic report the outcome/receipt; `kiro_reconcile` events appear in the Log tab, even when the raw Kiro transcript gate is closed. Conversation bodies are not placed in audit events or returned by the tool.

Files, directories and manifest are fsynced and read back before a durable intent can authorize re-pinning. An interrupted confirmed intent can finish only that exact selection; malformed, changed or uncertain evidence holds. Work is bounded on the existing Kiro store worker, outside the fleet event loop.

## Roll back into a stopped hold

Stop this one instance first using the normal single-instance controls. Never use the fleet-wide `agend stop` for this step. Request the **same exact IDs** with the outcome receipt:

```json
{
  "name": "your-kiro-instance",
  "keep_session_id": "original-carried-uuid",
  "archive_session_id": "newer-uuid",
  "rollback_receipt": "64-lowercase-hex-receipt"
}
```

This requires a new admin Confirm. A superseded identity, mismatched scope or changed claims is refused. Rollback restores the exact frozen classic rows from the matching verified archive without overwriting conflicting rows, restores the previous AgEnD identity/claims, and stays stopped. Both native V2 conversations (including work done after reconciliation) and every archive are retained. It does not roll back workspace edits or paste/replay prompts.

A durable rollback-pending/rolled-back marker prevents automatic startup from choosing a conversation. After inspection, a new explicit reconciliation can select the original again. Rollback is not permission to resume classic or an arbitrary alternate session.

Deploy the reviewed code before requesting a real operation. A release or a previous user choice alone does not replace the fresh General confirmation. For a repair run supervised by the fleet leader, wait for that leader's live-call approval.
