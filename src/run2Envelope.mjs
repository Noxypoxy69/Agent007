/**
 * THE RUN 2 MACHINE ENVELOPE: seven fields a cold seat may believe, each with
 * the query that established it and whether it may be trusted.
 *
 * Contract: ~/.agentbridge/RUN2-ENVELOPE-SPEC.md (frozen by the owner,
 * 2026-09-23). This module is the classifier of section 6 -- PURE. It takes
 * observations that scripts/run2-envelope.mjs has already fetched, as plain
 * data, and returns the envelope. No spawn, no fetch, no filesystem, no clock:
 * `generated_at` and every `observed_at` arrive as inputs, which is what makes
 * the same observations produce a byte-identical envelope.
 *
 * IT REPORTS SOURCE FAILURE; IT DOES NOT REPAIR IT. A stale task row, a ghost
 * roster row or a manifest that disagrees with the directory is classified and
 * named in `reason`. Nothing here deletes, rewrites, guesses or picks a likely
 * answer.
 *
 * A TRUST STATE THAT NEVER CHANGES IS A HARDCODED STRING. Fields 2, 3, 4 and 6
 * are computed from their observations and each can move in both directions;
 * test/run2Envelope.test.mjs drives every direction section 7 names. Fields 1
 * and 5 are ABSENT BY CONTRACT and read nothing, so no prose handed to this
 * function can reach them.
 *
 * FIELDS 2 AND 6 ARE UNTRUSTWORTHY BY CONSTRUCTION (spec AMENDMENT 2).
 * Recency was a proxy: a store whose open rows were all fresh promoted to
 * TRUSTED even while it omitted tonight's work, and two registries that agree
 * still share the blind spot of a seat that never registered. So freshness and
 * the registry cross-check may only DEMOTE. Promotion needs a COMPLETENESS
 * ANCHOR -- a separately named input, `anchors.assignment` / `anchors.liveness`,
 * from a source independent of the store it judges -- and the anchor must be
 * covered. registrations.json is NOT an anchor for field 6 (Controller
 * decision under the amendment): it is a registry with the same blind spot.
 * The driver supplies no anchor today, so live, neither field promotes.
 * Since T-131 an anchor must also carry a `kind` from ANCHOR_KINDS, matched
 * exactly; see the anchor section below.
 * PRECONDITION FOR WIRING ANY ANCHOR SOURCE (T-173): an anchor's observed_at
 * is not read today (named limit 4 at anchorProblem). That gap MUST be closed
 * before any anchor source is wired, because AMENDMENT 2 asks for evidence the
 * work is "known to be current".
 *
 * NAMED LIMITS OF THE WHOLE MODULE (anchor-specific ones are listed below).
 *  - HEARTBEAT SKEW. Liveness compares each heartbeat with the observation's
 *    own observed_at. A writer whose clock runs ahead or behind by minutes is
 *    judged by its own clock; nothing here measures skew between machines.
 *  - BASENAME repo_id. Field 3's repo identity is the basename of the git
 *    top-level. Two clones named "Agent007" in different directories read as
 *    the same repository; HEAD and tree, not the name, tell them apart.
 */

import { createHash } from 'node:crypto';
import { livenessOf, isAvailable, LIVENESS, STALE_AFTER_MS, CAPACITIES } from './liveRegistry.mjs';

export const ENVELOPE_VERSION = 'run2-v0';
export const HISTORY_MARKER = 'HISTORY_IS_NOT_INSTRUCTION';

export const TRUST = Object.freeze({
  TRUSTED: 'TRUSTED',
  ABSENT: 'ABSENT',
  UNTRUSTWORTHY: 'UNTRUSTWORTHY',
});

export const FIELD_IDS = Object.freeze([
  'role_authority',
  'assignment_candidate',
  'baseline',
  'protected_frozen',
  'review_independence',
  'channel_liveness',
  'history_marker',
]);

/** An open task row not touched for this long is residue, not current work. */
export const TASK_FRESH_MS = 24 * 60 * 60 * 1000;

/** A timestamp further in the future than this is a clock problem, not a fresh row. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** States that present a task as live work. */
export const OPEN_TASK_STATES = Object.freeze(['runnable', 'assigned', 'blocked', 'returned']);

/**
 * States that close a task: accept_task writes 'accepted', cancel_task writes
 * 'cancelled' (supabase/functions/mcp/_shared.js; list_tasks documents the six
 * states). A state in neither list demotes field 2 rather than reading as closed.
 */
const CLOSED_TASK_STATES = Object.freeze(['accepted', 'cancelled']);

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/*
 * "CARRIES NOTHING" HAS ONE DEFINITION (T-176 E): empty once format and
 * default-ignorable characters (zero-width space and joiners, BOM, soft
 * hyphen) are stripped and whitespace is trimmed -- the same strip clean()
 * applies to anchor labels. A U+200B agent or session is not a name.
 */
const IGNORABLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const blank = (s) => s.replace(IGNORABLE, '').trim() === '';
const str = (v) => (typeof v === 'string' && !blank(v) ? v : null);
/*
 * A REASON IS BOUNDED (T-176 A). Any input text quoted in a message is cut to
 * CLIP code units plus a length note BEFORE it is concatenated or stringified:
 * a 2^29-code-unit message, or a generated_at of 1e8 control characters,
 * otherwise pushed a reason past V8's string limit and a RangeError escaped.
 */
const CLIP = 200;
const clip = (s) => (s.length <= CLIP ? s : `${s.slice(0, CLIP)}... (${s.length} code units)`);
/*
 * A SORT KEY IS A STRING OR EMPTY, never String()-coerced (T-157): String() on
 * a null-prototype record throws, and on an array it reads Array.prototype.
 * Every caller sorts a list whose field is refused anyway when the key is not
 * a string, so a non-string key only has to not throw.
 */
const sortText = (v) => (typeof v === 'string' ? v : '');
const byKey = (k) => (a, b) => (sortText(a[k]) < sortText(b[k]) ? -1 : sortText(a[k]) > sortText(b[k]) ? 1 : 0);
const listed = (xs, n = 5) => {
  const shown = xs.slice(0, n).map(clip).join(', ');
  return xs.length <= n ? shown : `${shown} (+${xs.length - n} more)`;
};

/**
 * The seven attributes of section 2, always all present, always in this order.
 * `keep_value` is for a field whose value is PER-COMPONENT (field 3): the null
 * rule has already been applied to each component, so the field keeps the
 * container even when it is not TRUSTED.
 */
function field(field_id, opts) {
  /*
   * OWN options only (T-155). Callers pass literals that OMIT keys, and a
   * destructuring default applies only when the read is undefined -- a read
   * that walks the prototype. With Object.prototype.source polluted, fields 1
   * and 5 printed the polluted source even after the input copy below.
   */
  const opt = (k, d) => (Object.hasOwn(opts, k) && opts[k] !== undefined ? opts[k] : d);
  const value = opt('value', null);
  const source = opt('source', null);
  const source_identity = opt('source_identity', null);
  const observed_at = opt('observed_at', null);
  const trust_state = opt('trust_state', undefined);
  const reason = opt('reason', null);
  const keep_value = opt('keep_value', false);
  return {
    field_id,
    value: trust_state === TRUST.TRUSTED || keep_value ? value : null,
    source,
    source_identity,
    observed_at,
    trust_state,
    reason: trust_state === TRUST.TRUSTED ? null : reason,
  };
}

/* ── 1 · role_authority and 5 · review_independence: ABSENT by contract ───── */

/*
 * These take NO observation argument, on purpose. The anti-prose rule is
 * enforced by construction: SEATS.md, a handoff, a tab name or a registry label
 * passed to compileEnvelope has no path into either field.
 */
function roleAuthority(generatedAt) {
  return field('role_authority', {
    observed_at: generatedAt,
    trust_state: TRUST.ABSENT,
    reason: 'no authoritative machine source',
  });
}

function reviewIndependence(generatedAt) {
  return field('review_independence', {
    observed_at: generatedAt,
    trust_state: TRUST.ABSENT,
    reason: 'only prose/Markdown source exists',
  });
}

/* ── completeness anchors (AMENDMENT 2) ────────────────────────────────── */

/*
 * THE ANCHOR KIND ALLOWLIST IS THE AUTHORITY (T-131, Controller decision).
 *
 * Five independent verifiers each found new label spellings that a denylist
 * did not know. A denylist of labels is unbounded by construction (CLAUDE.md
 * rule 8), so independence is no longer judged from labels at all: an anchor
 * must carry `kind`, and `kind` must EXACTLY equal (===, no normalisation of
 * any sort) one entry here. Anything else -- missing, misspelt, re-cased,
 * padded -- is refused.
 *
 * These two are the T-113 direction: a record the owner signed, and a record
 * written once to a remote store the builder cannot rewrite. ADDING A KIND IS A
 * REVIEWED CHANGE, not a configuration edit. The driver mints no anchor of any
 * kind today.
 */
export const ANCHOR_KINDS = Object.freeze(['owner-signed-record', 'remote-write-once-record']);

/**
 * Sources that are JUDGED by fields 2 and 6 and so can never anchor them.
 * Checked AFTER the kind allowlist, as defence in depth: an allowed kind whose
 * labels name a judged store is still the store vouching for itself.
 */
export const JUDGED_SOURCES = Object.freeze(['task-store', 'list_tasks', 'roster', 'list_agents', 'registrations', 'registrations.json']);

/*
 * THE LABEL DENYLIST (defence in depth, T-122..T-131).
 *
 * PLAIN PRINTABLE ASCII OR REFUSED. Default-ignorable and format characters
 * (zero-width space, joiners, BOM, soft hyphen) are stripped first, since they
 * carry nothing; after that ANY code point outside U+0020..U+007E is refused --
 * C0 controls, DEL, tab and newline, combining marks, accented letters,
 * Cyrillic, fullwidth forms, and the "_" confusables U+2017 and U+0331. There
 * is deliberately no NFKD fold any more: U+2017 decomposes to a space plus a
 * mark, so folding MANUFACTURED a confusable ("list<U+2017>tasks" became
 * "listtasks") instead of removing one.
 *
 * Comparison is on a canonical form (backslash to slash, spaces removed,
 * lower-cased), for BOTH the source and the source_identity, on the whole value
 * and its last path segment, plus tokens split on every character outside
 * [a-z0-9._-] and again on dots.
 */
