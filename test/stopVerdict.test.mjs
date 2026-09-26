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
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/* T-273: a NAMESPACE import for everything new, so this file still LOADS against a module without it and the
 * new tests go red by ASSERTION -- a link error would fail the file with no assertion run (hollow harness). */
import * as SV from '../src/stopVerdict.mjs';
import * as VC from '../src/verifyCache.mjs';
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

test('T-273 window: a PASS is reused up to ONE HOUR (owner decision), never at or past it, never future-dated', () => {
  // Literals, not the constants: a test that reads the bound it checks agrees with itself (hollow gate 2).
  assert.equal(MAX_REUSE_AGE_MS, 600_000, 'the freshness LABEL bound is still 10 minutes');
  assert.equal(SV.REUSE_WINDOW_MS, 3_600_000, 'the reuse window is one hour');
  const reused = (msAgo) => chooseReuse({ records: [rec({ at: iso(msAgo) })], key: H('a'), nowMs: NOW }).reuse;
  assert.ok(reused(600_000 - 1000), 'fresh, just inside 10 min');
  assert.ok(reused(600_000), 'exactly 10 min: refused before T-273, reused (labelled NOT FRESH) now');
  assert.ok(reused(3_600_000 - 1000), 'just inside one hour');
  assert.equal(reused(3_600_000), null, 'at one hour');
  assert.equal(reused(3_600_000 + 1000), null, 'past one hour');
  assert.equal(reused(86_400_000 - 1000), null, 'T-264\'s rejected 24 h window is NOT what shipped');
  assert.equal(reused(-5000), null, 'future-dated');
  // An explicit bound is still honoured.
  assert.equal(chooseReuse({ records: [rec({ at: iso(600_000) })], key: H('a'), nowMs: NOW, maxAgeMs: 600_000 }).reuse, null);
});

test('T-273 NEWEST RECORD DECIDES: a FAIL or DEADLINE newer than a PASS for the same key blocks that PASS', () => {
  const pass = rec({ at: iso(20 * 60_000) });
  for (const outcome of ['fail', 'deadline']) {
    const later = rec({ outcome, at: iso(10 * 60_000) });
    // Positive control first: the PASS alone IS reusable at this moment.
    assert.ok(chooseReuse({ records: [pass], key: H('a'), nowMs: NOW }).reuse, 'precondition: the PASS alone is reused');
    for (const order of [[pass, later], [later, pass]]) {
      const r = chooseReuse({ records: order, key: H('a'), nowMs: NOW });
      assert.equal(r.reuse, null, `a PASS was reused across a newer ${outcome} (store order ${order.map((x) => x.outcome)})`);
      assert.match(String(r.reason), new RegExp(`newest record for this key is a ${outcome}`));
    }
    // A newer non-pass for ANOTHER key does not block this key's PASS.
    assert.ok(chooseReuse({ records: [pass, { ...later, key: H('b') }], key: H('a'), nowMs: NOW }).reuse, `another key's ${outcome}`);
  }
  // Same instant: the non-pass wins, in either store order.
  const t = iso(5 * 60_000);
  for (const order of [[rec({ at: t }), rec({ at: t, outcome: 'fail' })], [rec({ at: t, outcome: 'fail' }), rec({ at: t })]]) {
    assert.equal(chooseReuse({ records: order, key: H('a'), nowMs: NOW }).reuse, null, 'a tie must not reuse');
  }
  // A future-dated FAIL is still NEWER than the PASS, and still blocks it (fail safe on skew).
  assert.equal(chooseReuse({ records: [pass, rec({ outcome: 'fail', at: iso(-60_000) })], key: H('a'), nowMs: NOW }).reuse, null,
    'a future-dated FAIL did not block the PASS');
  // A record for this key whose time cannot be read: its order is unknown, so nothing is reused.
  assert.equal(chooseReuse({ records: [pass, rec({ outcome: 'fail', at: 'not a time' })], key: H('a'), nowMs: NOW }).reuse, null,
    'a record with no readable time let a PASS through');
  // A NEWER PASS after a FAIL is reusable again: the rule recovers.
  const back = chooseReuse({ records: [pass, rec({ outcome: 'fail', at: iso(10 * 60_000) }), rec({ at: iso(60_000) })], key: H('a'), nowMs: NOW });
  assert.equal(back.reuse?.at, iso(60_000), 'the newest PASS, after the FAIL, is the one reused');
});

/* The a543adf9 records, verbatim from ~/.agentbridge/guard-sessions/stop-verdicts.jsonl (lines 54-61, T-265/T-269). */
const A543 = 'a543adf9dc2e76f608f914c53dcfc7eec5cc55bcaf859c034b9d1cae3e94d115';
const A543_RECORDS = [
  ['pass', '2026-09-25T06:45:10.354Z'], ['pass', '2026-09-25T06:57:26.318Z'], ['pass', '2026-09-25T07:09:50.309Z'],
  ['fail', '2026-09-25T07:37:51.230Z'], ['fail', '2026-09-25T07:40:54.989Z'],
  ['pass', '2026-09-25T07:46:15.204Z'], ['pass', '2026-09-25T08:09:59.863Z'],
].map(([outcome, at]) => rec({ key: A543, outcome, at }));
const storeUpTo = (ms) => A543_RECORDS.filter((r) => Date.parse(r.at) <= ms);

