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
   tunnel**. Create a remotely managed Cloudflared tunnel and name it.
   Some accounts show this under Cloudflare One → Networks → Connectors.
2. In the connector installation instructions, copy **only the connector
   token** following `--token`. Do not paste the installation command into
   AgEnD. Do not install a separate cloudflared service for this tunnel:
   AgEnD owns its connector process. Use a dedicated tunnel for this host.
3. On the tunnel's **Routes** tab, select **Add route → Published application**.
   Choose your subdomain and domain, for example `agend.example.com`.
4. Set Service URL to **HTTP**, **127.0.0.1:19282**. Leave the path empty and
   leave the HTTP Host Header override unset. Save the route. This is AgEnD's
   restricted public gateway; **do not point it at the main web port 19280**.
   If 19282 is occupied, choose another port in both AgEnD and this route.

Dashboard labels can change; see Cloudflare's current
[dashboard setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
and [run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/).

## Configure AgEnD

On the direct, signed-in dashboard (not through the public link), open
**Settings → Web**:

1. Enter `agend.example.com` in **Fixed public hostname**. An HTTPS root URL
   such as `https://agend.example.com/` also works. No wildcard, IP address,
   port, path, query, user information or fragment is accepted.
2. Set **Named tunnel origin port** to 19282, or the port used above. Review
   and apply the changes, confirming the requested change when prompted.
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
command-line argument. Named-mode child diagnostics are withheld to avoid
echoing credentials. Local processes with the same OS identity can still
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
