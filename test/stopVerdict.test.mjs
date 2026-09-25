/**
 * src/stopVerdict.mjs -- the Stop gate's verdict-reuse and one-suite-lock
 * decisions (T-147, owner ruling (a)).
 *
 * The property: a reused PASS happens ONLY for byte-identical key inputs, only
 * from a PASS, only when fresh, only from a store that parses entirely -- and
 * its message says exactly what it does not cover. Every "changes the key"
 * assertion is GENERATED over every KEY_PART, so adding a part extends it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VERDICT_STORE_LABEL, MAX_REUSE_AGE_MS, EXCLUDED_ENV, KEY_PARTS, REUSE_RESIDUAL,
  envForKey, verdictKey, formatVerdictRecord, parseVerdictStore, chooseReuse, reusedPassMessage, lockState,
  shouldRecord, acquireOrReuse,
} from '../src/stopVerdict.mjs';

const H = (c) => c.repeat(64);
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function parts() {
  return {
    repoRoot: 'C:/work/agent007',
    head: 'a'.repeat(40),
    tracked: [['src/a.mjs', H('1')], ['test/a.test.mjs', H('2')]],
    untracked: [['notes.txt', H('3')]],
    ignored: [['.env', H('4')], ['node_modules/.package-lock.json', 'deleted']],
    gateScriptSha256: H('5'),
    suiteFiles: ['test/a.test.mjs'],
    nodeVersion: 'v24.19.0',
    platform: 'win32',
    arch: 'x64',
    env: [['PATH', 'C:/bin'], ['HOME', 'C:/Users/x']],
    secrets: [['dir', 'C:/Users/x/Documents/agentbridge-secrets'], ['entry', 'reader.token', '40', '1790000000000']],
  };
}

/** Flip ONE character of the first string found in a part (depth-first). */
function flipOneByte(value) {
  if (typeof value === 'string') {
    const c = value.charCodeAt(value.length - 1);
    return value.slice(0, -1) + String.fromCharCode(c === 0x61 ? 0x62 : 0x61);
  }
  if (Array.isArray(value)) {
    const copy = value.map((v) => (Array.isArray(v) ? [...v] : v));
    copy[0] = flipOneByte(copy[0]);
    return copy;
  }
  throw new Error(`cannot flip ${typeof value}`);
}

test('POSITIVE CONTROL: the same inputs give the same key, whatever order the lists were observed in', () => {
  const a = verdictKey(parts());
  const b = parts();
  for (const p of KEY_PARTS) if (Array.isArray(b[p])) b[p].reverse();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(verdictKey(b), a);
});

test('ANY single-byte change to ANY key part changes the key (generated over KEY_PARTS)', () => {
  const base = verdictKey(parts());
  assert.equal(KEY_PARTS.length, 12, 'the key part list changed: re-examine what the key covers');
  for (const p of KEY_PARTS) {
    const changed = parts();
    changed[p] = flipOneByte(changed[p]);
    assert.notDeepEqual(changed[p], parts()[p], `precondition: ${p} was actually changed`);
    assert.notEqual(verdictKey(changed), base, `a one-byte change to ${p} did not change the key`);
  }
});

test('a missing key part is refused, never keyed without it', () => {
  for (const p of KEY_PARTS) {
    const missing = parts();
    delete missing[p];
    assert.throws(() => verdictKey(missing), new RegExp(`missing part\\(s\\) ${p}`), p);
  }
});

test('envForKey: every variable is keyed except the named per-session ids', () => {
  const env = { PATH: 'C:/bin', NODE_OPTIONS: '', GIT_DIR: 'x', AGENTBRIDGE_HOME: 'h', TEMP: 't' };
  for (const k of EXCLUDED_ENV) env[k] = 'per-session';
  const keyed = envForKey(env).map(([k]) => k);
  assert.deepEqual(keyed, ['AGENTBRIDGE_HOME', 'GIT_DIR', 'NODE_OPTIONS', 'PATH', 'TEMP']);
  // Excluded names change nothing; any other name or value changes the key.
  const withEnv = (e) => verdictKey({ ...parts(), env: envForKey(e) });
  const base = withEnv(env);
  for (const k of EXCLUDED_ENV) assert.equal(withEnv({ ...env, [k]: 'another session' }), base, k);
  assert.equal(withEnv({ ...env, claude_code_session_id: 'lower-case spelling' }), base, 'exclusion is case-insensitive');
  for (const k of ['PATH', 'NODE_OPTIONS', 'GIT_DIR', 'AGENTBRIDGE_HOME', 'TEMP']) {
    assert.notEqual(withEnv({ ...env, [k]: `${env[k]}x` }), base, `a change to ${k} did not change the key`);
  }
  assert.notEqual(withEnv({ ...env, NEW_VAR: '1' }), base, 'an added variable did not change the key');
});

