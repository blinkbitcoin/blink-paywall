import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlinkSource } from '../src/sources/blink.js';
import { createL402Source } from '../src/sources/l402.js';

function gqlResponse(data) {
    return { ok: true, json: async () => ({ data }) };
}

function fakeResponse({ status = 200, headers = {}, body = '', json = null }) {
    const lower = {};
    for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => lower[name.toLowerCase()] ?? null },
        json: async () => json,
        text: async () => body,
    };
}

afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
});

describe('createBlinkSource', () => {
    const config = { username: 'alice', amount: 2100, currency: 'sats', id: 'ebook', title: 'T' };

    it('custodial: wallet lookup then on-behalf invoice with memo', async () => {
        const fetchMock = vi.fn(async (url, options) => {
            const body = JSON.parse(options.body);
            if (body.query.includes('accountDefaultWallet')) {
                return gqlResponse({ accountDefaultWallet: { id: 'w1', currency: 'BTC' } });
            }
            expect(body.variables.input.memo).toBe('Unlock: T');
            expect(body.variables.input.amount).toBe('2100');
            return gqlResponse({
                lnInvoiceCreateOnBehalfOfRecipient: {
                    invoice: { paymentRequest: 'lnbc21u1x', paymentHash: 'h', satoshis: 2100 },
                    errors: [],
                },
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        const challenge = await createBlinkSource(config).challenge();
        expect(challenge).toMatchObject({
            paymentRequest: 'lnbc21u1x',
            paymentHash: 'h',
            sats: 2100,
        });
        expect(challenge.verifyUrl).toBeUndefined();
    });

    it('self-custodial fallback: LNURL invoice with verify URL', async () => {
        const fetchMock = vi.fn(async (url) => {
            const urlString = String(url);
            if (urlString.includes('graphql')) {
                return gqlResponse(null); // no custodial wallet
            }
            if (urlString.includes('.well-known')) {
                return fakeResponse({
                    json: {
                        tag: 'payRequest',
                        callback: 'https://blink.sv/lnurlp/alice/callback',
                        minSendable: 1000,
                        maxSendable: 1e11,
                        commentAllowed: 64,
                    },
                });
            }
            return fakeResponse({ json: { pr: 'lnbc21u1spark', verify: 'https://blink.sv/v/1' } });
        });
        vi.stubGlobal('fetch', fetchMock);

        const challenge = await createBlinkSource(config).challenge();
        expect(challenge).toMatchObject({
            paymentRequest: 'lnbc21u1spark',
            verifyUrl: 'https://blink.sv/v/1',
            sats: 2100,
        });
    });

    it('friendly error for unknown usernames', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) =>
                String(url).includes('graphql')
                    ? gqlResponse(null)
                    : fakeResponse({ status: 404, json: {} })
            )
        );
        await expect(createBlinkSource(config).challenge()).rejects.toThrow(
            'Blink user "alice" not found'
        );
    });

    it('checkOnce prefers the verify URL when present', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => fakeResponse({ json: { settled: true, preimage: 'p' } }))
        );
        const settled = await createBlinkSource(config).checkOnce({
            paymentRequest: 'x',
            verifyUrl: 'https://blink.sv/v/1',
        });
        expect(settled).toEqual({ preimage: 'p' });
    });
});

describe('createL402Source', () => {
    const config = { l402: 'https://site.example/api/content/ebook' };

    it('challenge parses the 402 WWW-Authenticate header', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                fakeResponse({
                    status: 402,
                    headers: {
                        'WWW-Authenticate': 'L402 macaroon="mac1", invoice="lnbc10u1rest"',
                    },
                })
            )
        );
        const challenge = await createL402Source(config).challenge();
        expect(challenge).toMatchObject({
            paymentRequest: 'lnbc10u1rest',
            macaroon: 'mac1',
            sats: 1000,
        });
    });

    it('challenge marks a 200 as free', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                fakeResponse({
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                    json: { html: '<p>hi</p>' },
                })
            )
        );
        const challenge = await createL402Source(config).challenge();
        expect(challenge.free).toBe(true);
        expect(challenge.response).toEqual({ html: '<p>hi</p>' });
    });

    it('challenge rejects a 402 without a parsable header', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => fakeResponse({ status: 402 }))
        );
        await expect(createL402Source(config).challenge()).rejects.toThrow(
            'without a valid L402 challenge'
        );
    });

    it('finalize sends Authorization, stores the token, returns the body', async () => {
        const fetchMock = vi.fn(async () =>
            fakeResponse({
                status: 200,
                headers: { 'content-type': 'text/html' },
                body: '<b>paid content</b>',
            })
        );
        vi.stubGlobal('fetch', fetchMock);

        const source = createL402Source(config);
        const { response } = await source.finalize(
            { macaroon: 'mac1', paymentRequest: 'lnbc10u1rest' },
            'preimg'
        );
        expect(response).toEqual({ html: '<b>paid content</b>' });
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('L402 mac1:preimg');

        // Token persisted -> restore() replays it.
        const restored = await source.restore();
        expect(restored.response).toEqual({ html: '<b>paid content</b>' });
    });

    it('finalize throws when the server rejects the token', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => fakeResponse({ status: 402 }))
        );
        await expect(createL402Source(config).finalize({ macaroon: 'm' }, 'p')).rejects.toThrow(
            'rejected the payment token'
        );
    });

    it('restore clears a rejected token and reports null', async () => {
        localStorage.setItem(
            'blink-paywall:token:' + config.l402,
            JSON.stringify({ macaroon: 'm', preimage: 'p' })
        );
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => fakeResponse({ status: 401 }))
        );
        const source = createL402Source(config);
        expect(await source.restore()).toBeNull();
        expect(localStorage.getItem('blink-paywall:token:' + config.l402)).toBeNull();
    });

    it('restore resolves null with no stored token (no fetch)', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        expect(await createL402Source(config).restore()).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