/*
 * PERCENT-ESCAPES ARE DECODED FIRST (FLOOR-3): "%6C%69%73%74%5F..." and
 * "list%5Ftasks" are the judged name, spelled for a URL. Decoded up to three
 * times so a doubly-escaped "%255F" cannot hide one; a decoded byte outside
 * printable ASCII is then refused like any other.
 */
const decodePct = (s) => {
  let out = s;
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (next === out) break;
    out = next;
  }
  return out;
};
const clean = (s) => decodePct(String(s ?? '').replace(IGNORABLE, ''));
const NOT_PRINTABLE_ASCII = /[^\x20-\x7E]/;
const canon = (s) => clean(s).replace(/\\/g, '/').replace(/ +/g, '').toLowerCase();
const lastSegment = (c) => c.split('/').filter(Boolean).pop() ?? '';
/*
 * TOKENS: split on EVERY character outside [a-z0-9._-], so a judged name
 * wrapped in punctuation -- "(registrations.json)", "`list_tasks`",
 * "registrations.json!", "~", "+copy" -- or embedded in an identity
 * ("... sha256:...", "... @ https://...") is still seen. A token must EQUAL a
 * judged name; "rosterless" is not "roster".
 */
const tokens = (s) => clean(s).toLowerCase().split(/[^a-z0-9._-]+/)
  .filter(Boolean)
  // AND each dot-separated part (FLOOR-3): "list_tasks.json", "mirror.roster"
  // and "registrations.json.json" carry the judged name as a dotted component.
  // This also covers a trailing dot ("list_tasks." -> "list_tasks"), so the
  // separate trailing-dot strip was removed rather than kept as a rule no
  // mutation could observe.
  .flatMap((t) => [t, ...t.split('.').filter(Boolean)]);
const JUDGED_CANON = JUDGED_SOURCES.map(canon);

/*
 * IDENTITY PARTS (FLOOR-3). A judged identity is a composite --
 * "list_tasks @ https://.../mcp", "<path>/registrations.json sha256:<hex>" --
 * and each distinctive PART of it identifies the store on its own: the
 * endpoint URL, the file path, the digest. The parts are the identity split on
 * whitespace, "@" and ":", and a label CONTAINING any part of 8+ characters is
 * refused, so the URL survives a query, fragment, trailing dot, "::$DATA",
 * gluing or prose ("copy-of-https://.../mcp?v=2"), and a bare file digest is
 * caught. Under 8 characters a part is too generic to contain safely.
 */
const MIN_PART = 8;
const identityParts = (id) => clean(id).toLowerCase().replace(/\\/g, '/')
  .split(/[\s@:]+/).filter((p) => p.length >= MIN_PART);

/*
 * BOUNDED, NOT PARTS x LABEL (T-179 F2). `parts.some((p) => c.includes(p))`
 * costs (judged parts) x (label length) per label, and the parts are
 * re-derived for every label: 1e5 parts x a 1e6 label took 3.5 s, 1e6 x 1e7
 * was killed at 120 s, and a refused tasks slot still cost field 6 2.2 s.
 * The fix is TWO BOUNDS, checked in anchorProblem before this runs:
 *  - an anchor label is at most MAX_LABEL code units, or it is refused;
 *  - a judged identity is at most MAX_IDENTITY code units, or the anchor
 *    judged against it is refused ("cannot be shown independent") -- and that
 *    identity's own field refuses it by the header rule.
 * WHY 256 FOR A LABEL: the realistic labels measured (T-181) were 28 to 231
 * characters -- a source name, a URL with a query, a deep path plus
 * " sha256:<64 hex>". That suffix is 72 characters, so a label of that shape
 * leaves 184 for the path; a longer one is REFUSED (fail-closed, a false
 * refusal by design, named limit 3 at anchorProblem). Judged identities
 * ("list_tasks @ <url>", "<path> sha256:<hex>") get the far larger
 * MAX_IDENTITY. With both bounds, one call is at most 3 x 4096
 * characters of derivation plus ~1500 parts x 256 characters of includes() --
 * a constant, so what remains is linear in the input. MEASURED (compile, in a
 * child): 3e5 parts x 1e6 label 8 ms (was 7.2 s), 1e6 x 1e7 27 ms (was killed
 * at 60 s), a 4e6-part task identity 169 ms (was 4.7 s).
 * A set-of-substrings lookup and a once-per-compile memo were tried first; with
 * these bounds no mutation of either could be observed (rule 11), so neither is
 * kept: the bounds are the mechanism.
 */
const MAX_LABEL = 256;
const MAX_IDENTITY = 4096;
function namesAJudgedSource(value, judgedIdentities) {
  const c = canon(value);
  if (!c) return false;
  const judged = judgedIdentities.filter(Boolean);
  const ids = judged.map(canon);
  const idForms = new Set([...ids, ...ids.map(lastSegment)].filter(Boolean));
  const parts = judged.flatMap(identityParts);
  const forms = [c, lastSegment(c)];
  return forms.some((x) => JUDGED_CANON.includes(x) || idForms.has(x))
    // a judged identity embedded in a longer label ("<id> sha256:...", a path
    // ending in it); identities under 8 characters are too short to contain safely
    || ids.some((id) => id.length >= MIN_PART && c.includes(id))
    || parts.some((p) => c.includes(p))
    || tokens(value).some((t) => JUDGED_CANON.includes(t));
}

/*
 * OWN DATA ONLY (T-155). A property the classifier reads must be one the
 * observation CARRIES, never one it inherits. T-131 read `anchor.kind` through
 * the prototype chain: an anchor built with Object.create({kind}) -- or merged
 * with Object.assign from JSON carrying "__proto__" -- promoted, and with
 * Object.prototype polluted an anchor with NO kind promoted. The same held for
 * every other field read here (ok, current, live_sessions, source, rows,
 * task_id, heartbeat_at inside liveRegistry, ...).
 *
 * So inheritance is removed at the boundary: each observation is copied, by
 * the SCHEMA of what is read (copyAs, SCHEMAS), into null-prototype records and
 * ordinary arrays holding only OWN properties, each read exactly once
 * (ownRead). Nothing downstream of the copy can inherit anything, including
 * liveRegistry, whose reads are part of the schema.
 *
 * THE COPY IS SNAPSHOTTED IN compileEnvelope, NOT RUN INSIDE A FIELD: each
 * slot's copy (or the error it threw) is taken once, and an error is rethrown
 * inside the guard of the field that owns the slot, so a throwing getter, an
 * over-long list, an exhausted work budget or an absurdly deep value still
 * costs only its own field (M25). Field 3 goes one step further and snapshots
 * PER COMPONENT (T-179 F1): see BASELINE_GROUPS.
 *
 * ARRAY HOLES become undefined elements, never inherited ones. filter() and
 * friends test a hole with HasProperty, which walks the prototype: under T-131
 * a hole in `rows` with Object.prototype[0] polluted was read as a row.
 */
/*
 * EVERY INPUT PROPERTY IS READ EXACTLY ONCE (T-157 rework, T-161). A check and
 * a use that each read the property can see two different values: an accessor
 * on observations.anchors answered {} to the isRecord test and then an Array
 * carrying valid anchors to the read, and both fields promoted. So an input
 * property is read ONLY through ownRead, whose one read is its own property
 * descriptor. The "is it own?" test and the value come from that same read,
 * rather than Object.hasOwn followed by a [[Get]], which a Proxy can answer
 * differently -- and a [[Get]] that falls through to the target walks its
 * prototype. A getter is called once, and whatever it returns is the value.
 * The descriptor's fields are read as OWN fields: a descriptor is an ordinary
 * object, so `'value' in d` would see a polluted Object.prototype.value.
 * test/run2Envelope.test.mjs turns every property of the fixture, at every
 * depth, into a counting accessor and requires a count of exactly 1.
 */
function ownRead(o, k) {
  const d = Object.getOwnPropertyDescriptor(o, k);
  if (d === undefined) return undefined;
  if (Object.hasOwn(d, 'value')) return d.value;
  const get = Object.hasOwn(d, 'get') ? d.get : undefined;
  return typeof get === 'function' ? get.call(o) : undefined;
}

/*
 * A LIST'S LENGTH IS INPUT, SO IT IS VALIDATED BEFORE ANYTHING ITERATES IT
 * (T-173 NEW-F5). A Proxy may claim any length: 2^32-1 took ~24 s to walk, and
 * a string or an object with valueOf was coerced by `i < n`. The length is
 * read once, and accepted only as a safe integer in 0..MAX_LIST_LENGTH.
 * NAMED LIMIT: a real observation with more than MAX_LIST_LENGTH elements
 * (e.g. a working tree with over a million untracked files) is refused.
 */
const MAX_LIST_LENGTH = 1_000_000;
function listLength(v) {
  const n = v.length;
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_LIST_LENGTH) {
    throw new RangeError(`list length ${describe(n)} is not an integer in 0..${MAX_LIST_LENGTH}`);
  }
  return n;
}

