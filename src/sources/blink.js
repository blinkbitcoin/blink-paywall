/**
 * Soft (backendless) payment source: invoices are created straight from the
 * visitor's browser with Blink's public API.
 *
 * Custodial-first: `accountDefaultWallet(username)` -> on-behalf-of invoice.
 * Self-custodial (Spark) fallback: no custodial wallet -> LNURL-pay to
 * `username@blink.sv`, settled via the LUD-21 verify URL.
 */

import * as blink from '../blink.js';
import * as lnurl from '../lnurl.js';

export function createBlinkSource(config) {
    // Shows in the recipient's Blink transaction list. The prefix is context
    // for them, so skip it when the title already says "Unlock ...".
    const label = config.title || config.id;
    const memo = /^unlock\b/i.test(label) ? label : `Unlock: ${label}`;

    return {
        kind: 'blink',
        scope: `${config.username}:${config.id}`,

        async challenge() {
            const wallet = await blink.getDefaultWallet(config.username);

            if (!wallet) {
                // Spark wallets are BTC-only: price must become sats.
                const { amount: sats } = await blink.computeInvoiceAmount(
                    config.amount,
                    config.currency,
                    'BTC'
                );
                let invoice;
                try {
                    invoice = await lnurl.getLnurlInvoice(config.username, sats, memo);
                } catch (error) {
                    if (error.usernameNotFound) {
                        throw new Error(`Blink user "${config.username}" not found`);
                    }
                    throw error;
                }
                return {
                    paymentRequest: invoice.paymentRequest,
                    verifyUrl: invoice.verifyUrl,
                    sats,
                    expiresAt: Date.now() + lnurl.LNURL_EXPIRY_MINUTES * 60_000,
                };
            }

            const { amount, unit } = await blink.computeInvoiceAmount(
                config.amount,
                config.currency,
                wallet.currency
            );
            const invoice = await blink.createInvoice({
                walletId: wallet.id,
                walletCurrency: wallet.currency,
                amount,
                unit,
                memo,
            });
            return {
                paymentRequest: invoice.paymentRequest,
                paymentHash: invoice.paymentHash,
                sats: invoice.satoshis,
                expiresAt: invoice.expiresAt,
            };
        },

        /** Single settlement probe (pending-invoice recovery on reload). */
        async checkOnce(challenge) {
            if (challenge.verifyUrl) {
                const result = await lnurl.checkVerify(challenge.verifyUrl);
                return result.settled ? { preimage: result.preimage } : null;
            }
            const result = await blink.checkStatus(challenge.paymentRequest);
            return result.status === 'PAID' ? { preimage: result.preimage } : null;
        },

        settle(challenge, { signal } = {}) {
            const options = { expiresAt: challenge.expiresAt, signal };
            return challenge.verifyUrl
                ? lnurl.watchVerify(challenge.verifyUrl, options)
                : blink.watchPayment(challenge.paymentRequest, options);
        },
    };
}
