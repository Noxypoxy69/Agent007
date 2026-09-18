import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIG_VERSION = 'v1';
export const MAX_SKEW_MS = 120_000;

export function bodyHash(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Canonical string. Signing the body *hash* binds the payload to the signature. */
export function canonical({ machineId, timestamp, nonce, body }) {
  return [SIG_VERSION, machineId, String(timestamp), nonce, bodyHash(body)].join('\n');
}

export function sign({ machineId, timestamp, nonce, body, secret }) {
  return createHmac('sha256', secret).update(canonical({ machineId, timestamp, nonce, body })).digest('hex');
}

export function newNonce() { return randomBytes(16).toString('hex'); }

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch { return false; }
}

/** Pure verification: no I/O, so it is unit-testable. Replay store is the caller's job. */
export function verify({ machineId, timestamp, nonce, body, signature, secret, now = Date.now() }) {
  if (!machineId || !timestamp || !nonce || !signature || !secret) {
    return { ok: false, reason: 'missing-auth-fields' };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad-timestamp' };
  const skew = Math.abs(now - ts);
  if (skew > MAX_SKEW_MS) return { ok: false, reason: 'timestamp-out-of-window', skewMs: skew };
  if (!/^[a-f0-9]{32}$/i.test(nonce)) return { ok: false, reason: 'bad-nonce' };
  const expected = sign({ machineId, timestamp: ts, nonce, body, secret });
  if (!safeEqualHex(expected, signature)) return { ok: false, reason: 'bad-signature' };
  return { ok: true };
}
