/**
 * The decisions behind the session watcher.
 *
 * THE POSITIVE IS ASSERTED BEFORE EVERY NEGATIVE. CLAUDE.md rule 5: "the tool is
 * absent for a reader" passes against a fixture that stopped being a reader, so
 * each refusal below is preceded by the same input succeeding with one field
 * changed back. A refusal test whose fixture was broken for some other reason
 * proves nothing about the rule it names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  sessionIdFor,
  resolveIdentity,
  resolveInterval,
  watchArgv,
  stopArgv,
  watcherPaths,
  shouldStartWatcher,
  describeOutcome,
  DEFAULT_INTERVAL_SECONDS,
  STALE_WINDOW_SECONDS,
  SESSION_PREFIX,
} from '../src/sessionWatch.mjs';

const UUID = '0b9f2c41-77ae-4f1e-9a2c-2f0e5d4b6a18';
const GOOD_ENV = { AGENTBRIDGE_AGENT_ID: 'code-e', AGENTBRIDGE_LANE: 'audit' };
const GOOD_PAYLOAD = { session_id: UUID };

test('the positive: a configured session resolves to one agent and one session', () => {
  const r = resolveIdentity(GOOD_ENV, GOOD_PAYLOAD);
  assert.equal(r.ok, true);
  assert.equal(r.agentId, 'code-e');
  assert.equal(r.sessionId, `${SESSION_PREFIX}${UUID}`);
  assert.equal(r.lane, 'audit');
  assert.equal(r.capacity, 'idle', 'a session that has just started holds nothing');
});

test('the session id is NOT truncated', () => {
  /*
   * The readable thing to do is slice the uuid to eight characters, and it is
   * wrong: a collision makes two sessions share one row and each deregisters the
   * other. Asserted explicitly because the shortening is the tempting edit.
   */
  const id = sessionIdFor(GOOD_PAYLOAD);
  assert.ok(id.endsWith(UUID), `${id} must carry the whole session id`);
  assert.equal(id, `${SESSION_PREFIX}${UUID}`);
});

test('a session id that would escape the watcher directory is refused', () => {
  // Positive first: the same call with a clean id succeeds.
  assert.ok(sessionIdFor({ session_id: 'abc123' }));

  for (const hostile of [
    '../../etc/passwd',
    '..\\..\\windows\\system32',
    'a/b',
    'a\\b',
    '.hidden',
    '',
    '   ',
    'x'.repeat(200),
  ]) {
    assert.equal(sessionIdFor({ session_id: hostile }), null, `${JSON.stringify(hostile)} must not become a file name`);
  }
  for (const wrongType of [null, undefined, 42, {}, []]) {
    assert.equal(sessionIdFor({ session_id: wrongType }), null);
  }
});

test('an agent id is never invented', () => {
  // Positive: with the id present it resolves.
  assert.equal(resolveIdentity(GOOD_ENV, GOOD_PAYLOAD).ok, true);

  const r = resolveIdentity({ AGENTBRIDGE_LANE: 'audit' }, GOOD_PAYLOAD);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-agent-id');
  assert.match(r.reason, /never invented/);
  // The session id is still reported, so the message can name what was refused.
  assert.equal(r.sessionId, `${SESSION_PREFIX}${UUID}`);
});

test('a malformed agent id, lane or capacity is refused rather than sent', () => {
  const cases = [
    [{ ...GOOD_ENV, AGENTBRIDGE_AGENT_ID: '../../x' }, 'bad-agent-id'],
    [{ ...GOOD_ENV, AGENTBRIDGE_AGENT_ID: 'has space' }, 'bad-agent-id'],
    [{ ...GOOD_ENV, AGENTBRIDGE_LANE: 'a/b' }, 'bad-lane'],
    [{ ...GOOD_ENV, AGENTBRIDGE_CAPACITY: 'working' }, 'bad-capacity'],
  ];
  for (const [env, code] of cases) {
    const r = resolveIdentity(env, GOOD_PAYLOAD);
    assert.equal(r.ok, false, `${JSON.stringify(env)} should be refused`);
    assert.equal(r.code, code);
  }
});

test('a lane is optional and an explicit capacity is honoured', () => {
  const noLane = resolveIdentity({ AGENTBRIDGE_AGENT_ID: 'fixer' }, GOOD_PAYLOAD);
  assert.equal(noLane.ok, true);
  assert.equal(noLane.lane, null);

  const busy = resolveIdentity({ ...GOOD_ENV, AGENTBRIDGE_CAPACITY: 'busy' }, GOOD_PAYLOAD);
  assert.equal(busy.capacity, 'busy');
});