const rec = (over = {}) => ({ v: 1, label: VERDICT_STORE_LABEL, key: H('a'), outcome: 'pass', at: iso(60_000), durationMs: 1, counts: {}, ...over });

test('reuse: a fresh PASS for the exact key is reused (positive control)', () => {
  const r = chooseReuse({ records: [rec()], key: H('a'), nowMs: NOW });
  assert.equal(r.reuse?.key, H('a'));
});

test('reuse: a FAIL or a DEADLINE is NEVER reused, however fresh', () => {
  for (const outcome of ['fail', 'deadline']) {
    assert.equal(chooseReuse({ records: [rec({ outcome })], key: H('a'), nowMs: NOW }).reuse, null, outcome);
  }
});

test('reuse: a key mismatch in any single character is not reused', () => {
  for (let i = 0; i < 64; i += 8) {
    const other = H('a').slice(0, i) + 'b' + H('a').slice(i + 1);
    assert.equal(chooseReuse({ records: [rec()], key: other, nowMs: NOW }).reuse, null, `position ${i}`);
  }
});

test('reuse: a PASS aged at or over 10 minutes, or dated in the future, is not reused', () => {
  assert.equal(MAX_REUSE_AGE_MS, 600_000);
  assert.ok(chooseReuse({ records: [rec({ at: iso(MAX_REUSE_AGE_MS - 1000) })], key: H('a'), nowMs: NOW }).reuse, 'just inside');
  assert.equal(chooseReuse({ records: [rec({ at: iso(MAX_REUSE_AGE_MS) })], key: H('a'), nowMs: NOW }).reuse, null, 'at the limit');
  assert.equal(chooseReuse({ records: [rec({ at: iso(MAX_REUSE_AGE_MS + 1000) })], key: H('a'), nowMs: NOW }).reuse, null, 'past it');
  assert.equal(chooseReuse({ records: [rec({ at: iso(-5000) })], key: H('a'), nowMs: NOW }).reuse, null, 'future-dated');
});

test('reuse: no key means no reuse', () => {
  for (const key of [null, undefined, '', 'short']) {
    assert.equal(chooseReuse({ records: [rec()], key, nowMs: NOW }).reuse, null, String(key));
  }
});

test('store: records written by formatVerdictRecord parse back; ANY corrupt line voids the whole store', () => {
  const good = formatVerdictRecord({ key: H('a'), outcome: 'pass', at: iso(1000), durationMs: 5, counts: { tests: 1 } })
    + formatVerdictRecord({ key: H('b'), outcome: 'fail', at: iso(500), durationMs: 5, counts: {} });
  const parsed = parseVerdictStore(good);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].label, VERDICT_STORE_LABEL);
  assert.deepEqual(parseVerdictStore(''), { ok: true, records: [] });
  for (const [name, text] of [
    ['a truncated last line', good.slice(0, -10)],
    ['garbage appended', `${good}not json\n`],
    ['a record without the label', `${JSON.stringify({ ...rec(), label: undefined })}\n`],
    ['a record with an unknown outcome', `${JSON.stringify(rec({ outcome: 'ok' }))}\n`],
    ['a record with a short key', `${JSON.stringify(rec({ key: 'abc' }))}\n`],
    ['a record with a bad time', `${JSON.stringify(rec({ at: 'yesterday' }))}\n`],
    ['not text', null],
  ]) {
    assert.equal(parseVerdictStore(text).ok, false, name);
  }
});

test('the reused-pass message carries the exact residual wording, the record time, and the store label', () => {
  const r = rec({ at: '2026-09-24T11:59:00.000Z' });
  const msg = reusedPassMessage(r, NOW);
  assert.equal(REUSE_RESIDUAL, 'It does NOT cover network or production-server state, the live process table, the clock, or machine load, nor hand edits inside node_modules that npm\'s lockfile (node_modules/.package-lock.json) does not record.');
  // T-153: the node_modules residual is named in the message itself, not only in the constant
  assert.ok(/hand edits inside node_modules/.test(msg) && /node_modules\/\.package-lock\.json/.test(msg), msg);
  assert.ok(msg.startsWith('[agentbridge:stop-verdict-reused] The suite was NOT run for this turn.'), msg);
  assert.ok(msg.includes('This reused pass certifies "these exact inputs passed at 2026-09-24T11:59:00.000Z on this machine".'), msg);
  assert.ok(msg.includes(REUSE_RESIDUAL), msg);
  assert.ok(msg.includes('60s ago'), msg);
  assert.ok(msg.includes(`Store: ${VERDICT_STORE_LABEL}.`), msg);
});

