import { afterEach, describe, expect, it, vi } from 'vitest';
import { actions, mount, scan, version } from '../src/index.js';

afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
});

function makeEl(attributes) {
    const el = document.createElement('div');
    for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
    el.innerHTML = '<template><p>x</p></template>';
    document.body.appendChild(el);
    return el;
}

describe('mount', () => {
    it('mounts soft mode from data attributes', async () => {
        const el = makeEl({
            'data-username': 'alice',
            'data-amount': '2100',
            'data-id': 'ebook',
        });
        const instance = mount(el);
        expect(instance).not.toBeNull();
        await vi.waitFor(() => expect(el.dataset.state).toBe('locked'));
        instance.destroy();
    });

    it('mounts hard mode with only data-l402', () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true }))
        ); // not awaited here
        const el = makeEl({ 'data-l402': 'https://s.example/api/x' });
        const instance = mount(el);
        expect(instance).not.toBeNull();
        instance.destroy();
    });

    it('rejects a config with neither mode', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const el = makeEl({ 'data-amount': '10' });
        expect(mount(el)).toBeNull();
    });

    it('accepts a selector and is idempotent', async () => {
        const el = makeEl({
            id: 'pw',
            'data-username': 'alice',
            'data-amount': '1',
        });
        const first = mount('#pw');
        expect(mount(el)).toBe(first);
        first.destroy();
    });

    it('camel-cases multi-word data attributes and defaults id to the path', () => {
        const el = makeEl({
            'data-username': 'alice',
            'data-amount': '1',
            'data-unlock-class': 'premium',
        });
        const instance = mount(el, { onUnlock: () => {} });
        expect(instance).not.toBeNull();
        instance.destroy();
    });
});

describe('scan', () => {
    it('mounts every [data-blink-paywall]', () => {
        makeEl({ 'data-blink-paywall': '', 'data-username': 'a', 'data-amount': '1' });
        makeEl({ 'data-blink-paywall': '', 'data-username': 'b', 'data-amount': '2' });
        makeEl({ 'data-username': 'c', 'data-amount': '3' }); // no marker attribute
        const instances = scan();
        expect(instances).toHaveLength(2);
        instances.forEach((instance) => instance.destroy());
    });
});

describe('public API', () => {
    it('exposes actions registry and version', () => {
        expect(typeof actions.reveal).toBe('function');
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    });
});
