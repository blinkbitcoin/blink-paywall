/**
 * Hard payment source: L402 ("HTTP 402 Payment Required").
 *
 * The owner's server (or ANY L402-protected resource) mints the invoice and
 * enforces access; the widget is just an L402 browser client:
 *
 *   GET url                -> 402, WWW-Authenticate: L402 macaroon=".." invoice=".."
 *   pay, obtain preimage   -> Blink public status poll (Blink-issued invoices)
 *                             or WebLN (any invoice; raced by the paywall)
 *   GET url + Authorization: L402 macaroon:preimage -> 200 + content
 *
 * The macaroon:preimage pair is a bearer token, persisted per URL and replayed
 * on return visits until the server rejects it.
 */

import * as blink from '../blink.js';
import { buildAuthorization, decodeAmountSats, parseChallenge } from '../l402.js';
import { loadToken, saveToken, clearToken } from '../storage.js';

async function parseBody(response) {
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type.includes('json')) {
        try {
            return await response.json();
        } catch {
            return {};
        }
    }
    const text = await response.text();
    return text ? { html: text } : {};
}

export function createL402Source(config) {
    const url = config.l402;

    async function authorizedFetch(token) {
        const response = await fetch(url, {
            headers: {
                Authorization: buildAuthorization(token.macaroon, token.preimage),
                Accept: 'application/json, text/html;q=0.9',
            },
        });
        if (response.status === 401 || response.status === 402) return null; // token rejected
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        return await parseBody(response);
    }

    return {
        kind: 'l402',
        scope: `l402:${url}`,

        /** Replay a stored token. @returns {Promise<{response: object}|null>} */
        async restore() {
            const token = loadToken(url);
            if (!token) return null;
            const response = await authorizedFetch(token);
            if (response === null) {
                clearToken(url);
                return null;
            }
            return { response };
        },

        async challenge() {
            const response = await fetch(url, { headers: { Accept: 'application/json' } });
            if (response.ok) {
                // Not protected (or already authorized by a cookie): unlock free.
                return { free: true, response: await parseBody(response) };
            }
            if (response.status !== 402) {
                throw new Error(`Server returned ${response.status}`);
            }
            const header = response.headers.get('WWW-Authenticate');
            const challenge = parseChallenge(header);
            if (!challenge) {
                throw new Error('Server sent 402 without a valid L402 challenge');
            }
            return {
                paymentRequest: challenge.invoice,
                macaroon: challenge.macaroon,
                sats: decodeAmountSats(challenge.invoice) || undefined,
                // The real invoice expiry is unknown; poll for a bounded window.
                expiresAt: Date.now() + 15 * 60_000,
            };
        },

        async checkOnce(challenge) {
            const result = await blink.checkStatus(challenge.paymentRequest);
            return result.status === 'PAID' ? { preimage: result.preimage } : null;
        },

        /**
         * Poll Blink's public status API — works for Blink-issued invoices
         * (our reference server). Non-Blink L402 invoices settle via the
         * WebLN preimage race in the paywall instead.
         */
        settle(challenge, { signal } = {}) {
            return blink.watchPayment(challenge.paymentRequest, {
                expiresAt: challenge.expiresAt,
                signal,
            });
        },

        /** Exchange preimage for content; persist the bearer token. */
        async finalize(challenge, preimage) {
            const token = { macaroon: challenge.macaroon, preimage };
            const response = await authorizedFetch(token);
            if (response === null) {
                throw new Error('The server rejected the payment token');
            }
            saveToken(url, token);
            return { response };
        },
    };
}
