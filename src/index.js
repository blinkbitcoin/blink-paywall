/**
 * Blink Paywall — public API and auto-scan.
 *
 * Embed:
 *   <script defer src="https://blinkbitcoin.github.io/blink-paywall/v1/blink-paywall.js"></script>
 *   <div data-blink-paywall data-username="alice" data-amount="2100" data-id="ebook">
 *     <template><!-- locked content --></template>
 *   </div>
 *
 * Globals (IIFE bundle): BlinkPaywall.{mount, scan, actions, version}
 */

import { actions } from './actions.js';
import { createPaywall } from './paywall.js';
import { createBlinkSource } from './sources/blink.js';
import { createL402Source } from './sources/l402.js';
import { createView, VERSION } from './ui.js';

export { actions };
export const version = VERSION;

/**
 * Build an instance config from data-* attributes merged with JS overrides.
 * `el.dataset` is the parser: data-unlock-class -> unlockClass, etc.
 */
function configFrom(el, overrides = {}) {
    const d = el.dataset;
    const config = {
        username: d.username,
        l402: d.l402,
        amount: d.amount ? parseFloat(d.amount) : undefined,
        currency: d.currency || 'sats',
        id: d.id,
        title: d.title,
        description: d.description,
        remember: d.remember,
        theme: d.theme,
        redirect: d.redirect,
        webhook: d.webhook,
        unlockClass: d.unlockClass,
        ...overrides,
    };
    // Default id: unique per page so receipts do not collide across articles.
    if (!config.id) config.id = window.location.pathname;
    return config;
}

/**
 * Mount a paywall on an element (or CSS selector).
 * @returns {{el: Element, unlocked: boolean, destroy: () => void}|null}
 */
export function mount(target, overrides = {}) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) {
        console.error('Blink Paywall: element not found:', target);
        return null;
    }
    if (el.__blinkPaywall) return el.__blinkPaywall;

    const config = configFrom(el, overrides);
    let source;
    if (config.l402) {
        source = createL402Source(config);
    } else if (config.username && config.amount > 0) {
        source = createBlinkSource(config);
    } else {
        console.error(
            'Blink Paywall: needs data-username + data-amount (soft mode) or data-l402 (hard mode)',
            el
        );
        return null;
    }

    const instance = createPaywall(el, config, source, createView);
    el.__blinkPaywall = instance;
    const destroy = instance.destroy;
    instance.destroy = () => {
        delete el.__blinkPaywall;
        destroy();
    };
    return instance;
}

/** Mount every [data-blink-paywall] element. Call again after SPA navigation. */
export function scan(root = document) {
    const instances = [];
    root.querySelectorAll('[data-blink-paywall]').forEach((el) => {
        const instance = mount(el);
        if (instance) instances.push(instance);
    });
    return instances;
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => scan());
    } else {
        scan();
    }
}
