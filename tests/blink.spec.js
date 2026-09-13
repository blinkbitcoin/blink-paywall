import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ExpiredError,
    checkStatus,
    computeInvoiceAmount,
    createInvoice,
    getDefaultWallet,
    getRate,
    poll,
    watchPayment,
} from '../src/blink.js';

function gqlResponse(data, errors) {
    return {
        ok: true,
        json: async () => (errors ? { errors } : { data }),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('getDefaultWallet', () => {
    it('returns id and currency for a custodial user', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => gqlResponse({ accountDefaultWallet: { id: 'w1', currency: 'BTC' } }))
        );
        expect(await getDefaultWallet('alice')).toEqual({ id: 'w1', currency: 'BTC' });
        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body.variables).toEqual({ username: 'alice' });
    });

    it('returns null on API error (self-custodial / unknown user)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => gqlResponse(null, [{ message: 'Account does not exist' }]))
        );
        expect(await getDefaultWallet('ghost')).toBeNull();
    });

    it('returns null on network failure', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Promise.reject(new Error('offline')))
        );
        expect(await getDefaultWallet('alice')).toBeNull();
    });
});

describe('getRate', () => {
    it('applies base/offset', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                gqlResponse({
                    realtimePrice: {
                        btcSatPrice: { base: 512, offset: 4 },
                        usdCentPrice: { base: 100, offset: 2 },
                    },
                })
            )
        );
        const rate = await getRate('usd');
        expect(rate.satPrice).toBeCloseTo(0.0512);
        expect(rate.usdCentPrice).toBeCloseTo(1);
        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body.variables.currency).toBe('USD');
    });
});

describe('computeInvoiceAmount', () => {
    function stubRate(satPrice, usdCentPrice) {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                gqlResponse({
                    realtimePrice: {
                        btcSatPrice: { base: satPrice, offset: 0 },
                        usdCentPrice: { base: usdCentPrice, offset: 0 },
                    },
                })
            )
        );
    }

    it('sats -> BTC wallet: passthrough, no fetch', async () => {
        vi.stubGlobal('fetch', vi.fn());
        expect(await computeInvoiceAmount(2100, 'sats', 'BTC')).toBe(2100);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('USD -> USD wallet: cents, no fetch', async () => {
        vi.stubGlobal('fetch', vi.fn());
        expect(await computeInvoiceAmount(2.5, 'USD', 'USD')).toBe(250);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('fiat -> BTC wallet: converts via satPrice', async () => {
        stubRate(0.05, 1); // 1 sat = 0.05 cents
        expect(await computeInvoiceAmount(2.5, 'USD', 'BTC')).toBe(5000);
    });

    it('sats -> USD wallet: converts via USD satPrice', async () => {
        stubRate(0.05, 1);
        expect(await computeInvoiceAmount(5000, 'sats', 'USD')).toBe(250);
    });

    it('other fiat -> USD wallet: converts via usdCentPrice', async () => {
        stubRate(0.05, 2); // 1 US cent = 2 EUR minor units
        expect(await computeInvoiceAmount(5, 'EUR', 'USD')).toBe(250);
    });

    it('rejects unknown wallet currency', async () => {
        await expect(computeInvoiceAmount(1, 'sats', 'DOGE')).rejects.toThrow(
            'Unsupported wallet currency'
        );
    });
});

describe('createInvoice', () => {
    it('BTC wallet: sats amount, 15 min expiry', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                gqlResponse({
                    lnInvoiceCreateOnBehalfOfRecipient: {
                        invoice: {
                            paymentRequest: 'lnbc1...',
                            paymentHash: 'ha5h',
                            satoshis: 1000,
                        },
                        errors: [],
                    },
                })
            )
        );
        const before = Date.now();
        const invoice = await createInvoice({
            walletId: 'w1',
            walletCurrency: 'BTC',
            amount: 1000,
            memo: 'Unlock: X',
        });
        expect(invoice.paymentRequest).toBe('lnbc1...');
        expect(invoice.paymentHash).toBe('ha5h');
        expect(invoice.expiresAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body.variables.input).toEqual({
            recipientWalletId: 'w1',
            amount: '1000',
            memo: 'Unlock: X',
            expiresIn: '15',
        });
    });

    it('USD wallet: uses the USD mutation, 5 min expiry', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                gqlResponse({
                    lnUsdInvoiceCreateOnBehalfOfRecipient: {
                        invoice: { paymentRequest: 'lnbc2...', paymentHash: 'h2', satoshis: 4000 },
                        errors: [],
                    },
                })
            )
        );
        const invoice = await createInvoice({
            walletId: 'w2',
            walletCurrency: 'USD',
            amount: 250,
            memo: 'm',
        });
        expect(invoice.paymentRequest).toBe('lnbc2...');
        const body = JSON.parse(fetch.mock.calls[0][1].body);
        expect(body.query).toContain('lnUsdInvoiceCreateOnBehalfOfRecipient');
        expect(body.variables.input.expiresIn).toBe('5');
    });

    it('surfaces payload errors', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                gqlResponse({
                    lnInvoiceCreateOnBehalfOfRecipient: {
                        invoice: null,
                        errors: [{ message: 'amount too small' }],
                    },
                })
            )
        );
        await expect(
            createInvoice({ walletId: 'w1', walletCurrency: 'BTC', amount: 0, memo: '' })
        ).rejects.toThrow('amount too small');
    });
});

