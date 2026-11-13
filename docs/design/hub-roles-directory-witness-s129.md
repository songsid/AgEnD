# Retained administration witness at a directory decision

This is an inactive continuation of #3819 and #3820. The source may expose the exact decision's callback-local `decisionProof` getter. Construction captures that getter and the permit's explicit decision assertion by identity. The ordinary administration check remains mandatory outside an actual frame; a missing getter does not create an exception.

During a frame, the retained witness invokes the same permit's explicit assertion, which owns the database/Hub/actor/session/request/policy/version/clock fences from #3820. The witness verifies its original source and actor before and after both getter and permit callbacks. Replacing the getter or permit method, changing the source image or observing any failed assertion permanently retires the witness. Thenables and undefined getter results refuse; invalid handles still require the underlying opaque proof's authority.

The source interface carries this optional server-only method. No production source produces it in this slice. It is not a request/response field, a new session, a renewed permit or an old-policy fallback. The five-second administration proof and strict normal readers retain their limits.

Validation uses actual SQLite, session, audit, transport, role cutover and decision logic; directory answers and staged file-image hashes are synthetic. Extra reentrant callback controls wrap an actual permit with owned inert callbacks. This does not establish a working auxiliary Directory Save, file installation, successor-session authorization, HTTP issuer, startup activation or a browser/container/live-directory operation.

The sealed writer, session transition and factory remain unchanged. Their integration, mounted recovery/expiry/ACK/member/SSE acceptance and the remaining S-129 controls follow. The parent-first plain-merge/current-head review and CI rules, full-S129 hold and alpha.3 release freeze remain. Rollback before activation is to leave the getter producer absent.
