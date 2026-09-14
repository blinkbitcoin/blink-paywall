/**
 * Blink API client — no DOM, no state.
 *
 * Everything here uses Blink's PUBLIC (unauthenticated) GraphQL operations:
 *   - accountDefaultWallet(username)              wallet lookup
 *   - realtimePrice(currency)                     fiat -> sats conversion
 *   - lnInvoiceCreateOnBehalfOfRecipient          invoice into a BTC wallet (sats)
 *   - lnUsdInvoiceCreateOnBehalfOfRecipient       invoice into a USD wallet (cents)
 *   - lnInvoicePaymentStatusByPaymentRequest      settlement poll (returns preimage when PAID)
 */

export const API_URL = 'https://api.blink.sv/graphql';

/** Invoice expiry minutes per wallet currency (USD invoices peg a fiat amount, so short). */
const EXPIRY_MINUTES = { BTC: 15, USD: 5 };
const POLL_MS = 2000;
const POLL_ERROR_MS = 5000;
const POLL_GRACE_MS = 5000;

async function gql(query, variables) {
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Blink API returned ${response.status}`);
    const data = await response.json();
    if (data.errors && data.errors.length) {
        throw new Error(data.errors[0].message || 'Blink API error');
    }
    return data.data;
}

/**
 * Look up a user's default custodial wallet.
 * @returns {Promise<{id: string, currency: 'BTC'|'USD'}|null>} null = no custodial
 *   wallet (nonexistent user, or a self-custodial Spark user — caller decides via LNURL).
 */
export async function getDefaultWallet(username) {
    try {
        const data = await gql(
            `query DefaultWallet($username: Username!) {
                accountDefaultWallet(username: $username) { id currency }
            }`,
            { username }
        );
        const wallet = data && data.accountDefaultWallet;
        return wallet && wallet.id ? { id: wallet.id, currency: wallet.currency } : null;
    } catch {
        return null;
    }
}

/**
 * Realtime price for one display currency.
 * @returns {Promise<{satPrice: number, usdCentPrice: number}>}
 *   satPrice: price of 1 sat in minor units (cents) of `currency`;
 *   usdCentPrice: price of 1 US cent in minor units of `currency`.
 */
export async function getRate(currency) {
    const data = await gql(
        `query RealtimePrice($currency: DisplayCurrency!) {
            realtimePrice(currency: $currency) {
                btcSatPrice { base offset }
                usdCentPrice { base offset }
            }
        }`,
        { currency: currency.toUpperCase() }
    );
    const price = data.realtimePrice;
    return {
        satPrice: price.btcSatPrice.base / Math.pow(10, price.btcSatPrice.offset),
        usdCentPrice: price.usdCentPrice.base / Math.pow(10, price.usdCentPrice.offset),
    };
}

/**
 * Turn a price (amount + currency, where currency is 'sats' or a display
 * currency code) into the integer amount and the unit the invoice should be
 * denominated in.
 *
 * A sats price is ALWAYS invoiced in sats, even into a USD wallet: converting
 * it to cents would round to a whole cent and then have Blink price those
 * cents back into sats at the dealer spread, so a "1000 sats" paywall quoted
 * the payer ~1007 sats. Blink credits the USD wallet with the equivalent at
 * creation, so the recipient still receives USD.
 *
 * @returns {Promise<{amount: number, unit: 'sats'|'cents'}>}
 */
export async function computeInvoiceAmount(amount, currency, walletCurrency) {
    if (walletCurrency !== 'BTC' && walletCurrency !== 'USD') {
        throw new Error(`Unsupported wallet currency: ${walletCurrency}`);
    }
    if (currency === 'sats') return { amount: Math.round(amount), unit: 'sats' };

    if (walletCurrency === 'BTC') {
        const rate = await getRate(currency);
        return { amount: Math.round((amount * 100) / rate.satPrice), unit: 'sats' };
    }
    if (currency.toUpperCase() === 'USD') {
        return { amount: Math.round(amount * 100), unit: 'cents' };
    }
    const rate = await getRate(currency);
    return { amount: Math.round((amount * 100) / rate.usdCentPrice), unit: 'cents' };
}

/**
 * The public "on behalf of recipient" mutation for each
 * (wallet currency, invoice denomination) pair. BTC wallets can only be
 * invoiced in sats; USD wallets take either.
 */
const MUTATIONS = {
    'BTC:sats': 'lnInvoiceCreateOnBehalfOfRecipient',
    'USD:cents': 'lnUsdInvoiceCreateOnBehalfOfRecipient',
    // Sat-denominated, credited to the USD wallet as its value at creation.
    'USD:sats': 'lnUsdInvoiceBtcDenominatedCreateOnBehalfOfRecipient',
};

/**
 * Create an invoice into someone else's wallet. `amount` and `unit` come from
 * computeInvoiceAmount().
 * @returns {Promise<{paymentRequest: string, paymentHash: string, satoshis: number, expiresAt: number}>}
 */
export async function createInvoice({ walletId, walletCurrency, amount, unit, memo }) {
    const name = MUTATIONS[`${walletCurrency}:${unit}`];
    if (!name) {
        throw new Error(`Cannot invoice a ${walletCurrency} wallet in ${unit}`);
    }
    const inputType = name[0].toUpperCase() + name.slice(1) + 'Input';
    const expiryMinutes = EXPIRY_MINUTES[walletCurrency];

    const data = await gql(
        `mutation CreateInvoice($input: ${inputType}!) {
            ${name}(input: $input) {
                invoice { paymentRequest paymentHash satoshis }
                errors { message }
            }
        }`,
        {
            input: {
                recipientWalletId: walletId,
                amount: String(amount),
                memo,
                expiresIn: String(expiryMinutes),
            },
        }
    );
    const payload = data[name];
    if (payload.errors && payload.errors.length) {
        throw new Error(payload.errors[0].message || 'Could not create invoice');
    }
    if (!payload.invoice || !payload.invoice.paymentRequest) {
        throw new Error('Could not create invoice');
    }
    return {
        paymentRequest: payload.invoice.paymentRequest,
        paymentHash: payload.invoice.paymentHash,
        satoshis: payload.invoice.satoshis,
        expiresAt: Date.now() + expiryMinutes * 60_000,
    };
}

/**
 * One settlement check. @returns {Promise<{status: string, preimage?: string}>}
 */
export async function checkStatus(paymentRequest) {
    const data = await gql(
        `query PaymentStatus($input: LnInvoicePaymentStatusByPaymentRequestInput!) {
            lnInvoicePaymentStatusByPaymentRequest(input: $input) {
                status
                paymentPreimage
            }
        }`,
        { input: { paymentRequest } }
    );
    const result = data.lnInvoicePaymentStatusByPaymentRequest;
    return { status: result.status, preimage: result.paymentPreimage || undefined };
}

/** Error thrown by watchers when the invoice expires unpaid. */
export class ExpiredError extends Error {
    constructor() {
        super('Invoice expired');
        this.name = 'ExpiredError';
    }
}

/**
 * Generic bounded poller: calls `check()` every `intervalMs` until it returns a
 * truthy value (resolved), `expiresAt` passes (rejects ExpiredError), or
 * `signal` aborts (rejects signal.reason). Errors inside `check` back off.
 */
export function poll(check, { expiresAt, signal, intervalMs = POLL_MS } = {}) {
    return new Promise((resolve, reject) => {
        let timer = null;
        const stop = (fn, value) => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            fn(value);
        };
        const onAbort = () => stop(reject, signal.reason || new Error('Aborted'));
        if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }
        const tick = async () => {
            if (expiresAt && Date.now() >= expiresAt + POLL_GRACE_MS) {
                return stop(reject, new ExpiredError());
            }
            let result;
            let delay = intervalMs;
            try {
                result = await check();
            } catch (error) {
                if (error && error.terminal) return stop(reject, error);
                delay = POLL_ERROR_MS;
            }
            if (signal && signal.aborted) return;
            if (result) return stop(resolve, result);
            timer = setTimeout(tick, delay);
        };
        tick();
    });
}

/**
 * Wait until an invoice is PAID. Resolves {preimage} (may be undefined if the
 * API withholds it). Rejects ExpiredError / abort reason.
 */
export function watchPayment(paymentRequest, { expiresAt, signal, intervalMs } = {}) {
    return poll(
        async () => {
            const { status, preimage } = await checkStatus(paymentRequest);
            if (status === 'PAID') return { preimage };
            if (status === 'EXPIRED') {
                const error = new ExpiredError();
                error.terminal = true;
                throw error;
            }
            return null;
        },
        { expiresAt, signal, intervalMs }
    );
}
