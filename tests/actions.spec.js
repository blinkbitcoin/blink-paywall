import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actions, runActions } from '../src/actions.js';

let el;

beforeEach(() => {
    el = document.createElement('div');
    el.innerHTML = '<div class="widget">card</div><template><p>secret</p></template>';
    document.body.appendChild(el);
});

afterEach(() => {
    el.remove();
    document.documentElement.className = '';
    vi.restoreAllMocks();
    delete actions.confetti;
});

const receipt = { id: 'x', paidAt: 1 };

describe('reveal', () => {
    it('replaces container content with template content', () => {
        runActions({ el, config: {}, receipt });
        expect(el.querySelector('.widget')).toBeNull();
        expect(el.querySelector('template')).toBeNull();
        expect(el.textContent).toContain('secret');
    });

    it('prefers response.html (L402 mode)', () => {
        runActions({ el, config: {}, receipt, response: { html: '<b>from server</b>' } });
        expect(el.innerHTML).toBe('<b>from server</b>');
    });

    it('does nothing without template or response html', () => {
        el.innerHTML = '<div class="widget">card</div>';
        runActions({ el, config: {}, receipt });
        expect(el.querySelector('.widget')).not.toBeNull();
    });
});

describe('unlockClass', () => {
    it('adds the class to <html> when configured', () => {
        runActions({ el, config: { unlockClass: 'premium' }, receipt });
        expect(document.documentElement.classList.contains('premium')).toBe(true);
    });

    it('skips without config', () => {
        runActions({ el, config: {}, receipt });
        expect(document.documentElement.className).toBe('');
    });
});

describe('webhook', () => {
    it('POSTs the receipt fire-and-forget', () => {
        const fetchMock = vi.fn(async () => ({}));
        vi.stubGlobal('fetch', fetchMock);
        runActions({ el, config: { webhook: 'https://hooks.example/z' }, receipt });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://hooks.example/z',
            expect.objectContaining({ method: 'POST', mode: 'no-cors' })
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(receipt);
    });
});

describe('redirect', () => {
    it('navigates to config.redirect', () => {
        const assign = vi.fn();
        vi.stubGlobal('location', { assign });
        actions.redirect({ el, config: { redirect: 'https://x/thanks' }, receipt });
        expect(assign).toHaveBeenCalledWith('https://x/thanks');
    });

    it('response.redirect wins over config', () => {
        const assign = vi.fn();
        vi.stubGlobal('location', { assign });
        actions.redirect({
            el,
            config: { redirect: 'https://x/a' },
            receipt,
            response: { redirect: 'https://x/b' },
        });
        expect(assign).toHaveBeenCalledWith('https://x/b');
    });
});

describe('registry (OCP)', () => {
    it('runs plugin actions and isolates their errors', () => {
        const spy = vi.fn();
        actions.confetti = (ctx) => {
            if (ctx.config.confetti === undefined) return;
            spy(ctx.receipt);
            throw new Error('boom');
        };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        runActions({ el, config: { confetti: '' }, receipt });
        expect(spy).toHaveBeenCalledWith(receipt);
        expect(errorSpy).toHaveBeenCalled(); // error logged, not thrown
        expect(el.textContent).toContain('secret'); // reveal still ran
    });
});
