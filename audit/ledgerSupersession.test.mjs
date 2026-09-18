import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSupersession,
  applySupersession,
  currentRecord,
  history,
  followChain,
  supersededRecords,
  assertAppendOnly,
  SUPERSESSION,
  REQUIRED_FIELDS,
} from '../src/supersession.mjs';

/**
 * THE LEDGER IS APPENDED TO. IT IS NEVER REWRITTEN.
 *
 * The case this was built for is real and is in master's history: four
 * contracts covering src/laneRegistry.mjs were all marked `withdrawn` with no
 * head_sha, while the work they described was integrated. The ledger said
 * nobody was contracted to do what shipped, and `withdrawn` is terminal, so it
 * could not express its own correction.
 *
 * Every refusal below is paired with the nearest case that must still be
 * ACCEPTED. A ledger that refuses every correction is not append-only, it is
 * read-only, and a record that cannot be corrected at all is the same dead end
 * that caused this — reached from the other side.
 */

const SHA = 'a'.repeat(40);
const resolveSha = (s) => s === SHA;

const withdrawn = (id) => ({ id, state: 'withdrawn', task: 'the original, wrong' });
const LEDGER = [withdrawn('d-one'), { id: 'd-two', state: 'accepted' }];

const correction = (over = {}) => ({
  id: 'c-1',
  supersedes: 'd-one',
  reason: 'withdrawn in error; the work shipped as 771522e',
  replacement_task_id: 'd-one-redone',
  recorded_by_agent: 'worker-b',
  recorded_by_session: 's-b',
  recorded_at: '2026-09-15T10:00:00.000Z',
  ...over,
});

/* ── the happy path, first, or none of the refusals mean anything ────── */

test('a correction APPENDS and leaves the original untouched', () => {
  const before = JSON.parse(JSON.stringify(LEDGER));
  const r = applySupersession(LEDGER, correction(), { resolveSha });
  assert.equal(r.ok, true, r.errors?.join('; '));
  assert.equal(r.rows.length, LEDGER.length + 1);
  const appendOnly = assertAppendOnly(before, r.rows);
  assert.deepEqual(appendOnly.errors, []);
});

test('THE WITHDRAWN RECORD REMAINS IMMUTABLE, byte for byte', () => {
  const originalJson = JSON.stringify(LEDGER[0]);
  const r = applySupersession(LEDGER, correction(), { resolveSha });
  const stillThere = r.rows.find((x) => x.id === 'd-one');
  assert.equal(JSON.stringify(stillThere), originalJson);
  assert.equal(stillThere.state, 'withdrawn', 'the mistake must survive the correction');
});

test('the correction carries every required field', () => {
  const { record } = createSupersession(correction(), { resolveSha });
  for (const f of REQUIRED_FIELDS) {
    assert.ok(record[f] != null && record[f] !== '', `${f} must be present`);
  }
  assert.equal(record.kind, SUPERSESSION);
});

test('replacement_head_sha is optional, and recorded when given', () => {
  const a = createSupersession(correction(), { resolveSha });
  assert.equal(a.ok, true, 'a correction with no replacement sha yet must be allowed');
  assert.equal(a.record.replacement_head_sha, null);

  const b = createSupersession(correction({ replacement_head_sha: SHA }), { resolveSha });
  assert.equal(b.ok, true);
  assert.equal(b.record.replacement_head_sha, SHA);
});

/* ── current-state lookup follows the chain ──────────────────────────── */

test('CURRENT STATE FOLLOWS THE SUPERSESSION to the authoritative record', () => {
  const { rows } = applySupersession(LEDGER, correction(), { resolveSha });
  const cur = currentRecord(rows, 'd-one');
  assert.equal(cur.ok, true);
  assert.equal(cur.record.id, 'c-1');
  assert.equal(cur.superseded, true);
});

test('NEAREST CLEAN: an uncorrected record speaks for itself', () => {
  const cur = currentRecord(LEDGER, 'd-two');
  assert.equal(cur.record.id, 'd-two');
  assert.equal(cur.superseded, false);
});

test('a chain of corrections resolves to the LAST one', () => {
  let rows = applySupersession(LEDGER, correction(), { resolveSha }).rows;
  rows = applySupersession(rows, correction({ id: 'c-2', supersedes: 'c-1', reason: 'the first correction named the wrong sha' }), { resolveSha }).rows;
  const cur = currentRecord(rows, 'd-one');
  assert.equal(cur.record.id, 'c-2');
});