/*
 * ONLY WHAT IS READ IS COPIED, AND EACH COPY HAS A WORK BUDGET (T-176 B).
 * The copy used to walk EVERY own key, including keys nothing reads, so 1e6
 * aliases of one 1e5-element list under an ignored key took 45 s, and the
 * same aliases in a READ list were 1e11 element copies. Now each observation
 * is copied by a SCHEMA (the SCHEMAS near compileEnvelope):
 *  - a record copies only the keys the compiler reads;
 *  - a list copies its elements with the element schema;
 *  - a value whose shape is wrong for its slot is NOT walked. It is kept only
 *    as its shape (an empty array, an empty null-prototype record, or a marker
 *    function), so every "wrong shape" rule still sees it and names it.
 * Every value copied costs one unit, every key read one unit, and every string
 * one more unit per 8 code units. When a copy exceeds SLOT_BUDGET it throws a RangeError, inside that
 * observation's snapshot, so only the owning field is refused (M25).
 * WHY PER OBSERVATION AND NOT ONE SHARED COUNTER: one shared counter would
 * let one observation's size refuse a DIFFERENT field. The compile-wide total
 * is still bounded by construction -- 6 record slots x SLOT_BUDGET, plus field
 * 3's 7 component groups x SLOT_BUDGET (BASELINE_GROUPS) -- and the
 * classification after the copy is O(n log n) in what was copied.
 * NAMED LIMITS, and WHAT SCALES WITH THE REPOSITORY (T-179 F1 (d)):
 *  - Field 3's CLEANLINESS group (status + index_flags) has its own budget.
 *    `index_flags` is `git ls-files -v`: ONE LINE PER TRACKED FILE, charged
 *    1 unit per 8 characters, so the budget is about 8e7 characters of index
 *    flags -- roughly 400k tracked files with 200-character paths, or 1.0-1.3M
 *    with ~60-character lines. `status` is one line per changed or untracked
 *    file, and a list over MAX_LIST_LENGTH (1e6) is refused. Past either
 *    bound CLEANLINESS alone is refused (UNTRUSTWORTHY); repo identity, HEAD
 *    and tree keep their own verdicts.
 *  - Any other observation over SLOT_BUDGET (about 1e6 status-sized strings,
 *    or ~600k task rows) is refused as a whole field, not read.
 */
const SLOT_BUDGET = 10_000_000;
const SCALAR = 0;
const listOf = (item) => Object.freeze({ list: item });
const recordOf = (keys) => Object.freeze({ keys: Object.freeze([...keys]), types: Object.freeze({}) });
const recordWith = (scalars, nested) => Object.freeze({ keys: Object.freeze([...scalars, ...Object.keys(nested)]), types: Object.freeze({ ...nested }) });
function markerFunction() {}
function spendFrom(budget) {
  let left = budget;
  return (units) => {
    left -= units;
    if (left < 0) throw new RangeError(`observation exceeds the work budget of ${budget} units`);
  };
}
function copyAs(v, schema, spend) {
  spend(1);
  if (typeof v === 'string') { spend(Math.ceil(v.length / 8)); return v; }
  if (typeof v === 'function') return markerFunction;
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    if (schema === SCALAR || schema.list === undefined) return [];
    const n = listLength(v);
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(copyAs(ownRead(v, i), schema.list, spend));
    return out;
  }
  const out = Object.create(null);
  if (schema === SCALAR || schema.keys === undefined) return out;
  for (const k of schema.keys) {
    spend(1); // every read is work, present or not
    const x = ownRead(v, k);
    if (x !== undefined) out[k] = copyAs(x, Object.hasOwn(schema.types, k) ? schema.types[k] : SCALAR, spend);
  }
  return out;
}
/*
 * ONLY A RECORD IS EVER READ (T-157). ownData leaves primitives as primitives
 * and copies arrays into ordinary Arrays, and reading `.kind` from either walks
 * Object.prototype exactly as reading it from an unprotected object did: an
 * anchor that was `[]` promoted field 2 once Object.prototype carried the
 * anchor's keys, and a `[]` roster row borrowed Object.prototype.sessionId.
 * So every RECORD SLOT -- the observations, each observation, the anchors
 * container, each anchor, `details` -- accepts only a non-null, non-array
 * object; any other shape there is ABSENT. Every ELEMENT of a list of records
 * (task rows, roster and runtime rows, patch entries, drift entries) that is
 * not a record is NAMED and demotes its field: it is never read, and never
 * dropped, since dropping it would let the field promote over it.
 */
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A record slot's schema copy, or undefined (ABSENT) when it holds any other shape. */
const record = (v, schema) => (isRecord(v) ? copyAs(v, schema, spendFrom(SLOT_BUDGET)) : undefined);
/** How many elements of a list are not records (holes arrive from the copy as undefined, so they count). */
const notRecords = (xs) => xs.filter((x) => !isRecord(x)).length;
/**
 * A value rendered for a reason. A primitive is String()ed; anything else is
 * named by its shape and never coerced: String() on a null-prototype record
 * throws, and that throw is what hid R5's named reason behind the catch-all.
 */
const text = (v) => (typeof v === 'string' ? clip(v) : v === null || (typeof v !== 'object' && typeof v !== 'function') ? String(v)
  : typeof v === 'function' ? '(function)' : `(${Array.isArray(v) ? 'array' : 'object'})`);
/*
 * DESCRIBING A VALUE MUST NOT BE ABLE TO THROW (T-173 NEW-F1). The guard's
 * reason was `${e?.message ?? e}`. For a thrown revoked Proxy, Symbol,
 * null-prototype object, throwing `message` getter or `message` whose
 * toPrimitive throws, building that reason threw in turn, and the whole of
 * compileEnvelope threw instead of one field being refused. So a value named in
 * a message is described by typeof alone: a string is quoted, another
 * primitive is String()ed (String() cannot throw on a primitive), and
 * anything else is named by its type and never touched.
 */
const KIND = Object.freeze({ object: 'an object', function: 'a function', symbol: 'a symbol' });
const describe = (v) => (typeof v === 'string' ? JSON.stringify(clip(v))
  : v === null || (typeof v !== 'object' && typeof v !== 'function' && typeof v !== 'symbol') ? String(v)
    : `(${KIND[typeof v]})`);
const UNDESCRIBED = 'a thrown value that could not be described';
/**
 * A thrown value's message: its OWN DATA `message` when that is a string, else
 * a fixed description. No getter is called, nothing is coerced, and the one
 * operation that can still throw -- reading a descriptor from a revoked Proxy
 * -- falls back to a fixed string.
 */
function describeThrown(e) {
  if (typeof e === 'string') return clip(e);
  if (e === null || (typeof e !== 'object' && typeof e !== 'function')) return describe(e);
  try {
    const d = Object.getOwnPropertyDescriptor(e, 'message');
    if (d !== undefined && Object.hasOwn(d, 'value') && typeof d.value === 'string') return clip(d.value);
    return `a thrown ${typeof e === 'function' ? 'function' : 'object'} with no text message`;
  } catch {
    return UNDESCRIBED;
  }
}
/*
 * A VALUE READ AS TEXT MUST BE TEXT (T-157, observer O-2..O-4). Date.parse and
 * RegExp#test coerce their argument: `["<iso>"]` parsed as the timestamp and
 * `["<40 hex>"]` passed as a HEAD, and a null-prototype object threw into the
 * catch-all. So a timestamp or digest is read only from a string, and a key a
 * field reads or publishes as text that is PRESENT with another shape demotes
 * the field by name. null and a missing key stay "not reported", as before.
 */
/*
 * A JUDGED TIMESTAMP CARRIES ITS ZONE, OR IT IS NOT A TIMESTAMP (T-176 C).
 * Date.parse reads a zone-less ISO string -- and free forms like "2099" or
 * "Sep 30 2026" -- as LOCAL time, so the same input gave different verdicts
 * under different TZ values: the compiler was not pure. when() therefore
 * never calls Date.parse. It accepts exactly
 *   YYYY-MM-DDTHH:MM:SS[.1-9 digits](Z|+HH:MM|-HH:MM)
 * (PostgREST's "+00:00" with microseconds, and toISOString's "Z"), checks
 * every component (no 2026-02-30, no hour 24, no leap second), and computes
 * the instant with Date.UTC: no local time anywhere. Fractions beyond
 * milliseconds are truncated. Every value accepted here is also parsed
 * IDENTICALLY by V8's Date.parse (51 forms measured), which is why
 * liveRegistry -- which calls Date.parse on heartbeats and `now` -- may be
 * handed a value only after when() accepted it (channelLiveness does so).
 */
const ZONED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;
function when(v) {
  if (typeof v !== 'string') return NaN;
  const m = ZONED.exec(v);
  if (m === null) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return NaN;
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 to 1900-1999, which
  // made when() refuse 0050 while isIsoUtc (Date.parse) accepted it (T-179 F5).
  const back = new Date(0);
  back.setUTCFullYear(y, mo - 1, d);
  back.setUTCHours(h, mi, s, ms);
  const t = back.getTime();
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
  if (m[8] === 'Z') return t;
  const oh = Number(m[10]);
  const om = Number(m[11]);
  if (oh > 23 || om > 59) return NaN;
  return t - (m[9] === '+' ? 1 : -1) * (oh * 60 + om) * 60_000;
}
const hexOf = (re, v) => typeof v === 'string' && re.test(v);
/** `<where>.<key>` for each key of record `r` present with a shape other than a string. */
const notText = (r, keys, where) => keys
  .filter((k) => r[k] !== undefined && r[k] !== null && typeof r[k] !== 'string')
  .map((k) => `${where}.${k}`);
/*
 * ONE HEADER RULE FOR EVERY COMPUTED FIELD (T-176 F). Fields 2 and 6 demoted
 * on a missing or malformed observed_at, while fields 3 and 4 stayed TRUSTED
 * and published null. §2 makes source_identity and observed_at attributes of
 * EVERY field, so a TRUSTED field that cannot say which query established it,
 * or when, is not established. Fields 2, 3, 4 and 6 now apply the same rule.
 */
function headerProblems(obs) {
  const problems = [];
  if (Number.isNaN(when(obs.observed_at))) problems.push('observation carries no usable observed_at');
  if (str(obs.source_identity) === null) problems.push('observation carries no source_identity');
  else if (obs.source_identity.length > MAX_IDENTITY) problems.push(`observation source_identity is longer than ${MAX_IDENTITY} characters`);
  return problems;
}
/** One own property of a top-level container, never an inherited one, read once (ownRead). */
const ownProp = (o, k) => (o !== null && typeof o === 'object' ? ownRead(o, k) : undefined);

/** A non-empty string, never a coerced one: 0, null, undefined and objects are not ids. */
const isId = (x) => typeof x === 'string' && !blank(x);

