# Kiro upgrade adoption fixture (#1624)

`conversation-v1.json` is a real `conversations_v2.value` written by the official
kiro-cli 2.29.0 Classic binary during the isolated #1595 probe. The probe used a
scratch HOME, a private tmux socket, `unshare -rn`, a dummy social token and a
loopback synthetic model service. No real account or operator store was read.
Only scratch paths are replaced with `/fixture/work` and `/fixture/home`; the JSON structure is
unchanged. Tests replace the conversation id and use fixture timestamps.

Native table shape:

```sql
CREATE TABLE conversations_v2 (
 key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY (key, conversation_id)
);
```

Selection reads only metadata through `idx_conversations_v2_key_updated`, never
parses this TEXT. The fixture proves row compatibility, not account integration.
