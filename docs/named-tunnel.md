# A fixed public URL with Cloudflare Tunnel

AgEnD can use your Cloudflare **remotely managed tunnel connector token** for
the dashboard public link. Its hostname stays the same when you reopen the
link, so a phone's Add to Home Screen shortcut keeps its address. Leaving the
hostname unset retains the existing random quick tunnel.

This fixes the address, not the exposure lifetime: open the public link from
AgEnD's dashboard menu as usual. The configured 1–480 minute lifetime, Close,
sign-in verification and session revocation still apply. After expiry or a
fleet restart, reopen the link at the same address. It does not start an
always-on public service. Login terminals and preview tunnels retain their
existing separate behavior.

## Create the tunnel

You need a domain managed by Cloudflare DNS and a locally available
cloudflared binary (AgEnD can install its pinned copy as usual). No Cloudflare
API key or DNS-edit permission is stored in AgEnD.

1. In the Cloudflare dashboard, open **Networking → Tunnels → Create a
   tunnel**. Create a remotely managed Cloudflared tunnel. In the name field,
   **type any name**, for example `agend-home`; you do not need to select one
   from a list. Some accounts show this under Cloudflare One → Networks →
   Connectors.
2. In the connector installation instructions, copy **only the long token
   string starting with `eyJ`**. On Windows, the displayed command may look
   like `cloudflared.exe service install eyJ…`: the token follows
   `service install`, with no `--token` flag. Other command examples put it
   after `--token`. In either case, paste just that long string into AgEnD,
   without the command, flag, spaces or quotation marks. Do not run the
   installation command or install a separate cloudflared service for this
   tunnel: AgEnD owns its connector process. Use a dedicated tunnel for this
   host.
3. Return to **Networking → Tunnels** and open the tunnel you just created
   (`agend-home` in this example). Open **that tunnel's Routes tab**, then
   **Add route → Published application**. The account-wide **Networks →
   Routes** page is for private IP/CIDR routes; it is not the page for this
   setup. Choose your subdomain and domain, for example `agend.example.com`.
4. In **Add published application**, enter this complete value in the single
   **Service URL** field: **`http://127.0.0.1:19282`**. Include `http://` in the
   field; there is no separate Type dropdown to find. **Do not add a trailing
   `/` or any path.** Leave the route's Path field empty and the HTTP Host
   Header override unset, then save with **Add route**. This is AgEnD's
   restricted public gateway; **do not point it at the main web port 19280**.
   If 19282 is occupied, choose another port in both AgEnD and this route.

If Cloudflare rejects `http://127.0.0.1:19282/` with
“Validation failed: http://127.0.0.1:19282/ is an invalid address, ingress rules don't support proxying to a different path on the origin service”,
remove the final `/` so the Service URL is exactly `http://127.0.0.1:19282`.

Dashboard labels can change; see Cloudflare's current
[dashboard setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
and [run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/).

## Configure AgEnD

On the direct, signed-in dashboard (not through the public link), open
**Settings → Web**:

1. Enter `agend.example.com` in **Fixed public hostname**. An HTTPS root URL
   such as `https://agend.example.com/` also works. No wildcard, IP address,
   port, path, query, user information or fragment is accepted.
2. Set **Named tunnel origin port** to 19282, or the port used above. Valid
   edits immediately appear in the sticky **changes not applied** bar. Select
   **Apply changes**, then confirm the requested change when prompted. You
   do not need to select **Review changes** first.
3. Paste the token into the masked **Cloudflare connector token** field and
   select **Set token**. Confirm the change when prompted. It is checked for
   format locally; validity and routing are checked when opening the link.
4. Open the public link from AgEnD's dashboard menu. Readiness must return
   this exposure's own marker through the fixed HTTPS hostname before AgEnD
   shares the sign-in URL. Then sign in on the phone and Add to Home Screen.

The configuration contains only a reference:

```yaml
web:
  public_link:
    hostname: agend.example.com
    tunnel_token_env: AGEND_CLOUDFLARE_TUNNEL_TOKEN
    origin_port: 19282
    ttl_minutes: 120
    protocol: http2
```

The token is stored in the existing private `~/.agend/.env` (or the current
AGEND_HOME), written atomically with mode 0600 on Unix. Settings never reads
it back; only configured/not-configured status is returned. It reaches
cloudflared via its child-only `TUNNEL_TOKEN` environment variable, never a
command-line argument. Raw named-mode child diagnostics remain private. AgEnD
classifies them into fixed, sanitized failure reasons instead of echoing vendor
output or credentials. Local processes with the same OS identity can still
inspect private files or process environments; this does not isolate mutually
untrusted users sharing an OS account.

Setting or clearing the token, or changing named settings, closes the current
exposure; reopen it afterward. **Clear token** erases its value and keeps an empty override in `.env`, so an old service environment cannot restore it after restart. To
return to quick tunnels, also blank the hostname and apply the Web settings.
A named hostname with a missing token fails; it never silently opens a random
replacement URL. A busy port, invalid token, wrong route or a wrong readiness
page also leaves public access closed. Check the route, port and connector
token, then reopen. Cloudflare Access can add another layer, but an Access
challenge in front of `/signin` prevents AgEnD's marker probe from succeeding;
configure any such policy with that limitation in mind.

## If opening fails

`/web` and the public-link control in Web settings explain the failed step. Named
failures use fixed messages; raw connector output, tokens and identifiers are not
shown. Check the matching setting, then reopen:

| Reason | Next step |
| --- | --- |
| Connector token refused | Copy only the long `eyJ…` token and use **Set token** again. |
| Published application not reached | Check the tunnel's own Routes tab, hostname and DNS. |
| Different page answered | Point the published application at `http://127.0.0.1:19282`; check redirects or Cloudflare Access challenges. |
| Local origin unreachable | Check the route's Service URL and that its port matches AgEnD's origin port. |
| Cannot connect to Cloudflare | Check network, DNS and firewall access, then retry. |
| Local origin port already in use | Close the conflicting program, or choose another port in both AgEnD and the Cloudflare route. |

A failed readiness check never opens the link. Unknown failures keep a generic
next step rather than exposing arbitrary connector output. Saving a token is a
local format check, not proof that Cloudflare accepts it; opening the link verifies
credentials and routing.

## Acceptance with your Cloudflare account

Development tests use a stub and make no real tunnel calls. With your own
account, verify:

1. Open the named link, sign in, and check that unsigned-in browsers still
   require verification. Save the phone shortcut.
2. Close and reopen: the hostname is identical, old exposure sessions are
   revoked, and the saved shortcut opens the new sign-in page.
3. After TTL expiry or restart, verify it is closed; reopen and use the same
   shortcut. There should be no requirement to save a new URL.
4. Try a wrong hostname/route or invalid token: opening fails and no URL is
   published as ready. Restore the correct values and reopen.
5. Check Settings reads, chat and logs: no token value. On Linux, check the
   owned cloudflared process command line locally: it has `run`, without
   `--token` or the token value. Do not share `/proc/.../environ` or `.env`.
6. Clear the token and hostname, apply, then open again: the existing quick
   tunnel behavior returns. Avoid repeated real quick-tunnel smoke tests on
   networks where Cloudflare rate-limits them.

[繁體中文](named-tunnel.zh-TW.md)
