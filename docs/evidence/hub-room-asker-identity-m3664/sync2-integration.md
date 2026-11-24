# Settlement-hook release integration

While the first synced head's CI was pending, the release base advanced again and GitHub reported CONFLICTING. This plain merge combines source-cleared a71de4546 with release2698b130, which adds M-3660 question settlement/own-turn behavior and a pricing update.

Only compose/member.ts and locale.ts conflicted. Both settlement-hook detach calls and asker-getter detach calls are retained. Incoming contact-window wording remains exact, alongside the two existing clock-warning locale values. The locale file is byte-equal to incoming after removing those two own keys. Auto-merged questionSettled methods retain the independent historical getter; signature/actor/companion/GC/deadline policy is unchanged.

Focused actual adapter/member, settlement and own-turn controls passed66/4. The existing provenance case additionally asserts unsettled before answer, settled after answer/ACK/restart, while the same historical verified author remains readable and no new input is created. Incoming daemon tests replay frames with pane/native probes stubbed; no CLI/tmux/account/model runs. Types and full build/postbuild exited0. Parent/resolution hashes and the zero-context patch are retained separately; prior proof remains staged.
