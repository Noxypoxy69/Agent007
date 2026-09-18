/**
 * A POLL CANNOT MAKE A SESSION LIVE, AND THAT IS THE POINT.
 *
 * Three liveness signals have shipped on this bridge and every one measures
 * something adjacent to what the roster claims: the watcher proved a daemon was
 * running, `touchLiveness` proves somebody holding the SHARED worker token
 * spoke for a session, and the session poll proves a supervisor process is
 * re-arming. A wedged or finished agent keeps polling exactly like a working
 * one, so the roster has been reporting "live" for processes with nobody home —
 * and "not live" for agents that were demonstrably sending messages.
 *
 * These tests pin the round trip the agent itself has to close, and they spend
 * most of their length on the ways it could quietly become a fourth proxy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLiveness, probeDue, ackMatches, applyAck, recordProbe, parseInstant,
  LIVENESS, PROBE_DEFAULTS,
} from '../src/livenessProbe.mjs';

const T = (iso) => Date.parse(iso);
const NOW = T('2026-09-18T21:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;

/** A session that is polling happily and has answered recently. */
const healthy = () => ({
  agentId: 'code-b',
  sessionId: 'danny-win-b1',
  lastPollAt: ago(30 * SEC),
  lastAckAt: ago(1 * MIN),
  probeId: null,
  probeSentAt: null,
});

test('THE POSITIVE FIRST: a session that answered recently is live', () => {
  /*
   * Rule 5. Every "not live" assertion below is satisfied by a classifier that
   * never says live at all, which would be a worse roster than the one we have.
   */
  const r = classifyLiveness(healthy(), NOW);
  assert.equal(r.state, LIVENESS.LIVE, `a recently-acked session was ${r.state}: ${r.reason}`);
  assert.match(r.reason, /acked \d+s ago/, `the reason does not say why: ${r.reason}`);
});

test('POLLING IS NOT LIVENESS — the defect this whole module exists for', () => {
  /*
   * THE CENTRAL ASSERTION. A supervisor re-arming every few seconds proves a
   * PROCESS is running. The agent behind it may have finished, wedged, or died.
   * The old signals answered "live" here; this one must not.
   */
  const pollingButSilent = {
    ...healthy(),
    lastPollAt: ago(5 * SEC),          // polling right now
    lastAckAt: ago(40 * MIN),          // but has not answered in forty minutes
    probeId: 'p-1',
    probeSentAt: ago(20 * MIN),        // and a probe has been outstanding for twenty
  };

  const spent = { ...pollingButSilent, probeAttempts: PROBE_DEFAULTS.maxAttempts };
  const r = classifyLiveness(spent, NOW);
  assert.notEqual(r.state, LIVENESS.LIVE,
    'a session polling every five seconds with no ack for forty minutes was reported LIVE — '
    + 'that is the proxy, restored');
  assert.equal(r.state, LIVENESS.SILENT, `expected silent, got ${r.state}: ${r.reason}`);
  assert.match(r.reason, /still polling/,
    `the reason must name the contradiction a reader can see for themselves: ${r.reason}`);
});

test('FIVE ATTEMPTS BEFORE A DROP — one missed round trip proves nothing', () => {
  /*
   * DANNY'S RULE, and the reason it matters: an agent mid-tool-call, a slow
   * model turn, a momentary fault and a dead session are indistinguishable at
   * the FIRST unanswered probe. Calling that silent is how the roster tells
   * somebody an agent is dead forty-five seconds after it sent a message —
   * precisely the failure this module exists to stop, and it must not reappear
   * one layer up.
   */
  const base = { ...healthy(), lastAckAt: ago(40 * MIN), probeId: 'p', probeSentAt: ago(20 * MIN) };

  for (let n = 1; n < PROBE_DEFAULTS.maxAttempts; n += 1) {
    const r = classifyLiveness({ ...base, probeAttempts: n }, NOW);
    assert.equal(r.state, LIVENESS.AWAITING_ACK,
      `dropped after ${n} unanswered probe(s); the budget is ${PROBE_DEFAULTS.maxAttempts}: ${r.reason}`);
    assert.match(r.reason, new RegExp(`attempt ${n} of ${PROBE_DEFAULTS.maxAttempts}`),
      `the reason does not say where in the sequence it is: ${r.reason}`);
  }

  const r = classifyLiveness({ ...base, probeAttempts: PROBE_DEFAULTS.maxAttempts }, NOW);
  assert.equal(r.state, LIVENESS.SILENT,
    `the budget was spent and the session was still not called silent: ${r.reason}`);
});

