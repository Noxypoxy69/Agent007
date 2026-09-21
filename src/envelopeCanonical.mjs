/**
 * CANONICAL SERIALIZATION FOR THE AUTHORITY ENVELOPE.
 *
 * This module produces THE BYTES THAT GET SIGNED. Nothing else in the protocol
 * may decide that question, because two implementations that disagree about it
 * produce signatures that do not verify against each other -- or, far worse,
 * signatures that verify against the WRONG envelope.
 *
 * WHY FRAMING RATHER THAN CONCATENATION, which is the whole reason this file
 * exists. Concatenating fields is ambiguous:
 *
 *     repo_id = "a"   policy = "bc"   ->  "abc"
 *     repo_id = "ab"  policy = "c"    ->  "abc"
 *
 * Two different envelopes, one byte string, one signature. An attacker who
 * controls any two ADJACENT fields can move the boundary between them and
 * present a different authority statement under a signature that verifies.
 *
 * This repository already learned that lesson for digests -- `deployGate.mjs`,
 * `auditRange.mjs`, `guardSession.mjs`, `findingRegistry.mjs` and
 * `auditJob.mjs` all frame with `${path}\x00${len}\x00${body}\x00` because,
 * in the words of the note in CLAUDE.md, "without the framing, two different
 * file lists can hash the same". The authority envelope is the same problem
 * with a worse blast radius, so it gets the same answer.
 *
 * WHAT THE FIRST DRAFT GOT WRONG, recorded because the correction is the point.
 * Rev 3 of the specification defined
 *
 *     frame(x) = decimal_length(x) || 0x00 || x || 0x00
 *
 * and never said whether `decimal_length` counted BYTES or CODE POINTS, nor
 * what encoding a string field used. For any non-ASCII input two conformant
 * implementations therefore still disagree -- the fix for an ambiguity was
 * itself ambiguous. Every one of those choices is made explicit below, and
 * each has a test that fails if it is changed.
 *
 * DOMAIN SEPARATION. The input begins with a context string. Without it, a
 * signature over an envelope can be replayed as a signature over anything else
 * this key ever signs.
 *
 * THIS MODULE DOES NO CRYPTOGRAPHY. It returns bytes. Signing and verification
 * live elsewhere, behind the key boundary, and this file is deliberately
 * importable and testable without either.
 */

const NUL = 0;

/** Domain separation tag. Changing this invalidates every existing signature. */
export const CONTEXT = 'agent007/authority-envelope/v1';

/**
 * The field order of the signing input, fixed HERE and not by object key order.
 *
 * Key order is a property of how an object was built; two producers that agree
 * on every value can still disagree on iteration order, and JSON object key
 * order is not guaranteed across implementations. So the order is a constant,
 * and an unknown field is an error rather than something appended silently.
 */
export const FIELD_ORDER = Object.freeze([
  'protocol_version',
  'repo_id',
  'policy_digest',
  'verifier_generation',
  'transition_seq',
  'prev_envelope_digest',
  'nonce',
  'baseline_tree_algorithm',
  'baseline_tree_digest',
  'candidate_tree_algorithm',
  'candidate_tree_digest',
  'disposition',
  'author_principal_id',
  'reviewer_principal_id',
  'verifier_identity',
  'issued_at',
]);

/** Fields that must be non-negative integers rather than strings. */
const INTEGER_FIELDS = Object.freeze(new Set([
  'protocol_version',
  'verifier_generation',
  'transition_seq',
]));

export class CanonicalError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Encode one string field as UTF-8, NFC-normalised.
 *
 * NFC MATTERS AND IS NOT DECORATION. The same visible text can be carried as a
 * precomposed code point or as a base plus a combining mark -- "é" is either
 * U+00E9 or U+0065 U+0301. Those are different byte sequences, so without
 * normalisation the same logical envelope signs two different ways depending on
 * which editor, filesystem or HTTP client last touched the value. macOS in
 * particular hands back decomposed forms where Windows hands back precomposed.
 */
function utf8(value) {
  return new TextEncoder().encode(value.normalize('NFC'));
}

/**
 * frame(x) = octet_length(utf8(x)) || 0x00 || utf8(x) || 0x00
 *
 * THE LENGTH IS AN OCTET COUNT, NOT A CHARACTER COUNT. `"é".length` is 1 in
 * JavaScript and 2 in UTF-8 bytes; a code-point count would make the framing
 * disagree with the bytes it frames, which reopens exactly the ambiguity the
 * framing exists to close. The count is rendered as ASCII decimal with no
 * leading zeros, so it has one spelling.
 */
