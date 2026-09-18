/**
 * DETERMINISTIC SERIALISATION FOR IDENTITY-BEARING INPUTS.
 *
 * Everything that feeds a pattern_id passes through here. The spec's rule is
 * "same inputs -> same id, any identity-bearing change -> different id", and
 * both halves fail for the same reason: an encoding that is not injective.
 *
 * THREE ENCODING BUGS THIS REPOSITORY HAS ALREADY PAID FOR, and which this file
 * exists to not repeat:
 *
 *   1. A JOINED LIST IS NOT A CANONICAL LIST. src/verificationProof.mjs says it
 *      plainly: ['a,b','c'] and ['a','b,c'] join to the same comma string. Lists
 *      are encoded as JSON here, never joined.
 *
 *   2. CONCATENATION WITHOUT FRAMING IS AMBIGUOUS. src/deployGate.mjs and
 *      src/auditRange.mjs carry literal NUL bytes for exactly this reason --
 *      without length framing, two different file lists hash the same.
 *
 *   3. AN UNKNOWN KEY THAT RIDES ALONG UNHASHED IS A FORGERY SURFACE. A record
 *      spread with {authorization:'approved'} read back as valid because the
 *      digest did not cover the extra key. Callers here declare their schema and
 *      an undeclared key is a refusal, not a silent drop.
 *
 * REFUSAL IS THE ONLY FAILURE MODE. Spec section 10: "Canonicalization failure
 * must refuse admission." Nothing in this file returns a best-effort encoding --
 * if a value cannot be encoded deterministically it throws, and the caller turns
 * that into a refused admission rather than an admitted pattern with a hash
 * nobody can reproduce.
 *
 * PURE. No clock, no filesystem, no network, no randomness -- by construction,
 * since any of those would be the nondeterminism this module is here to reject.
 */

import { createHash } from 'node:crypto';

/** Named so a caller can tell "this cannot be encoded" from any other throw. */
export class CanonicalizationError extends Error {
  constructor(reason, at = '') {
    super(at ? `${reason} (at ${at})` : reason);
    this.name = 'CanonicalizationError';
    this.reason = reason;
    this.at = at;
  }
}

const fail = (reason, at) => {
  throw new CanonicalizationError(reason, at);
};

/**
 * Keys that carry ambient session state rather than meaning.
 *
 * Spec section 10 says to EXCLUDE timestamps, random ids and worktree paths from
 * identity, and section 16.7 repeats it for git/worktree paths specifically. The
 * obvious reading is "strip them", and that is the wrong one: a stripped key is
 * a key the caller supplied and the hash does not cover, which is defect 3 in
 * the header. So they are REFUSED, loudly, and the caller omits them.
 */
const AMBIENT_KEYS = Object.freeze(new Set([
  'timestamp', 'timestamps', 'created_at', 'updated_at', 'admitted_at', 'last_verified_at',
  'observed_at', 'generated_at', 'date', 'time', 'now',
  'uuid', 'guid', 'nonce', 'random', 'random_id', 'session_id', 'run_id', 'trace_id',
  'cwd', 'tmpdir', 'temp_dir', 'worktree', 'worktree_path', 'abs_path', 'absolute_path',
  'machine', 'hostname', 'pid',
]));

/**
 * An absolute machine path, in the two shapes this fleet actually produces.
 *
 * Windows is first because it is the operator's machine and a POSIX-only check
 * is how the shell rail shipped broken -- measured 2026-09-17, same repository.
 */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|tmp|var|private|mnt|opt)\/)/;

/**
 * Text normalisation applied to EVERY string before it is hashed.
 *
 * Unicode NFC because two byte sequences that render identically must not mint
 * two pattern ids, and line endings because the same file checked out on Windows
 * and on Linux is the same file. Both are named in spec section 10.
 */
export function canonicalText(value, at = 'text') {
  if (typeof value !== 'string') fail('expected a string', at);
  return value.normalize('NFC').replace(/\r\n?/g, '\n');
}

