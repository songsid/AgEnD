# Alpha.7 acceptance

Pass 1 product build: `b9bcdf454700f02ebb953cabf2297a59ce39f363`.

Real Chrome 156, desktop 1366 × 900 and phone 390 × 844. All fleets, directory users, credentials, APIs, Runtime peers and marker files belong to isolated test rigs. No live fleet or real account was used. This branch contains evidence only.

## C11: new colleague prerequisite

`pass1/pass1-C11-03-allow-new-colleague.png` shows the actual failed Allow. `alex` was an eligible user in the fake LDAPS directory, with no prior Hub session. The owner typed `alex` into the contextual Allow dialog and submitted. The page displayed “Not found, or not available to you.” behind the still-open dialog. After Alex signed in to this Hub once, the unchanged Allow succeeded and showed “1 may ask.”

The existing named-known-person grant restriction is respected. This finding concerns the missing first-sign-in instruction and recovery, not a proposal to broaden grant authority.

Further story results and the dependency delta will be added after pass 2.