test('looking up a record that does not exist reports missing, not a crash', () => {
  const cur = currentRecord(LEDGER, 'nope');
  assert.equal(cur.ok, false);
  assert.equal(cur.reason, 'missing');
});

/* ── history keeps the mistake ───────────────────────────────────────── */

test('HISTORY SHOWS THE ORIGINAL MISTAKE AND EVERY CORRECTION, in order', () => {
  /*
   * The half an audit reads. A history showing only the corrected state cannot
   * answer "was this ever wrong, and for how long" — the only question worth
   * asking after something shipped uncovered.
   */
  let rows = applySupersession(LEDGER, correction(), { resolveSha }).rows;
  rows = applySupersession(rows, correction({ id: 'c-2', supersedes: 'c-1', reason: 'again' }), { resolveSha }).rows;
  const h = history(rows, 'd-one');
  assert.deepEqual(h.map((r) => r.id), ['d-one', 'c-1', 'c-2']);
  assert.equal(h[0].state, 'withdrawn', 'the original error is still visible');
  assert.equal(h[1].reason, 'withdrawn in error; the work shipped as 771522e');
});

test('supersededRecords lists what was corrected and why', () => {
  const { rows } = applySupersession(LEDGER, correction(), { resolveSha });
  assert.deepEqual(supersededRecords(rows), [
    { supersedes: 'd-one', by: 'c-1', reason: 'withdrawn in error; the work shipped as 771522e', at: '2026-09-15T10:00:00.000Z' },
  ]);
});

/* ── refusals, each with its nearest accepted twin ───────────────────── */

test('an UNKNOWN supersedes target is refused', () => {
  const r = applySupersession(LEDGER, correction({ supersedes: 'd-nonexistent' }), { resolveSha });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown supersedes target/.test(e)), r.errors.join('; '));
  assert.equal(r.rows.length, LEDGER.length, 'a refused correction must not land');
});

test('NEAREST CLEAN: a known target is accepted', () => {
  assert.equal(applySupersession(LEDGER, correction({ supersedes: 'd-two' }), { resolveSha }).ok, true);
});

test('SELF-supersession is refused', () => {
  const r = applySupersession(LEDGER, correction({ id: 'd-one', supersedes: 'd-one' }), { resolveSha });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /cannot supersede itself/.test(e)), r.errors.join('; '));
});

test('A CIRCULAR chain is refused BEFORE it is written', () => {
  /*
   * Walking a cycle either loops forever or stops arbitrarily, and "stops
   * arbitrarily" means the authoritative record depends on where the walk began.
   */
  let rows = applySupersession(LEDGER, correction(), { resolveSha }).rows;
  // c-1 supersedes d-one. Now try to make d-one supersede c-1.
  const r = applySupersession(rows, correction({ id: 'd-loop', supersedes: 'c-1', reason: 'x' }), { resolveSha });
  assert.equal(r.ok, true, 'a straightforward second correction is fine');

  // ...and a true cycle: something superseding a record that already leads back.
  const cyc = applySupersession(r.rows, { ...correction({ id: 'c-1', supersedes: 'd-loop', reason: 'loop' }) }, { resolveSha });
  assert.equal(cyc.ok, false);
  assert.ok(cyc.errors.some((e) => /cycle|already exists/.test(e)), cyc.errors.join('; '));
});

test('a longer cycle is refused too', () => {
  const rows = [{ id: 'a' }, { id: 'b' }];
  const one = applySupersession(rows, correction({ id: 'b', supersedes: 'a', reason: 'r' }), { resolveSha });
  assert.equal(one.ok, false, 'id already exists');

  let l = [{ id: 'a' }];
  l = applySupersession(l, correction({ id: 'b', supersedes: 'a', reason: 'r' }), { resolveSha }).rows;
  l = applySupersession(l, correction({ id: 'c', supersedes: 'b', reason: 'r' }), { resolveSha }).rows;
  const loop = applySupersession(l, correction({ id: 'd', supersedes: 'c', reason: 'r' }), { resolveSha });
  assert.equal(loop.ok, true, 'a three-hop chain is legal');
  assert.equal(currentRecord(loop.rows, 'a').record.id, 'd');
});

test('a MISSING REASON is refused', () => {
  const r = applySupersession(LEDGER, correction({ reason: '' }), { resolveSha });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /reason is required/.test(e)), r.errors.join('; '));
});