/**
 * Why an anchor cannot promote, or null when it is usable. Coverage is checked
 * by the caller, against the rows the anchor vouches for.
 *
 * A non-empty list of non-empty STRING ids is required: an anchor naming
 * nothing is evidence of nothing, and an entry is never String()-coerced (an
 * anchor naming "undefined" must not cover a row whose task_id is missing).
 *
 * NAMED LIMITS.
 *  1. INDEPENDENCE IS DECLARED, NEVER ESTABLISHED. The kind allowlist says what
 *     sort of record an anchor claims to be; nothing here verifies the claim.
 *     Whatever CONSTRUCTS an anchor owns its real independence.
 *  2. THE LABEL DENYLIST IS NOT A BOUND. Spellings it does not know
 *     ("tasks", "task store", "agentbridge.tasks", ".../rest/v1/tasks", the
 *     8.3 name "REGIST~1.JSO") pass it. The allowlist is the control; the
 *     denylist only refuses the self-anchoring it happens to recognise.
 *  3. FALSE REFUSALS, BY DESIGN (fail-closed). An anchor whose last path
 *     segment equals a judged identity's last segment -- any URL ending
 *     ".../mcp" while the task store is read from ".../mcp" -- is refused; so
 *     is any label CONTAINING a judged identity part of 8+ characters (any
 *     label that mentions the bridge's own endpoint URL, e.g. another tool on
 *     the same server), any label that is not plain printable ASCII,
 *     accented letters included, and any label longer than MAX_LABEL (256).
 *  4. AN ANCHOR'S AGE IS NOT CHECKED: its observed_at is never read, so a
 *     month-old anchor promotes if it still matches the store exactly. This
 *     is acceptable for Run 2 ONLY because no anchor source is wired (the
 *     driver mints none). It MUST BE CLOSED BEFORE ANY ANCHOR SOURCE IS WIRED:
 *     AMENDMENT 2 asks for evidence that the work is "known to be current",
 *     and an anchor of unknown age is not that evidence. Recorded on the road
 *     map as a precondition (T-173); pinned by a test that goes red when it
 *     is closed.
 */
function anchorProblem(anchor, listKey, judgedIdentities) {
  if (anchor === undefined || anchor === null) return 'no completeness anchor';
  if (anchor.ok !== true) return `no completeness anchor (${str(anchor.detail) ?? 'anchor was not observed'})`;
  // EXACT membership of an OWN STRING. No trim, no case fold, no Unicode
  // normalisation, and never inherited: `anchor` is an ownData copy, so a kind
  // it carries is one the observation carried (T-155). The string requirement
  // is includes() itself: ANCHOR_KINDS is frozen and all-string and includes()
  // compares by SameValueZero, so a boxed String, an array or an object with a
  // toString never matches. A separate typeof test would be a check no mutation
  // could observe (rule 11), so there is none.
  if (!ANCHOR_KINDS.includes(anchor.kind)) return 'completeness anchor kind not recognised';
  const src = str(anchor.source);
  const sid = str(anchor.source_identity);
  if (!src || !sid) return 'completeness anchor names no source';
  // Each slot is judged on its own, and the reason quotes the slot that fired.
  // Both labels are bounded BEFORE any processing (T-179 F2): see namesAJudgedSource.
  for (const [slot, value] of [['source', src], ['source_identity', sid]]) {
    if (value.length > MAX_LABEL) {
      return `completeness anchor label is longer than ${MAX_LABEL} characters (${slot} ${JSON.stringify(clip(value))})`;
    }
  }
  for (const [slot, value] of [['source', src], ['source_identity', sid]]) {
    if (NOT_PRINTABLE_ASCII.test(clean(value))) {
      return `completeness anchor label is not plain printable ASCII (${slot} ${JSON.stringify(clip(value))})`;
    }
    if (judgedIdentities.some((id) => typeof id === 'string' && id.length > MAX_IDENTITY)) {
      return `a judged source identity is longer than ${MAX_IDENTITY} characters, so the anchor cannot be shown independent of it`;
    }
    if (namesAJudgedSource(value, judgedIdentities)) {
      return `completeness anchor is not independent of the source it judges (${slot} ${JSON.stringify(clip(value))})`;
    }
  }
  const ids = anchor[listKey];
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isId)) {
    return `completeness anchor lists no ${listKey}`;
  }
  // An id listed twice makes the anchor's coverage depend on counting, not on
  // membership: it is not a well-formed completeness record (T-179 F5).
  if (new Set(ids).size !== ids.length) return `completeness anchor lists a duplicate ${listKey} id`;
  return null;
}

/* ── 2 · assignment_candidate ──────────────────────────────────────────── */

/** The row keys field 2 reads or publishes as text: `state` decides openness, the rest are open_work. */
/** A task row's commit sha: 40 hex, either case. */
const TASK_SHA = /^[0-9a-f]{40}$/i;

const TASK_TEXT_KEYS = Object.freeze(['state', 'updated_at', 'lease_expires_at', 'assigned_agent', 'assigned_session', 'base_sha', 'returned_head_sha']);

function assignmentCandidate(obs, anchor, judged) {
  const base = {
    source: 'task-store',
    source_identity: str(obs?.source_identity),
    observed_at: str(obs?.observed_at),
  };
  // The anchor decides promotion; everything below can only add demotions.
  const anchorIssue = anchorProblem(anchor, 'current', judged);
  const fail = (reasons, value = null) => field('assignment_candidate', {
    ...base, value, trust_state: TRUST.UNTRUSTWORTHY, reason: [anchorIssue, ...reasons].filter(Boolean).join('; '),
  });
  if (!obs || obs.ok !== true) return fail([`task store could not be read: ${str(obs?.detail) ?? 'no observation'}`]);
  if (!Array.isArray(obs.rows)) return fail(['task store answer was not a list of rows']);
  const malformed = notRecords(obs.rows);
  if (malformed) return fail([`task store answer holds ${malformed} row(s) that are not a record`]);
  // Every key read or published as text. task_id is not listed: a non-string
  // id has its own named rule ("open row without an id") below.
  const misshapen = [
    ...notText(obs, ['source_identity'], 'observation'),
    ...obs.rows.flatMap((r) => notText(r, TASK_TEXT_KEYS, `row ${isId(r.task_id) ? r.task_id : '(no task_id)'}`)),
  ];
  if (misshapen.length) return fail([`value(s) that are not text: ${listed(misshapen.sort())}`]);
  /*
   * A STATE OUTSIDE THE VOCABULARY IS NOT "CLOSED" (T-161 (a)). Openness was
   * decided by an allowlist of OPEN states alone, so "in_progress", "Runnable"
   * or a missing state read as closed work and field 2 promoted over it --
   * failing open on vocabulary, with no CHECK on tasks.state to stop such a
   * row. Every row must now carry a state from one list or the other.
   */
  const unknownState = obs.rows
    .filter((r) => !OPEN_TASK_STATES.includes(r.state) && !CLOSED_TASK_STATES.includes(r.state))
    .map((r) => `${isId(r.task_id) ? r.task_id : '(no task_id)'} ${text(r.state)}`);
  if (unknownState.length) return fail([`row(s) whose state is not in the task vocabulary: ${listed(unknownState.sort())}`]);
  /*
   * WHAT A TRUSTED FIELD 2 PUBLISHES MUST BE WELL FORMED, NOT MERELY TEXT
   * (T-173 NEW-F3, NEW-F4). Open rows are the ones published as open_work.
   *  - base_sha / returned_head_sha: 40 hex, either case (the bridge's own
   *    head-sha check is /i).
   *  - assigned_agent / assigned_session: non-blank when present.
   *  - lease_expires_at: a parseable timestamp when present, and REQUIRED on
   *    an assigned row. A real claim always writes it, so an assigned row
   *    without one is not a claim; without it the expired-lease demotion
   *    below could never fire.
   * null and a missing key stay "not reported", except the assigned lease.
   */
  const rowLabel = (r) => (isId(r.task_id) ? r.task_id : '(no task_id)');
  const openRows = obs.rows.filter((r) => OPEN_TASK_STATES.includes(r.state));
  const malformedValues = openRows.flatMap((r) => [
    ...['base_sha', 'returned_head_sha'].filter((k) => r[k] != null && !TASK_SHA.test(r[k])),
    ...['assigned_agent', 'assigned_session'].filter((k) => r[k] != null && !isId(r[k])),
    ...(r.state !== 'assigned' && r.lease_expires_at != null && Number.isNaN(when(r.lease_expires_at)) ? ['lease_expires_at'] : []),
  ].map((k) => `${rowLabel(r)}.${k}`));
  if (malformedValues.length) return fail([`open row(s) with malformed value(s): ${listed(malformedValues.sort())}`]);
  const leaseless = openRows.filter((r) => r.state === 'assigned' && Number.isNaN(when(r.lease_expires_at))).map(rowLabel);
  if (leaseless.length) return fail([`assigned row(s) with no usable lease_expires_at: ${listed(leaseless.sort())}`]);
  const header = headerProblems(obs);
  if (header.length) return fail(header);
  const now = when(obs.observed_at);

  const open = obs.rows.filter((r) => OPEN_TASK_STATES.includes(r.state));
  const stale = [];
  const undated = [];
  const future = [];
  const expiredLease = [];
  for (const r of open) {
    // Type-checked BEFORE any String() (T-157): an object id is counted below
    // as "open row without an id", not thrown on here.
    const id = isId(r.task_id) ? r.task_id : '(no task_id)';
    const at = when(r.updated_at);
    if (Number.isNaN(at)) undated.push(id);
    else if (now - at > TASK_FRESH_MS) stale.push(id);
    else if (at - now > CLOCK_SKEW_MS) future.push(id);
    if (r.state === 'assigned' && r.lease_expires_at) {
      const exp = when(r.lease_expires_at);
      if (!Number.isNaN(exp) && exp < now) expiredLease.push(id);
    }
  }

  const problems = [];
  if (stale.length) problems.push(`${stale.length} open row(s) not updated within ${TASK_FRESH_MS / 3600000}h: ${listed(stale.sort())}`);
  if (undated.length) problems.push(`${undated.length} open row(s) with no usable updated_at: ${listed(undated.sort())}`);
  if (future.length) problems.push(`${future.length} open row(s) dated in the future: ${listed(future.sort())}`);
  if (expiredLease.length) problems.push(`${expiredLease.length} assigned row(s) with an expired lease: ${listed(expiredLease.sort())}`);
  /*
   * IDS ARE NON-EMPTY STRINGS OR THE ROW CANNOT BE ACCOUNTED FOR (T-131).
   * An open row without one could be neither named nor covered by an anchor --
   * and under String() coercion an anchor naming "undefined" covered it. A
   * DUPLICATED task_id makes "which row is current" depend on row order, so it
   * demotes rather than letting the last row win.
   */
  const idless = open.filter((r) => !isId(r?.task_id)).length;
  if (idless) problems.push(`open row without an id: ${idless} row(s)`);
  // A CLOSED row is not exempt (T-176 F): a Symbol, number, object or blank id
  // cannot be counted for duplicates or named, so it demotes the same way.
  const closedIdless = obs.rows.filter((r) => CLOSED_TASK_STATES.includes(r.state) && !isId(r.task_id)).length;
  if (closedIdless) problems.push(`closed row without an id: ${closedIdless} row(s)`);
  const counts = new Map();
  for (const r of obs.rows) if (isId(r?.task_id)) counts.set(r.task_id, (counts.get(r.task_id) ?? 0) + 1);
  const dupes = [...counts].filter(([, n]) => n > 1).map(([id]) => id).sort();
  if (dupes.length) problems.push(`duplicate id: ${listed(dupes)}`);
  /*
   * STALE ROWS DEMOTE EVEN WITH AN ANCHOR. The anchor proves the store holds
   * work known to be current; it says nothing about the residue beside it, and
   * section 3 forbids printing stale runnable tasks as current assignment.
   * Filtering them out instead would be the compiler choosing a likely
   * assignment, which section 5 forbids.
   */
  const reasons = problems.length ? [`source contains stale or inconsistent open work; ${problems.join('; ')}`] : [];
  if (!anchorIssue) {
    // String ids only: never String()-coerce a missing id into "undefined".
    const openIds = new Set(open.filter((r) => isId(r?.task_id)).map((r) => r.task_id));
    const uncovered = anchor.current.filter((id) => !openIds.has(id)).sort();
    if (uncovered.length) reasons.push(`completeness anchor names current work absent from the store's open rows: ${listed(uncovered)}`);
    /*
     * AN OPEN ROW THE ANCHOR DOES NOT NAME DEMOTES, however fresh (Controller
     * ruling 2, T-129). A fresh, superseded row -- t-fixer-stopgate-recovery
     * touched an hour ago -- is exactly the residue §3 forbids printing as
     * current assignment. It DEMOTES rather than being filtered out: dropping
     * rows the anchor did not name would be §5's "choose a likely assignment".
     * Live consequence, intended: field 2 cannot promote while the store holds
     * residue.
     */
    const anchored = new Set(anchor.current);
    const unnamed = [...openIds].filter((id) => !anchored.has(id)).sort();
    if (unnamed.length) reasons.push(`open row(s) the completeness anchor does not name: ${listed(unnamed)}`);
  }

  const open_work = open.map((r) => ({
    task_id: r.task_id ?? null,
    state: r.state,
    assigned_agent: r.assigned_agent ?? null,
    assigned_session: r.assigned_session ?? null,
    base_sha: r.base_sha ?? null,
    returned_head_sha: r.returned_head_sha ?? null,
    lease_expires_at: r.lease_expires_at ?? null,
    updated_at: r.updated_at,
  })).sort(byKey('task_id'));
  /*
   * THE CANDIDATE VALUE IS HANDED TO field() EITHER WAY, and field()'s null
   * rule is what withholds it when the field is not TRUSTED. That makes the
   * null rule load-bearing on a real path (rule 11): it was redundant while
   * every untrusted caller happened to pass no value, so dropping it changed
   * nothing a test could see.
   */
  if (anchorIssue || reasons.length) return fail(reasons, { open_work });
  return field('assignment_candidate', { ...base, trust_state: TRUST.TRUSTED, value: { open_work } });
}

