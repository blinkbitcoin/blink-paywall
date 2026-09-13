import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    clearPending,
    loadPending,
    loadReceipt,
    loadToken,
    parseDuration,
    savePending,
    saveReceipt,
    saveToken,
    clearToken,
} from '../src/storage.js';

afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
});

describe('parseDuration', () => {
    it('parses m/h/d units', () => {
        expect(parseDuration('30m')).toBe(30 * 60_000);
        expect(parseDuration('24h')).toBe(24 * 3_600_000);
        expect(parseDuration('7d')).toBe(7 * 86_400_000);
    });

    it('forever, empty and garbage are all forever (fail open)', () => {
        expect(parseDuration('forever')).toBeNull();
        expect(parseDuration(undefined)).toBeNull();
        expect(parseDuration('')).toBeNull();
        expect(parseDuration('next tuesday')).toBeNull();
    });
});

describe('receipts', () => {
    it('round-trips and respects remember duration', () => {
        const receipt = { id: 'x', paidAt: Date.now() };
        saveReceipt('alice:x', receipt);
        expect(loadReceipt('alice:x', 'forever')).toEqual(receipt);
        expect(loadReceipt('alice:x', '24h')).toEqual(receipt);
    });

    it('expires and removes old receipts', () => {
        saveReceipt('alice:x', { id: 'x', paidAt: Date.now() - 25 * 3_600_000 });
        expect(loadReceipt('alice:x', '24h')).toBeNull();
        expect(loadReceipt('alice:x', 'forever')).toBeNull(); // removed
    });

    it('returns null when nothing stored', () => {
        expect(loadReceipt('nobody:y', 'forever')).toBeNull();
    });
});

describe('pending invoices', () => {
    it('round-trips while unexpired', () => {
        const challenge = { paymentRequest: 'lnbc1', expiresAt: Date.now() + 60_000 };
        savePending('alice:x', challenge);
        expect(loadPending('alice:x')).toEqual(challenge);
        clearPending('alice:x');
        expect(loadPending('alice:x')).toBeNull();
    });

    it('drops expired pending invoices', () => {
        savePending('alice:x', { paymentRequest: 'lnbc1', expiresAt: Date.now() - 1 });
        expect(loadPending('alice:x')).toBeNull();
    });
});

describe('tokens', () => {
    it('round-trips by URL', () => {
        saveToken('https://s/p', { macaroon: 'm', preimage: 'p' });
        expect(loadToken('https://s/p')).toEqual({ macaroon: 'm', preimage: 'p' });
        clearToken('https://s/p');
        expect(loadToken('https://s/p')).toBeNull();
    });
});

describe('storage unavailable', () => {
    it('never throws', () => {
        const broken = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceeded');
        });
        expect(() => saveReceipt('a:b', { paidAt: 1 })).not.toThrow();
        broken.mockRestore();
    });
});
