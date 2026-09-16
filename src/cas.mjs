/**
 * A CONTENT-ADDRESSED STORE, IN THE SHAPE THE REMOTE EXECUTION API USES.
 *
 * A digest is a hash AND a size, not a hash alone. The size is not decoration:
 * it is the cheapest possible check that the bytes you got back are the bytes
 * the digest names, it makes a truncated read detectable without rehashing, and
 * it lets a caller decide whether to fetch something before fetching it. Every
 * mature CAS carries it and the reason is always the same.
 *
 * THE STORE IS INJECTED. Memory in a test, disk on a worker, an object store in
 * a fleet -- the identity rules live here and the bytes live wherever they live.
 * Nothing in this file knows how to reach a network.
 *
 * WHAT THIS IS NOT. It is not a cache of decisions and it holds no authority.
 * It answers exactly one question: "here is a digest, what were the bytes". A
 * blob cannot go stale, because changing the bytes changes the name.
 */

import { createHash } from 'node:crypto';

/** The empty blob has a digest like anything else, and callers rely on it. */
export const EMPTY_DIGEST = Object.freeze({
  hash: createHash('sha256').update('').digest('hex'),
  sizeBytes: 0,
});

export function digestOf(payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  return Object.freeze({
    hash: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  });
}

/** Stable text form, so a digest can key a map or appear in a record. */
export function digestKey(digest) {
  assertDigest(digest);
  return `${digest.hash}/${digest.sizeBytes}`;
}

export function assertDigest(digest) {
  if (digest === null || typeof digest !== 'object') throw new TypeError('cas: digest required');
  if (!/^[0-9a-f]{64}$/.test(digest.hash ?? '')) throw new TypeError('cas: digest.hash must be sha256 hex');
  if (!Number.isInteger(digest.sizeBytes) || digest.sizeBytes < 0) {
    throw new TypeError('cas: digest.sizeBytes must be a non-negative integer');
  }
  return digest;
}

export const digestsEqual = (a, b) => a?.hash === b?.hash && a?.sizeBytes === b?.sizeBytes;

/**
 * The reference form a spilled artifact carries, and its parser.
 *
 * BOTH LIVE HERE BECAUSE THE FORMAT IS A CONTRACT. The first test written
 * against this took the reference apart by hand and got it wrong, which is the
 * whole argument: every call site that splits the string is a place the format
 * can be misread, and they all drift independently the day it changes.
 */
export function casRef(namespace, digest) {
  return `cas://${namespace}/${digestKey(digest)}`;
}

/** Returns null rather than throwing: a reference from elsewhere is not ours. */
export function parseCasRef(ref) {
  if (typeof ref !== 'string') return null;
  const match = /^cas:\/\/([^/]+)\/([0-9a-f]{64})\/(\d+)$/.exec(ref);
  if (match === null) return null;
  return Object.freeze({
    namespace: match[1],
    digest: Object.freeze({ hash: match[2], sizeBytes: Number(match[3]) }),
  });
}

/**
 * `store` is the byte layer: get(key), set(key, bytes), has(key).
 *
 * `namespace` is part of every key. Cross-tenant reuse is then impossible by
 * construction rather than by a policy check somebody can forget to write --
 * two projects with byte-identical content get different keys and can never see
 * each other's entries, including by timing.
 */
export function createCas({ store, namespace = 'default' } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('cas: a store with get and set is required');
  }
  if (typeof namespace !== 'string' || namespace === '') throw new TypeError('cas: namespace required');

  const keyFor = (digest) => `${namespace}:${digestKey(digest)}`;

  async function put(payload) {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    const digest = digestOf(bytes);
    await store.set(keyFor(digest), bytes);
    return digest;
  }

  /**
   * Fetch and VERIFY. A store that hands back the wrong bytes is the failure a
   * content-addressed system is supposed to make impossible, so it is checked
   * rather than assumed -- a corrupted or truncated entry is a miss, never a
   * quietly wrong answer. This is the one place the size in the digest earns
   * its keep on every single read.
   */
  async function get(digest) {
    assertDigest(digest);
    const bytes = await store.get(keyFor(digest));
    if (bytes === undefined || bytes === null) return null;
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
    if (buffer.length !== digest.sizeBytes) return null;
    if (!digestsEqual(digestOf(buffer), digest)) return null;
    return buffer;
  }

  async function has(digest) {
    assertDigest(digest);
    if (typeof store.has === 'function') return Boolean(await store.has(keyFor(digest)));
    return (await get(digest)) !== null;
  }

  /**
   * The sink shape the compact-output module expects, so a spill lands in the
   * CAS instead of nowhere. This is what turns "truncated, incomplete" into
   * "spilled, retrievable" at the call site.
   */
  const sink = {
    put: async ({ text }) => casRef(namespace, await put(text)),
  };

  /** Resolve a reference this CAS produced, verifying it belongs to us. */
  async function getRef(ref) {
    const parsed = parseCasRef(ref);
    if (parsed === null || parsed.namespace !== namespace) return null;
    return get(parsed.digest);
  }

  return Object.freeze({ namespace, put, get, has, sink, getRef });
}

/** An in-memory store. Real on a worker, a fixture in a test, same interface. */
export function memoryStore() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, bytes) {
      map.set(key, bytes);
    },
    async has(key) {
      return map.has(key);
    },
  };
}
