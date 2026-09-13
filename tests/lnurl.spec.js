import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkVerify, getLnurlInvoice, watchVerify } from '../src/lnurl.js';

const META = {
    tag: 'payRequest',
    callback: 'https://blink.sv/lnurlp/alice/callback',
    minSendable: 1000,
    maxSendable: 100_000_000_000,
    commentAllowed: 32,
};

function jsonResponse(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('getLnurlInvoice', () => {
    it('fetches metadata then callback with msats + comment', async () => {
        const fetchMock = vi.fn(async (url) => {
            if (String(url).includes('.well-known')) return jsonResponse(META);
            return jsonResponse({ pr: 'lnbc123', verify: 'https://blink.sv/verify/h' });
        });
        vi.stubGlobal('fetch', fetchMock);

        const invoice = await getLnurlInvoice('Alice', 1000, 'Unlock: X');
        expect(invoice).toEqual({
            paymentRequest: 'lnbc123',
            verifyUrl: 'https://blink.sv/verify/h',
        });

        expect(String(fetchMock.mock.calls[0][0])).toBe(
            'https://blink.sv/.well-known/lnurlp/alice'
        );
        const callbackUrl = new URL(fetchMock.mock.calls[1][0]);
        expect(callbackUrl.searchParams.get('amount')).toBe('1000000');
        expect(callbackUrl.searchParams.get('comment')).toBe('Unlock: X');
    });

    it('drops the comment when commentAllowed is 0', async () => {
        const fetchMock = vi.fn(async (url) => {
            if (String(url).includes('.well-known')) {
                return jsonResponse({ ...META, commentAllowed: 0 });
            }
            return jsonResponse({ pr: 'lnbc123' });
        });
        vi.stubGlobal('fetch', fetchMock);
        await getLnurlInvoice('alice', 1000, 'memo');
        const callbackUrl = new URL(fetchMock.mock.calls[1][0]);
        expect(callbackUrl.searchParams.get('comment')).toBeNull();
    });

    it('flags 404 as usernameNotFound', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse({}, false, 404))
        );
        await expect(getLnurlInvoice('ghost', 1000)).rejects.toMatchObject({
            usernameNotFound: true,
        });
    });

    it('enforces minSendable', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse({ ...META, minSendable: 10_000 }))
        );
        await expect(getLnurlInvoice('alice', 1)).rejects.toThrow('below minimum');
    });

    it('surfaces LNURL callback errors', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) =>
                String(url).includes('.well-known')
                    ? jsonResponse(META)
                    : jsonResponse({ status: 'ERROR', reason: 'nope' })
            )
        );
        await expect(getLnurlInvoice('alice', 1000)).rejects.toThrow('LNURL error: nope');
    });
});

describe('checkVerify / watchVerify', () => {
    it('reports settled with preimage', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse({ settled: true, preimage: 'p1' }))
        );
        expect(await checkVerify('https://v')).toEqual({ settled: true, preimage: 'p1' });
    });

    it('marks "not found" verify errors terminal', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse({ status: 'ERROR', reason: 'Not found' }))
        );
        await expect(checkVerify('https://v')).rejects.toMatchObject({ terminal: true });
    });

    it('watchVerify polls until settled', async () => {
        vi.useFakeTimers();
        const bodies = [{ settled: false }, { settled: true, preimage: 'p2' }];
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse(bodies.shift()))
        );
        const promise = watchVerify('https://v', { intervalMs: 2000 });
        await vi.advanceTimersByTimeAsync(4000);
        await expect(promise).resolves.toEqual({ preimage: 'p2' });
    });
});