/* ── 3 · baseline ──────────────────────────────────────────────────────── */

/*
 * PER-COMPONENT TRUST (spec AMENDMENT 1). §3 names five facts -- repo identity,
 * HEAD, tree identity, working-tree cleanliness, known drift -- and blending
 * them let an untracked cache discard a HEAD git answers exactly. Each is now
 * its own component with its own trust_state, and the null rule applies PER
 * COMPONENT: a dirty tree nulls nothing in identity.
 *
 * THE FIELD IS TRUSTED ONLY WHEN EVERY COMPONENT IS (§7.1, Controller note).
 * Splitting them changes what survives a dirty tree, never whether a dirty tree
 * can be TRUSTED.
 *
 * NOT A RELAXATION. Untracked files still make cleanliness untrusted, and the
 * compiler's "clean" is deliberately NOT aligned with baselineBlockingDriftFromGit
 * (which ignores untracked and non-protected paths): the two are reported side
 * by side as separate components, and which is right is an open owner question.
 */
export const BASELINE_COMPONENTS = Object.freeze(['repo_identity', 'head', 'tree', 'cleanliness', 'drift']);

function component(source, trusted, value, reason) {
  return trusted
    ? { value, trust_state: TRUST.TRUSTED, source, reason: null }
    : { value: null, trust_state: TRUST.UNTRUSTWORTHY, source, reason };
}

/*
 * FIELD 3 IS SNAPSHOTTED PER COMPONENT (T-179 F1). The baseline observation
 * used to be copied under ONE guard and ONE work budget, and `index_flags` --
 * the whole of `git ls-files -v`, one line per TRACKED file -- was charged to
 * it: a large sparse index (9000 entries with 12k-character paths, through the
 * real driver) exhausted the budget and the guard nulled the WHOLE field, HEAD,
 * tree and identity included, although git had answered each exactly. That is
 * cleanliness dragging identity down, which AMENDMENT 1 forbids.
 * Now each group below is read and copied under its OWN try and its OWN
 * budget, and a failure refuses only what that group feeds:
 *   header      -> the whole field (every component is judged against `ok`)
 *   repo_id / head / tree / cleanliness / drift -> that component only
 *   details     -> the FIELD is refused (its reasons cannot be told), while
 *                  every component keeps its own verdict and value.
 * RULE 8 SWEEP: field 3 is the only field that reports per component; fields
 * 2, 4 and 6 give one verdict, so their whole-field guard is the right scope.
 */
const BASELINE_GROUPS = Object.freeze([
  ['header', ['ok', 'observed_at', 'source_identity', 'detail']],
  ['repo_identity', ['repo_id']],
  ['head', ['head']],
  ['tree', ['tree']],
  ['cleanliness', ['status', 'index_flags']],
  ['drift', ['drift']],
  ['details', ['details']],
]);
/**
 * A record slot copied group by group: {record, failed}, where `failed` maps a
 * key whose read or copy threw (or overran its group's budget) to the error.
 * Each key is still read exactly once.
 */
function recordByGroups(v, schema, groups) {
  if (!isRecord(v)) return undefined;
  const record = Object.create(null);
  const failed = Object.create(null);
  for (const [, keys] of groups) {
    const spend = spendFrom(SLOT_BUDGET);
    for (const k of keys) {
      try {
        spend(1);
        const x = ownRead(v, k);
        if (x !== undefined) record[k] = copyAs(x, Object.hasOwn(schema.types, k) ? schema.types[k] : SCALAR, spend);
      } catch (e) {
        failed[k] = e;
      }
    }
  }
  return { record, failed };
}

