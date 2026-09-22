/**
 * THE BARE `--` IS A SEPARATOR, NOT A FLAG THAT TAKES A VALUE.
 *
 * `positionals` rejected any token starting with `--` as a flag, then asked
 * whether it was in VALUELESS_FLAGS by slicing the leading dashes off. For a
 * bare `--` that slice is the EMPTY STRING, which is legitimately absent from
 * that list, so the separator fell through to the value-taking branch and ate
 * the token after it. Measured before the fix:
 *
 *   ['--', 'roster']          -> []          the topic vanished
 *   ['--', 'alpha', 'beta']   -> ['beta']    the first operand vanished
 *   ['--', 'a816ae4']         -> []          the sha vanished
 *
 * That is the POSIX end-of-options marker doing the opposite of its job: its
 * entire purpose is to protect the tokens after it, and it was consuming one.
 *
 * THE CONTROL COMES FIRST. Every assertion below about `--` would also pass if
 * `positionals` were broken in a way that emitted everything, so the first test
 * pins the ordinary behaviour that a careless fix would destroy. A separator
 * test with no control cannot tell a fix from a regression.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { positionals } from '../src/argv.mjs';

test('CONTROL: flags, their values and plain words are unchanged', () => {
  assert.deepEqual(positionals(['--json', 'roster']), ['roster'],
    'a valueless flag consumes nothing');
  assert.deepEqual(positionals(['--repo', 'C:/Dev/Agent007', 'topic']), ['topic'],
    'a value-taking flag still consumes its value');
  assert.deepEqual(positionals(['alpha', 'beta']), ['alpha', 'beta'],
    'bare words are positionals');
  assert.deepEqual(positionals(['--repo=C:/x', 'topic']), ['topic'],
    '--flag=value carries its own value and consumes nothing');
});

test('a bare -- consumes nothing, and is not itself a positional', () => {
  assert.deepEqual(positionals(['--', 'roster']), ['roster']);
  assert.deepEqual(positionals(['--', 'alpha', 'beta']), ['alpha', 'beta']);
  assert.deepEqual(positionals(['--', 'a816ae4']), ['a816ae4']);
});

test('after --, a token that LOOKS like a flag is still a positional', () => {
  /*
   * This is the half that matters and the half a narrow fix misses. Making `--`
   * merely stop consuming would satisfy the block above while still dropping
   * everything dashed after it -- which is precisely what a separator exists to
   * prevent. A filename called --json is the whole reason POSIX has this token.
   */
  assert.deepEqual(positionals(['--', '--json']), ['--json']);
  assert.deepEqual(positionals(['--', '--repo', '--json']), ['--repo', '--json']);
  assert.deepEqual(positionals(['roster', '--', '--repo', '--json']),
    ['roster', '--repo', '--json']);
});

test('-- with nothing after it yields nothing and does not throw', () => {
  assert.deepEqual(positionals(['roster', '--']), ['roster']);
  assert.deepEqual(positionals(['--']), []);
});