export function frame(value) {
  const body = utf8(value);
  if (body.includes(NUL)) {
    throw new CanonicalError('E_FIELD_CONTAINS_NUL',
      'a field may not contain a NUL octet; NUL is the frame delimiter');
  }
  const len = utf8(String(body.length));
  const out = new Uint8Array(len.length + 1 + body.length + 1);
  out.set(len, 0);
  out[len.length] = NUL;
  out.set(body, len.length + 1);
  out[out.length - 1] = NUL;
  return out;
}

/** Render an integer field. One spelling: ASCII decimal, non-negative, no padding. */
function integerField(name, value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CanonicalError('E_FIELD_NOT_INDEX',
      `${name} must be a non-negative safe integer, got ${JSON.stringify(value)}`);
  }
  return String(value);
}

function stringField(name, value) {
  if (typeof value !== 'string') {
    throw new CanonicalError('E_FIELD_NOT_STRING',
      `${name} must be a string, got ${value === null ? 'null' : typeof value}`);
  }
  if (value === '') {
    // An empty field is permitted by the framing (length 0 is unambiguous) but
    // never by this protocol: every field in FIELD_ORDER identifies something,
    // and an empty identity is an omission wearing a value.
    throw new CanonicalError('E_FIELD_EMPTY', `${name} must not be empty`);
  }
  return value;
}

/**
 * Evidence digests, sorted by `kind` so that two producers listing the same
 * evidence in different orders sign the same bytes. The COUNT is framed before
 * the entries -- without it, one envelope with two evidence entries and another
 * with one entry whose fields happen to concatenate the same way are again a
 * collision. Framing the count closes the list the way framing a field closes
 * a field.
 */
function evidenceBytes(evidence) {
  if (!Array.isArray(evidence)) {
    throw new CanonicalError('E_EVIDENCE_NOT_ARRAY', 'evidence_digests must be an array');
  }
  const seen = new Set();
  const rows = evidence.map((entry, i) => {
    if (entry === null || typeof entry !== 'object') {
      throw new CanonicalError('E_EVIDENCE_ENTRY', `evidence_digests[${i}] must be an object`);
    }
    const kind = stringField(`evidence_digests[${i}].kind`, entry.kind);
    if (seen.has(kind)) {
      // Two entries of one kind make the sort order ambiguous again, and an
      // envelope that carries two different digests for one kind of evidence
      // is not saying anything a verifier can act on.
      throw new CanonicalError('E_EVIDENCE_DUPLICATE_KIND', `duplicate evidence kind ${kind}`);
    }
    seen.add(kind);
    return {
      kind,
      algorithm: stringField(`evidence_digests[${i}].algorithm`, entry.algorithm),
      digest: stringField(`evidence_digests[${i}].digest`, entry.digest),
    };
  });

  // Sort on the UTF-8 bytes of `kind`, not on JS string comparison, which
  // orders by UTF-16 code unit and disagrees with byte order above the BMP.
  rows.sort((a, b) => {
    const x = utf8(a.kind);
    const y = utf8(b.kind);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i += 1) {
      if (x[i] !== y[i]) return x[i] - y[i];
    }
    return x.length - y.length;
  });

  const parts = [frame(String(rows.length))];
  for (const row of rows) {
    parts.push(frame(row.kind), frame(row.algorithm), frame(row.digest));
  }
  return parts;
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Build the exact octet string that gets signed.
 *
 * NOTE WHAT IS NOT HERE: `signature` is excluded by construction, because it
 * cannot cover itself. And `independence` is absent because it is not a field
 * of this envelope at all -- a verifier asserting its own independence inside
 * the artefact it signs is self-certification in the one place this protocol
 * exists to prevent it. The recipient derives independence from
 * author_principal_id and reviewer_principal_id.
 */
export function signingInput(envelope) {
  if (envelope === null || typeof envelope !== 'object') {
    throw new CanonicalError('E_ENVELOPE_NOT_OBJECT', 'envelope must be an object');
  }

  const parts = [frame(CONTEXT)];
  for (const name of FIELD_ORDER) {
    if (!Object.hasOwn(envelope, name)) {
      throw new CanonicalError('E_FIELD_MISSING', `envelope is missing ${name}`);
    }
    const raw = envelope[name];
    parts.push(frame(INTEGER_FIELDS.has(name)
      ? integerField(name, raw)
      : stringField(name, raw)));
  }

  if (!Object.hasOwn(envelope, 'evidence_digests')) {
    throw new CanonicalError('E_FIELD_MISSING', 'envelope is missing evidence_digests');
  }
  parts.push(...evidenceBytes(envelope.evidence_digests));

  return concat(parts);
}

/** Hex, for test vectors and for logging. Never a substitute for the bytes. */
export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