test('T-273 THE MEASURED CASE: a543adf9 PASS -> FAIL -> PASS never reuses a PASS across the FAIL', () => {
  const at = (s) => Date.parse(s);
  // After the first FAIL, the 07:09 PASS (28 min old, inside the hour) is NOT reused ...
  const afterFail1 = chooseReuse({ records: storeUpTo(at('2026-09-25T07:39:00Z')), key: A543, nowMs: at('2026-09-25T07:39:00Z') });
  assert.equal(afterFail1.reuse, null, 'the 07:09 PASS was reused across the 07:37 FAIL');
  // ... nor after the second, when the run that PASSED at 07:46 started (07:44:42) ...
  assert.equal(chooseReuse({ records: storeUpTo(at('2026-09-25T07:44:42Z')), key: A543, nowMs: at('2026-09-25T07:44:42Z') }).reuse, null);
  // ... and once the 07:46 PASS exists it IS reused: the rule blocks across a FAIL, it does not ban the key.
  const after = chooseReuse({ records: storeUpTo(at('2026-09-25T07:50:00Z')), key: A543, nowMs: at('2026-09-25T07:50:00Z') });
  assert.equal(after.reuse?.at, '2026-09-25T07:46:15.204Z');
  // Identity first, still: the same records under any other key are never reused.
  assert.equal(chooseReuse({ records: A543_RECORDS, key: H('b'), nowMs: at('2026-09-25T08:10:30Z') }).reuse, null);
});

test('T-273 STATED COST, PINNED: within the hour, a flaky FAIL is never observed -- the 07:36 run would have been a reuse', () => {
  // The first a543adf9 FAIL ran 07:36:18.864Z-07:37:51.230Z (durationMs 92366). When it STARTED, the store
  // held only the three PASSes, the newest 1588 s old. Under the one-hour window that start is a REUSE, so
  // the FAIL would never have been recorded. The owner's ruling accepts this; this test says it out loud,
  // and goes red if the window or the rule changes without somebody re-reading this cost.
  const start = Date.parse('2026-09-25T07:37:51.230Z') - 92_366;
  const r = chooseReuse({ records: storeUpTo(start), key: A543, nowMs: start });
  assert.equal(r.reuse?.at, '2026-09-25T07:09:50.309Z');
  assert.equal(Math.round((start - Date.parse(r.reuse.at)) / 1000), 1589);
});

test('T-273 message: past 10 minutes the reuse says NOT FRESH first; a fresh one keeps the old wording', () => {
  const fresh = reusedPassMessage(rec({ at: iso(60_000) }), NOW);
  assert.ok(!fresh.includes('NOT FRESH'), fresh);
  assert.ok(fresh.startsWith('[agentbridge:stop-verdict-reused] The suite was NOT run for this turn. A PASS recorded 60s ago'), fresh);
  const edge = reusedPassMessage(rec({ at: iso(600_000) }), NOW);
  assert.ok(edge.includes('NOT FRESH: this PASS is 10 minutes old'), edge);
  const old = reusedPassMessage(rec({ at: iso(47 * 60_000 + 30_000) }), NOW);
  assert.ok(old.startsWith('[agentbridge:stop-verdict-reused] The suite was NOT run for this turn. NOT FRESH: this PASS is 47 minutes old, past the 10-minute freshness bound'), old);
  assert.ok(old.includes(REUSE_RESIDUAL), 'the residual still travels with the claim');
  assert.ok(old.includes('changes made and reverted during the run are not excluded.'), 'and the ABA residual');
});

test('T-273 IMMEDIATE STATE-CHANGE INVALIDATION: a one-byte change to one tracked file is a new key, so no reuse', () => {
  const before = parts();
  const after = parts();
  after.tracked = after.tracked.map(([rel, h]) => (rel === 'src/a.mjs' ? [rel, `${h.slice(0, -1)}${h.endsWith('0') ? '2' : '0'}`] : [rel, h]));
  assert.notDeepEqual(after.tracked, before.tracked, 'precondition: exactly one tracked file digest changed');
  const kBefore = verdictKey(before);
  const kAfter = verdictKey(after);
  assert.notEqual(kAfter, kBefore);
  const store = [rec({ key: kBefore, at: iso(60_000) })];
  assert.ok(chooseReuse({ records: store, key: kBefore, nowMs: NOW }).reuse, 'positive control: the unchanged tree reuses');
  assert.equal(chooseReuse({ records: store, key: kAfter, nowMs: NOW }).reuse, null, 'the changed tree reused the old PASS');
  // The same holds end to end through the real gate: test/stopGateHallPass.test.mjs "T-273 one-byte" (T-292 F6).
});

