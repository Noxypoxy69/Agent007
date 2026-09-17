import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_FORMAT, FIELD_SEP, FIELDS_PER_RECORD, RECENT_MS,
  sessionFromTrailer, parseLog, workEvidence, reconcile,
} from '../src/workEvidence.mjs';

/**
 * The regression is the 2026-09-16 roster: fourteen rows, all offline,
 * idle_workers 0, while three sessions were committing. Everything here is
 * built from that shape.
 */

const NOW = '2026-09-17T00:00:00.000Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();

const SHA = (seed) => String(seed).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, 'a');
const rec = (sha, at, session, subject = 'x') =>
  [SHA(sha), at, session ? `https://claude.ai/code/${session}` : '', subject].join(FIELD_SEP) + FIELD_SEP;

test('the trailer is a URL and the session is the id inside it', () => {
  assert.equal(sessionFromTrailer('https://claude.ai/code/session_01Bo9xY'), 'session_01Bo9xY');
  assert.equal(sessionFromTrailer('  session_01Bo9xY  '), 'session_01Bo9xY');
  assert.equal(sessionFromTrailer(''), null);
  assert.equal(sessionFromTrailer(null), null);
});

test('a record with no sha, no date or a non-sha is DROPPED, never defaulted', () => {
  // Exactly four NUL-terminated fields each, so grouping stays aligned. git
  // always emits four; a hand-built record with a different count would shift
  // every record after it, which is a property of counted fields, not a bug.
  const raw4 = (a, b, c, d) => [a, b, c, d].join(FIELD_SEP) + FIELD_SEP;
  const text = raw4('', NOW, '', 'x')
    + raw4(SHA('b'), '', '', 'x')
    + raw4('not-a-sha', NOW, '', 'x')
    + rec('c', NOW, 'session_c');
  const parsed = parseLog(text);
  assert.deepEqual(parsed.map((c) => c.sha), [SHA('c')]);
});

test('the format emits exactly the field count the parser reads in', () => {
  // A format defined in the CLI and parsed here would be the splice problem:
  // two copies, edited apart. git renders %x00 as the separator, so count those.
  assert.equal(FIELD_SEP, '\x00', 'the delimiter must be the one git cannot put in a message');
  assert.equal((LOG_FORMAT.match(/%x00/g) || []).length, FIELDS_PER_RECORD,
    'the format must terminate every field the parser reads');
});

test('FORGERY: a commit SUBJECT cannot manufacture a second commit', () => {
  /*
   * The defect this replaced, found by attacking the parser rather than by
   * testing it. The first version split records on \x1e and fields on \x1f,
   * under a comment asserting neither "occurs in a subject line". A subject
   * containing \x1e ended the record early and the remainder parsed as a whole
   * new commit -- so anyone who can write a commit message to this repository
   * could name a session that never existed, or inflate another's count. It
   * produced two records, the second attributed to session_EVIL.
   *
   * NUL is the fix because git REFUSES it at object creation: checked by trying
   * to build one with git commit-tree, which answers
   * "a NUL byte in commit log message not allowed". There is no delimiter left
   * in the data to forge with.
   */
  const evil = rec('1', NOW, 'session_good',
    `subj\x1e${SHA('2')}\x1f${NOW}\x1fhttps://claude.ai/code/session_EVIL\x1fforged`);
  const parsed = parseLog(evil);
  assert.equal(parsed.length, 1, 'a subject must never become a second record');
  assert.equal(parsed[0].session, 'session_good', 'and must never carry a forged session');
  assert.match(parsed[0].subject, /session_EVIL/, 'the subject is kept WHOLE, not truncated at a separator');
  const e = workEvidence(parsed, { now: NOW });
  assert.deepEqual(e.sessions.map((s) => s.session), ['session_good']);
});

test('a truncated stream drops the partial record rather than padding it', () => {
  // execFile throws on maxBuffer overflow, but a short read must not invent a
  // commit out of three fields and an undefined.
  const good = rec('1', NOW, 'session_a');
  const partial = [SHA('2'), NOW].join(FIELD_SEP);
  const parsed = parseLog(good + partial);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sha, SHA('1'));
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