describe('checkStatus', () => {
    it('returns status and preimage', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                gqlResponse({
                    lnInvoicePaymentStatusByPaymentRequest: {
                        status: 'PAID',
                        paymentPreimage: 'pre1mage',
                    },
                })
            )
        );
        expect(await checkStatus('lnbc1...')).toEqual({ status: 'PAID', preimage: 'pre1mage' });
    });
});

describe('poll / watchPayment', () => {
    it('resolves when check returns truthy', async () => {
        vi.useFakeTimers();
        let calls = 0;
        const promise = poll(async () => (++calls >= 3 ? { done: true } : null), {
            intervalMs: 2000,
        });
        await vi.advanceTimersByTimeAsync(6000);
        await expect(promise).resolves.toEqual({ done: true });
        expect(calls).toBe(3);
    });

    it('rejects ExpiredError past expiresAt + grace', async () => {
        vi.useFakeTimers();
        const promise = poll(async () => null, {
            expiresAt: Date.now() + 1000,
            intervalMs: 2000,
        });
        promise.catch(() => {}); // avoid unhandled rejection between timer steps
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(promise).rejects.toBeInstanceOf(ExpiredError);
    });

    it('backs off on check errors instead of failing', async () => {
        vi.useFakeTimers();
        let calls = 0;
        const promise = poll(
            async () => {
                calls += 1;
                if (calls === 1) throw new Error('network');
                return { ok: true };
            },
            { intervalMs: 2000 }
        );
        await vi.advanceTimersByTimeAsync(5000); // error backoff is 5s
        await expect(promise).resolves.toEqual({ ok: true });
    });

    it('aborts via AbortSignal', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const promise = poll(async () => null, { signal: controller.signal, intervalMs: 2000 });
        promise.catch(() => {});
        controller.abort();
        await expect(promise).rejects.toBeTruthy();
    });

    it('watchPayment resolves preimage on PAID', async () => {
        const responses = [{ status: 'PENDING' }, { status: 'PAID', paymentPreimage: 'abc' }];
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                gqlResponse({ lnInvoicePaymentStatusByPaymentRequest: responses.shift() })
            )
        );
        const promise = watchPayment('lnbc1...', { intervalMs: 2000 });
        await vi.advanceTimersByTimeAsync(4000);
        await expect(promise).resolves.toEqual({ preimage: 'abc' });
    });

    it('watchPayment rejects terminally on EXPIRED status', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                gqlResponse({ lnInvoicePaymentStatusByPaymentRequest: { status: 'EXPIRED' } })
            )
        );
        const promise = watchPayment('lnbc1...', { intervalMs: 2000 });
        promise.catch(() => {});
        await vi.advanceTimersByTimeAsync(100);
        await expect(promise).rejects.toBeInstanceOf(ExpiredError);
    });
});