function baseline(snapshot) {
  const obs = snapshot?.record;
  const failed = snapshot?.failed ?? Object.create(null);
  const failedIn = (keys) => keys.find((k) => Object.hasOwn(failed, k));
  const header = BASELINE_GROUPS[0][1].find((k) => Object.hasOwn(failed, k));
  if (header !== undefined) throw failed[header]; // the whole field: every component hangs on `ok`
  const base = {
    source: 'git + baselineBlockingDriftFromGit',
    source_identity: str(obs?.source_identity),
    observed_at: str(obs?.observed_at),
  };
  const ok = !!obs && obs.ok === true;
  const failedReason = `git could not answer: ${str(obs?.detail) ?? 'no observation'}`;
  // `details` is a record slot: any other shape is absent, never indexed (T-157).
  const details = isRecord(obs?.details) ? obs.details : undefined;
  const why = (k, fallback) => (!ok ? failedReason : str(details?.[k]) ?? fallback);
  /** A component whose own inputs could not be read is refused, and only it. */
  const unreadable = (keys) => {
    const k = failedIn(keys);
    return k === undefined ? null : `observation could not be classified: ${describeThrown(failed[k])}`;
  };

  const components = {};
  /*
   * ONE MECHANISM WITHHOLDS AN UNTRUSTED VALUE: component()'s null rule. The
   * value is passed as observed; `ok` gates only the trust decision. A second
   * `ok ? value : null` gate here was redundant with the null rule, so a
   * mutation removing it changed nothing (T-122 M22) -- it is gone rather than
   * kept as a protection nobody can watch fail.
   */
  const idRefusal = unreadable(['repo_id']);
  components.repo_identity = idRefusal !== null
    ? component('git rev-parse --show-toplevel', false, null, idRefusal)
    : component('git rev-parse --show-toplevel',
      ok && !!str(obs.repo_id), str(obs?.repo_id), why('repo_id', 'repository identity was not established'));
  const headRefusal = unreadable(['head']);
  components.head = headRefusal !== null
    ? component('git rev-parse HEAD^{commit}', false, null, headRefusal)
    : component('git rev-parse HEAD^{commit}',
      ok && hexOf(HEX40, obs.head), obs?.head ?? null, why('head', 'HEAD did not resolve to a commit'));
  const treeRefusal = unreadable(['tree']);
  components.tree = treeRefusal !== null
    ? component('git rev-parse HEAD^{tree}', false, null, treeRefusal)
    : component('git rev-parse HEAD^{tree}',
      ok && hexOf(HEX40, obs.tree), obs?.tree ?? null, why('tree', 'HEAD^{tree} did not resolve to a tree'));

  /*
   * CLEANLINESS: porcelain status (untracked INCLUDED) and index flags.
   * `git ls-files -v` lowercases a tag for assume-unchanged and prints S/s for
   * skip-worktree; either lets a file differ on disk while status is silent.
   * Every problem is listed, not the first.
   */
  const cleanRefusal = unreadable(['status', 'index_flags']);
  if (cleanRefusal !== null) {
    components.cleanliness = component('git status --porcelain --untracked-files=all + git ls-files -v', false, null, cleanRefusal);
  } else if (!ok || !Array.isArray(obs.status) || typeof obs.index_flags !== 'string') {
    components.cleanliness = component('git status --porcelain --untracked-files=all + git ls-files -v', false, null,
      !ok ? failedReason : !Array.isArray(obs.status)
        ? (str(details?.status) ?? 'working-tree status could not be read')
        : (str(details?.index_flags) ?? 'index flags could not be read'));
  } else {
    const problems = [];
    // A status entry that is not a string is a dirty-tree signal of the wrong
    // shape: it demotes, it is never filtered away as blank (T-157, O-2).
    const misshapen = obs.status.filter((l) => typeof l !== 'string').length;
    if (misshapen) problems.push(`${misshapen} status entr${misshapen === 1 ? 'y that is' : 'ies that are'} not text`);
    // SORTED before any reason string: git's line order must not reach the output.
    const dirty = obs.status.filter((l) => typeof l === 'string' && l.trim() !== '').map((l) => l.trim()).sort();
    if (dirty.length) {
      problems.push(`working tree is not clean: ${dirty.length} entr${dirty.length === 1 ? 'y' : 'ies'} (${listed(dirty)})`);
    }
    const hidden = [];
    for (const line of obs.index_flags.split('\n')) {
      if (line.length < 3) continue;
      const tag = line[0];
      const assumeUnchanged = tag >= 'a' && tag <= 'z';
      const skipWorktree = tag === 'S' || tag === 's';
      if (assumeUnchanged || skipWorktree) {
        hidden.push(`${line.slice(2).replace(/\r$/, '')} ${[assumeUnchanged && 'assume-unchanged', skipWorktree && 'skip-worktree'].filter(Boolean).join('+')}`);
      }
    }
    if (hidden.length) problems.push(`hidden from status: ${listed(hidden.sort())}`);
    components.cleanliness = component('git status --porcelain --untracked-files=all + git ls-files -v',
      problems.length === 0, { status: [], hidden: [] }, problems.join('; '));
  }

  // DRIFT: the shipped query's own verdict, reported as its own component.
  // null means "could not measure", which is unknown, never clean.
  const driftRefusal = unreadable(['drift']);
  if (driftRefusal !== null) {
    components.drift = component('baselineBlockingDriftFromGit', false, null, driftRefusal);
  } else if (!ok || !Array.isArray(obs.drift)) {
    components.drift = component('baselineBlockingDriftFromGit', false, null,
      !ok ? failedReason : (str(details?.drift) ?? 'baseline drift could not be measured'));
  } else {
    // An entry that is not a record is named, never read; a label that is not a
    // primitive is named by its shape, never String()ed (T-157).
    components.drift = component('baselineBlockingDriftFromGit', obs.drift.length === 0, [],
      `baseline drift: ${listed(obs.drift.map((d) => (isRecord(d)
        ? `${text(d.file)} ${text(d.now)} ${text(d.kind)}`
        : `an entry that is not a record: ${text(d)}`)).sort())}`);
  }

  const untrusted = BASELINE_COMPONENTS.filter((k) => components[k].trust_state !== TRUST.TRUSTED);
  // The header rule and an unreadable `details` apply to the FIELD; components
  // keep their own verdicts.
  const fieldProblems = ok ? headerProblems(obs) : [];
  if (Object.hasOwn(failed, 'details')) fieldProblems.push(`details could not be read: ${describeThrown(failed.details)}`);
  const trusted = untrusted.length === 0 && fieldProblems.length === 0;
  return field('baseline', {
    ...base,
    trust_state: trusted ? TRUST.TRUSTED : TRUST.UNTRUSTWORTHY,
    value: { components },
    keep_value: true,
    reason: [...fieldProblems, ...untrusted.map((k) => `${k}: ${components[k].reason}`)].join('; '),
  });
}

/* ── 4 · protected_frozen ──────────────────────────────────────────────── */

/**
 * The digest each MANIFEST.txt entry pins, keyed by the candidate's file name.
 *
 * An entry is a 64-hex digest (bare, or after `sha256 `) followed later in the
 * same entry by a `to <path>` line. Lines of the "NOT copied" section carry a
 * digest and a path on ONE line and no `to`, so they pin nothing here.
 */
function parseManifest(text) {
  const pins = new Map();
  /*
   * A NAME PINNED MORE THAN ONCE is reported, never resolved (T-173 NEW-F2).
   * Last-wins made the verdict depend on ORDER: the right pin last stayed
   * TRUSTED, and the same two pins swapped demoted. This is the manifest-side
   * twin of "a patch listed more than once". Pinning the same digest twice
   * demotes too: the manifest is then not a one-to-one record either.
   */
  const repeated = new Set();
  /*
   * AN ENTRY PINS ONLY WHEN IT IS EXACTLY ONE DIGEST, THEN EXACTLY ONE `to`
   * (T-176 D). The parser used to keep a running "pending" digest: two digests
   * before one `to` kept the LAST, and one digest before two `to` lines pinned
   * the FIRST, so the verdict depended on line order. Every many-to-one step
   * is now counted per ENTRY -- from an `OK` line to the next blank line, `OK`
   * line or the end -- and an entry with any other count or order pins nothing
   * and is reported. A `to` line outside any entry is reported too. Digest lines
   * outside entries (the "NOT copied" section) are ignored, as before.
   * Measured on the real MANIFEST.txt: 17 entries, each one digest then one
   * `to`, so nothing live changes.
   */
  const malformed = [];
  let entry = null;
  const close = () => {
    if (entry === null) return;
    const { head, digests, tos, digestFirst } = entry;
    if (digests.length === 1 && tos.length === 1 && digestFirst) {
      const name = tos[0];
      if (pins.has(name)) repeated.add(name);
      pins.set(name, digests[0]);
    } else if (digests.length > 0 || tos.length > 0) {
      malformed.push(`entry "${head}": ${digests.length} digest line(s) and ${tos.length} "to" line(s)${digests.length === 1 && tos.length === 1 ? ', "to" first' : ''}`);
    }
    entry = null;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^OK\s/.test(line)) { close(); entry = { head: clip(line), digests: [], tos: [], digestFirst: false }; continue; }
    if (line === '') { close(); continue; }
    const digest = line.match(/^(?:sha256\s+)?([0-9a-f]{64})(\s|$)/);
    if (digest) {
      if (entry !== null) { if (entry.tos.length === 0 && entry.digests.length === 0) entry.digestFirst = true; entry.digests.push(digest[1]); }
      continue;
    }
    const to = line.match(/^to\s+(.+)$/);
    if (to) {
      const name = to[1].trim().split(/[\\/]/).pop();
      if (entry === null) malformed.push(`a "to" line outside any entry: ${clip(name)}`);
      else entry.tos.push(name);
    }
  }
  close();
  return { pins, repeated, malformed };
}

/*
 * `bytes` is DISPLAY-ONLY: no trust decision reads it. So a malformed value is
 * published as null ("not reported", exactly as if absent), not demoted
 * (T-173 NEW-F4). A candidate patch is never empty, so 0 is malformed too.
 */
const isByteCount = (b) => Number.isSafeInteger(b) && b > 0;

function protectedFrozen(obs) {
  const base = {
    source: 'PROTECTED_PATHS + candidates/MANIFEST.txt',
    source_identity: str(obs?.source_identity),
    observed_at: str(obs?.observed_at),
  };
  const bad = (reason) => field('protected_frozen', { ...base, trust_state: TRUST.UNTRUSTWORTHY, reason });

  if (!obs || obs.ok !== true) return bad(`sources could not be read: ${str(obs?.detail) ?? 'no observation'}`);
  const header = headerProblems(obs);
  if (header.length) return bad(header.join('; '));
  const paths = obs.protected_paths;
  // A path that carries nothing (" ", "\t", U+200B) protects nothing (T-176 F).
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isId)) {
    return bad('PROTECTED_PATHS was not a non-empty list of paths');
  }
  // ONLY null means "the file does not exist" (the driver's contract). A
  // manifest of any other shape, or one not reported at all, was not read as
  // text -- that is UNTRUSTWORTHY, not ABSENT (T-179 F5).
  if (obs.manifest_text === null) {
    return field('protected_frozen', {
      ...base, trust_state: TRUST.ABSENT,
      reason: 'candidates/MANIFEST.txt is missing, so no candidate has a pinned identity',
    });
  }
  if (typeof obs.manifest_text !== 'string') return bad('candidates/MANIFEST.txt was not observed as text');
  if (!Array.isArray(obs.patches)) return bad('candidates/ could not be listed');

  const { pins, repeated, malformed } = parseManifest(obs.manifest_text);
  const problems = [...repeated].map((name) => `${name}: pinned more than once in the manifest`);
  problems.push(...malformed);
  /*
   * manifest_sha256 IS BOUND TO manifest_text (T-179 F5). The field publishes
   * the digest as the manifest's identity, so it must be the digest of the
   * text that was judged -- its UTF-8 bytes, as the driver reads and decodes
   * the file. A digest of other bytes demotes; a digest not reported is
   * published as null. Hashing is computation, not I/O: purity is unchanged.
   */
  const manifestDigest = createHash('sha256').update(Buffer.from(obs.manifest_text, 'utf8')).digest('hex');
  if (obs.manifest_sha256 !== undefined && obs.manifest_sha256 !== null && obs.manifest_sha256 !== manifestDigest) {
    problems.push('manifest_sha256 is not the digest of manifest_text');
  }
  const seen = new Set();
  for (const p of obs.patches) {
    // A patch entry is a record and its file a non-empty string, each checked
    // BEFORE it is read or String()ed (T-157).
    if (!isRecord(p)) { problems.push(`an entry that is not a record: ${text(p)}`); continue; }
    if (!isId(p.file)) { problems.push(`an entry with no file name: ${text(p.file)}`); continue; }
    const name = p.file;
    // A directory cannot list one name twice, so a duplicate is a malformed
    // observation: it demotes, as a duplicate id does in fields 2 and 6 (T-161 (c)).
    if (seen.has(name)) { problems.push(`${name}: listed more than once`); continue; }
    seen.add(name);
    const pinned = pins.get(name);
    if (!hexOf(HEX64, p.sha256)) { problems.push(`${name}: no digest measured`); continue; }
    if (!pinned) { problems.push(`${name}: not in the manifest`); continue; }
    if (pinned !== p.sha256) { problems.push(`${name}: digest ${p.sha256.slice(0, 12)} is not the pinned ${pinned.slice(0, 12)}`); continue; }
    const prefix = name.match(/-([0-9a-f]{12})\.patch$/);
    if (prefix && !p.sha256.startsWith(prefix[1])) problems.push(`${name}: name prefix does not match its digest`);
  }
  for (const name of pins.keys()) {
    if (!seen.has(name)) problems.push(`${name}: pinned in the manifest but not present`);
  }
  if (problems.length) {
    return bad(`manifest and candidates/ disagree: ${listed(problems.sort())}`);
  }

  return field('protected_frozen', {
    ...base,
    trust_state: TRUST.TRUSTED,
    value: {
      protected_paths: [...paths].sort(),
      manifest_sha256: obs.manifest_sha256 === manifestDigest ? manifestDigest : null,
      candidates: obs.patches
        .map((p) => ({ file: p.file, sha256: p.sha256, bytes: isByteCount(p.bytes) ? p.bytes : null }))
        .sort(byKey('file')),
      rule: 'do not rebase, regenerate, recut or silently replace; refer to a candidate by sha256',
    },
  });
}

