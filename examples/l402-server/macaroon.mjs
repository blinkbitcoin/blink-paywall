/**
 * Minimal L402 macaroon — mint + verify.
 *
 * Ported from blink-skills (blink/scripts/_l402_macaroon.js) and kept
 * WIRE-COMPATIBLE with it: tokens minted here validate with
 * `blink l402-verify` and vice versa.
 *
 * Intentionally NOT the full libmacaroons v2 spec — a practical,
 * self-contained implementation of the L402 security model:
 *   1. Cryptographic binding: the macaroon encodes payment_hash, HMAC-signed
 *      with a secret root key -> only this server can mint valid tokens.
 *   2. Caveats: expiry + resource scope.
 *   3. The preimage remains the payment proof: sha256(preimage) == payment_hash,
 *      and the preimage only exists once OUR invoice was settled.
 *
 * Binary layout (base64url on the wire):
 *   [0]          version byte (0x01)
 *   [1..32]      payment_hash (32 raw bytes)
 *   [33..N]      caveats as TLV: 0x01 expiry (uint64BE unix seconds), 0x02 resource (utf8)
 *   [N+1..N+32]  HMAC-SHA256(rootKey, bytes[0..N])
 */

import crypto from 'node:crypto';

const VERSION_BYTE = 0x01;
const PAYMENT_HASH_SIZE = 32;
const HMAC_SIZE = 32;
const CAVEAT_TYPE_EXPIRY = 0x01;
const CAVEAT_TYPE_RESOURCE = 0x02;

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function encodeCaveats(caveats) {
    const parts = [];
    for (const caveat of caveats) {
        const head = Buffer.alloc(3);
        head[0] = caveat.type;
        head.writeUInt16BE(caveat.value.length, 1);
        parts.push(head, caveat.value);
    }
    return Buffer.concat(parts);
}

function decodeCaveats(buffer) {
    const caveats = [];
    let offset = 0;
    while (offset + 3 <= buffer.length) {
        const type = buffer[offset];
        const length = buffer.readUInt16BE(offset + 1);
        offset += 3;
        if (offset + length > buffer.length) break; // malformed — truncate
        caveats.push({ type, value: buffer.subarray(offset, offset + length) });
        offset += length;
    }
    return caveats;
}

/**
 * Mint a macaroon bound to a payment hash.
 * @param {{paymentHash: string, rootKey: Buffer, expirySeconds?: number, resource?: string}} options
 *   expirySeconds: ABSOLUTE unix timestamp (seconds), not a duration.
 * @returns {string} base64url macaroon
 */
export function createMacaroon({ paymentHash, rootKey, expirySeconds, resource }) {
    if (!/^[0-9a-fA-F]{64}$/.test(paymentHash)) {
        throw new Error('paymentHash must be a 64-character hex string.');
    }
    if (!Buffer.isBuffer(rootKey) || rootKey.length !== 32) {
        throw new Error('rootKey must be a 32-byte Buffer.');
    }
    const caveats = [];
    if (expirySeconds !== undefined && expirySeconds !== null) {
        const value = Buffer.alloc(8);
        value.writeBigUInt64BE(BigInt(Math.floor(expirySeconds)), 0);
        caveats.push({ type: CAVEAT_TYPE_EXPIRY, value });
    }
    if (resource !== undefined && resource !== null) {
        caveats.push({ type: CAVEAT_TYPE_RESOURCE, value: Buffer.from(resource, 'utf8') });
    }
    const body = Buffer.concat([
        Buffer.from([VERSION_BYTE]),
        Buffer.from(paymentHash, 'hex'),
        encodeCaveats(caveats),
    ]);
    return Buffer.concat([body, hmac(rootKey, body)]).toString('base64url');
}

/**
 * Decode + verify the HMAC of a macaroon.
 * @returns {{signatureValid: boolean, paymentHash: string, expiresAt: number|null, resource: string|null}}
 */
export function decodeMacaroon({ macaroon, rootKey }) {
    let raw;
    try {
        raw = Buffer.from(macaroon, 'base64url');
    } catch {
        throw new Error('Macaroon is not valid base64url.');
    }
    if (raw.length < 1 + PAYMENT_HASH_SIZE + HMAC_SIZE) {
        throw new Error('Macaroon too short to be valid.');
    }
    if (raw[0] !== VERSION_BYTE) {
        throw new Error(`Unsupported macaroon version: 0x${raw[0].toString(16)}`);
    }
    const body = raw.subarray(0, raw.length - HMAC_SIZE);
    const signatureValid = crypto.timingSafeEqual(
        raw.subarray(raw.length - HMAC_SIZE),
        hmac(rootKey, body)
    );
    const paymentHash = body.subarray(1, 1 + PAYMENT_HASH_SIZE).toString('hex');

    let expiresAt = null;
    let resource = null;
    for (const caveat of decodeCaveats(body.subarray(1 + PAYMENT_HASH_SIZE))) {
        if (caveat.type === CAVEAT_TYPE_EXPIRY && caveat.value.length === 8) {
            expiresAt = Number(caveat.value.readBigUInt64BE(0));
        } else if (caveat.type === CAVEAT_TYPE_RESOURCE) {
            resource = caveat.value.toString('utf8');
        }
    }
    return { signatureValid, paymentHash, expiresAt, resource };
}

/** sha256(preimage) === paymentHash — the proof the invoice was settled. */
export function verifyPreimage(preimageHex, paymentHash) {
    if (!/^[0-9a-fA-F]{64}$/.test(preimageHex)) return false;
    if (!/^[0-9a-fA-F]{64}$/.test(paymentHash)) return false;
    const computed = crypto
        .createHash('sha256')
        .update(Buffer.from(preimageHex, 'hex'))
        .digest('hex');
    return computed.toLowerCase() === paymentHash.toLowerCase();
}

/**
 * Full token check. `authorization` is the raw Authorization header value.
 * @returns {{valid: boolean, reason?: string, paymentHash?: string}}
 */
export function verifyToken({ authorization, rootKey, resource, nowSeconds }) {
    const match = /^L402\s+([^:\s]+):([0-9a-fA-F]{64})$/i.exec(authorization || '');
    if (!match) return { valid: false, reason: 'malformed Authorization header' };
    const [, macaroon, preimage] = match;

    let decoded;
    try {
        decoded = decodeMacaroon({ macaroon, rootKey });
    } catch (error) {
        return { valid: false, reason: error.message };
    }
    if (!decoded.signatureValid) return { valid: false, reason: 'invalid signature' };
    if (!verifyPreimage(preimage, decoded.paymentHash)) {
        return { valid: false, reason: 'preimage does not match payment hash' };
    }
    const now = nowSeconds !== undefined ? nowSeconds : Math.floor(Date.now() / 1000);
    if (decoded.expiresAt !== null && now > decoded.expiresAt) {
        return { valid: false, reason: 'token expired' };
    }
    if (decoded.resource !== null && resource !== undefined && decoded.resource !== resource) {
        return { valid: false, reason: 'token is for a different resource' };
    }
    return { valid: true, paymentHash: decoded.paymentHash };
}