test('T-159: every reused-pass message states the ABA residual in the owner\'s exact words', () => {
  // Written out here, not imported: a test that reads the constant it checks agrees with itself (hollow gate 2).
  const OWNER_TEXT = 'Identity matched at the pre-run and pre-save boundaries; changes made and reverted during the run are not excluded.';
  for (const at of ['2026-09-24T11:59:00.000Z', '2026-09-24T11:55:30.500Z']) {
    const msg = reusedPassMessage(rec({ at }), NOW);
    assert.ok(msg.includes(OWNER_TEXT), msg);
    assert.equal(msg.split(OWNER_TEXT).length, 2, 'stated exactly once');
    assert.ok(msg.indexOf(OWNER_TEXT) > msg.indexOf(REUSE_RESIDUAL), 'after the existing residual, not replacing it');
  }
});

test('lock: absent is free; a live holder in budget is held; a dead holder or an overrun is stale', () => {
  const base = { pid: 4242, startedAt: iso(1000), budgetMs: 60_000, mtimeMs: NOW - 1000 };
  const s = (lock, pidAlive) => lockState({ lock, nowMs: NOW, pidAlive, fallbackBudgetMs: 190_000 });
  assert.equal(s(null), 'free');
  assert.equal(s(base, true), 'held');
  assert.equal(s(base, false), 'stale', 'a dead holder');
  assert.equal(s({ ...base, startedAt: iso(61_000) }, true), 'stale', 'past its own budget');
  assert.equal(s({ ...base, startedAt: iso(59_000) }, true), 'held', 'just inside its budget');
});

/*
 * T-153: THE WAIT, DRIVEN POINT BY POINT. acquireOrReuse takes every effect as
 * an argument, so each re-check can be given a case that ONLY it can decide
 * (CLAUDE.md rule 11: T-148 found the two re-checks masking each other, G03 and
 * G04 each surviving a mutation because the other still fired).
 */
const K = H('a');
const K2 = H('b');
const PASSREC = { outcome: 'pass', key: K, at: iso(1000) };
function fakeEffects({ keys, passes, lockSeq }) {
  let t = NOW; const calls = { freshPass: [], currentKey: 0, tryLock: 0, sleep: 0 };
  let ki = 0; let pi = 0; let li = 0;
  return {
    calls,
    effects: {
      currentKey: () => { calls.currentKey += 1; return keys[Math.min(ki++, keys.length - 1)]; },
      freshPass: (k) => { calls.freshPass.push(k); const p = passes[Math.min(pi++, passes.length - 1)]; return p && p.key === k ? p : null; },
      tryLock: () => { calls.tryLock += 1; return lockSeq[Math.min(li++, lockSeq.length - 1)]; },
      readLock: () => ({ pid: 1, startedAt: iso(0), budgetMs: 600_000 }),
      lockIsStale: () => false,
      breakLock: () => { throw new Error('a live lock must never be broken'); },
      now: () => t,
      sleep: async (ms) => { calls.sleep += 1; t += ms; },
    },
  };
}
const deadline = { deadlineAt: NOW + 60_000, minSuiteMs: 5_000, pollMs: 1_000 };

test('G03 ONLY: a waiter that NEVER gets the lock reuses the PASS its holder records (poll re-check)', async () => {
  // the lock is never free, so the re-check at the lock can never run: only the poll can reuse
  const f = fakeEffects({ keys: [K], passes: [null, PASSREC], lockSeq: ['held'] });
  const d = await acquireOrReuse({ effects: f.effects, ...deadline });
  assert.equal(d.action, 'reuse', `expected a reuse from the poll, got ${JSON.stringify(d)}`);
  assert.equal(d.at, 'poll');
  assert.ok(f.calls.sleep >= 1, 'precondition: the waiter actually waited');
});

test('G04 ONLY: a PASS that appears by the time the lock is taken is reused, not re-run (re-check at the lock)', async () => {
  // the lock is free at once, so the poll never runs: only the re-check at the lock can reuse
  const f = fakeEffects({ keys: [K], passes: [null, PASSREC], lockSeq: ['taken'] });
  const d = await acquireOrReuse({ effects: f.effects, ...deadline });
  assert.equal(f.calls.sleep, 0, 'precondition: no poll happened');
  assert.equal(d.action, 'reuse', `expected a reuse at the lock, got ${JSON.stringify(d)}`);
  assert.equal(d.at, 'lock');
});