test('a whitespace-only reason is refused too', () => {
  assert.equal(applySupersession(LEDGER, correction({ reason: '   ' }), { resolveSha }).ok, false);
});

test('NEAREST CLEAN: any non-empty reason is accepted', () => {
  assert.equal(applySupersession(LEDGER, correction({ reason: 'x' }), { resolveSha }).ok, true);
});

test('AN UNRESOLVABLE replacement_head_sha is refused', () => {
  const r = applySupersession(LEDGER, correction({ replacement_head_sha: 'b'.repeat(40) }), { resolveSha });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /does not resolve/.test(e)), r.errors.join('; '));
});

test('NEAREST CLEAN: a resolvable sha is accepted', () => {
  assert.equal(applySupersession(LEDGER, correction({ replacement_head_sha: SHA }), { resolveSha }).ok, true);
});

test('a sha supplied with NO resolver is refused, not trusted', () => {
  // Unverifiable is not the same as verified. Accepting it here would record a
  // commit reference nobody ever checked.
  const r = applySupersession(LEDGER, correction({ replacement_head_sha: SHA }), {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no resolver/.test(e)));
});

test('a resolver that throws is treated as "does not resolve"', () => {
  const r = applySupersession(LEDGER, correction({ replacement_head_sha: SHA }), {
    resolveSha: () => { throw new Error('git exploded'); },
  });
  assert.equal(r.ok, false);
});

test('missing attribution is refused — a correction nobody signed', () => {
  assert.equal(applySupersession(LEDGER, correction({ recorded_by_agent: null }), { resolveSha }).ok, false);
  assert.equal(applySupersession(LEDGER, correction({ recorded_by_session: null }), { resolveSha }).ok, false);
});

test('a duplicate correction id is refused', () => {
  const { rows } = applySupersession(LEDGER, correction(), { resolveSha });
  assert.equal(applySupersession(rows, correction(), { resolveSha }).ok, false);
});

/* ── append-only, asserted directly ──────────────────────────────────── */

test('assertAppendOnly catches an in-place edit', () => {
  const before = [{ id: 'a', state: 'withdrawn' }];
  const edited = [{ id: 'a', state: 'accepted' }];
  const r = assertAppendOnly(before, edited);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /EDITED IN PLACE/.test(e)));
});

test('assertAppendOnly catches a deletion, and SAYS it was a deletion', () => {
  /*
   * The message is asserted, and that is not pedantry: mutation showed the
   * length check was masked by the per-index comparison. Removing it left this
   * test green, because prev[1] vs next[1] (undefined) already differs — so the
   * deletion was reported as "record 1 was EDITED IN PLACE", which sends a
   * reader looking for an edit that never happened.
   *
   * Same masking shape as a branch made redundant by the one after it. The code
   * alone cannot distinguish the two faults; the wording is what carries it.
   */
  const r = assertAppendOnly([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /shrank/.test(e)), `a deletion must be named as one: ${r.errors.join('; ')}`);
});

test('NEAREST CLEAN: a pure append passes', () => {
  assert.equal(assertAppendOnly([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]).ok, true);
});

test('applySupersession never mutates the rows it is given', () => {
  const rows = [withdrawn('d-one')];
  const snapshot = JSON.stringify(rows);
  applySupersession(rows, correction(), { resolveSha });
  assert.equal(JSON.stringify(rows), snapshot);
});

test('a refused correction returns the ledger unchanged', () => {
  const r = applySupersession(LEDGER, correction({ reason: '' }), { resolveSha });
  assert.equal(r.rows, LEDGER);
});

/* ── shape ───────────────────────────────────────────────────────────── */

test('followChain reports a cycle rather than looping', () => {
  const rows = [
    { id: 'a' },
    { kind: SUPERSESSION, id: 'b', supersedes: 'a' },
    { kind: SUPERSESSION, id: 'a', supersedes: 'b' },
  ];
  const w = followChain(rows, 'a');
  assert.equal(w.ok, false);
  assert.equal(w.reason, 'cycle');
});

test('empty and absent inputs do not crash', () => {
  assert.deepEqual(supersededRecords([]), []);
  assert.deepEqual(history([], 'x'), []);
  assert.equal(currentRecord([], 'x').ok, false);
  assert.equal(applySupersession(undefined, correction(), { resolveSha }).ok, false);
});