test('THE ATTEMPT BUDGET IS CONSECUTIVE — one ack clears it', () => {
  /*
   * Otherwise an agent that misses four probes over a long session is dropped
   * on the next one, months of good behaviour notwithstanding.
   */
  const nearlySpent = {
    ...healthy(), lastAckAt: ago(40 * MIN), probeId: 'p-9',
    probeSentAt: ago(1 * MIN), probeAttempts: 4,
  };
  const answered = applyAck(nearlySpent, { probeId: 'p-9', at: ago(5 * SEC) });
  assert.equal(answered.probeAttempts, 0, 'an ack did not reset the consecutive-failure count');
  assert.equal(classifyLiveness(answered, NOW).state, LIVENESS.LIVE, 'an answered session is not live');
});

test('recordProbe COUNTS A SEQUENCE, and a fresh ack starts a new one', () => {
  const s0 = { ...healthy(), lastAckAt: ago(40 * MIN), probeId: null, probeSentAt: null };
  const s1 = recordProbe(s0, { probeId: 'p-1', at: ago(30 * MIN) });
  assert.equal(s1.probeAttempts, 1, 'the first probe of a sequence was not counted as 1');

  const s2 = recordProbe(s1, { probeId: 'p-2', at: ago(20 * MIN) });
  assert.equal(s2.probeAttempts, 2, 'a follow-up probe did not increment the sequence');

  const answered = applyAck(s2, { probeId: 'p-2', at: ago(19 * MIN) });
  const s3 = recordProbe(answered, { probeId: 'p-3', at: ago(5 * MIN) });
  assert.equal(s3.probeAttempts, 1,
    'a probe after an ack continued the old failure sequence instead of starting a new one');

  assert.equal(recordProbe(s0, { probeId: '', at: ago(1 * MIN) }), s0, 'an empty probe id was recorded');
  assert.equal(recordProbe(null, { probeId: 'p', at: ago(1 * MIN) }), null, 'a probe was recorded on nothing');
});

test('THE FIVE ATTEMPTS ARE A BURST, NOT A DAY', () => {
  /*
   * "5 attempts in a row, not all day." Spacing retries at the healthy probe
   * interval would stretch the budget over twenty-five minutes, and a roster
   * that takes that long to conclude anything is no better than the stale
   * window it replaces.
   */
  const { maxAttempts, ackGraceMs, probeIntervalMs } = PROBE_DEFAULTS;
  const wholeSequenceMs = maxAttempts * ackGraceMs;

  assert.ok(wholeSequenceMs <= 5 * MIN,
    `five attempts would take ${Math.round(wholeSequenceMs / 1000)}s — that is not "in a row"`);
  assert.ok(ackGraceMs < probeIntervalMs,
    'the retry gap is not shorter than the healthy interval, so failures are spaced like successes');

  // The next attempt is due as soon as the grace lapses, not a healthy interval later.
  const midSequence = {
    ...healthy(), lastAckAt: ago(10 * MIN), probeId: 'p',
    probeSentAt: ago(ackGraceMs + SEC), probeAttempts: 2,
  };
  assert.equal(probeDue(midSequence, NOW), true,
    'the next attempt in a failing sequence waits longer than the grace — the burst is not a burst');
});

test('SILENCE IS A VERDICT ABOUT NOW, NOT A PERMANENT LABEL', () => {
  /*
   * "Also it's hard for them to refresh." A session that recovers must rejoin
   * without a human noticing and restarting something, so a spent budget slows
   * the probing down rather than stopping it. A terminal state nothing ever
   * re-examines is how a roster fills with rows that are wrong the other way.
   */
  const dropped = {
    ...healthy(), lastAckAt: ago(2 * 60 * MIN), probeId: 'p-x',
    probeSentAt: ago(2 * MIN), probeAttempts: PROBE_DEFAULTS.maxAttempts,
  };
  assert.equal(probeDue(dropped, NOW), false, 'a just-probed silent session was probed again immediately');

  const later = { ...dropped, probeSentAt: ago(20 * MIN) };
  assert.equal(probeDue(later, NOW), true,
    'a silent session is never probed again — it can never recover without a human');
});

