# Copied-prompt vocabulary repair

Exact CI43874606926 on4aaef had one failed assertion in ui-zh-terms-815bfe4a: the copied zh-TW setup prompt used the prohibited product word for proxy. All other shard1 suites passed; build failed as an aggregate. The gate is unchanged and no exception is added.

The phrase now says not to install AgEnD or any other program (其他程式), preserving URL-only setup. Only one copied-prompt value changes. The existing vocabulary and app-page suites pass28/2 locally; source bindings below cover the changed dictionary. Earlier native, image, full-gate and review evidence retains its source scope. No browser/model/native/mutation campaign is repeated. Rollback is the phrase change; there is no data or permission migration.

Plain merge of actual alpha df3afc3697e5dcfb968a632bc3b699244bd2ba11 consumes the merged parent. The only two conflicts are this feature's MCP HTTP/policy additions; incoming blobs equal the approved parent9f and the reviewed UI blobs are retained. All72 own paths keep their blobs/modes from the wording source, and all72 incoming-only paths equal alpha. No local rerun or new source review is performed for that unchanged merge per5afe2996; fresh exact-head CI is required.
