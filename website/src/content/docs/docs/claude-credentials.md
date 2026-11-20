---
title: 'Connect Claude Code: login, setup token, or API key'
description: Choose how a Claude Code profile signs in, understand billing, and replace or remove a saved credential.
---

This guide applies from the **AgEnD 2.4.0-beta.16 and later**. Earlier versions may not have these controls.

Organization-managed Claude settings are not supported.

## Choose a method

| Method | Where it comes from | Billing and when to choose it |
| --- | --- | --- |
| Subscription login | Claude’s official sign-in page | The usual choice for a Claude subscription. Your plan’s limits apply. |
| Token from setup-token | The official Claude Code CLI on your own computer | A subscription credential for Claude Code; subscription limits still apply. Useful when obtaining the credential on another computer. |
| Anthropic API key | Anthropic Console | Separately billed API usage, outside your Claude subscription allowance. Review API billing before choosing it. |

Availability depends on your plan and organization. See [Claude Code authentication](https://code.claude.com/docs/en/authentication).

<span id="subscription"></span>
## Subscription login

In **Settings → AI accounts & keys → Accounts → Claude Code**, choose **Subscription login** and finish on Claude’s official website. Never paste your website password into AgEnD.

<span id="oauth"></span>
## Get a setup token

In the local dashboard on the AgEnD computer, verify your administrator session and choose **Token from setup-token → Get a token for me**. AgEnD opens a private sign-in session. Choose **Open sign-in page** and sign in on Claude’s website; if prompted, paste the **Authorization code** back into AgEnD. The token goes directly into encrypted storage and is never displayed. The flow expires after 10 minutes; you can retry or paste a token instead. Saving makes no model request.

To obtain a token yourself instead:

1. On **your own computer**, install or open the official Claude Code CLI. Run:

   ```sh
   claude setup-token
   ```

2. Complete the official sign-in flow. Copy the resulting token privately. The command prints it; it does not save it for you.
3. On the computer running AgEnD, open the **local dashboard** and use a verified administrator session. Under the Claude Code account controls, choose **Token from setup-token**, paste it and choose **Save credential**.

A public dashboard link cannot save credentials. Do not send the token in chat or include it in screenshots. The command above is the manual alternative to **Get a token for me**. See the [official CLI reference](https://code.claude.com/docs/en/cli-reference).

<span id="api"></span>
## Get an API key

1. Open [Anthropic Console → API keys](https://platform.claude.com/settings/keys), select the intended workspace, and create a key. Copy it privately.
2. Review billing and configure the organization or workspace spend controls available to your account. These are not arbitrary per-key caps. A separate workspace limit is unavailable for the default workspace; see [workspace spend limits](https://support.claude.com/en/articles/9796807-create-and-manage-workspaces-in-the-claude-console).
3. Return to AgEnD’s local dashboard with a verified administrator session. Choose **Anthropic API key**, paste it and choose **Save credential**.

API charges are separate from your subscription. AgEnD does not set Anthropic’s budget for you.

## Saved does not mean verified

The state **Saved · not verified** means the format was checked and the credential was stored. **Saving makes no model call**, paid or otherwise. Saving alone does not confirm that Anthropic accepts it; the saved status remains unverified. If normal use fails authentication, check or replace the credential. A pasted credential does not provide a subscription meter or a guessed remaining balance.

## Who can obtain the credential?

AgEnD encrypts its saved copy. An agent running under the **same computer user** can still obtain it while it is being used. Encryption does not keep it away from that agent.

API keys reach Claude Code through a credential helper; setup tokens enter the Claude child process’s environment. Neither provides isolation from processes running as that computer user.

## Replace, remove, or revoke

- **Replace:** keeps the profile name, assignments and conversation. Confirm the affected agents and their restart when idle. A format or storage failure keeps the old credential.
- **Remove:** first move or stop the agents using it, then remove AgEnD’s saved credential. The profile and conversation remain; the removed credential is not used as a fallback. This is different from deleting the account profile.
- **Revoke at Anthropic:** removing AgEnD’s copy does not disable copies elsewhere. Delete an API key in Anthropic Console to revoke it; see [API key security guidance](https://support.claude.com/en/articles/9767949-api-key-best-practices-keep-your-keys-safe-and-secure). For setup tokens, follow Anthropic’s current account/session guidance or contact [official support](https://support.claude.com/). This guide does not promise a control for revoking one individual setup token.

## If something goes wrong

If saving is unavailable, open the dashboard on the AgEnD computer and verify your administrator session. For an authentication failure, check the credential type, expiry and provider permissions; replace it if needed. A network failure does not delete the saved credential. For profile selection and switching, see the [Web Guide](/AgEnD/docs/web-guide/).