test('the interval is bounded at BOTH ends, and the upper bound is the new one', () => {
  assert.equal(resolveInterval({}).seconds, DEFAULT_INTERVAL_SECONDS);
  assert.equal(resolveInterval({ AGENTBRIDGE_WATCH_INTERVAL: '60' }).seconds, 60);

  // Below the floor the CLI already enforces.
  assert.equal(resolveInterval({ AGENTBRIDGE_WATCH_INTERVAL: '4' }).ok, false);

  /*
   * THE UPPER BOUND EXISTS NOWHERE ELSE. bin/agentbridge.mjs refuses under 5s and
   * accepts anything above, so `--interval 900` produces a watcher whose session
   * is offline more often than it is live -- a watcher that causes the failure it
   * was added to prevent.
   */
  const past = resolveInterval({ AGENTBRIDGE_WATCH_INTERVAL: String(STALE_WINDOW_SECONDS) });
  assert.equal(past.ok, false);
  assert.match(past.reason, /age out between beats/);
  assert.equal(resolveInterval({ AGENTBRIDGE_WATCH_INTERVAL: String(STALE_WINDOW_SECONDS - 1) }).ok, true);

  for (const junk of ['abc', '12.5', '', ' ', '-1']) {
    const r = resolveInterval({ AGENTBRIDGE_WATCH_INTERVAL: junk });
    if (junk.trim() === '') assert.equal(r.ok, true, 'an unset interval falls back to the default');
    else assert.equal(r.ok, false, `${JSON.stringify(junk)} is not an interval`);
  }
});

test('the watcher argv actually asks for --watch', () => {
  /*
   * The entire defect was a registration that did not refresh. An argv builder
   * that dropped this flag would reintroduce it while every other assertion here
   * stayed green, so it is asserted on its own.
   */
  const argv = watchArgv({
    agentId: 'code-e', sessionId: 'claude-x', lane: 'audit', capacity: 'idle', intervalSeconds: 120,
  });
  assert.ok(argv.includes('--watch'), 'without --watch this is the one-shot that caused the bug');
  assert.equal(argv[0], 'register-session');
  assert.deepEqual(argv, [
    'register-session', '--agent', 'code-e', '--session', 'claude-x',
    '--lane', 'audit', '--capacity', 'idle', '--interval', '120', '--watch',
  ]);

  const noLane = watchArgv({
    agentId: 'code-e', sessionId: 'claude-x', lane: null, capacity: 'idle', intervalSeconds: 60,
  });
  assert.ok(!noLane.includes('--lane'));
  assert.ok(noLane.includes('--watch'));
  assert.equal(noLane[noLane.indexOf('--interval') + 1], '60');
});

test('stopping deregisters by name', () => {
  assert.deepEqual(stopArgv('claude-x'), ['unregister-session', '--session', 'claude-x']);
});

test('watcherPaths takes home as an argument and refuses an unusable id', () => {
  /*
   * HOME IS PASSED, NOT READ. A module that resolves it from process.env reaches
   * the operator's real ~/.agentbridge from inside the suite; that is how a live
   * override grant once turned a guard proof red and blamed the guard.
   */
  const p = watcherPaths(path.join('/tmp', 'fake-home'), 'claude-abc');
  assert.equal(p.pidFile, path.join('/tmp', 'fake-home', 'watchers', 'claude-abc.json'));
  assert.equal(p.logFile, path.join('/tmp', 'fake-home', 'watchers', 'claude-abc.log'));

  for (const hostile of ['../escape', 'a/b', '', null]) {
    assert.throws(() => watcherPaths('/tmp/fake-home', hostile), /unusable session id/);
  }
});

test('a second watcher is never started for a live one, and a dead one does not disable watching', () => {
  // Positive: nothing recorded means start.
  assert.equal(shouldStartWatcher({ record: null, isAlive: false }).start, true);

  // The idempotence that SessionStart's resume/clear/compact firings require.
  const live = shouldStartWatcher({ record: { pid: 4321 }, isAlive: true });
  assert.equal(live.start, false);
  assert.match(live.reason, /already running/);

  // A stale pidfile must not be mistaken for a running watcher, or the first
  // crash would disable watching permanently.
  assert.equal(shouldStartWatcher({ record: { pid: 4321 }, isAlive: false }).start, true);
  assert.equal(shouldStartWatcher({ record: { pid: 0 }, isAlive: true }).start, true);
  assert.equal(shouldStartWatcher({ record: { pid: 'nope' }, isAlive: true }).start, true);
});

test('not watching is LOUD, because silence is the bug', () => {
  const msg = describeOutcome({ kind: 'refused', reason: 'the token could not be read' });
  assert.match(msg, /NOT WATCHING/);
  assert.match(msg, /the token could not be read/);
  assert.match(msg, /age out/, 'the message must say what the consequence is');

  assert.match(
    describeOutcome({ kind: 'watching', agentId: 'code-e', sessionId: 'claude-x', intervalSeconds: 120, pid: 9 }),
    /code-e \/ claude-x refreshing every 120s \(pid 9\)/,
  );
  assert.match(describeOutcome({ kind: 'stopped', sessionId: 'claude-x' }), /stopped and deregistered/);
});
