import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionals, VALUELESS_FLAGS } from '../src/argv.mjs';

/**
 * TWO COMMANDS CARRIED THIS LOOP AND BOTH WERE WRONG THE SAME WAY.
 *
 * Measured before the fix, not reasoned about:
 *   check-first --json roster  ->  topic ""   then "no prior work"
 *   verify-sha  --json <rev>   ->  revision lost
 *
 * The check-first case is the worse one: a mistyped invocation produced a
 * confident "nothing found" from the command whose entire job is stopping
 * duplicate work. Absent presented as zero.
 */

test('a boolean flag does not eat the positional after it', () => {
  assert.deepEqual(positionals(['--json', 'roster']), ['roster']);
  assert.deepEqual(positionals(['--json', 'HEAD']), ['HEAD']);
  assert.deepEqual(positionals(['--dry-run', 'a', 'b']), ['a', 'b']);
});

test('a value flag still consumes its value', () => {
  assert.deepEqual(positionals(['--repo', '/x', 'HEAD']), ['HEAD']);
  assert.deepEqual(positionals(['roster', '--hours', '24']), ['roster']);
  assert.deepEqual(
    positionals(['--hours', '24', 'roster']),
    ['roster'],
    'check-first roster --hours 24 must not search for "roster 24"',
  );
});

test('--flag=value never consumes a following token, in either list', () => {
  assert.deepEqual(positionals(['--repo=/x', 'HEAD']), ['HEAD']);
  assert.deepEqual(positionals(['--json=1', 'HEAD']), ['HEAD']);
});

test('flags mixed either side of the positional', () => {
  assert.deepEqual(positionals(['--repo', '/x', '--json', 'HEAD']), ['HEAD']);
  assert.deepEqual(positionals(['HEAD', '--repo', '/x', '--json']), ['HEAD']);
  assert.deepEqual(positionals(['--json', '--repo', '/x', 'HEAD']), ['HEAD']);
});

test('a value flag at the very end consumes nothing that is not there', () => {
  assert.deepEqual(positionals(['roster', '--repo']), ['roster']);
  assert.deepEqual(positionals(['--repo']), []);
});

test('the valueless list is overridable, and defaults are frozen', () => {
  assert.deepEqual(positionals(['--wombat', 'x'], { valueless: ['wombat'] }), ['x']);
  // Not declared valueless: the next token IS treated as its value.
  assert.deepEqual(positionals(['--wombat', 'x']), []);
  assert.throws(() => VALUELESS_FLAGS.push('nope'), TypeError);
});

test('non-string and empty input do not throw', () => {
  assert.deepEqual(positionals(undefined), []);
  assert.deepEqual(positionals([]), []);
  assert.deepEqual(positionals([null, 'a']), ['', 'a']);
});
