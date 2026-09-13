/**
 * Persistence — receipts, pending invoices and L402 tokens in localStorage.
 * All reads/writes are guarded: storage may be unavailable (private mode,
 * sandboxed iframes) and the paywall must still work, just without memory.
 */

const PREFIX = 'blink-paywall:';

function read(key) {
    try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function write(key, value) {
    try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {}
}

function erase(key) {
    try {
        localStorage.removeItem(PREFIX + key);
    } catch {}
}

const DURATION_UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse a remember duration: 'forever' (or empty) -> null, '30m'/'24h'/'7d' -> ms.
 * Unparseable values are treated as forever (fail open: a typo should not
 * lock out paying visitors).
 */
export function parseDuration(value) {
    if (!value || value === 'forever') return null;
    const match = String(value).match(/^(\d+)([mhd])$/);
    if (!match) return null;
    return Number(match[1]) * DURATION_UNITS[match[2]];
}

/** Save a paid receipt for a paywall scope ("<username>:<id>" or the L402 URL). */
export function saveReceipt(scope, receipt) {
    write('receipt:' + scope, receipt);
}

/**
 * Load a receipt if it is still within the remember duration.
 * @param {string} scope
 * @param {string} [remember] duration string; expired receipts are removed.
 */
export function loadReceipt(scope, remember) {
    const receipt = read('receipt:' + scope);
    if (!receipt) return null;
    const duration = parseDuration(remember);
    if (duration !== null && Date.now() >= (receipt.paidAt || 0) + duration) {
        erase('receipt:' + scope);
        return null;
    }
    return receipt;
}

export function clearReceipt(scope) {
    erase('receipt:' + scope);
}

/**
 * Persist an unexpired outstanding invoice so a paid-then-reloaded visitor is
 * not charged twice: on mount the pending invoice is checked once.
 */
export function savePending(scope, challenge) {
    write('pending:' + scope, challenge);
}

export function loadPending(scope) {
    const challenge = read('pending:' + scope);
    if (!challenge) return null;
    if (!challenge.expiresAt || Date.now() >= challenge.expiresAt) {
        erase('pending:' + scope);
        return null;
    }
    return challenge;
}

export function clearPending(scope) {
    erase('pending:' + scope);
}

/** L402 bearer token ({macaroon, preimage}) for a resource URL. */
export function saveToken(url, token) {
    write('token:' + url, token);
}

export function loadToken(url) {
    return read('token:' + url);
}

export function clearToken(url) {
    erase('token:' + url);
}
