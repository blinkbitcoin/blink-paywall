# Blink Paywall

A Lightning paywall for any website: one pasted snippet gates **an
owner-defined action** behind a payment to your [Blink](https://get.blink.sv)
account. No backend, no API key, no account signup for visitors.

Generator (for non-technical users):
**https://blinkbitcoin.github.io/blink-paywall/**

```html
<script defer src="https://blinkbitcoin.github.io/blink-paywall/v1/blink-paywall.js"></script>

<div data-blink-paywall
     data-username="satoshi"
     data-amount="2.50" data-currency="USD"
     data-id="ebook-1"
     data-title="Unlock the full article"
     data-remember="30d">
  <template>
    <!-- locked content: any HTML. Inert until paid — iframes don't even load. -->
  </template>
</div>
```

The visitor sees a card with an "Unlock" button → Lightning invoice QR
(WebLN / `lightning:` deeplink / copy) → on payment the action runs. The
unlock is remembered in `localStorage`.

## What can a payment unlock?

Everything is driven by which attributes are present; all that apply run:

| Attribute | Action | Typical use |
|---|---|---|
| `<template>` child | **reveal** — the template content replaces the card | article, secret code, download link, YouTube/PDF iframe, image, audio |
| `data-redirect="url"` | navigate after payment (runs last) | thank-you page, signed download URL, Calendly |
| `data-unlock-class="x"` | add class `x` to `<html>` | unlock any part of the page with pure CSS |
| `data-webhook="url"` | POST the receipt (JSON) to a URL | Zapier / Make / n8n → email, Google Sheets, Discord |
| `data-l402="url"` | **hard paywall** — see below | content that must stay server-side |
| always | `blink:unlocked` DOM event (bubbles) + `onUnlock(receipt, response)` via `BlinkPaywall.mount(el, { onUnlock })` | anything JavaScript can do |

Developers can add actions without touching this project (a plugin gets its
own `data-confetti` trigger, for example):

```js
BlinkPaywall.actions.confetti = ({ el, config, receipt, response }) => {
  if (config.confetti === undefined) return; // runs only when data-confetti is set
  /* ... */
};
```

## All attributes

| Attribute | Default | |
|---|---|---|
| `data-username` | — | your Blink username (soft mode; required unless `data-l402`) |
| `data-amount` + `data-currency` | — / `sats` | price; currency `sats`, `USD`, `EUR`, ... (any Blink display currency) |
| `data-l402` | — | URL of an L402-protected resource (hard mode) |
| `data-id` | page path | unlocks are remembered per `username`+`id` |
| `data-title`, `data-description` | — | card text |
| `data-remember` | `forever` | `24h`, `7d`, `30d`, ... (`Nm/Nh/Nd`) — how long the unlock lasts on the device |
| `data-theme` | `auto` | `auto` follows the visitor's own light/dark preference; `light` or `dark` pins it |
| `data-redirect`, `data-webhook`, `data-unlock-class` | — | actions, see above |

JS API (for SPAs / custom flows): `BlinkPaywall.scan()`,
`BlinkPaywall.mount(elementOrSelector, overrides)`, `BlinkPaywall.actions`,
`BlinkPaywall.version`. Multiple paywalls per page are fine.

## Security model — read this

**Soft mode (`data-username`) is a soft paywall.** The whole flow runs in the
visitor's browser; the locked content is in the page source and a determined
visitor can open DevTools and take it. That is the same model as most
newspaper paywalls, and it is the honest price of "no backend". Perfect for
tips, articles, supporter perks and honest audiences. Payments themselves are
real and go straight to your wallet; nothing about *money* is spoofable —
only the *unlocking* is client-side.

**Hard mode (`data-l402`) is a real paywall.** Your server keeps the content
and only releases it after cryptographic payment verification, speaking the
standard [L402](https://docs.lightning.engineering/the-lightning-network/l402)
protocol ("HTTP 402 Payment Required"):

```
GET url                                   → 402, WWW-Authenticate: L402 macaroon="…", invoice="…"
(widget shows the QR; visitor pays; preimage obtained from Blink's public
 payment-status API, or from the WebLN wallet for non-Blink invoices)
GET url  Authorization: L402 mac:preimage → 200 → response unlocks the card
```

The 200 response controls the action: `{ "html": "…" }` is revealed in place
of the card, `{ "redirect": "…" }` navigates, any other JSON is handed to
`onUnlock`/`blink:unlocked`. The token is stored and replayed on return
visits until your server says no.

A zero-dependency reference server (no Blink API key needed — ~200 lines of
`node:http`) lives in [`examples/l402-server/`](examples/l402-server/), with
the threat model in its README. Its macaroons are wire-compatible with
[blink-skills](https://github.com/blinkbitcoin/blink-skills)' `blink l402-verify`.

`data-l402` also works against **any** L402 resource on the internet, not
just our reference server — note that non-Blink invoices settle only through
a WebLN wallet (there is no public status API to poll).

The `data-webhook` POST comes from the visitor's browser and can be forged —
treat it as a notification, never as proof of payment.

## Self-custodial (Blink Spark) recipients

Soft mode works: the widget falls back to LNURL-pay on `username@blink.sv`
and detects settlement via LUD-21 `verify`. Hard mode's reference server
needs a custodial wallet (the public on-behalf-of mutation).

## Development

```bash
npm install
npm test            # vitest (jsdom) — unit + full flow tests
npm run lint
npm run build       # esbuild → v1/blink-paywall.js (single file, no runtime deps)
npm run dev         # watch + serve
```

Manual end-to-end: `examples/soft.html` (soft) and
`BLINK_USERNAME=you node examples/l402-server/server.mjs` →
http://localhost:4402/ (hard). A real payment needs a *second* Blink account —
Blink blocks paying yourself.

Architecture: `src/paywall.js` orchestrates a per-element state machine
(locked → invoice → paid → unlocked) and depends only on interfaces:
payment *sources* (`src/sources/blink.js` soft, `src/sources/l402.js` hard —
same shape: `challenge / settle / checkOnce / finalize? / restore?`), the
*view* (`src/ui.js`, shadow DOM), *storage* and the open *actions* registry.
Adding a payment source or an action touches nothing else.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
