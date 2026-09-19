/**
 * THE ACK CHECK MUST BE THE SAME ON BOTH SURFACES, AND IT IS THE WHOLE ARGUMENT.
 *
 * A probe is only worth anything because an ack has to name the OUTSTANDING id.
 * If any ack counted, a supervisor could close the loop by replaying an old one
 * and a second worker could answer for a dead session — and the probe would
 * join the three signals that already measure something adjacent to what the
 * roster claims.
 *
 * `supabase/functions/mcp/_shared.js` is a hand-maintained splice, and the
 * tests exercise the ORIGINALS. `revokeDecision` was anchored in `src/` and
 * left untouched in `_shared.js` for three commits while the commit message
 * said "Anchored" — nothing noticed, because no test imported it from either
 * file. This is that test, for the function that carries the property.
 *
 * COMPARED BY BEHAVIOUR. The two copies take different shapes on purpose —
 * `src/` uses camelCase fields and a helper module, the splice uses the
 * database's snake_case — so a textual comparison would be noise. What must
 * agree is the ANSWER: for the same situation, do both accept or both refuse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ackMatches as srcAck, applyAck as srcApply } from '../src/livenessProbe.mjs';
import { ackMatches as hostedAck, applyAck as hostedApply } from '../supabase/functions/mcp/_shared.js';

const NOW = Date.parse('2026-09-19T02:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const ahead = (ms) => new Date(NOW + ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;

/** The same situation in each surface's own field spelling. */
const pair = (probeId, sentAt) => ({
  src: { probeId, probeSentAt: sentAt, lastAckAt: ago(40 * MIN) },
  hosted: { probe_id: probeId, probe_sent_at: sentAt, last_ack_at: ago(40 * MIN) },
});

const ackPair = (probeId, at) => ({
  src: { probeId, at },
  hosted: { probe_id: probeId, at },
});

/**
 * Situations that have to agree. Generated where it can be, so a case added
 * here is covered on both surfaces at once.
 */
const CASES = [
  ['the real answer', pair('p-1', ago(1 * MIN)), ackPair('p-1', ago(10 * SEC)), true],
  ['a different probe id', pair('p-1', ago(1 * MIN)), ackPair('p-2', ago(10 * SEC)), false],
  ['an empty probe id', pair('p-1', ago(1 * MIN)), ackPair('', ago(10 * SEC)), false],
  ['no probe outstanding', pair(null, null), ackPair('p-1', ago(10 * SEC)), false],
  ['an ack predating its probe', pair('p-1', ago(1 * MIN)), ackPair('p-1', ago(5 * MIN)), false],
  ['an ack far in the future', pair('p-1', ago(1 * MIN)), ackPair('p-1', ahead(365 * 24 * 60 * MIN)), false],
  ['an ack inside ordinary skew', pair('p-1', ago(1 * MIN)), ackPair('p-1', ahead(30 * SEC)), true],
  ['a case-folded id', pair('p-abc', ago(1 * MIN)), ackPair('P-ABC', ago(10 * SEC)), false],
  ['a padded id', pair('p-abc', ago(1 * MIN)), ackPair(' p-abc ', ago(10 * SEC)), false],
  ['an unparseable ack time', pair('p-1', ago(1 * MIN)), ackPair('p-1', 'not-a-time'), false],
  ['an unparseable probe time', pair('p-1', 'nonsense'), ackPair('p-1', ago(10 * SEC)), false],
];

test('THE POSITIVE FIRST: both surfaces accept the real answer', () => {
  /*
   * Rule 5. A parity loop over two functions that refuse everything agrees
   * perfectly and proves nothing — and "refuses everything" is the failure that
   * would make every session look dead.
   */
  const [, session, ack] = CASES[0];
  assert.equal(srcAck(session.src, ack.src, NOW), true, 'src refused the real answer');
  assert.equal(hostedAck(session.hosted, ack.hosted, NOW), true, 'hosted refused the real answer');
});

