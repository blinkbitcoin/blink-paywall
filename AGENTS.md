# AGENTS.md — architecture and guardrails

One-paragraph mental model: **a paywall instance is a state machine**
(`locked → invoice → paid → unlocked`, side exits `expired`/`error`) that
buys a `{ preimage }` from a *payment source*, turns it into a *receipt*,
persists it, and hands it to the *actions* registry. Everything else is
plumbing around that sentence.

## Map

```
src/index.js          public API (mount/scan/actions/version) + auto-scan; el.dataset IS the config parser
src/paywall.js        the state machine; source + view are INJECTED (test with fakes)
src/sources/blink.js  soft mode: public on-behalf invoice; Spark fallback via LNURL
src/sources/l402.js   hard mode: 402 client; bearer token per URL in localStorage
src/blink.js          Blink public GraphQL + generic bounded poll() (2s, 5s backoff, expiry+5s grace)
src/lnurl.js          LUD-16 pay + LUD-21 verify (ported from donation-button.blink.sv)
src/l402.js           pure: WWW-Authenticate parse, bolt11 HRP amount decode (ported from blink-skills)
src/actions.js        registry: webhook, unlockClass, reveal, redirect (redirect always last)
src/storage.js        receipts / pending invoices / L402 tokens; ALL guarded try/catch
src/ui.js             shadow-DOM card; reports intent via handlers (onUnlock/onRetry/onPreimage)
src/qr.js             vendored qrcode-generator 1.4.4 (MIT) — do not edit, eslint-ignored
examples/l402-server  reference hard-paywall backend; macaroon.mjs is WIRE-COMPATIBLE with
                      blink-skills _l402_macaroon.js (byte-identical vector in tests/macaroon.spec.js)
index.html+generator.js  generator page, served raw (no build)
```

Build: esbuild → `v1/blink-paywall.js` (IIFE, global `BlinkPaywall`, `.css`
imported as text). `/v1/` is gitignored; CI builds it on deploy, so the
published URL is `<pages-origin>/v1/blink-paywall.js`.

Hosting: GitHub Pages from `main` via Actions, currently
`https://blinkbitcoin.github.io/blink-paywall/`. `paywall.blink.sv` is the
intended domain: adding it = DNS record + a `CNAME` file + swapping the URL
in `generator.js` (`SCRIPT_URL`), `README.md`, `src/index.js` (doc comment),
`examples/l402-server/README.md` and `index.html` (canonical + og:url).

## Payment flow (high level)

1. **Soft, custodial-first**: `accountDefaultWallet(username)` →
   `ln(Usd)InvoiceCreateOnBehalfOfRecipient` (sats / cents, memo
   `Unlock: <title>`, 15/5-min expiry) → poll public
   `lnInvoicePaymentStatusByPaymentRequest`, which returns the **preimage**
   when PAID.
2. **Soft, Spark fallback**: no custodial wallet → LNURL-pay
   `blink.sv/.well-known/lnurlp/<user>` → poll LUD-21 `verify`.
3. **Hard (L402)**: fetch → 402 → parse header → same QR UI → preimage from
   the Blink poll *raced against WebLN* (`ui.js` hands it up) → refetch with
   `Authorization: L402 macaroon:preimage` → 200 body drives the actions.

Everything is called from the browser, unauthenticated. The reference server
needs no API key either (public on-behalf mutation + stateless HMAC macaroon).

## Invariants (don't break these)

- **Zero runtime dependencies.** Dev-deps only. New npm packages need a very
  good reason.
- The public embed contract is frozen: one script tag + `[data-blink-paywall]`
  attributes + `BlinkPaywall.{mount,scan,actions,version}` + the
  `blink:unlocked` event. Additive changes only; the deployed URL is
  versioned (`/v1/`) — breaking changes mean `/v2/`.
- `paywall.js` must not import concrete sources; `sources/*` must not touch
  the DOM; `ui.js` must not do payments; `storage.js` never throws.
- Pollers are bounded (invoice expiry + grace) and cancellable
  (AbortController). Never ship an unbounded poll loop.
- Locked content stays inert: it lives in `<template>` (or server-side in
  hard mode). Never render/fetch it pre-payment.
- The soft/hard security distinction in README (`## Security model`) is
  honest marketing law: never describe soft mode as secure.
- `examples/l402-server/macaroon.mjs` stays wire-compatible with blink-skills
  (`tests/macaroon.spec.js` has the frozen byte-identical vector).

## Testing

`npm test` — vitest + jsdom. `tests/paywall.spec.js` runs the full flow with
a fake source against the REAL view (shadow DOM), fake timers. Blink API is
never hit in tests (fetch stubbed). Manual e2e needs a second Blink account
(CANT_PAY_SELF).

Known deliberate cuts: polling only (no GraphQL WS subscription), English
only, no replay protection on L402 tokens (bearer semantics, as blink-skills),
browser-POST webhook is spoofable (Blink's invoice `webhookUrl` input could
replace it once its callback payload is documented).