/* ── 6 · channel_liveness ──────────────────────────────────────────────── */

const sessionOf = (r) => str(r?.session_id) ?? str(r?.sessionId);

/*
 * The row keys field 6 reads as text, here or inside liveRegistry
 * (heartbeatAgeMs reads heartbeat_at, lastSeenAt, last_seen_at; presenceOf
 * reads capacity). NAMED LIMIT: this mirrors liveRegistry's reads by name, so
 * an alias added THERE is not shape-checked here until it is added here; such
 * a value is still refused, by the catch-all, if it throws.
 */
const ROW_TEXT_KEYS = Object.freeze(['session_id', 'sessionId', 'agent_id', 'agentId', 'capacity', 'heartbeat_at', 'lastSeenAt', 'last_seen_at']);
/** The heartbeat keys liveRegistry.heartbeatAgeMs reads, in its order. */
const HEARTBEAT_KEYS = Object.freeze(['heartbeat_at', 'lastSeenAt', 'last_seen_at']);

function channelLiveness(roster, runtime, anchor, judged) {
  const base = {
    source: 'roster (list_agents) checked against local runtime registrations',
    source_identity: [str(roster?.source_identity), str(runtime?.source_identity)].filter(Boolean).join(' + ') || null,
    observed_at: str(roster?.observed_at),
  };
  /*
   * The registrations.json cross-check is RETAINED and may still demote, but it
   * is not an anchor: two registries agreeing cannot see a seat that registered
   * with neither. Only an independent liveness anchor promotes.
   */
  const anchorIssue = anchorProblem(anchor, 'live_sessions', judged);
  const bad = (reason) => field('channel_liveness', {
    ...base, trust_state: TRUST.UNTRUSTWORTHY, reason: [anchorIssue, reason].filter(Boolean).join('; '),
  });

  if (!roster || roster.ok !== true) return bad(`roster could not be read: ${str(roster?.detail) ?? 'no observation'}`);
  if (!Array.isArray(roster.rows)) return bad('roster answer was not a list of rows');
  if (!runtime || runtime.ok !== true || !Array.isArray(runtime.rows)) {
    return bad(`no runtime observation to check the roster against: ${str(runtime?.detail) ?? 'no observation'}`);
  }
  // A row that is not a record is named and demotes (T-157): reading a session
  // id from `[]` or "x" walks Object.prototype, and dropping it would promote.
  const malformed = [['roster', roster.rows], ['runtime', runtime.rows]]
    .filter(([, rows]) => notRecords(rows) > 0)
    .map(([where, rows]) => `${where} ${notRecords(rows)}`);
  if (malformed.length) return bad(`row(s) that are not a record: ${malformed.join(', ')}`);
  // Every key this field or liveRegistry reads as text, and the identities the
  // anchor denylist compares against (T-157, O-3/O-4): `["<iso>"]` must not
  // parse as a heartbeat, nor `["offline"]` read as present.
  const rowLabel = (where, r) => `${where} ${sessionOf(r) ?? '(no session id)'}`;
  const misshapen = [
    ...notText(roster, ['source_identity'], 'roster'),
    ...notText(runtime, ['source_identity'], 'runtime'),
    ...roster.rows.flatMap((r) => notText(r, ROW_TEXT_KEYS, rowLabel('roster', r))),
    ...runtime.rows.flatMap((r) => notText(r, ROW_TEXT_KEYS, rowLabel('runtime', r))),
  ];
  if (misshapen.length) return bad(`value(s) that are not text: ${listed(misshapen.sort())}`);
  const header = [
    ...headerProblems(roster).map((p) => `roster ${p}`),
    ...headerProblems(runtime).map((p) => `runtime ${p}`),
  ];
  if (header.length) return bad(header.join('; '));
  const rNow = roster.observed_at;
  const oNow = runtime.observed_at;
  /*
   * HEARTBEATS ARE JUDGED TIMESTAMPS (T-176 C). liveRegistry parses them, and
   * `now`, with Date.parse, which reads a zone-less value as LOCAL time. Every
   * heartbeat key it reads must therefore pass when() -- a zoned form that
   * Date.parse reads identically in every zone -- before any row is handed
   * over. liveRegistry itself is unchanged; see the note at when().
   */
  const unzoned = [['roster', roster.rows], ['runtime', runtime.rows]].flatMap(([where, rows]) => rows.flatMap((r) => HEARTBEAT_KEYS
    .filter((k) => r[k] != null && Number.isNaN(when(r[k])))
    .map((k) => `${rowLabel(where, r)}.${k}`)));
  if (unzoned.length) return bad(`heartbeat(s) without a zoned timestamp: ${listed(unzoned.sort())}`);
  /*
   * CAPACITY IS A CLOSED VOCABULARY (T-179 F3), as task state is (T-161 (a)).
   * presenceOf reads only `=== 'offline'`, so "OFFLINE", "offline ", a
   * zero-width-prefixed "offline", "retired" or "" all read as PRESENT and
   * published can_accept_work:true. A capacity that is reported must be exactly
   * one of liveRegistry's CAPACITIES; a missing one stays "not reported" (null).
   */
  const offVocabulary = [['roster', roster.rows], ['runtime', runtime.rows]].flatMap(([where, rows]) => rows
    .filter((r) => r.capacity != null && !CAPACITIES.includes(r.capacity))
    .map((r) => `${rowLabel(where, r)} ${JSON.stringify(clip(r.capacity))}`));
  if (offVocabulary.length) return bad(`capacity not in the vocabulary (${CAPACITIES.join(', ')}): ${listed(offVocabulary.sort())}`);

  /*
   * A ROW WITH NO SESSION ID CANNOT BE COMPARED, SO IT CANNOT BE DROPPED.
   * Filtering it out would let a live-looking row vanish from the comparison
   * and the field promote over it.
   */
  const unkeyed = [
    ...roster.rows.filter((r) => !sessionOf(r)).map((r) => `roster ${str(r?.agent_id) ?? str(r?.agentId) ?? '(no agent id)'}`),
    ...runtime.rows.filter((r) => !sessionOf(r)).map((r) => `runtime ${str(r?.agent_id) ?? str(r?.agentId) ?? '(no agent id)'}`),
  ];
  if (unkeyed.length) {
    return bad(`row(s) with no session id cannot be checked: ${listed(unkeyed.sort())}`);
  }
  /*
   * A DUPLICATED session_id within one source demotes (T-131). The Map below
   * keeps the LAST row per session, so a duplicate made liveness depend on row
   * order -- a stale row after a live one hid it, and the reverse invented one.
   */
  const dupesIn = (rows) => {
    const counts = new Map();
    for (const r of rows) counts.set(sessionOf(r), (counts.get(sessionOf(r)) ?? 0) + 1);
    return [...counts].filter(([, n]) => n > 1).map(([s]) => s).sort();
  };
  const dupes = [...dupesIn(roster.rows).map((s) => `roster ${s}`), ...dupesIn(runtime.rows).map((s) => `runtime ${s}`)];
  if (dupes.length) return bad(`duplicate id: ${listed(dupes)}`);

  const liveIn = (rows, now) => new Map(rows
    .filter((r) => sessionOf(r) && livenessOf(r, { now, staleAfterMs: STALE_AFTER_MS }) === LIVENESS.LIVE)
    .map((r) => [sessionOf(r), r]));
  const rosterLive = liveIn(roster.rows, rNow);
  const observedLive = liveIn(runtime.rows, oNow);

  const reasons = [];
  // A LIVE roster row is published as topology, so it must name its agent
  // (T-179 F3), as an open task row must carry an id in field 2.
  const anonymous = [...rosterLive.values()].filter((r) => (str(r.agent_id) ?? str(r.agentId)) === null).map(sessionOf).sort();
  if (anonymous.length) reasons.push(`live roster row(s) without an agent id: ${listed(anonymous)}`);
  const missing = [...observedLive.keys()].filter((s) => !rosterLive.has(s)).sort();
  const ghosts = [...rosterLive.keys()].filter((s) => !observedLive.has(s)).sort();
  if (missing.length || ghosts.length) {
    const parts = [`roster ${roster.rows.length} row(s), ${rosterLive.size} live; runtime ${observedLive.size} live`];
    if (missing.length) parts.push(`observed live but absent from roster: ${listed(missing)}`);
    if (ghosts.length) parts.push(`live in roster but not observed: ${listed(ghosts)}`);
    reasons.push(`authoritative source contradicts directly observed runtime population; ${parts.join('; ')}`);
  }
  if (!anchorIssue) {
    // The anchor is the population. The roster must match it exactly: a seat the
    // anchor sees and the roster lacks is omission, and the converse is a ghost.
    const anchored = new Set(anchor.live_sessions);
    const unrostered = [...anchored].filter((s) => !rosterLive.has(s)).sort();
    const unanchored = [...rosterLive.keys()].filter((s) => !anchored.has(s)).sort();
    if (unrostered.length) reasons.push(`completeness anchor sees live seat(s) the roster lacks: ${listed(unrostered)}`);
    if (unanchored.length) reasons.push(`roster claims live seat(s) the completeness anchor does not see: ${listed(unanchored)}`);
  }
  if (anchorIssue || reasons.length) return bad(reasons.join('; '));

  const live_worker_topology = [...rosterLive.values()].map((r) => ({
    agent_id: str(r.agent_id) ?? str(r.agentId),
    session_id: sessionOf(r),
    capacity: str(r.capacity),
    // The heartbeat liveRegistry JUDGED, by its own `??` order (T-179 F3); every
    // present one passed when() above, so this is a zoned timestamp or null.
    heartbeat_at: r.heartbeat_at ?? r.lastSeenAt ?? r.last_seen_at ?? null,
    can_accept_work: isAvailable(r, { now: rNow, staleAfterMs: STALE_AFTER_MS }),
  })).sort(byKey('session_id'));
  return field('channel_liveness', { ...base, trust_state: TRUST.TRUSTED, value: { live_worker_topology } });
}

