# Verify relayed messages and human consent

A peer's summary can omit or change what a person authorized. `delivery_status` previously limited reads to a row's source and target, so a third instance could not verify even a correctly referenced original. Explicit forwarding now grants read-only access to that original row.

```json
{"instance_name":"worker","message":"Review the original consent before acting","forwards":["hmsg-<receipt UUID>"]}
```

`send_to_instance` and `delegate_task` accept up to 16 unique `forwards` IDs. Every reference must be delivered and readable by the authenticated sender. The outgoing message and grants commit together. Merely mentioning an ID grants nothing. A second hop needs its own explicit forward; the receiver cannot see unrelated rows, correlation siblings or hidden cursors. Retrying an admitted operation cannot add or replace references or change its forwarded body, recipient, session or requested mode. Forwarded operations are pinned by authenticated sender and operation ID, independently of the effective delivery mode. An unchanged retry reuses its original effective mode even if a queued predecessor appears or clears. A minimal operation checkpoint survives notification pruning; if that admitted row is gone, the retry refuses instead of creating new grants.

## Original human receipt

Fresh trusted Discord and Telegram ingress captures the actual adapter, actor ID, username and platform message ID. Quoted messages, bot/system messages, agent text and historical relays never acquire a human origin. Discord receipts require a non-system Default (0) or Reply (19) event; thread-created titles and unsupported/unknown types carry no human authority. Discord native forwards retain the outer person's own comment as original content; a quoted author's text is not that person's authorization.

The target receives a separate `[agend-human-id:hmsg-…]` header and `verification_id`. Platform `message_id` stays intact for replies and reactions. Use the verification ID for an original human lookup:

```json
{"message_id":"hmsg-<receipt UUID>"}
```

The result contains original `content`, `origin`, `content_sha256`, `wire_content_sha256`, `proof_kind` and `delivered_at`. Original input is snapshotted before attachments, Classic chat context and Web/slash action argument trimming; the wire digest covers the actual formatted, sanitized bytes. A receiver with an explicit grant reads the same immutable original, not the relay's summary. Other status selectors keep content redacted.

- Native messages: `origin.platform`, `adapter_id` and `user_id` are separate authority facts. A display label is not an actor ID.
- Button/slash actions: origin identifies the click/interaction and its anchor when available; `platform_message_id` is null because the bot reply is not a human-authored message. A button receipt's original content is its visible label; a hidden value is only in the wire body.
- Web: platform is `web`, and platform actor/adapter/message IDs are null. It does not claim verified Telegram or Discord consent.

Before an irreversible action, verify **both** the relaying peer's message and the original human receipt. Require delivered with a supported owned proof, the expected platform/adapter/actor authorized for that resource, and original content naming the exact operation/resource. A receipt proves acceptance by the CLI, not permission for every action. Check real refs/resources independently.

## Positive proof and limits

| Mode | Positive human evidence |
|---|---|
| Idle/native queue | The fresh receipt ID is outside the positively readable input region at the current owned observation. |
| Structural steering | The owned receipt ID was in the fresh composer before Enter; after that Enter the same current composer's exact supported steer/queue/idle mode is positively empty, with a clear dialog and valid deadline. |
| `/raw` | No positive authorization evidence is enabled: pasted bytes carry no receipt ID. |

Every proof matches the receipt ID, mode and wire hash and revalidates the Daemon object/boot, launch tuple, tmux owner, lifecycle and delivery epochs. Output changes, a disappeared draft, generic success, readerless/unknown input or unreadable transcript evidence remain uncertain. No new paste, Enter, transcript polling or resend policy is added. Native acceptance never sets `consumed_at`/`consumed_via`.

`Delivery not found` includes hidden, expired and absent rows. Do not infer consent or resend from it; ask for an explicit forward or fresh consent. Uncertain/queued human receipts cannot be forwarded as consent. Human receipts are evidence only, never pumped or re-delivered. A new process marks unfinished old receipts uncertain; retention removes original evidence and its grants together, while pruning a relay does not remove its original grant.

CLI mode supports repeatable `--forward` on `agend-agent send` / `delegate`, and `agend-agent delivery-status --message-id <verification_id>`.

Same-uid shell-capable agents are not isolated from one another. These grants protect the authenticated tool path, not mutually hostile processes sharing an OS user. Use distinct OS users/containers for that threat model. Rolling back code hides forwarded reads under the previous source/target policy; additive evidence tables can remain on disk. Do not delete or replay the outbox to roll back.

[繁體中文](delivery-verification.zh-TW.md)
