# Joining a Hub and trusting a pilot Hub

> Preview behaviour. Company sign-in is the way in; the
> pairing form and the pilot-trust switch below exist for Hubs that need
> them. Turn pilot trust off once the Hub has a trusted certificate.

## One way in

On your dashboard, **Settings → Hub** has one box, **Hub address**. Type the
address your administrator gave you (`hub.example.com` is enough, without
`https://`); with a join code, add a space and the code
(`hub.example.com ABCD-EFGH`).

Once the Hub at that address answers that it takes company sign-in, that
sign-in is the one way in: the older **Other ways** pairing-code form is
hidden. **Other ways** stays for a Hub without company sign-in — and while
the Hub cannot be reached or its certificate is not trusted, because the
page cannot tell yet.

## The pairing-code form

**Other ways** holds the pairing-code method for Hubs without company
sign-in. The form has its own **Hub address** box: type the address shown
with the pairing code (it ends in a port). It is the member address, not
the address of the Hub's pages.

A pairing code is 12 characters, 0–9 and a–f (for example `1a2b3c4d5e6f`);
dashes and spaces are ignored. The page checks the shape before anything
is confirmed — submit stays disabled until it looks right. A join code
(`XXXX-XXXX`) typed here belongs in the **Hub address** box at the top of
the card instead: "This is a join code. In “Hub address” at the top of this
card, type the address, a space, then this code."

If a confirmed pairing is not applied, the page names the handler's own
reason instead of a generic retry line:

- "Confirmed, but it was not applied: that is not a valid pairing code. A
  pairing code is 12 characters, 0–9 and a–f."
- "Confirmed, but it was not applied: that is not a Hub's member address."
- "Confirmed, but it was not applied: the Hub could not be reached at that
  address."
- "Confirmed, but it was not applied: the Hub refused this pairing code
  (used, expired or not issued for this Hub)."
- "Confirmed, but it was not applied: the Hub is busy. Try again in a
  moment."

## Trusting a pilot Hub's self-signed certificate

A Hub your team is piloting may use a self-signed test certificate, which
this computer cannot confirm by itself. In the **Hub address** box it shows
"This Hub uses a self-signed test certificate", its **Certificate
fingerprint**, and **Show the full fingerprint**. Compare the fingerprint
with your Hub administrator, then press **Trust this Hub and continue** —
or **Cancel**. Trusting saves exactly that certificate for this Hub address
and carries on with company sign-in; a join code you already typed stays
included.

Afterwards the found line reads "You trusted this Hub's self-signed
certificate (for testing)." If the certificate changes, the saved pin
refuses the connection; only after the administrator confirms the
replacement do you press **Trust again and continue**, which replaces just
that pin. Expired certificates, wrong host names, and an untrusted issuing
chain keep the ordinary certificate error — trusting never overrides those.

The Fleet switch **Allow trusting a Hub with a self-signed certificate
(for testing)** stays available in **Settings → Hub**, including after
connection. Turn it off after the pilot or once the Hub uses a trusted
certificate; alpha and beta (prerelease) builds default it on, stable builds off. With it off,
connection needs ordinary certificate trust, and the browser opened for
sign-in keeps its own certificate policy either way.