/* ── 7 · history_marker ────────────────────────────────────────────────── */

function historyMarker(generatedAt) {
  return field('history_marker', {
    value: HISTORY_MARKER,
    source: 'protocol constant',
    source_identity: 'src/run2Envelope.mjs HISTORY_MARKER',
    observed_at: generatedAt,
    trust_state: TRUST.TRUSTED,
  });
}

/* ── the envelope ──────────────────────────────────────────────────────── */

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
/**
 * ISO 8601 in UTC ("Z" only -- an offset, even +00:00, is refused), and a real
 * instant by the SAME calendar rule as every other judged timestamp: when()
 * (T-179 F5 -- the two used to disagree on years 0000-0099).
 */
function isIsoUtc(s) {
  return typeof s === 'string' && ISO_UTC.test(s) && !Number.isNaN(when(s));
}

/**
 * Classify observations into the seven fields.
 *
 * @param {object} observations
 *   generated_at  ISO string, supplied by the caller (this function has no clock)
 *   tasks         {ok, rows, observed_at, source_identity, detail}
 *   baseline      {ok, repo_id, head, tree, status: string[], index_flags: string (raw `git ls-files -v`),
 *                  drift: Array|null, observed_at, source_identity, detail}
 *   protected     {ok, protected_paths, manifest_text: string|null (null = the file does not exist),
 *                  manifest_sha256, patches: [{file, sha256, bytes}]|null, observed_at, source_identity, detail}
 *   roster        {ok, rows, observed_at, source_identity, detail}
 *   runtime       {ok, rows, observed_at, source_identity, detail}  -- a missing source is ok:false, never rows:[]
 *   anchors       COMPLETENESS ANCHORS (AMENDMENT 2), each of a kind in ANCHOR_KINDS:
 *                   assignment {ok, kind, source, source_identity, observed_at, current: task_id[]}
 *                   liveness   {ok, kind, source, source_identity, observed_at, live_sessions: session_id[]}
 *                 Absent -> fields 2 and 6 cannot promote.
 *   Any other key is ignored. In particular nothing here reads prose.
 *
 * THROWS when generated_at is not an ISO 8601 UTC timestamp (T-131). It is
 * the one input every field's observed_at and the envelope's identity hang
 * on; an envelope stamped "yesterday" or with an offset is not produced.
 */
/*
 * WHAT EACH OBSERVATION IS COPIED AS: exactly the keys the classifier (and
 * liveRegistry) read, and nothing else. A key missing here is a key nothing
 * reads; test/run2Envelope.test.mjs turns every fixture key into a counting
 * accessor and requires each to be read exactly once, so a read key missing
 * here fails that test.
 */
const HEADER_KEYS = ['ok', 'observed_at', 'source_identity', 'detail'];
const SCHEMAS = Object.freeze({
  tasks: recordWith(HEADER_KEYS, { rows: listOf(recordOf(['task_id', 'state', ...TASK_TEXT_KEYS.filter((k) => k !== 'state')])) }),
  baseline: recordWith([...HEADER_KEYS, 'repo_id', 'head', 'tree', 'index_flags'], {
    status: listOf(SCALAR),
    drift: listOf(recordOf(['file', 'now', 'kind'])),
    details: recordOf(['repo_id', 'head', 'tree', 'status', 'index_flags', 'drift']),
  }),
  protected: recordWith([...HEADER_KEYS, 'manifest_text', 'manifest_sha256'], {
    protected_paths: listOf(SCALAR),
    patches: listOf(recordOf(['file', 'sha256', 'bytes'])),
  }),
  agents: recordWith(HEADER_KEYS, { rows: listOf(recordOf(ROW_TEXT_KEYS)) }),
  anchor: recordWith(['ok', 'detail', 'kind', 'source', 'source_identity', 'observed_at'], {
    current: listOf(SCALAR),
    live_sessions: listOf(SCALAR),
  }),
});

export function compileEnvelope(observations = {}) {
  // Top level: OWN properties only, each READ ONCE, into a snapshot that every
  // later check and use shares (T-157 rework). The observations and the anchors
  // container are record slots too (T-157).
  /*
   * A snapshot slot holds the own-data copy, or the error the read threw. The
   * error is rethrown inside the owning field's guard, so a throwing getter
   * still costs only the field(s) that read that slot (M25).
   */
  const snap = (fn) => { try { return { ok: true, v: fn() }; } catch (e) { return { ok: false, e }; } };
  /*
   * THE ONLY THING compileEnvelope THROWS IS THE NAMED generated_at TypeError
   * (T-173 NEW-F1 sweep). A root that cannot even be tested for its shape (a
   * revoked Proxy) is no record, and an unreadable generated_at is no
   * timestamp; the message describes the value by typeof alone, where
   * JSON.stringify threw on a BigInt, a cycle, a revoked Proxy or a toJSON.
   */
  const root = snap(() => isRecord(observations));
  const o = root.ok && root.v ? observations : {};
  const gen = snap(() => ownProp(o, 'generated_at'));
  const generatedAt = gen.ok ? gen.v : undefined;
  if (!isIsoUtc(generatedAt)) {
    throw new TypeError(`generated_at must be an ISO 8601 UTC timestamp (YYYY-MM-DDTHH:MM:SS[.fff]Z), got ${gen.ok ? describe(generatedAt) : `an unreadable value (${describeThrown(gen.e)})`}`);
  }
  const take = (s) => { if (!s.ok) throw s.e; return s.v; };
  const tasks = snap(() => record(ownProp(o, 'tasks'), SCHEMAS.tasks));
  const git = snap(() => recordByGroups(ownProp(o, 'baseline'), SCHEMAS.baseline, BASELINE_GROUPS));
  const prot = snap(() => record(ownProp(o, 'protected'), SCHEMAS.protected));
  const roster = snap(() => record(ownProp(o, 'roster'), SCHEMAS.agents));
  const runtime = snap(() => record(ownProp(o, 'runtime'), SCHEMAS.agents));
  const container = snap(() => { const a = ownProp(o, 'anchors'); return isRecord(a) ? a : undefined; });
  const assignmentAnchor = snap(() => record(ownProp(take(container), 'assignment'), SCHEMAS.anchor));
  const livenessAnchor = snap(() => record(ownProp(take(container), 'liveness'), SCHEMAS.anchor));
  /*
   * THE JUDGED IDENTITIES ARE SHARED BY BOTH ANCHORS (T-161 (d)). The name
   * denylist already refused "registrations.json" for field 2 while that
   * store's DIGEST passed, because field 2 was handed only the task store's
   * identity. Every store fields 2 and 6 judge is now judged for both.
   * NAMED LIMIT: an observation that could not be read contributes no identity
   * (its own field is refused by the guard); making the OTHER field refuse too
   * would break M25's rule that a throw costs only its own field.
   */
  const identityOf = (s) => (s.ok ? str(s.v?.source_identity) : null);
  const judged = [identityOf(tasks), identityOf(roster), identityOf(runtime)];
  const guard = (id, fn) => {
    try { return fn(); } catch (e) {
      return field(id, { trust_state: TRUST.UNTRUSTWORTHY, reason: `observation could not be classified: ${describeThrown(e)}` });
    }
  };
  return {
    envelope_version: ENVELOPE_VERSION,
    generated_at: generatedAt,
    fields: {
      role_authority: roleAuthority(generatedAt),
      assignment_candidate: guard('assignment_candidate', () => assignmentCandidate(take(tasks), take(assignmentAnchor), judged)),
      baseline: guard('baseline', () => baseline(take(git))),
      protected_frozen: guard('protected_frozen', () => protectedFrozen(take(prot))),
      review_independence: reviewIndependence(generatedAt),
      channel_liveness: guard('channel_liveness', () => channelLiveness(take(roster), take(runtime), take(livenessAnchor), judged)),
      history_marker: historyMarker(generatedAt),
    },
  };
}

/*
 * SERIALISED FROM OWN DATA (T-157). JSON.stringify looks up `toJSON` on every
 * object, array, function and BigInt it meets, through the prototype chain, so
 * with Object.prototype.toJSON polluted the whole envelope printed as
 * "POLLUTED". It is handed a copy in which every object AND every array has a
 * null prototype, so there is no chain to walk. The copy keeps what
 * JSON.stringify would print: own enumerable keys in order, an array hole as
 * null, a function dropped (null in an array), and a BigInt refused -- with
 * the same TypeError it raises, rather than whatever an inherited toJSON says.
 */
function jsonData(v) {
  if (typeof v === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
  if (typeof v === 'function') return undefined;
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = [];
    const n = listLength(v);
    for (let i = 0; i < n; i += 1) out.push(jsonData(ownRead(v, i)));
    return Object.setPrototypeOf(out, null);
  }
  const out = Object.create(null);
  for (const k of Object.keys(v)) out[k] = jsonData(ownRead(v, k));
  return out;
}

/** The one serialisation. Stable key order comes from compileEnvelope; arrays are sorted there. */
export function serializeEnvelope(envelope) {
  return `${JSON.stringify(jsonData(envelope), null, 2)}\n`;
}
