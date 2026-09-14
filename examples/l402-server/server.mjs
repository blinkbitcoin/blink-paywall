/**
 * Reference L402 paywall server — the HARD paywall backend for Blink Paywall.
 *
 * Zero dependencies (node:http), no API key, no database:
 *   - invoices are minted into YOUR Blink wallet with the public
 *     `lnInvoiceCreateOnBehalfOfRecipient` mutation (only your username needed)
 *   - access tokens are stateless macaroons (see macaroon.mjs); verification
 *     is pure crypto: HMAC (we minted it) + preimage (it was paid) + caveats
 *
 * Run:
 *   BLINK_USERNAME=<your-blink-username> node server.mjs
 *
 * Env:
 *   BLINK_USERNAME    required — payments go to this Blink account
 *   PORT              default 4402
 *   L402_ROOT_KEY     64-char hex; random per boot if unset (old tokens die on restart)
 *   TOKEN_TTL_DAYS    how long a paid unlock stays valid (default 30)
 *
 * Endpoints:
 *   GET /content/:id      the L402-protected resource (this URL goes in data-l402)
 *   GET /                 demo page embedding the widget
 *   GET /widget.js        the built widget (../../v1/blink-paywall.js)
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createMacaroon, verifyToken } from './macaroon.mjs';

const USERNAME = process.env.BLINK_USERNAME;
const PORT = Number(process.env.PORT || 4402);
const TOKEN_TTL_DAYS = Number(process.env.TOKEN_TTL_DAYS || 30);
const API_URL = 'https://api.blink.sv/graphql';

if (!USERNAME) {
    console.error('BLINK_USERNAME is required (payments go to that account).');
    process.exit(1);
}

const ROOT_KEY = process.env.L402_ROOT_KEY
    ? Buffer.from(process.env.L402_ROOT_KEY, 'hex')
    : crypto.randomBytes(32);
if (ROOT_KEY.length !== 32) {
    console.error('L402_ROOT_KEY must be 64 hex characters (32 bytes).');
    process.exit(1);
}
if (!process.env.L402_ROOT_KEY) {
    console.warn('No L402_ROOT_KEY set — using a random key; tokens will not survive a restart.');
}

// ── Your content ─────────────────────────────────────────────────────────────
// Anything you can express as JSON: `html` is revealed in place of the
// paywall card; `redirect` sends the visitor to a URL instead.
const CONTENT = {
    ebook: {
        title: 'The Full Article',
        priceSats: 210,
        body: {
            html: '<article><h2>The Full Article</h2><p>This paragraph was delivered by the server only after the Lightning payment was cryptographically verified. Client-side tricks cannot reach it.</p></article>',
        },
    },
    download: {
        title: 'Download link',
        priceSats: 1000,
        body: { redirect: 'https://example.com/files/secret.pdf?sig=...' },
    },
};

// ── Blink public API (no key) ────────────────────────────────────────────────

async function gql(query, variables) {
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    const data = await response.json();
    if (data.errors && data.errors.length) throw new Error(data.errors[0].message);
    return data.data;
}

let walletPromise = null;
function getWallet() {
    walletPromise ||= gql(
        `query DefaultWallet($username: Username!) {
            accountDefaultWallet(username: $username) { id currency }
        }`,
        { username: USERNAME }
    ).then((data) => data.accountDefaultWallet);
    return walletPromise;
}

/**
 * Create an invoice for exactly `sats` into the owner's wallet. A USD wallet
 * gets the sat-denominated variant — invoicing it in cents would round to a
 * whole cent and add the dealer spread, so the payer would be quoted more than
 * the advertised price. Blink credits the USD wallet either way.
 */
async function createInvoice(sats, memo) {
    const wallet = await getWallet();
    const name =
        wallet.currency === 'BTC'
            ? 'lnInvoiceCreateOnBehalfOfRecipient'
            : 'lnUsdInvoiceBtcDenominatedCreateOnBehalfOfRecipient';
    // USD invoices carry an exchange rate, so Blink caps them at 5 minutes.
    const expiresIn = wallet.currency === 'BTC' ? '15' : '5';
    const data = await gql(
        `mutation CreateInvoice($input: ${name[0].toUpperCase()}${name.slice(1)}Input!) {
            ${name}(input: $input) {
                invoice { paymentRequest paymentHash }
                errors { message }
            }
        }`,
        { input: { recipientWalletId: wallet.id, amount: String(sats), memo, expiresIn } }
    );
    const payload = data[name];
    if (payload.errors && payload.errors.length) throw new Error(payload.errors[0].message);
    return payload.invoice;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'WWW-Authenticate',
};

function send(res, status, headers, body) {
    res.writeHead(status, { ...CORS, ...headers });
    res.end(body);
}

const json = (res, status, value, headers = {}) =>
    send(res, status, { 'Content-Type': 'application/json', ...headers }, JSON.stringify(value));

async function handleContent(req, res, id) {
    const item = CONTENT[id];
    if (!item) return json(res, 404, { error: 'unknown content id' });

    // 1. Valid token -> content. Stateless: HMAC + preimage + caveats.
    const check = verifyToken({
        authorization: req.headers.authorization,
        rootKey: ROOT_KEY,
        resource: id,
    });
    if (check.valid) return json(res, 200, item.body);

    // 2. No/invalid token -> mint invoice + macaroon, answer 402.
    const invoice = await createInvoice(item.priceSats, `Unlock: ${item.title}`);
    const macaroon = createMacaroon({
        paymentHash: invoice.paymentHash,
        rootKey: ROOT_KEY,
        resource: id,
        expirySeconds: Math.floor(Date.now() / 1000) + TOKEN_TTL_DAYS * 86_400,
    });
    send(
        res,
        402,
        { 'WWW-Authenticate': `L402 macaroon="${macaroon}", invoice="${invoice.paymentRequest}"` },
        JSON.stringify({ error: 'payment required' })
    );
}

const DEMO_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Blink Paywall — L402 demo</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family: sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px">
  <h1>Hard paywall (L402) demo</h1>
  <p>The content below is served by this server only after payment verification.</p>
  <script defer src="/widget.js"></script>
  <div data-blink-paywall data-l402="http://localhost:${PORT}/content/ebook"
       data-title="The Full Article" data-description="One-time payment, verified server-side."></div>
</body></html>`;

http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
    try {
        if (req.method === 'OPTIONS') return send(res, 204, {}, '');
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

        const contentMatch = pathname.match(/^\/content\/([\w-]+)$/);
        if (contentMatch) return await handleContent(req, res, contentMatch[1]);
        if (pathname === '/') return send(res, 200, { 'Content-Type': 'text/html' }, DEMO_PAGE);
        if (pathname === '/widget.js') {
            const widget = await readFile(new URL('../../v1/blink-paywall.js', import.meta.url));
            return send(res, 200, { 'Content-Type': 'text/javascript' }, widget);
        }
        json(res, 404, { error: 'not found' });
    } catch (error) {
        console.error(error);
        json(res, 500, { error: error.message });
    }
}).listen(PORT, () => {
    console.log(`L402 paywall server for @${USERNAME}: http://localhost:${PORT}/`);
});