test('S16 (unit): a PASS recorded for the OLD key is not reused at the poll once the tree has moved', async () => {
  // the waiter observed K; by the poll the inputs are K2; a PASS exists for K only
  const f = fakeEffects({ keys: [K, K2, K2], passes: [null, PASSREC, PASSREC, null], lockSeq: ['held', 'taken'] });
  const d = await acquireOrReuse({ effects: f.effects, ...deadline });
  assert.equal(d.action, 'run', `a PASS for a state that is no longer current was reused: ${JSON.stringify(d)}`);
  assert.equal(d.keyBeforeWait, K);
  assert.equal(d.keyBeforeSuite, K2);
  assert.equal(shouldRecord({ keyBeforeWait: d.keyBeforeWait, keyBeforeSuite: d.keyBeforeSuite, keyBeforeRecord: K2 }), false,
    'a run whose key moved before the suite must not be recorded');
});

test('S16 (unit): reuse at the lock is keyed on the state as it is AT the lock', async () => {
  // observed K before the wait; K2 at the lock; a PASS exists for K only -> run, never reuse K's PASS
  const f = fakeEffects({ keys: [K, K2], passes: [null, PASSREC], lockSeq: ['taken'] });
  const d = await acquireOrReuse({ effects: f.effects, ...deadline });
  assert.equal(d.action, 'run', JSON.stringify(d));
  assert.deepEqual(f.calls.freshPass, [K, K2], 'the re-check at the lock asked about the CURRENT key');
});

test('shouldRecord: only when the key held before the wait, before the suite and before recording', () => {
  assert.equal(shouldRecord({ keyBeforeWait: K, keyBeforeSuite: K, keyBeforeRecord: K }), true, 'positive control');
  for (const [w, s, r] of [[K2, K, K], [K, K2, K], [K, K, K2], [null, null, null], ['short', 'short', 'short']]) {
    assert.equal(shouldRecord({ keyBeforeWait: w, keyBeforeSuite: s, keyBeforeRecord: r }), false, `${w}/${s}/${r}`);
  }
});

test('a waiter over budget refuses; it never runs and never passes', async () => {
  const f = fakeEffects({ keys: [K], passes: [null], lockSeq: ['held'] });
  const d = await acquireOrReuse({ effects: f.effects, deadlineAt: NOW + 7_000, minSuiteMs: 5_000, pollMs: 1_000 });
  assert.equal(d.action, 'deadline', JSON.stringify(d));
  // WHICH check refused: a live holder is refused by the held-lock check, before the next sleep
  assert.equal(d.where, 'lock-held', JSON.stringify(d));
  assert.equal(d.holder?.pid, 1, 'the refusal names the holder');
});

test('a lock that keeps vanishing cannot hold a waiter past its budget (the per-iteration check alone)', async () => {
  // readLock always 'vanished' skips the held-lock check and the sleep: only the loop-top check can stop this.
  // That path never awaits, so a missing check would spin SYNCHRONOUSLY (no test timeout could fire):
  // the fake lock therefore throws past a spin cap, turning a hang into a named failure.
  const f = fakeEffects({ keys: [K], passes: [null], lockSeq: ['held'] });
  let t = NOW; let spins = 0;
  f.effects.readLock = () => 'vanished';
  f.effects.tryLock = () => { spins += 1; if (spins > 10_000) throw new Error('spun past the budget: no check stopped the loop'); return 'held'; };
  f.effects.now = () => { t += 500; return t; };
  const d = await acquireOrReuse({ effects: f.effects, ...deadline });
  assert.equal(d.action, 'deadline', JSON.stringify(d));
  assert.equal(d.where, 'lock-attempt', JSON.stringify(d));
});

test('a fresh PASS at the START is reused at once: no lock attempt, no wait', async () => {
  // the lock is free, so the re-check at the lock would ALSO reuse -- this asserts the start check did it, untouched lock
  const f = fakeEffects({ keys: [K], passes: [PASSREC], lockSeq: ['taken'] });
  const d = await acquireOrReuse({ effects: f.effects, ...deadline });
  assert.equal(d.action, 'reuse', JSON.stringify(d));
  assert.equal(d.at, 'start');
  assert.equal(f.calls.tryLock, 0, 'a reusable PASS must not take (and so block others on) the one-suite lock');
});

test('lock: an unreadable lock is held until its file outlives the fallback budget -- never free on sight', () => {
  const s = (lock) => lockState({ lock, nowMs: NOW, pidAlive: undefined, fallbackBudgetMs: 190_000 });
  assert.equal(s({ unreadable: true, mtimeMs: NOW - 1000 }), 'held');
  assert.equal(s({ unreadable: true, mtimeMs: NOW - 191_000 }), 'stale');
  assert.equal(s({ pid: 'x', startedAt: 'never', mtimeMs: NOW - 1000 }), 'held', 'malformed but young');
  assert.equal(s({ pid: 'x', startedAt: 'never', mtimeMs: NOW - 191_000 }), 'stale', 'malformed and old');
});
