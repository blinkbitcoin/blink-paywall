import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpiredError } from '../src/blink.js';
import { createPaywall } from '../src/paywall.js';
import { createView, formatPrice } from '../src/ui.js';
import { loadReceipt, savePending, saveReceipt } from '../src/storage.js';

const CONFIG = {
    username: 'alice',
    amount: 2100,
    currency: 'sats',
    id: 'ebook',
    title: 'Full article',
    remember: 'forever',
};

const CHALLENGE = {
    paymentRequest: 'lnbc21u1fake',
    paymentHash: 'hash1',
    sats: 2100,
    expiresAt: Date.now() + 15 * 60_000,
};

function fakeSource(overrides = {}) {
    return {
        kind: 'blink',
        scope: 'alice:ebook',
        challenge: vi.fn(async () => ({ ...CHALLENGE })),
        checkOnce: vi.fn(async () => null),
        settle: vi.fn(() => new Promise(() => {})), // never settles unless overridden
        ...overrides,
    };
}

let el;
let instance;

function shadow() {
    return el.firstElementChild.shadowRoot;
}

async function flush(ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement('div');
    el.innerHTML = '<template><p class="premium">secret content</p></template>';
    document.body.appendChild(el);
});

afterEach(() => {
    if (instance) instance.destroy();
    instance = null;
    el.remove();
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('price formatting', () => {
    it('sats verbatim, fiat with the currency decimals', () => {
        expect(formatPrice(2100, 'sats')).toBe('2100 sats');
        expect(formatPrice(0.5, 'USD')).toBe('$0.50');
        expect(formatPrice(2.5, 'EUR')).toMatch(/2[.,]50/);
        expect(formatPrice(300, 'JPY')).toMatch(/300/); // 0-decimal currency
        expect(formatPrice(5, 'NOTACURRENCY')).toBe('5 NOTACURRENCY');
    });
});

describe('locked state', () => {
    it('renders the locked card with price', async () => {
        instance = createPaywall(el, CONFIG, fakeSource(), createView);
        await flush();
        expect(el.dataset.state).toBe('locked');
        const button = shadow().querySelector('.btn.primary');
        expect(button.textContent).toBe('Unlock for 2100 sats');
        expect(el.querySelector('template')).not.toBeNull(); // content still inert
    });
});

describe('pay flow', () => {
    it('unlock click -> invoice -> settle -> reveal + event + receipt', async () => {
        const source = fakeSource({
            settle: vi.fn(async () => ({ preimage: 'pre1' })),
        });
        const onUnlock = vi.fn();
        const eventSpy = vi.fn();
        el.addEventListener('blink:unlocked', eventSpy);

        instance = createPaywall(el, { ...CONFIG, onUnlock }, source, createView);
        await flush();
        shadow().querySelector('.btn.primary').click();
        await flush(); // challenge + settle resolve

        expect(source.challenge).toHaveBeenCalled();
        await flush(1200); // paid flash

        expect(el.dataset.state).toBe('unlocked');
        expect(el.textContent).toContain('secret content');
        expect(el.querySelector('template')).toBeNull();

        const receipt = loadReceipt('alice:ebook', 'forever');
        expect(receipt).toMatchObject({
            username: 'alice',
            id: 'ebook',
            amount: 2100,
            currency: 'sats',
            paymentHash: 'hash1',
            paymentRequest: 'lnbc21u1fake',
            preimage: 'pre1',
        });
        expect(onUnlock).toHaveBeenCalledWith(expect.objectContaining({ id: 'ebook' }), undefined);
        expect(eventSpy).toHaveBeenCalled();
        expect(eventSpy.mock.calls[0][0].detail.receipt.preimage).toBe('pre1');
    });

    it('shows the invoice QR and countdown while pending', async () => {
        instance = createPaywall(el, CONFIG, fakeSource(), createView);
        await flush();
        shadow().querySelector('.btn.primary').click();
        await flush();

        expect(shadow().querySelector('.qr img')).not.toBeNull();
        expect(shadow().querySelector('.countdown').textContent).toMatch(/Expires in \d+:\d{2}/);
        expect(shadow().querySelector('.qr').href).toContain('lightning:lnbc21u1fake');
    });

    it('WebLN preimage wins the race', async () => {
        const source = fakeSource(); // network watcher never resolves
        instance = createPaywall(el, CONFIG, source, createView);
        await flush();
        shadow().querySelector('.btn.primary').click();
        await flush();

        vi.stubGlobal('webln', {
            enable: vi.fn(async () => {}),
            sendPayment: vi.fn(async () => ({ preimage: 'webln-pre' })),
        });
        shadow().querySelector('.btn.primary').click(); // "Pay in wallet"
        await flush(1200);

        expect(el.dataset.state).toBe('unlocked');
        expect(loadReceipt('alice:ebook', 'forever').preimage).toBe('webln-pre');
    });

    it('expired invoice shows retry, retry re-challenges', async () => {
        let settleCalls = 0;
        const source = fakeSource({
            settle: vi.fn(async () => {
                settleCalls += 1;
                if (settleCalls === 1) throw new ExpiredError();
                return { preimage: 'p2' };
            }),
        });
        instance = createPaywall(el, CONFIG, source, createView);
        await flush();
        shadow().querySelector('.btn.primary').click();
        await flush();

        expect(shadow().textContent).toContain('The invoice expired.');
        shadow().querySelector('.btn.primary').click(); // Try again
        await flush(1200);
        expect(el.dataset.state).toBe('unlocked');
    });

    it('challenge failure shows the error message', async () => {
        const source = fakeSource({
            challenge: vi.fn(async () => {
                throw new Error('Blink user "ghost" not found');
            }),
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        instance = createPaywall(el, CONFIG, source, createView);
        await flush();
        shadow().querySelector('.btn.primary').click();
        await flush();
        expect(shadow().textContent).toContain('Blink user "ghost" not found');
    });
});

describe('persistence', () => {
    it('a remembered receipt unlocks without payment', async () => {
        saveReceipt('alice:ebook', { id: 'ebook', paidAt: Date.now(), preimage: 'old' });
        const source = fakeSource();
        instance = createPaywall(el, CONFIG, source, createView);
        await flush();
        expect(el.dataset.state).toBe('unlocked');
        expect(el.textContent).toContain('secret content');
        expect(source.challenge).not.toHaveBeenCalled();
    });

    it('an expired receipt stays locked', async () => {
        saveReceipt('alice:ebook', { id: 'ebook', paidAt: Date.now() - 10 * 86_400_000 });
        instance = createPaywall(el, { ...CONFIG, remember: '7d' }, fakeSource(), createView);
        await flush();
        expect(el.dataset.state).toBe('locked');
    });

    it('recovers a pending invoice paid before a reload', async () => {
        savePending('alice:ebook', { ...CHALLENGE });
        const source = fakeSource({
            checkOnce: vi.fn(async () => ({ preimage: 'recovered' })),
        });
        instance = createPaywall(el, CONFIG, source, createView);
        await flush();
        expect(el.dataset.state).toBe('unlocked');
        expect(loadReceipt('alice:ebook', 'forever').preimage).toBe('recovered');
        expect(source.challenge).not.toHaveBeenCalled();
    });
});

describe('L402-style source (finalize/restore)', () => {
    it('finalize response html is revealed instead of the template', async () => {
        const source = fakeSource({
            kind: 'l402',
            settle: vi.fn(async () => ({ preimage: 'p' })),
            finalize: vi.fn(async () => ({ response: { html: '<b>server content</b>' } })),
        });
        instance = createPaywall(el, CONFIG, source, createView);
        await flush();
        shadow().querySelector('.btn.primary').click();
        await flush(1200);

        expect(source.finalize).toHaveBeenCalledWith(
            expect.objectContaining({ paymentRequest: CHALLENGE.paymentRequest }),
            'p'
        );
        expect(el.innerHTML).toBe('<b>server content</b>');
    });

    it('restore() short-circuits payment when the token is still accepted', async () => {
        saveReceipt('alice:ebook', { id: 'ebook', paidAt: Date.now() });
        const source = fakeSource({
            restore: vi.fn(async () => ({ response: { html: '<i>restored</i>' } })),
        });
        instance = createPaywall(el, CONFIG, source, createView);
        await flush();
        expect(el.innerHTML).toBe('<i>restored</i>');
    });

    it('a free (200) challenge unlocks without invoice', async () => {
        const source = fakeSource({
            challenge: vi.fn(async () => ({ free: true, response: { html: '<u>free</u>' } })),
        });
        instance = createPaywall(el, CONFIG, source, createView);
        await flush();
        shadow().querySelector('.btn.primary').click();
        await flush();
        expect(el.innerHTML).toBe('<u>free</u>');
    });
});

describe('destroy', () => {
    it('removes the card and stops reacting', async () => {
        instance = createPaywall(el, CONFIG, fakeSource(), createView);
        await flush();
        instance.destroy();
        expect(el.firstElementChild.tagName).toBe('TEMPLATE'); // card host removed
        expect(el.dataset.state).toBeUndefined();
        instance = null;
    });
});
