import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_FORMAT, FIELD_SEP, RECORD_SEP, RECENT_MS,
  sessionFromTrailer, parseLog, workEvidence, reconcile,
} from '../src/workEvidence.mjs';

/**
 * The regression is the 2026-09-16 roster: fourteen rows, all offline,
 * idle_workers 0, while three sessions were committing. Everything here is
 * built from that shape.
 */

const NOW = '2026-09-17T00:00:00.000Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();

const rec = (sha, at, session, subject = 'x') =>
  [sha, at, session ? `https://claude.ai/code/${session}` : '', subject].join(FIELD_SEP) + RECORD_SEP;

test('the trailer is a URL and the session is the id inside it', () => {
  assert.equal(sessionFromTrailer('https://claude.ai/code/session_01Bo9xY'), 'session_01Bo9xY');
  assert.equal(sessionFromTrailer('  session_01Bo9xY  '), 'session_01Bo9xY');
  assert.equal(sessionFromTrailer(''), null);
  assert.equal(sessionFromTrailer(null), null);
});

test('a record with no sha or no date is DROPPED, never defaulted', () => {
  const text = rec('', NOW, 'session_a') + rec('abc', '', 'session_b') + rec('def', NOW, 'session_c');
  const parsed = parseLog(text);
  assert.deepEqual(parsed.map((c) => c.sha), ['def']);
});

test('the format string and the parser agree, which is why the format is exported', () => {
  // A format defined in the CLI and parsed here would be the splice problem:
  // two copies, edited apart. Assert the separators the parser splits on are
  // the ones the exported format emits.
  assert.ok(LOG_FORMAT.includes(FIELD_SEP), 'format must use the field separator the parser splits on');
  assert.ok(LOG_FORMAT.endsWith(RECORD_SEP), 'format must terminate records with the separator the parser splits on');
  assert.equal(LOG_FORMAT.split(FIELD_SEP).length, 4, 'four fields: sha, date, trailer, subject');
});

test('THE REGRESSION: sessions committing while the registry reports nobody', () => {
  const commits = parseLog(
    rec('a1', ago(2 * 60 * 1000), 'session_alpha', 'the dispatcher fix') +
    rec('a2', ago(9 * 60 * 1000), 'session_alpha') +
    rec('b1', ago(11 * 60 * 1000), 'session_beta') +
    rec('c1', ago(6 * 60 * 60 * 1000), 'session_gamma'),
  );
  const e = workEvidence(commits, { now: NOW });

  assert.deepEqual(e.recent.map((s) => s.session), ['session_alpha', 'session_beta']);
  assert.deepEqual(e.quiet.map((s) => s.session), ['session_gamma']);
  assert.equal(e.sessions[0].commits, 2, 'commits per session are counted');
  assert.equal(e.sessions[0].lastSubject, 'the dispatcher fix', 'the newest subject, not the first seen');

  const r = reconcile(e, 0);
  assert.equal(r.disagrees, true, 'registry says nobody, the repository says two — that is the alarm');
  assert.equal(r.registryLive, 0);
  assert.equal(r.producingNow, 2);
});

test('agreement is not an alarm: a live registry and a producing repo', () => {
  const e = workEvidence(parseLog(rec('a1', ago(60_000), 'session_alpha')), { now: NOW });
  assert.equal(reconcile(e, 2).disagrees, false);
});

test('a quiet repo and an empty registry is NOT an alarm either', () => {
  const e = workEvidence(parseLog(rec('a1', ago(6 * 60 * 60 * 1000), 'session_alpha')), { now: NOW });
  assert.equal(reconcile(e, 0).disagrees, false, 'nobody committing and nobody registered agree with each other');
});

test('an unknown registry count is null and never zero — absent is not zero', () => {
  const e = workEvidence(parseLog(rec('a1', ago(60_000), 'session_alpha')), { now: NOW });
  for (const bad of [null, undefined, -1, 'two', 1.5]) {
    const r = reconcile(e, bad);
    assert.equal(r.registryLive, null, `${String(bad)} must read as unknown`);
    assert.equal(r.disagrees, false, 'unknown must never raise the alarm — that is a guess, not a finding');
  }
});

test('a commit with no trailer is unattributed, not nobody', () => {
  const e = workEvidence(parseLog(rec('a1', ago(60_000), null) + rec('a2', ago(6 * 60 * 60 * 1000), null)), { now: NOW });
  assert.equal(e.sessions.length, 0, 'no session can be named');
  assert.equal(e.unattributed, 2);
  assert.equal(e.unattributedRecent, 1, 'recent unattributed work still says SOMEBODY is here');
});

test('a commit dated in the future is not recent, and does not crash', () => {
  const e = workEvidence(parseLog(rec('a1', ago(-60 * 60 * 1000), 'session_alpha')), { now: NOW });
  assert.equal(e.recent.length, 0, 'a negative age is a clock problem, not a working agent');
});

test('the boundary is inclusive and one millisecond past it is quiet', () => {
  const at = workEvidence(parseLog(rec('a', ago(RECENT_MS), 'session_a')), { now: NOW });
  const past = workEvidence(parseLog(rec('a', ago(RECENT_MS + 1), 'session_a')), { now: NOW });
  assert.equal(at.recent.length, 1);
  assert.equal(past.recent.length, 0);
});

test('STRUCTURAL: nothing here can be handed to resolveWorker', () => {
  /*
   * The real risk in writing this module is that it becomes a second roster.
   * liveRegistry's header says what that costs: two implementations of identity
   * that disagree the first time one is fixed. A comment asking nobody to route
   * on this is not a control; the output being the wrong SHAPE is.
   *
   * Watch it fail by adding `agent_id` to a session object in workEvidence.
   */
  const e = workEvidence(parseLog(rec('a1', ago(60_000), 'session_alpha')), { now: NOW });
  const forbidden = ['agent_id', 'agentId', 'lane', 'lane_id', 'worktree', 'capacity'];
  for (const s of e.sessions) {
    for (const key of forbidden) {
      assert.equal(Object.hasOwn(s, key), false, `work evidence must not carry ${key}: it would look routable`);
    }
  }
  const r = reconcile(e, 0);
  assert.equal(r.joinable, false, 'the two identifier spaces do not join, and the output must say so');
  for (const key of forbidden) {
    assert.equal(Object.hasOwn(r, key), false, `reconcile must not carry ${key}`);
  }
});