test('A PROBE IN FLIGHT IS NOT YET A FAILURE', () => {
  /*
   * Flapping to "silent" the instant a probe goes out would make every busy
   * agent look dead for one round trip. A roster that cries wolf gets ignored,
   * which is rule 14's lesson about a harness burning its own credibility.
   */
  const justProbed = { ...healthy(), lastAckAt: ago(30 * MIN), probeId: 'p-2', probeSentAt: ago(10 * SEC) };
  const r = classifyLiveness(justProbed, NOW);
  assert.equal(r.state, LIVENESS.AWAITING_ACK, `expected awaiting-ack, got ${r.state}: ${r.reason}`);
  assert.match(r.reason, /within grace/, r.reason);
});

test('NEVER PROBED IS UNKNOWN, NOT SILENT', () => {
  /*
   * Nobody asked, so nobody failed to answer. Collapsing "we did not ask" into
   * "it did not answer" manufactures the confident wrong answer the roster is
   * already blamed for, and it is the same mistake as reporting an unmeasured
   * field as zero rather than null.
   */
  const unprobed = {
    agentId: 'code-a', sessionId: 'danny-win-a1',
    lastPollAt: ago(20 * SEC), lastAckAt: null, probeId: null, probeSentAt: null,
  };
  const r = classifyLiveness(unprobed, NOW);
  assert.equal(r.state, LIVENESS.UNKNOWN, `expected unknown, got ${r.state}: ${r.reason}`);
  assert.notEqual(r.state, LIVENESS.SILENT, 'an unprobed session was accused of not answering');
  assert.match(r.reason, /proves a process, not an agent/, r.reason);
});

test('AN ACK MUST NAME THE OUTSTANDING PROBE — the anti-proxy rule', () => {
  /*
   * THE WHOLE ARGUMENT. If any ack counted, the supervisor could close the loop
   * by replaying an old id and a second worker could ack for a dead one, and
   * this becomes the fourth signal that measures something adjacent.
   */
  const s = { ...healthy(), probeId: 'p-live', probeSentAt: ago(1 * MIN) };

  assert.equal(ackMatches(s, { probeId: 'p-live', at: ago(10 * SEC) }), true,
    'the real answer to the outstanding probe was refused');

  assert.equal(ackMatches(s, { probeId: 'p-old', at: ago(10 * SEC) }), false,
    'an ack naming a DIFFERENT probe was accepted — any replayed id now proves liveness');
  assert.equal(ackMatches(s, { probeId: '', at: ago(10 * SEC) }), false, 'an empty probe id was accepted');
  assert.equal(ackMatches(s, { at: ago(10 * SEC) }), false, 'an ack with no probe id was accepted');
  assert.equal(ackMatches(s, { probeId: 'p-live', at: ago(5 * MIN) }), false,
    'an ack timestamped BEFORE its own probe was accepted — that is a replay, not an answer');
  assert.equal(ackMatches({ ...s, probeId: null }, { probeId: 'p-live', at: ago(10 * SEC) }), false,
    'an ack was accepted with no probe outstanding');
  assert.equal(ackMatches(s, { probeId: 'P-LIVE', at: ago(10 * SEC) }), false,
    'probe ids were matched case-insensitively — an opaque id must match exactly');
});

test('applyAck REFUSES BY DEFAULT rather than trusting the caller', () => {
  /*
   * Rule 6: assert preconditions, do not guard on them. A caller that forgets
   * to check ackMatches must not be able to mark a dead agent live.
   */
  const s = {
    ...healthy(), lastAckAt: ago(40 * MIN), probeId: 'p-9',
    probeSentAt: ago(1 * MIN), probeAttempts: PROBE_DEFAULTS.maxAttempts,
  };

  const wrong = applyAck(s, { probeId: 'p-other', at: ago(1 * SEC) });
  assert.equal(wrong.lastAckAt, s.lastAckAt, 'a mismatched ack moved the liveness clock');
  assert.equal(classifyLiveness(wrong, NOW).state, LIVENESS.SILENT,
    'a mismatched ack made a silent session live');

  const right = applyAck(s, { probeId: 'p-9', at: ago(1 * SEC) });
  assert.equal(classifyLiveness(right, NOW).state, LIVENESS.LIVE, 'a valid ack did not take effect');
  assert.equal(right.probeId, null, 'the probe was left outstanding after being answered');
});