/** The interface stub, canonicalised. Spec 3.1 calls for a trimmed signature. */
export function canonicalStub(value, at = 'interface_stub') {
  const text = canonicalText(value, at).trim();
  if (text === '') fail('interface stub is empty; a pattern with no stable exported interface has no identity', at);
  return text;
}

/**
 * A set-like array: order carries no meaning, so it is sorted and deduplicated.
 *
 * Spec section 3.1: "Order differences in semantically equivalent maps/sets must
 * not change the hash. Actual value differences must." A set containing a
 * duplicate is the same set, so ['a','a','b'] and ['a','b'] must agree -- and
 * both must differ from ['a','c'].
 *
 * This is NEVER applied by guesswork. A caller names which fields are set-like,
 * because applying it to an ordered array would silently destroy meaning.
 */
export function canonicalSet(value, at = 'set') {
  if (!Array.isArray(value)) fail('expected an array for a set-like field', at);
  const out = new Set();
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== 'string') fail('a set-like field takes strings only', `${at}[${i}]`);
    out.add(canonicalText(entry, `${at}[${i}]`));
  }
  return [...out].sort();
}

/**
 * Recursive deterministic JSON. Object keys sorted, array order PRESERVED.
 *
 * Array order is preserved rather than sorted because spec section 10 requires
 * both behaviours and only the caller knows which applies: run canonicalSet on
 * the set-like fields first, then hand the result here.
 */
export function canonicalJson(value, at = '$') {
  return JSON.stringify(encode(value, at, new Set()));
}

function encode(value, at, seen) {
  if (value === null) return null;

  const t = typeof value;

  if (t === 'string') {
    const text = canonicalText(value, at);
    if (ABSOLUTE_PATH.test(text)) {
      fail('an absolute machine path may never enter identity (spec 16.7)', at);
    }
    return text;
  }

  if (t === 'number') {
    if (!Number.isFinite(value)) fail('NaN and Infinity have no canonical form', at);
    // -0 and 0 serialise identically in JSON; normalise so they also compare so.
    return value === 0 ? 0 : value;
  }

  if (t === 'boolean') return value;

  if (t === 'undefined') fail('undefined is not representable; omit the key instead', at);
  if (t === 'function' || t === 'symbol' || t === 'bigint') fail(`a ${t} has no canonical form`, at);

  if (value instanceof Date) fail('a timestamp may never enter identity (spec 10)', at);
  if (value instanceof RegExp || value instanceof Map || value instanceof Set) {
    fail(`a ${value.constructor.name} has no canonical form; pass a plain object or array`, at);
  }

  if (seen.has(value)) fail('a cycle has no canonical form', at);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, i) => encode(entry, `${at}[${i}]`, seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      fail('a class instance has no canonical form; pass a plain object', at);
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (AMBIENT_KEYS.has(key.toLowerCase())) {
        fail(`"${key}" is ambient session state and may never enter identity (spec 10)`, at);
      }
      out[key] = encode(value[key], at === '$' ? key : `${at}.${key}`, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Reject any key the schema did not declare.
 *
 * The forgery this prevents is concrete and already happened once in this repo:
 * spreading an extra field onto a valid record and having it read back as valid
 * because the digest did not cover it. Declared keys only, and the digest covers
 * every one of them.
 */
export function assertExactKeys(object, allowed, at = 'record') {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) {
    fail('expected an object', at);
  }
  const permitted = new Set(allowed);
  const present = Object.keys(object);
  const unknown = present.filter((k) => !permitted.has(k)).sort();
  if (unknown.length > 0) {
    fail(`unknown key(s) ${unknown.map((k) => JSON.stringify(k)).join(', ')}; an undeclared key would ride along unhashed`, at);
  }
  const missing = [...permitted].filter((k) => !present.includes(k)).sort();
  return { missing };
}

export const sha256Hex = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

/** A SHA-256 hex digest, exactly. Nothing else may stand in for one. */
export const isSha256Hex = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** A git object id. Matches the 40-hex form src/verificationProof.mjs accepts. */
export const isGitSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);

/** Hash a canonicalised structure. The caller has already declared its schema. */
export const hashCanonical = (value, at) => sha256Hex(canonicalJson(value, at));
