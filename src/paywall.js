/**
 * Paywall instance — the orchestrator. Owns the state machine
 *
 *   locked -> pending(invoice) -> paid -> unlocked
 *                    |-> expired -> (retry) -> pending
 *                    '-> error   -> (retry) -> pending
 *
 * and wires source (payments) -> storage (memory) -> view (card) ->
 * actions (what unlocking does). The source and view are injected, so the
 * whole flow is testable with fakes and new payment sources need no changes
 * here (DIP/OCP).
 */

import { runActions } from './actions.js';
import { ExpiredError } from './blink.js';
import { clearPending, loadPending, loadReceipt, savePending, saveReceipt } from './storage.js';
import { formatPrice } from './ui.js';

const PAID_FLASH_MS = 1200;

export function createPaywall(el, config, source, createViewFn) {
    let destroyed = false;
    let unlocked = false;
    let controller = null;
    let onPreimage = () => {};

    const view = createViewFn(el, config, {
        onUnlock: start,
        onRetry: start,
        onPreimage: (preimage) => onPreimage(preimage),
    });

    const priceLabel = config.amount ? formatPrice(config.amount, config.currency) : null;

    function labelFor(challenge) {
        return (
            priceLabel ||
            (challenge && challenge.sats ? formatPrice(challenge.sats, 'sats') : 'with Lightning')
        );
    }

    function buildReceipt(challenge, preimage) {
        const receipt = {
            id: config.id,
            paidAt: Date.now(),
        };
        if (config.username) receipt.username = config.username;
        if (config.l402) receipt.url = config.l402;
        if (config.title) receipt.title = config.title;
        if (config.amount) {
            receipt.amount = config.amount;
            receipt.currency = config.currency;
        }
        if (challenge) {
            if (challenge.sats) receipt.sats = challenge.sats;
            if (challenge.paymentHash) receipt.paymentHash = challenge.paymentHash;
            if (challenge.paymentRequest) receipt.paymentRequest = challenge.paymentRequest;
        }
        if (preimage) receipt.preimage = preimage;
        return receipt;
    }

    function unlock(receipt, response) {
        if (destroyed || unlocked) return;
        unlocked = true;
        el.dataset.state = 'unlocked';
        el.dispatchEvent(
            new CustomEvent('blink:unlocked', {
                bubbles: true,
                composed: true,
                detail: { receipt, response, element: el },
            })
        );
        if (typeof config.onUnlock === 'function') {
            try {
                config.onUnlock(receipt, response);
            } catch (error) {
                console.error('Blink Paywall: onUnlock callback failed', error);
            }
        }
        runActions({ el, config, receipt, response });
    }

    async function settleAndUnlock(challenge) {
        controller = new AbortController();
        const { signal } = controller;

        // Race the network watcher against a WebLN preimage from the view —
        // WebLN is the only settlement signal for non-Blink L402 invoices.
        const webln = new Promise((resolve) => {
            onPreimage = (preimage) => resolve({ preimage });
        });
        const watcher = source.settle(challenge, { signal });
        watcher.catch(() => {}); // loser of the race rejects on abort
        const settled = await Promise.race([watcher, webln]);
        controller.abort();
        if (destroyed) return;

        let response;
        if (source.finalize) {
            view.showWorking('Unlocking\u2026');
            ({ response } = await source.finalize(challenge, settled.preimage));
        }

        const receipt = buildReceipt(challenge, settled.preimage);
        saveReceipt(source.scope, receipt);
        clearPending(source.scope);

        view.showPaid();
        setTimeout(() => unlock(receipt, response), PAID_FLASH_MS);
    }

    async function start() {
        if (destroyed || unlocked) return;
        view.showWorking();
        try {
            const challenge = await source.challenge();
            if (destroyed) return;

            if (challenge.free) {
                // L402 resource answered 200 without payment.
                unlock(buildReceipt(null, null), challenge.response);
                return;
            }

            savePending(source.scope, challenge);
            view.showInvoice(challenge, labelFor(challenge));
            await settleAndUnlock(challenge);
        } catch (error) {
            if (destroyed) return;
            if (error instanceof ExpiredError) {
                clearPending(source.scope);
                view.showExpired();
                return;
            }
            console.error('Blink Paywall:', error);
            view.showError(error && error.message);
        }
    }

    async function mount() {
        // 1. A remembered receipt (and, for L402, a still-accepted token).
        const receipt = loadReceipt(source.scope, config.remember);
        if (receipt) {
            if (source.restore) {
                try {
                    const restored = await source.restore();
                    if (restored) {
                        view.showPaid();
                        unlock(receipt, restored.response);
                        return;
                    }
                } catch {}
                // token rejected or server unreachable -> fall through to locked
            } else {
                view.showPaid();
                unlock(receipt);
                return;
            }
        }

        // 2. An outstanding invoice from before a reload — paid while we were away?
        const pending = loadPending(source.scope);
        if (pending && source.checkOnce) {
            try {
                const settled = await source.checkOnce(pending);
                if (settled) {
                    let response;
                    if (source.finalize) {
                        ({ response } = await source.finalize(pending, settled.preimage));
                    }
                    const restoredReceipt = buildReceipt(pending, settled.preimage);
                    saveReceipt(source.scope, restoredReceipt);
                    clearPending(source.scope);
                    view.showPaid();
                    unlock(restoredReceipt, response);
                    return;
                }
            } catch {}
        }

        // 3. Locked.
        el.dataset.state = 'locked';
        view.showLocked(priceLabel);
    }

    mount();

    return {
        el,
        get unlocked() {
            return unlocked;
        },
        destroy() {
            destroyed = true;
            if (controller) controller.abort();
            view.destroy();
            delete el.dataset.state;
        },
    };
}