test('T-273 EXCLUDED_ENV is read by NO file in the repository (case-insensitive, whole tree; positive control first)', () => {
  /*
   * T-265 L1: the T-264 version searched exact-case literals in listed directories. This walks the WHOLE
   * repository (all but .git and node_modules), reads BYTES (the two NUL-framed files grep skips), and
   * matches case-insensitively in latin1 and in UTF-16LE. STATED LIMIT: a name built at runtime, or a
   * wholesale read of process.env, is invisible to any byte scan.
   */
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(repo);
  /* The module that DEFINES the list, and THIS file, whose own literals would satisfy every search. */
  const skip = new Set([path.join(repo, 'src', 'stopVerdict.mjs'), fileURLToPath(import.meta.url)].map((p) => p.toLowerCase()));
  const texts = files.filter((f) => !skip.has(f.toLowerCase())).map((f) => {
    const b = readFileSync(f);
    return [f, `${b.toString('latin1').toLowerCase()}\n${b.length % 2 === 0 ? b.toString('utf16le').toLowerCase() : ''}`];
  });
  const readers = (name) => texts.filter(([, t]) => t.includes(name.toLowerCase())).map(([f]) => path.relative(repo, f));
  assert.equal(files.filter((f) => skip.has(f.toLowerCase())).length, 2, 'precondition: both skipped files were found (spelling matches)');
  assert.ok(files.length > 100, `precondition: the walk found the repository (${files.length} files)`);
  assert.ok(readers('AGENTBRIDGE_HOME').length > 0, 'POSITIVE CONTROL: the scanner finds a variable the code does read');
  assert.ok(readers('agentbridge_home').length > 0, 'POSITIVE CONTROL: and finds it spelled in lower case');
  for (const name of ['CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'AI_AGENT']) {
    assert.ok(EXCLUDED_ENV.includes(name), `T-264/T-273: ${name} is excluded from the key`);
  }
  for (const name of EXCLUDED_ENV) assert.deepEqual(readers(name), [], `${name} is excluded from the key but appears in the repository`);
});

/* ── T-273: the failing test's identity ── */

/* Real node v24.19.0 output (live/T-273/work/probe-reporters.mjs), trimmed: TAP and the spec reporter. */
const TAP_OUT = [
  'TAP version 13', '# Subtest: passes', 'ok 1 - passes', '  ---', '  duration_ms: 0.5', "  type: 'test'", '  ...',
  "# Subtest: fails with it's quote", "not ok 2 - fails with it's quote", '  ---', '  duration_ms: 0.6', "  type: 'test'",
  "  failureType: 'testCodeFailure'", '  error: |-', "    one isn't two", '    ', '    1 !== 2', "  code: 'ERR_ASSERTION'",
  '  stack: |-', '    TestContext.<anonymous> (file:///x/a.test.mjs:4:46)', '  ...',
  '# Subtest: parent', '    # Subtest: child fails', '    not ok 1 - child fails', '      ---', "      failureType: 'testCodeFailure'",
  '      error: |-', '        line one', '        line two', '      ...', '    1..1',
  'not ok 3 - parent', '  ---', "  failureType: 'subtestsFailed'", "  error: '1 subtest failed'", '  ...',
  'not ok 4 - has \\# hash # TODO later', '  ---', "  error: 'todo is not a failure'", '  ...',
  'not ok 5 - test\\\\b.test.mjs', '  ---', "  failureType: 'testCodeFailure'", "  error: 'test failed'", '  ...',
  '1..5', '# tests 6', '# pass 1', '# fail 4',
].join('\n');
const SPEC_OUT = [
  '✔ passes (0.527ms)', "✖ fails with it's quote (0.6164ms)", '▶ parent', '  ✖ child fails (0.0995ms)', '✖ parent (0.299ms)',
  'ℹ tests 6', 'ℹ fail 5', '', '✖ failing tests:', '', 'test at test\\a.test.mjs:4:1', "✖ fails with it's quote (0.6164ms)",
  "  AssertionError [ERR_ASSERTION]: one isn't two", '  ', '  1 !== 2', '', 'test at test\\a.test.mjs:5:39', '✖ child fails (0.0995ms)',
  '  Error: line one', '  line two', '', 'test at test\\b.test.mjs:1:1', '✖ test\\b.test.mjs (43.4812ms)', "  'test failed'",
].join('\n');

test('T-273 failingTests reads TAP: leaf failures in order, parents marked, TODO skipped, escapes undone, first message line', () => {
  const f = SV.failingTests(TAP_OUT);
  assert.deepEqual(f, [
    { name: "fails with it's quote", message: "one isn't two", parent: false },
    { name: 'child fails', message: 'line one', parent: false },
    { name: 'parent', message: '1 subtest failed', parent: true },
    { name: 'test\\b.test.mjs', message: 'test failed', parent: false },
  ]);
  assert.equal(SV.firstFailing(f).name, "fails with it's quote");
  assert.equal(SV.firstFailing([{ name: 'p', parent: true }, { name: 'leaf', parent: false }]).name, 'leaf', 'a leaf is named before a parent');
  assert.deepEqual(SV.failingTests(TAP_OUT.replace(/\n/g, '\r\n')), f, 'CRLF output reads the same');
  assert.deepEqual(SV.failingTests('ok 1 - fine\n# tests 1\n'), [], 'a clean run names nothing');
  assert.deepEqual(SV.failingTests(null), [], 'no output names nothing');
});

test('T-273 failingTests reads the spec reporter\'s "failing tests" section, and a truncated one', () => {
  assert.deepEqual(SV.failingTests(SPEC_OUT), [
    { name: "fails with it's quote", message: "AssertionError [ERR_ASSERTION]: one isn't two", parent: false },
    { name: 'child fails', message: 'Error: line one', parent: false },
    { name: 'test\\b.test.mjs', message: "'test failed'", parent: false },
  ]);
  // Output whose head (and the section header) was cut: every ✖ line still names something.
  const cut = SPEC_OUT.split('\n').slice(0, 5).join('\n');
  assert.deepEqual(SV.failingTests(cut).map((x) => x.name), ["fails with it's quote", 'child fails', 'parent']);
});

test('T-273 failureReport: names and first lines only, capped, and NO environment or secret value in any spelling', () => {
  const secret = `T273-sEcReT'"\\/???>>>-${'x'.repeat(12)}`;
  const envVal = 'C:\\Users\\someone\\private-dir';
  const spellings = SV.secretSpellings(secret);
  assert.ok(spellings.length >= 8, 'precondition: many spellings are generated');
  // base64 and base64url must DIFFER here, or dropping either spelling would be a no-op nobody could see (rule 11).
  assert.match(Buffer.from(secret).toString('base64'), /[+/]/, 'precondition: this secret\'s base64 has a + or /');
  const leak = (s) => `leak raw=${s} json=${JSON.stringify(s)} dbl=${JSON.stringify(JSON.stringify(s))} yaml=${s.replace(/'/g, "''")} `
    + `slash=${s.replace(/\\/g, '/')} pct=${encodeURIComponent(s)} b64=${Buffer.from(s).toString('base64')} up=${s.toUpperCase()} low=${s.toLowerCase()}`;
  // Test 1's name carries the value as node's TAP writes it (backslashes escaped); test 2's name carries it
  // UNESCAPED, which failingTests' unescape turns into a backslash-free spelling.
  const tap = `not ok 1 - reads ${envVal.replace(/\\/g, '\\\\')}\n  ---\n  error: |-\n    ${leak(secret)} env=${JSON.stringify(envVal)} jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig Bearer abcdefghijklmnop123\n  ...\n`
    + `not ok 2 - raw ${envVal} and ${secret}\n  ---\n  error: '${secret.replace(/'/g, "''")}'\n  ...\n`;
  const r = SV.failureReport({
    output: tap, at: '2026-09-25T07:37:51.230Z', key: A543, outcome: 'fail', counts: { tests: 2099, fail: 1 },
    secrets: [{ label: 'secret', value: secret }, { label: 'env:PRIVATE', value: envVal }, { label: 'env:SHORT', value: 'tiny' }],
  });
  assert.ok(r.text.includes('not ok - reads [redacted:env:PRIVATE]'), r.text);
  assert.equal(r.first, 'reads [redacted:env:PRIVATE]');
  assert.equal(r.named, 2);
  assert.ok(r.text.includes('not ok - raw [redacted:env:PRIVATE] and [redacted:secret]'), r.text);
  assert.ok(r.text.includes('key: a543adf9dc2e76f6'), 'the key prefix is kept');
  assert.ok(!r.text.includes(A543), 'the full key is not');
  const low = r.text.toLowerCase();
  /*
   * The spellings checked are built HERE, independently of secretSpellings: a check that asked the code under
   * test which spellings to look for would stop looking for exactly the one a regression dropped (hollow gate 2).
   * And FRAGMENTS are checked, every 10-character window of every spelling, so a secret cut in half by a cap
   * placed before the redaction is still caught.
   */
  const own = (v) => [v, JSON.stringify(v).slice(1, -1), JSON.stringify(JSON.stringify(v)).slice(1, -1), v.replace(/'/g, "''"),
    v.replace(/\\/g, '/'), encodeURIComponent(v), Buffer.from(v).toString('base64')];
  for (const sp of [...own(secret), ...own(envVal)]) {
    assert.ok(!low.includes(sp.toLowerCase()), `spelling leaked: ${sp}\n${r.text}`);
    for (let k = 0; k + 10 <= sp.length; k += 1) {
      assert.ok(!low.includes(sp.slice(k, k + 10).toLowerCase()), `a fragment of a secret leaked: ${sp.slice(k, k + 10)}\n${r.text}`);
    }
  }
  assert.ok(!low.includes('t273-secret'), `a fragment of the secret leaked:\n${r.text}`);
  assert.ok(!r.text.includes('eyJhbGciOiJIUzI1NiJ9'), 'a JWT leaked');
  assert.ok(!r.text.includes('abcdefghijklmnop123'), 'a bearer token leaked');
  // Caps: many failures, huge names.
  const many = Array.from({ length: 60 }, (_, i) => `not ok ${i + 1} - ${'n'.repeat(500)}${i}\n  ---\n  error: '${'m'.repeat(900)}'\n  ...`).join('\n');
  const big = SV.failureReport({ output: many, at: 'x', key: null, outcome: 'fail', counts: {}, secrets: [] });
  assert.ok(Buffer.byteLength(big.text) <= SV.FAILURE_LIMITS.bytes, `capped in bytes: ${Buffer.byteLength(big.text)}`);
  assert.equal(big.named, 60);
  assert.ok(big.text.includes('failing tests named: 60 (first 25 kept)'), big.text.slice(0, 400));
  assert.ok(big.first.length <= SV.FAILURE_LIMITS.name, 'the refusal\'s name is capped');
  assert.equal(SV.failureFileName('2026-09-25T07:37:51.230Z', A543), '2026-09-25T07-37-51-230Z-a543adf9.txt');
  assert.equal(SV.failureFileName('2026-09-25T07:37:51.230Z', 'short'), '2026-09-25T07-37-51-230Z-nokey.txt');
  assert.match(SV.failureRefusalLine({ first: 'x', named: 1, file: 'f.txt' }), /^\[agentbridge:stop-failing-test\] First failing test: "x" \(1 failing test\(s\) named; kept in f\.txt\)\.$/);
  assert.match(SV.failureRefusalLine({ first: null, named: 0, file: null }), /No failing test could be named.*could not be written/);
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

test('T-273 every src/ module the Stop gate imports is PROTECTED, in guardSession AND policy (generated from the gate)', async () => {
  /*
   * T-265 demonstrated it: src/stopVerdict.mjs was not protected on master, the gate imports it from the working
   * tree, and dropping the key check in it made the gate APPROVE a failing tree. Generated from the gate's own
   * import statements (static and dynamic), so a new import is covered without anybody remembering to add it.
   */
  const G = await import('../src/guardSession.mjs');
  const P = await import('../src/policy.mjs');
  const gateText = readFileSync(new URL('../scripts/claude-stop-gate.mjs', import.meta.url), 'utf8');
  const imported = [...new Set([...gateText.matchAll(/(?:\bfrom|\bimport\()\s*'\.\.\/(src\/[^']+\.mjs)'/g)].map((m) => m[1]))].sort();
  for (const must of ['src/guardSession.mjs', 'src/safeGit.mjs', 'src/stopVerdict.mjs']) {
    assert.ok(imported.includes(must), `precondition: the scan finds the gate's import of ${must} (found ${imported})`);
  }
  for (const rel of imported) {
    assert.equal(G.isProtectedRelPath(rel), true, `guardSession does not protect ${rel}, which the Stop gate imports`);
    assert.equal(P.isProtectedRelPath(rel), true, `policy does not protect ${rel}, which the Stop gate imports`);
  }
  assert.equal(G.isProtectedRelPath('src/notImportedByTheGate.mjs'), false, 'NEGATIVE CONTROL: not everything is protected');
});

/* ── T-273: the hall pass (owner: "if your job runs late you can't be dinged if it runs") ── */

/* ── T-344: ONE SOURCE -- the per-key outcome log decides the hall pass ── */

/* A log as the gate lists it: entries built by the module's OWN writer, so a test cannot drift from the format.
 * LK has the REAL store-key shape (verifyCache.verifyKey: 32 hex) -- a 64-hex fixture once hid that the gate could
 * read no log at all (rule 9). */
const LK = 'a'.repeat(32);
const entry = (seq, outcome, over = {}) => ({
  name: SV.outcomeEntryName(seq),
  text: SV.formatOutcomeEntry({ key: LK, seq, outcome, at: iso(1000 * (100 - seq)), first: outcome === 'fail' ? `failing test ${seq}` : null, ...over }),
});
const logOf = (...outcomes) => SV.parseOutcomeLog({ key: LK, listing: { entries: outcomes.map((o, i) => entry(i + 1, o)) } });
const okDecision = { cause: 'suite-running', key: H('a'), debt: null, failuresSeen: 0, recordUnreadable: false };

test('T-344 hallPassDecision: issued ONLY for a late job with a key, no debt, no failure seen, and a log whose LAST entry is not a FAIL', () => {
  const ok = { ...okDecision, log: logOf() };
  assert.deepEqual(SV.hallPassDecision(ok), { issue: true, why: null }, 'POSITIVE CONTROL: nothing ever completed -- a late run is issued a hall pass');
  assert.equal(SV.hallPassDecision({ ...ok, cause: 'lock-held' }).issue, true, 'and so is a lock wait');
  assert.equal(SV.hallPassDecision({ ...ok, log: logOf('pass') }).issue, true, 'a last PASS issues');
  assert.equal(SV.hallPassDecision({ ...ok, log: logOf('fail', 'pass') }).issue, true, 'a PASS after a FAIL recovers');
  const refused = (over, why) => {
    const d = SV.hallPassDecision({ ...ok, ...over });
    assert.equal(d.issue, false, `issued despite ${JSON.stringify(over)}`);
    assert.match(String(d.why), why);
    return d;
  };
  for (const cause of ['pre-suite', 'deadline', '', undefined, 'SUITE-RUNNING']) refused({ cause }, /covers only a run still going or a held lock/);
  refused({ debt: { key: H('b'), at: iso(1000) } }, /already owes verification .* cannot be deferred again/);
  refused({ debt: { key: null, at: null, corrupt: true } }, /already owes verification/);
  for (const failuresSeen of [1, 7, null, undefined, NaN, '0']) refused({ failuresSeen }, /had already FAILED/);
  for (const key of [null, '', 'short', H('a').toUpperCase()]) refused({ key }, /no key could be observed/);
  for (const log of [null, undefined, {}, { ok: false, why: 'x' }, { ok: 'true', count: 0, last: null }, { ok: true, last: null }]) {
    refused({ log }, /outcome log for these inputs could not be read/);
  }
  const d = refused({ log: logOf('pass', 'fail') }, /newest completed result for these inputs is a FAIL \(outcome log entry #2\)/);
  assert.equal(d.knownFail, true);
  assert.equal(d.first, 'failing test 2', 'the refusal carries the failing test the LOG entry names');
  assert.equal(d.seq, 2);
  refused({ log: logOf('fail', 'pass', 'fail') }, /entry #3/);
  // The one veto: an unreadable record refuses; the flag must be EXACTLY false to issue (fail closed on omission).
  for (const recordUnreadable of [true, undefined, null, 0, 'false']) refused({ recordUnreadable }, /verify record for these inputs exists but cannot be read/);
  assert.deepEqual(SV.HALL_PASS_CAUSES, ['suite-running', 'lock-held']);
});

test('T-344 V3: a known FAIL is reported -- and its test named -- even when this session ALSO owes a debt', () => {
  const d = SV.hallPassDecision({ ...okDecision, debt: { key: H('b'), at: iso(1000) }, log: logOf('pass', 'fail') });
  assert.equal(d.issue, false);
  assert.equal(d.knownFail, true, 'the debt masked the known FAIL (T-331 V3)');
  assert.equal(d.first, 'failing test 2');
  assert.match(d.why, /is a FAIL .*; and this session already owes verification/, 'both reasons are said');
  // POSITIVE CONTROL: with no FAIL, the same debt still refuses on its own account.
  const owes = SV.hallPassDecision({ ...okDecision, debt: { key: H('b'), at: iso(1000) }, log: logOf('pass') });
  assert.equal(owes.knownFail, undefined);
  assert.match(owes.why, /^this session already owes verification/);
});

test('T-344 ORDER IS BY SEQUENCE, NEVER BY CLOCK: the later entry decides whatever its timestamp says (checklist K)', () => {
  const at = (msAgo) => iso(msAgo);
  const listing = (a, b) => ({ entries: [entry(1, a[0], { at: at(a[1]) }), entry(2, b[0], { at: at(b[1]) })] });
  // FAIL written second but stamped 2 h EARLIER than the PASS (the clock stepped back): the FAIL still decides.
  const back = SV.parseOutcomeLog({ key: LK, listing: listing(['pass', 1000], ['fail', 7_201_000]) });
  assert.equal(back.last.outcome, 'fail');
  assert.equal(SV.hallPassDecision({ ...okDecision, log: back }).issue, false, 'a clock step back let an older-stamped PASS win');
  // PASS written second but stamped 2 h earlier: the PASS decides (recovery is by write order too).
  const fwd = SV.parseOutcomeLog({ key: LK, listing: listing(['fail', 1000], ['pass', 7_201_000]) });
  assert.equal(SV.hallPassDecision({ ...okDecision, log: fwd }).issue, true);
  // Same instant: order decides, in either direction (the r3 "tie" rule is gone, not needed).
  const same = (a, b) => SV.parseOutcomeLog({ key: LK, listing: { entries: [entry(1, a, { at: iso(5000) }), entry(2, b, { at: iso(5000) })] } });
  assert.equal(SV.hallPassDecision({ ...okDecision, log: same('pass', 'fail') }).issue, false);
  assert.equal(SV.hallPassDecision({ ...okDecision, log: same('fail', 'pass') }).issue, true);
  // The listing's ORDER is not the sequence either: a directory may list in any order.
  const shuffled = SV.parseOutcomeLog({ key: LK, listing: { entries: [entry(3, 'pass'), entry(1, 'fail'), entry(2, 'fail')] } });
  assert.deepEqual([shuffled.count, shuffled.last.seq, shuffled.last.outcome], [3, 3, 'pass']);
});

test('T-344 parseOutcomeLog: missing is "none"; anything malformed ANYWHERE is unreadable (checklist U, generated)', () => {
  assert.deepEqual(SV.parseOutcomeLog({ key: LK, listing: { missing: true } }), { ok: true, count: 0, last: null }, 'no directory: nothing ever completed');
  assert.deepEqual(SV.parseOutcomeLog({ key: LK, listing: { entries: [] } }), { ok: true, count: 0, last: null }, 'an empty directory: nothing ever completed');
  const good = [entry(1, 'pass'), entry(2, 'fail'), entry(3, 'pass')];
  const base = SV.parseOutcomeLog({ key: LK, listing: { entries: good } });
  assert.equal(base.ok, true, `POSITIVE CONTROL: the well-formed log reads: ${base.why}`);
  assert.equal(base.count, 3);
  // Each corruption applied to EACH entry position in turn: "anywhere" means the first and the middle too.
  const text = (e) => e.text;
  const corruptions = {
    'NUL-filled at the same size': (e) => ({ ...e, text: '\0'.repeat(Buffer.byteLength(text(e))) }),
    empty: (e) => ({ ...e, text: '' }),
    'truncated mid-entry': (e) => ({ ...e, text: text(e).slice(0, Math.floor(text(e).length / 2)) }),
    'cut just before its newline': (e) => ({ ...e, text: text(e).slice(0, -1) }),
    'two lines': (e) => ({ ...e, text: `${text(e)}${text(e)}` }),
    'unreadable (read error)': (e) => ({ name: e.name, error: 'EACCES' }),
    'not text': (e) => ({ ...e, text: Buffer.from(text(e)) }),
    'another key': (e) => ({ ...e, text: text(e).replace(LK, 'b'.repeat(32)) }),
    'wrong seq field': (e) => ({ ...e, text: text(e).replace(/"seq":(\d+)/, (m, n) => `"seq":${Number(n) + 10}`) }),
    'seq as a string': (e) => ({ ...e, text: text(e).replace(/"seq":(\d+)/, '"seq":"$1"') }),
    'unknown outcome': (e) => ({ ...e, text: text(e).replace(/"outcome":"(pass|fail)"/, '"outcome":"deadline"') }),
    'outcome upper-cased': (e) => ({ ...e, text: text(e).replace(/"outcome":"(pass|fail)"/, (m, o) => `"outcome":"${o.toUpperCase()}"`) }),
    'bad time': (e) => ({ ...e, text: text(e).replace(/"at":"[^"]+"/, '"at":"yesterday"') }),
    'wrong label': (e) => ({ ...e, text: text(e).replace(/"label":"[^"]+"/, '"label":"x"') }),
    'v 2': (e) => ({ ...e, text: text(e).replace('"v":1', '"v":2') }),
    'extra field': (e) => ({ ...e, text: text(e).replace('"v":1', '"v":1,"extra":true') }),
    'missing field': (e) => ({ ...e, text: text(e).replace(/,"session":(null|"[^"]*")/, '') }),
    'cut as a string': (e) => ({ ...e, text: text(e).replace(/"cut":(true|false)/, '"cut":"no"') }),
    'first a number': (e) => ({ ...e, text: text(e).replace(/"first":(null|"[^"]*")/, '"first":7') }),
    'first empty': (e) => ({ ...e, text: text(e).replace(/"first":(null|"[^"]*")/, '"first":""') }),
    'JSON null': (e) => ({ ...e, text: 'null\n' }),
    'JSON array': (e) => ({ ...e, text: '[]\n' }),
    'a stray name': (e) => ({ ...e, name: `${e.name}.tmp` }),
    'name not 12 digits': (e) => ({ ...e, name: e.name.slice(1) }),
    'name seq 0': (e) => ({ ...e, name: '000000000000.json' }),
  };
  for (const [how, fn] of Object.entries(corruptions)) {
    for (let i = 0; i < good.length; i += 1) {
      const entries = good.map((e, j) => (j === i ? fn(e) : e));
      let r;
      try { r = SV.parseOutcomeLog({ key: LK, listing: { entries } }); } catch (e) { r = { threw: e.message }; }
      assert.equal(r.ok, false, `${how} at entry #${i + 1} was read as a log: ${JSON.stringify(r)}`);
      assert.equal(typeof r.why, 'string', `${how}: a refusal says why`);
    }
  }
  // Whole-log shapes.
  const whole = {
    'a gap (entry #2 deleted)': { entries: [good[0], good[2]] },
    'a duplicate name': { entries: [good[0], good[0]] },
    'a listing error': { error: 'ENOTDIR' },
    'entries not an array': { entries: 'x' },
    'no listing': null,
  };
  for (const [how, listing] of Object.entries(whole)) {
    assert.equal(SV.parseOutcomeLog({ key: LK, listing }).ok, false, `${how} was read as a log`);
  }
  for (const key of ['short', H('a'), LK.toUpperCase(), null]) assert.equal(SV.parseOutcomeLog({ key, listing: { missing: true } }).ok, false, `no store key (${key}), no log`);
  // THE REAL SHAPE, end to end: the key verifyKey makes for an identity is one this log accepts.
  const real = VC.verifyKey({ tree_digest: H('a'), command: 'node --test', toolchain: 'node', env_digest: 'e' });
  assert.equal(real.ok, true, 'precondition: a real store key');
  assert.equal(SV.parseOutcomeLog({ key: real.key, listing: { missing: true } }).ok, true, `the real store key shape (${real.key}) is refused`);
  assert.equal(SV.parseOutcomeLog().ok, false, 'no argument at all');
  // Deleting the LAST entry leaves a well-formed shorter log: that is outside the contract (deliberate same-user
  // deletion), pinned here so a change to it is seen.
  assert.equal(SV.parseOutcomeLog({ key: LK, listing: { entries: good.slice(0, 2) } }).last.outcome, 'fail');
});

test('T-344 parseOutcomeLog is TOTAL: a hostile container throws nothing, it refuses (checklist T)', () => {
  const trap = new Proxy({}, { get() { throw new Error('trap'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const throwingName = { get name() { throw new Error('getter'); } };
  const cases = {
    'listing is a trap': { key: LK, listing: trap },
    'listing is revoked': { key: LK, listing: revoked.proxy },
    'entries contain a trap': { key: LK, listing: { entries: [trap] } },
    'an entry name getter throws': { key: LK, listing: { entries: [throwingName] } },
    'entries is a trap array': { key: LK, listing: { entries: new Proxy([], { get() { throw new Error('arr'); } }) } },
    'an error that cannot be stringified': { key: LK, listing: { error: { toString() { throw new Error('s'); } } } },
  };
  for (const [how, arg] of Object.entries(cases)) {
    let r;
    try { r = SV.parseOutcomeLog(arg); } catch (e) { r = { threw: e.message }; }
    assert.equal(r.threw, undefined, `${how}: threw`);
    assert.equal(r.ok, false, `${how}: read as a log`);
  }
});

test('T-344 formatOutcomeEntry and outcomeEntryName: one line, round-trips, refuses what it cannot write', () => {
  const t = SV.formatOutcomeEntry({ key: LK, seq: 7, outcome: 'fail', at: iso(0), first: 'a\nb\u0000c', cut: true, session: 'S' });
  assert.ok(t.endsWith('\n') && t.indexOf('\n') === t.length - 1, 'one line');
  assert.deepEqual(JSON.parse(t), { v: 1, label: SV.OUTCOME_LOG_LABEL, key: LK, seq: 7, outcome: 'fail', at: iso(0), first: 'a b c', cut: true, session: 'S' });
  assert.ok(JSON.parse(t).label.includes('honest-error detection only'), 'the label travels on the entry');
  assert.equal(SV.formatOutcomeEntry({ key: LK, seq: 1, outcome: 'fail', at: iso(0), first: 'x'.repeat(500) }).includes('x'.repeat(201)), false, 'the name is capped');
  assert.equal(SV.outcomeEntryName(1), '000000000001.json');
  assert.equal(SV.outcomeEntryName(123456789012), '123456789012.json');
  for (const seq of [0, -1, 1.5, '1', 1e12, NaN]) assert.throws(() => SV.outcomeEntryName(seq), /bad sequence number/, String(seq));
  for (const key of ['short', H('a')]) assert.throws(() => SV.formatOutcomeEntry({ key, seq: 1, outcome: 'pass', at: iso(0) }), /32-hex store key/);
  for (const outcome of ['deadline', 'PASS', undefined]) assert.throws(() => SV.formatOutcomeEntry({ key: LK, seq: 1, outcome, at: iso(0) }), /pass or a fail/);
});

test('T-344 recordIsUnreadable: the veto fires on a record that exists and cannot be read, and on nothing else', () => {
  for (const state of SV.VERIFY_STATES) assert.equal(SV.recordIsUnreadable(JSON.stringify({ state })), false, `POSITIVE CONTROL: ${state} is readable`);
  for (const [how, text] of [['NUL-filled', '\0'.repeat(300)], ['empty', ''], ['truncated', '{"state":"VERIFY_FAI'], ['null', 'null'],
    ['an array', '[]'], ['unknown state', '{"state":"VERIFY_SOMETHING"}'], ['lower-cased state', '{"state":"verify_passed"}'], ['no state', '{}'], ['undefined', undefined]]) {
    assert.equal(SV.recordIsUnreadable(text), true, how);
  }
});

test('T-273 r2 firstFailingFromReport: names the first LEAF of a failure file for exactly this key', () => {
  const key = H('e');
  const text = SV.failureReport({
    output: TAP_OUT, at: '2026-09-25T07:37:51.230Z', key, outcome: 'fail', counts: { tests: 6, fail: 4 }, secrets: [],
  }).text;
  assert.equal(SV.firstFailingFromReport(text, key), "fails with it's quote", 'POSITIVE CONTROL: the report written for this key');
  assert.equal(SV.firstFailingFromReport(text.replace(/\r?\n/g, '\r\n'), key), "fails with it's quote", 'CRLF');
  assert.equal(SV.firstFailingFromReport(text, `${'e'.repeat(8)}${'f'.repeat(56)}`), null, 'same 8-char file-name prefix, another key');
  assert.equal(SV.firstFailingFromReport(text, 'short'), null, 'no key');
  const parentFirst = text.replace("not ok - fails with it's quote", 'not ok - p (a subtest failed)');
  assert.equal(SV.firstFailingFromReport(parentFirst, key), 'child fails', 'a leaf is named before a parent');
  assert.equal(SV.firstFailingFromReport(`key: ${key.slice(0, 16)}\nnot ok - only (a subtest failed)\n`, key), 'only', 'a parent alone is still named');
  assert.equal(SV.firstFailingFromReport(`key: ${key.slice(0, 16)}\n`, key), null, 'nothing named');
});

test('T-273 debtSettledBy: only a PASS for the owed key, or one recorded at or after the hall pass', () => {
  const debt = { key: H('a'), at: iso(10_000), corrupt: false };
  assert.equal(SV.debtSettledBy({ debt: null, record: null }), true, 'no debt: nothing to settle');
  assert.equal(SV.debtSettledBy({ debt, record: rec({ key: H('a'), at: iso(60_000) }) }), true, 'the owed key, even from before');
  assert.equal(SV.debtSettledBy({ debt, record: rec({ key: H('b'), at: iso(5_000) }) }), true, 'a later state, recorded after');
  assert.equal(SV.debtSettledBy({ debt, record: rec({ key: H('b'), at: iso(10_000) }) }), true, 'at the same instant');
  assert.equal(SV.debtSettledBy({ debt, record: rec({ key: H('b'), at: iso(10_001) }) }), false, 'another state, recorded BEFORE the hall pass');
  for (const outcome of ['fail', 'deadline']) {
    assert.equal(SV.debtSettledBy({ debt, record: rec({ key: H('a'), outcome, at: iso(1) }) }), false, `a ${outcome} never settles`);
  }
  assert.equal(SV.debtSettledBy({ debt, record: null }), false, 'no record never settles');
  assert.equal(SV.debtSettledBy({ debt: { key: null, at: null, corrupt: true }, record: rec({ key: H('a'), at: iso(1) }) }), false,
    'a corrupt debt is settled by no reuse');
  // The corrupt flag itself, where it is not redundant (rule 11): even a corrupt debt that carried a key and a
  // time is settled by no reuse.
  assert.equal(SV.debtSettledBy({ debt: { key: H('a'), at: iso(10_000), corrupt: true }, record: rec({ key: H('a'), at: iso(1) }) }), false,
    'a corrupt debt is settled by no reuse, whatever it carries');
});

test('T-273 debt file: round-trips; anything malformed is STILL a debt (fail closed)', () => {
  const text = SV.formatDebt({ session: 'S', key: H('c'), at: iso(0), cause: 'lock-held' });
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(SV.parseDebt(text), { key: H('c'), at: iso(0), cause: 'lock-held', corrupt: false });
  assert.ok(JSON.parse(text).label.includes('unverified, still owed'), 'the label travels on the file');
  for (const bad of ['', 'not json', '{}', text.replace('"v":1', '"v":2'), text.replace(H('c'), 'short'),
    text.replace(iso(0), 'yesterday'), JSON.stringify({ ...JSON.parse(text), label: 'x' })]) {
    assert.deepEqual(SV.parseDebt(bad), { key: null, at: null, cause: null, corrupt: true }, `not a debt: ${bad}`);
  }
});

test('T-273 hallPassMessage says NOT an approval first, names the key, the file and the rule', () => {
  for (const cause of ['suite-running', 'lock-held']) {
    const m = SV.hallPassMessage({ key: H('d'), cause, file: 'C:/h/stop-debts/x.json' });
    assert.ok(m.startsWith('[agentbridge:stop-hall-pass] UNVERIFIED, STILL OWED -- this is NOT an approval and NOT a pass: '), m);
    assert.ok(m.includes(`key ${H('d').slice(0, 16)}`), m);
    assert.ok(m.includes('C:/h/stop-debts/x.json'), m);
    assert.ok(m.includes('a FAIL refuses and names the failing test, and it cannot be deferred by a second hall pass'), m);
  }
  assert.match(SV.hallPassMessage({ key: H('d'), cause: 'suite-running', file: 'f' }), /suite was still running/);
  assert.match(SV.hallPassMessage({ key: H('d'), cause: 'lock-held', file: 'f' }), /held the one-suite lock/);
});

/*
 * T-344 r2 (verifier §5 F1, F4): WHICH ENTRY A COMPLETED RUN APPENDS. A known red is a FAIL whatever the run's final
 * state and whether or not its key held; a PASS needs VERIFY_PASSED, a held key and no failing test named; a partial
 * run that names no failing test appends nothing. The rows are GENERATED over state x output x key-held.
 */
test('T-344 r2 completedOutcome: a completed run that NAMES a failing test is a FAIL whatever its state or key', () => {
  assert.equal(typeof SV.completedOutcome, 'function', 'stopVerdict.completedOutcome exists');
  const RED = "TAP version 13\nnot ok 1 - first rig test\n  ---\n  error: 'rig says red'\n  ...\n1..1\n";
  const GREEN = 'TAP version 13\nok 1 - first rig test\n1..1\n';
  const SKIPPED = 'TAP version 13\nnot ok 1 - later # TODO\n1..1\n';          // a TODO not-ok is not a failure
  const OUTPUTS = { red: RED, green: GREEN, 'todo only': SKIPPED, empty: '', absent: undefined };
  for (const state of ['VERIFY_FAILED', 'VERIFY_PARTIAL', 'VERIFY_PASSED', 'VERIFY_TIMED_OUT', 'VERIFY_RUNNING', undefined]) {
    for (const [what, failingOutput] of Object.entries(OUTPUTS)) {
      for (const keysAgree of [true, false]) {
        const got = SV.completedOutcome({ state, failingOutput, keysAgree });
        const want = state === 'VERIFY_FAILED' || what === 'red' ? 'fail'
          : state === 'VERIFY_PASSED' && keysAgree ? 'pass' : null;
        assert.equal(got, want, `state ${state}, output ${what}, keys ${keysAgree ? 'held' : 'MOVED'}: got ${got}`);
      }
    }
  }
});
test('T-344 r2 completedOutcome (F1): a PARTIAL run that printed `not ok` is a FAIL; a PARTIAL that named none is nothing', () => {
  assert.equal(SV.completedOutcome({ state: 'VERIFY_PARTIAL', failingOutput: 'not ok 1 - first rig test\n', keysAgree: true }), 'fail');
  assert.equal(SV.completedOutcome({ state: 'VERIFY_PARTIAL', failingOutput: 'ok 1 - a\n', keysAgree: true }), null);
});
test('T-344 r2 parseOutcomeLog: an entry carrying a carriage return (CRLF-terminated) is malformed, like a BOM', () => {
  const key = 'c'.repeat(32);
  const text = SV.formatOutcomeEntry({ key, seq: 1, outcome: 'fail', at: '2026-09-25T00:00:00.000Z', first: 'x' });
  const read = (t) => SV.parseOutcomeLog({ key, listing: { entries: [{ name: '000000000001.json', text: t }] } });
  assert.equal(read(text).ok, true, 'POSITIVE CONTROL: the entry as the gate writes it reads');
  assert.equal(read(text).last?.outcome, 'fail');
  const crlf = read(text.replace(/\n$/, '\r\n'));
  assert.equal(crlf.ok, false, `a CRLF entry parsed: ${JSON.stringify(crlf)}`);
  assert.match(crlf.why, /contains a carriage return/);
});
test('T-344 r2 completedOutcome (F4): a FAIL whose inputs MOVED during the run is still a FAIL; a moved PASS is nothing', () => {
  assert.equal(SV.completedOutcome({ state: 'VERIFY_FAILED', failingOutput: '', keysAgree: false }), 'fail');
  assert.equal(SV.completedOutcome({ state: 'VERIFY_PASSED', failingOutput: '', keysAgree: false }), null);
});
