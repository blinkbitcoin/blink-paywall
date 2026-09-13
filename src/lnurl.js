/**
 * LNURL-pay (LUD-16) + LUD-21 verify — the self-custodial (Blink Spark) path.
 *
 * A Spark user has no custodial wallet, so `accountDefaultWallet` fails; their
 * `username@blink.sv` Lightning address still works via Blink's LNURL server
 * (CORS-open), and the callback returns a LUD-21 `verify` URL whose response
 * carries `settled` + `preimage`.
 *
 * Ported from donation-button.blink.sv/js/blink-lnurl.js (AGPL-3.0).
 */

import { poll } from './blink.js';

export const LNURL_DOMAIN = 'blink.sv';

/** LN-address invoices default to a 15-minute expiry on the Blink LNURL server. */
export const LNURL_EXPIRY_MINUTES = 15;

/**
 * Request an invoice for `username@blink.sv` via LNURL-pay.
 * @returns {Promise<{paymentRequest: string, verifyUrl?: string}>}
 * @throws {Error} error.usernameNotFound = true when the address does not exist.
 */
export async function getLnurlInvoice(username, amountSats, memo) {
    const endpoint = `https://${LNURL_DOMAIN}/.well-known/lnurlp/${encodeURIComponent(username.toLowerCase())}`;
    const metaResponse = await fetch(endpoint, { headers: { Accept: 'application/json' } });
    if (!metaResponse.ok) {
        const error = new Error(`LNURL endpoint returned ${metaResponse.status}`);
        if (metaResponse.status === 404) error.usernameNotFound = true;
        throw error;
    }
    const meta = await metaResponse.json();
    if (meta.tag !== 'payRequest' || !meta.callback) throw new Error('Invalid LNURL pay response');
    if (typeof meta.minSendable !== 'number' || typeof meta.maxSendable !== 'number') {
        throw new Error('LNURL response missing min/max sendable amounts');
    }

    const amountMsats = Math.round(amountSats) * 1000;
    if (amountMsats < meta.minSendable) {
        throw new Error(
            `Amount ${amountSats} sats is below minimum ${Math.ceil(meta.minSendable / 1000)} sats`
        );
    }
    if (amountMsats > meta.maxSendable) {
        throw new Error(
            `Amount ${amountSats} sats exceeds maximum ${Math.floor(meta.maxSendable / 1000)} sats`
        );
    }

    let comment = memo || '';
    const commentAllowed = meta.commentAllowed || 0;
    comment = commentAllowed > 0 ? comment.slice(0, commentAllowed) : '';

    const url = new URL(meta.callback);
    url.searchParams.set('amount', String(amountMsats));
    if (comment) url.searchParams.set('comment', comment);

    const callbackResponse = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
    });
    if (!callbackResponse.ok) throw new Error(`LNURL callback returned ${callbackResponse.status}`);
    const callback = await callbackResponse.json();
    if (callback.status === 'ERROR')
        throw new Error(`LNURL error: ${callback.reason || 'Unknown error'}`);
    if (!callback.pr) throw new Error('LNURL callback did not return a payment request');

    return { paymentRequest: callback.pr, verifyUrl: callback.verify };
}

/**
 * One LUD-21 verify check.
 * @returns {Promise<{settled: boolean, preimage?: string}>}
 */
export async function checkVerify(verifyUrl) {
    const response = await fetch(verifyUrl, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`LNURL verify returned ${response.status}`);
    const data = await response.json();
    if (data.status === 'ERROR') {
        const reason = data.reason || 'Unknown error';
        const error = new Error(`LNURL verify error: ${reason}`);
        if (/not\s*found/i.test(reason)) error.terminal = true;
        return Promise.reject(error);
    }
    return { settled: data.settled === true, preimage: data.preimage || undefined };
}

/**
 * Wait until a LUD-21 verify URL reports settled. Resolves {preimage}.
 */
export function watchVerify(verifyUrl, { expiresAt, signal, intervalMs } = {}) {
    return poll(
        async () => {
            const result = await checkVerify(verifyUrl);
            return result.settled ? { preimage: result.preimage } : null;
        },
        { expiresAt, signal, intervalMs }
    );
}