test('PROBES ARE NOT PILED ON A SESSION THAT IS ALREADY ANSWERING', () => {
  const inFlight = { ...healthy(), lastAckAt: ago(30 * MIN), probeId: 'p-3', probeSentAt: ago(30 * SEC) };
  assert.equal(probeDue(inFlight, NOW), false, 'a second probe was sent while one was in flight');

  assert.equal(probeDue(healthy(), NOW), false, 'a probe was sent to a session that acked a minute ago');
});

test('A SESSION THAT HAS GONE QUIET IS PROBED AGAIN', () => {
  /*
   * The recovery direction. A probe that goes unanswered must not stop the next
   * one, or a single missed round trip leaves the session unmeasurable forever
   * — the same shape as a cursor that can never move.
   */
  const stale = { ...healthy(), lastAckAt: ago(30 * MIN), probeId: 'p-4', probeSentAt: ago(30 * MIN) };
  assert.equal(probeDue(stale, NOW), true, 'a long-unanswered session is never probed again');

  const neverProbed = { ...healthy(), lastAckAt: null, probeId: null, probeSentAt: null };
  assert.equal(probeDue(neverProbed, NOW), true, 'a session that has never been probed is never probed');
});

test('MICROSECOND TIMESTAMPS SURVIVE THE PARSER', () => {
  /*
   * src/events.mjs lost mail to exactly this truncation. Nothing here compares
   * for equality, so this is defence rather than requirement — but a parser in
   * this repository that silently drops digits is a trap the next reader does
   * not deserve.
   */
  const a = parseInstant('2026-09-18T19:30:00.123456+00:00');
  const b = parseInstant('2026-09-18T19:30:00.123999+00:00');
  assert.ok(a !== null && b !== null, 'a real PostgREST timestamp did not parse');
  assert.ok(b > a, 'two timestamps inside one millisecond compared equal');
  assert.equal(parseInstant('not-a-time'), null, 'garbage parsed as a time');
});

test('MALFORMED INPUT IS UNKNOWN, NEVER LIVE', () => {
  /*
   * This decides what a roster tells a person. Every unusable input must fail
   * towards "I do not know" rather than towards a claim.
   */
  for (const bad of [null, undefined, 42, 'session', [], {}]) {
    const r = classifyLiveness(bad, NOW);
    assert.notEqual(r.state, LIVENESS.LIVE, `${JSON.stringify(bad)} was reported live`);
  }
  assert.equal(classifyLiveness(healthy(), 'not-a-clock').state, LIVENESS.UNKNOWN,
    'an unusable clock produced a verdict anyway');
  assert.equal(probeDue(null, NOW), false, 'a probe was scheduled for nothing');
});

test('THE WINDOWS ARE ARGUMENTS, so a caller can tighten them without editing this file', () => {
  const s = { ...healthy(), lastAckAt: ago(2 * MIN) };
  assert.equal(classifyLiveness(s, NOW).state, LIVENESS.LIVE, 'the default window rejected a 2-minute ack');
  assert.equal(classifyLiveness(s, NOW, { ackWindowMs: 60 * SEC }).state, LIVENESS.UNKNOWN,
    'a tightened ack window had no effect');
});

test('THE CONTROL: this classifier really discriminates', () => {
  /*
   * Rule 1. A classifier returning one constant satisfies whichever half of the
   * assertions above happens to match it. This pins that all four states are
   * reachable and distinct.
   */
  const seen = new Set([
    classifyLiveness(healthy(), NOW).state,
    classifyLiveness({ ...healthy(), lastAckAt: ago(30 * MIN), probeId: 'p', probeSentAt: ago(10 * SEC) }, NOW).state,
    classifyLiveness({
      ...healthy(), lastAckAt: ago(30 * MIN), probeId: 'p',
      probeSentAt: ago(30 * MIN), probeAttempts: PROBE_DEFAULTS.maxAttempts,
    }, NOW).state,
    classifyLiveness({ ...healthy(), lastAckAt: null, probeId: null, probeSentAt: null }, NOW).state,
  ]);
  assert.deepEqual([...seen].sort(),
    [LIVENESS.AWAITING_ACK, LIVENESS.LIVE, LIVENESS.SILENT, LIVENESS.UNKNOWN].sort(),
    `the classifier collapsed distinct outcomes: got ${[...seen].join(', ')}`);
  assert.ok(PROBE_DEFAULTS.ackWindowMs > 0 && PROBE_DEFAULTS.ackGraceMs > 0, 'the defaults are degenerate');
});
