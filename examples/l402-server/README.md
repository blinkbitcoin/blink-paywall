# Reference L402 paywall server

The **hard paywall** backend for [Blink Paywall](../../README.md). The widget's
soft mode unlocks in the browser and can be bypassed by anyone who opens
DevTools; this server keeps the locked content off the visitor's machine until
a Lightning payment is cryptographically verified.

Zero dependencies, no database, **no Blink API key**.

## Run

```bash
BLINK_USERNAME=<your-blink-username> node server.mjs
# open http://localhost:4402/ for a working demo page
```

| Env | Default | |
|---|---|---|
| `BLINK_USERNAME` | — | required; payments go to this Blink account |
| `PORT` | `4402` | |
| `L402_ROOT_KEY` | random per boot | 64 hex chars. **Set it in production** — a new key invalidates every token already sold. `openssl rand -hex 32` |
| `TOKEN_TTL_DAYS` | `30` | how long a paid unlock stays valid |

Edit the `CONTENT` map in `server.mjs`: each entry has a `priceSats` and a
`body` — `{ html: "..." }` is revealed in place of the paywall card,
`{ redirect: "..." }` sends the paying visitor to a URL (signed download link,
Calendly, ...).

Embed on any page:

```html
<script defer src="https://blinkbitcoin.github.io/blink-paywall/v1/blink-paywall.js"></script>
<div data-blink-paywall data-l402="https://your-server/content/ebook"
     data-title="Unlock the full article"></div>
```

## How it works (L402)

```
GET /content/ebook
  ← 402  WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
      macaroon = HMAC-signed(root key) over { payment_hash, resource, expiry }
      invoice  = minted into YOUR wallet via the public
                 lnInvoiceCreateOnBehalfOfRecipient mutation (username only)

(visitor pays; the widget obtains the preimage from Blink's public
 payment-status API or from a WebLN wallet)

GET /content/ebook   Authorization: L402 <macaroon>:<preimage>
  ← 200  { "html": ... }
```

Verification is **stateless** and needs no API call:

1. HMAC valid → *we* minted this macaroon, for this resource, and it binds a
   payment hash of an invoice that pays *us*.
2. `sha256(preimage) == payment_hash` → that invoice **was settled** (the
   preimage only leaves the recipient's node on settlement).
3. Caveats: not expired, resource matches.

An attacker cannot self-mint (no root key), cannot pay a cheaper/own invoice
(the hash wouldn't match any macaroon we signed), and cannot guess a preimage.

`macaroon.mjs` is ported from
[blink-skills](https://github.com/blinkbitcoin/blink-skills)' `_l402_macaroon.js`
and is **wire-compatible**: tokens minted here validate with
`blink l402-verify` and vice versa (see `tests/macaroon.spec.js`).

## Limits / production notes

- **Bearer token**: a paying visitor can share their token, like sharing a
  login. There is no per-visitor identity. If that matters, track used
  payment hashes and bind tokens to sessions — deliberately out of scope here.
- One invoice is minted per unauthorized request; unpaid ones simply expire
  (15 min). A hostile client could mint many — rate-limit in front if exposed.
- Same-origin deployments (serve your site and `/content/*` from one host)
  need no CORS at all; the permissive `Access-Control-Allow-Origin: *` here
  is for the cross-origin embed case and is safe because tokens are explicit
  headers, not cookies.
- Works for custodial Blink accounts. Self-custodial (Spark) owners: the
  on-behalf mutation needs a custodial wallet — use soft mode, or adapt the
  server to LNURL-pay + LUD-21 `verify`.