test('THE CORPUS REACHES BOTH VERDICTS, or agreement is vacuous', () => {
  const verdicts = new Set(CASES.map(([, s, a]) => srcAck(s.src, a.src, NOW)));
  assert.deepEqual([...verdicts].sort(), [false, true], 'the corpus produces only one verdict');
});

test('THE TWO SURFACES AGREE, SITUATION FOR SITUATION', () => {
  const diverged = [];
  for (const [name, session, ack, want] of CASES) {
    const a = srcAck(session.src, ack.src, NOW);
    const b = hostedAck(session.hosted, ack.hosted, NOW);
    if (a !== b || a !== want) diverged.push({ name, src: a, hosted: b, want });
  }
  assert.deepEqual(diverged, [],
    `the ack check has drifted:\n${diverged.map((d) =>
      `  ${d.name}: src=${d.src} hosted=${d.hosted} expected=${d.want}`).join('\n')}`);
});

test('A VALID ACK CLEARS THE PROBE AND THE ATTEMPT BUDGET, on both surfaces', () => {
  /*
   * The budget is CONSECUTIVE failures, so an answer resets it in full —
   * otherwise an agent that missed four probes across a long session is dropped
   * on the next one regardless of hours of good behaviour.
   */
  const at = ago(10 * SEC);

  const s = { probeId: 'p-9', probeSentAt: ago(1 * MIN), lastAckAt: ago(40 * MIN), probeAttempts: 4 };
  const sNext = srcApply(s, { probeId: 'p-9', at }, NOW);
  assert.equal(sNext.lastAckAt, at, 'src did not record the ack');
  assert.equal(sNext.probeId, null, 'src left the probe outstanding after it was answered');
  assert.equal(sNext.probeAttempts, 0, 'src did not reset the consecutive-failure count');

  const h = { probe_id: 'p-9', probe_sent_at: ago(1 * MIN), last_ack_at: ago(40 * MIN), probe_attempts: 4 };
  const hNext = hostedApply(h, { probe_id: 'p-9', at }, NOW);
  assert.equal(hNext.last_ack_at, at, 'hosted did not record the ack');
  assert.equal(hNext.probe_id, null, 'hosted left the probe outstanding');
  assert.equal(hNext.probe_attempts, 0, 'hosted did not reset the count');
});

test('A REFUSED ACK RETURNS THE ROW UNCHANGED, which is how the route detects it', () => {
  /*
   * The route reports a refusal by identity — `next === row`. If applyAck ever
   * returned a copy on the refusal path, the route would answer ok to a replay
   * and a dead session would keep looking alive.
   */
  const h = { probe_id: 'p-1', probe_sent_at: ago(1 * MIN), last_ack_at: ago(40 * MIN) };
  const same = hostedApply(h, { probe_id: 'p-wrong', at: ago(10 * SEC) }, NOW);
  assert.equal(same, h, 'a refused ack returned a NEW object — the route cannot tell it was refused');

  const s = { probeId: 'p-1', probeSentAt: ago(1 * MIN), lastAckAt: ago(40 * MIN) };
  assert.equal(srcApply(s, { probeId: 'p-wrong', at: ago(10 * SEC) }, NOW), s,
    'src returned a new object on refusal');
});

test('THE CONTROL: this comparison can actually fail', () => {
  /*
   * Rule 1. If the comparison were inert, every assertion above would pass for
   * two implementations that disagreed completely.
   */
  assert.notEqual(true, false, 'the verdict comparison is inert');
  const s = { probe_id: 'p-1', probe_sent_at: ago(1 * MIN) };
  assert.notEqual(
    hostedAck(s, { probe_id: 'p-1', at: ago(10 * SEC) }, NOW),
    hostedAck(s, { probe_id: 'p-2', at: ago(10 * SEC) }, NOW),
    'the ack check cannot tell the outstanding probe from another one',
  );
});
