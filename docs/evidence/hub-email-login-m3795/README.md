# Hub sign-in email and UPN — M-3795

The AD driver previously searched only its configured login attribute (normally sAMAccountName). It now tries that exact lookup first, then exact userPrincipalName/mail when no primary entry exists. It does not strip the address, retry a password, or fall back after a disabled/ambiguous primary result. One enabled exact entry is selected; the password binds only its DN, and the existing GUID/DN/eligibility recheck runs after binding. Two results and LDAP size-limit refusals use the ordinary invalid-credentials response; infrastructure failure remains unavailable. OpenLDAP and initialization/pairing/grant lookups retain their existing behavior. The label budget remains, and R1 adds a shared resolved-account budget so aliases cannot multiply password attempts.

The AD-only shell mark offers the EN hint “Sign in with your company email or AD account name.” and zh-TW “可以用公司 email 或 AD 帳號登入。”; autocomplete=username stays. The former instruction to drop the @ part is removed. Old shells have no positive hint until refreshed; they do not gain a false capability claim. The existing HubSignIn card/form and shared note styling are reused; no CSS or layout component change. Follows docs/design/ui-style-guide.md.

## Verification

- Initial 11 new directory cases on the unchanged base: 6 assertion failures / 5 controls passed.
- Initial affected run: 244 passed / 1 existing restored-directory-settings timeout, across 5 files (245 cases). No timeout raised. The same case passed in a scoped rerun.
- Final scoped run: 17 passed (15 new cases + AD composition mark + the restored-settings case); 143 deliberately unselected cases. Together with the first run this covers 249 distinct cases across 5 files. Final 15-case restored run and test types/build are retained locally.
- New actual driver cases use inert LDAP/TLS seams; actual Hub HTTP/session/SQL proves the same GUID yields one person row via all three identifiers, generic refusal and the unchanged five-attempt limit. No live directory calls.
- Three preceding-revision production reversals fail assertions: unescaped alias, missing AD profile gate, missing ambiguity refusal. mutations.json records inputs; mutation-baseline.patch reconstructs that predecessor from final source (the final change only avoids retrying a rejected module import in error handling). Restored controls pass.

Commands: vitest run tests/hub-directory-email-m3795.test.ts tests/hub-directory-init-lookup.test.ts tests/hub-compose.test.ts tests/hub-ui-s3-server.test.ts tests/hub-ui-s3.test.ts; scoped rerun uses -t 'M3795|directory matches|HTTP failures|person row|OpenLDAP ambiguity|loginWithEmail|runs prepare/test/Save as restored'; tsc --noEmit -p tsconfig.test.json; npm run build. Mutation commands select the corresponding new assertion cases only.

## Real-app capture scope

16 originals: before/after × desktop1366/phone390 × EN/zh-TW × light/dark. R1 replaces only the eight after views for the Leader-requested plain wording; all eight baseline files remain byte-identical. Presentation is bound separately from authentication tests; the requested throttle correction is recorded in review-r1.md. All individually inspected; no clipping or private data found. The phone Chinese hint can wrap between characters; no value/control is obscured. capture-inputs.json binds baseline and candidate presentation bytes, exact baseline interception counts and autocomplete/overflow/error results. Before uses the actual base panel/strings via exact URL interception plus the base shell mark; after uses candidate assets. Real Hub shell/listener and s3bRig synthetic directory, local scratch keys/home, no live Fleet/account/directory/model. All contexts/listeners/home closed. The first harness launch failed on an unavailable execFileSync export before creating resources; the corrected harness completed once. Scripts and hashes are retained. No provider or native-directory acceptance is claimed.

## Limits and rollback

Directory ACLs must permit the service reader to match UPN/mail. Ambiguous or disabled results refuse, even if a duplicate points to a disabled entry. No new directory configuration or persisted state. Reverting the patch restores account-name-only sign-in; sessions keep the same immutable identity. USER LOOK HOLD remains until explicit approval; no deployment or merge here.
