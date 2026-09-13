/**
 * Unlock actions — what happens when the paywall is paid.
 *
 * Every registered action is invoked on unlock with a context:
 *   { el, config, receipt, response }
 *     el        the paywall container element
 *     config    the instance config (dataset-derived: webhook, unlockClass, redirect, ...)
 *     receipt   { username?, id, title?, amount?, currency?, sats?, paymentHash?,
 *                 paymentRequest?, preimage?, paidAt }
 *     response  L402 mode only: parsed JSON body ({ html?, redirect?, ... }) of the
 *               authorized fetch, else undefined
 *
 * Each action guards on its own config key, so "configured = runs".
 * Open for extension (OCP): `BlinkPaywall.actions.confetti = (ctx) => {...}`
 * gives site owners a `data-confetti` trigger without touching this file.
 * `redirect` always runs last — it navigates away.
 */

export const actions = {
    /**
     * POST the receipt to a URL (Zapier/Make/n8n/...). Fire-and-forget,
     * no-cors so any endpoint works without CORS setup. NOTE: comes from the
     * visitor's browser, so it is spoofable — treat as a notification, not
     * as proof of payment (that is what L402 mode is for).
     */
    webhook(ctx) {
        if (!ctx.config.webhook) return;
        try {
            fetch(ctx.config.webhook, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ctx.receipt),
            }).catch(() => {});
        } catch {}
    },

    /** Add a class to <html> so the owner can unlock anything with CSS alone. */
    unlockClass(ctx) {
        if (!ctx.config.unlockClass) return;
        document.documentElement.classList.add(ctx.config.unlockClass);
    },

    /**
     * Reveal the locked content: the L402 response's `html` if present,
     * otherwise the container's inert <template> child. <template> content
     * never renders or loads (iframes included) until cloned here.
     */
    reveal(ctx) {
        if (ctx.response && typeof ctx.response.html === 'string') {
            ctx.el.innerHTML = ctx.response.html;
            return;
        }
        const template = ctx.el.querySelector('template');
        if (!template) return;
        ctx.el.replaceChildren(template.content.cloneNode(true));
    },

    /** Navigate to a thank-you / download / booking page. Runs last. */
    redirect(ctx) {
        const url = (ctx.response && ctx.response.redirect) || ctx.config.redirect;
        if (!url) return;
        window.location.assign(url);
    },
};

/** Run all registered actions, redirect last. Action errors never block others. */
export function runActions(ctx) {
    const names = Object.keys(actions).filter((name) => name !== 'redirect');
    if (actions.redirect) names.push('redirect');
    for (const name of names) {
        try {
            actions[name](ctx);
        } catch (error) {
            console.error(`Blink Paywall: action "${name}" failed`, error);
        }
    }
}
