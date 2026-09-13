import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    createMacaroon,
    decodeMacaroon,
    verifyPreimage,
    verifyToken,
} from '../examples/l402-server/macaroon.mjs';

const rootKey = Buffer.from('aa'.repeat(32), 'hex');
const preimage = 'bb'.repeat(32);
const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');

describe('macaroon mint/verify', () => {
    it('round-trips payment hash and caveats', () => {
        const macaroon = createMacaroon({
            paymentHash,
            rootKey,
            expirySeconds: 4102444800,
            resource: 'ebook',
        });
        const decoded = decodeMacaroon({ macaroon, rootKey });
        expect(decoded).toEqual({
            signatureValid: true,
            paymentHash,
            expiresAt: 4102444800,
            resource: 'ebook',
        });
    });

    it('is wire-compatible with blink-skills _l402_macaroon.js', () => {
        // Vector minted by blink-skills' createMacaroon with the same inputs.
        const skillsMacaroon =
            'AUyhRSaydRtkDVSc58r4rDlDhZIhGg7DcAZNV2ZqaCrWAQAIAAAAAPSGVwACAAVlYm9va' +
            '-snbVsuRcITFsgNOknxR2PPohwpQD10NM6zTrBoC6aY';
        const decoded = decodeMacaroon({ macaroon: skillsMacaroon, rootKey });
        expect(decoded.signatureValid).toBe(true);
        expect(decoded.paymentHash).toBe(paymentHash);
        expect(decoded.resource).toBe('ebook');
        expect(decoded.expiresAt).toBe(4102444800);
        // And ours is byte-identical to theirs.
        expect(
            createMacaroon({ paymentHash, rootKey, expirySeconds: 4102444800, resource: 'ebook' })
        ).toBe(skillsMacaroon);
    });

    it('rejects a tampered macaroon', () => {
        const macaroon = createMacaroon({ paymentHash, rootKey, resource: 'ebook' });
        const raw = Buffer.from(macaroon, 'base64url');
        raw[5] ^= 0xff;
        const decoded = decodeMacaroon({ macaroon: raw.toString('base64url'), rootKey });
        expect(decoded.signatureValid).toBe(false);
    });

    it('rejects a macaroon minted with a different root key', () => {
        const macaroon = createMacaroon({ paymentHash, rootKey: crypto.randomBytes(32) });
        expect(decodeMacaroon({ macaroon, rootKey }).signatureValid).toBe(false);
    });

    it('verifyPreimage checks sha256(preimage) == hash', () => {
        expect(verifyPreimage(preimage, paymentHash)).toBe(true);
        expect(verifyPreimage('cc'.repeat(32), paymentHash)).toBe(false);
        expect(verifyPreimage('nothex', paymentHash)).toBe(false);
    });
});

describe('verifyToken (Authorization header)', () => {
    const macaroon = createMacaroon({
        paymentHash,
        rootKey,
        expirySeconds: 4102444800,
        resource: 'ebook',
    });
    const good = `L402 ${macaroon}:${preimage}`;

    it('accepts a valid token', () => {
        expect(verifyToken({ authorization: good, rootKey, resource: 'ebook' })).toEqual({
            valid: true,
            paymentHash,
        });
    });

    it('rejects wrong resource, wrong preimage, expiry, and malformed headers', () => {
        expect(verifyToken({ authorization: good, rootKey, resource: 'other' }).valid).toBe(false);
        expect(
            verifyToken({
                authorization: `L402 ${macaroon}:${'cc'.repeat(32)}`,
                rootKey,
                resource: 'ebook',
            }).valid
        ).toBe(false);
        expect(
            verifyToken({
                authorization: good,
                rootKey,
                resource: 'ebook',
                nowSeconds: 4102444801,
            }).valid
        ).toBe(false);
        expect(verifyToken({ authorization: 'Bearer x', rootKey }).valid).toBe(false);
        expect(verifyToken({ authorization: undefined, rootKey }).valid).toBe(false);
    });
});
