import test from 'node:test';
import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { resolveBinary } from '../src/resolveBinary.mjs';

/*
 * WHY THIS EXISTS AT ALL.
 *
 * executorLocal runs a child with an ALLOW-LIST environment -- PATH is empty
 * unless the spec named one, because an agent that inherits the daemon's
 * environment inherits its credentials. That control is right and stays.
 *
 * But agentLaunch produces `file: binary ?? engine`, so a task naming an engine
 * with no binary configured yields a BARE executable name, and a bare name
 * cannot resolve against an empty PATH. That is why Loop B has never launched:
 * spawn claude ENOENT, every time, deterministically.
 *
 * The fix is to resolve in the TRUSTED PARENT and hand the child an absolute
 * path. The child's environment is untouched -- it still inherits nothing. The
 * alternative, giving the child a PATH, would widen exactly the thing the
 * allow-list was built to narrow.
 */

const posix = { PATH: ['/usr/bin', '/opt/bin'].join(delimiter) };

test('a bare name resolves against the PARENT path, not the child environment', () => {
  const exists = (p) => p === join('/opt/bin', 'claude');
  assert.equal(resolveBinary('claude', { env: posix, exists }), join('/opt/bin', 'claude'));
});

test('earlier PATH entries win, as the shell would do it', () => {
  const exists = (p) => p === join('/usr/bin', 'claude') || p === join('/opt/bin', 'claude');
  assert.equal(resolveBinary('claude', { env: posix, exists }), join('/usr/bin', 'claude'));
});

test('WINDOWS: a bare name finds its PATHEXT form', () => {
  // `claude` on Windows is usually claude.cmd. Resolving the bare name and
  // stopping there finds nothing, which looks identical to "not installed".
  const env = { PATH: 'C:\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const exists = (p) => p === join('C:\tools', 'claude.CMD');
  assert.equal(resolveBinary('claude', { env, exists }), join('C:\tools', 'claude.CMD'));
});

test('an absolute path is taken as given when it exists', () => {
  const exists = (p) => p === '/opt/bin/claude';
  assert.equal(resolveBinary('/opt/bin/claude', { env: posix, exists }), '/opt/bin/claude');
});

test('ABSENT IS NULL, never the bare name back', () => {
  // Returning the input unresolved is the dangerous shape: the caller cannot
  // tell "found it" from "gave up", and hands a doomed argv to the executor.
  assert.equal(resolveBinary('claude', { env: posix, exists: () => false }), null);
  assert.equal(resolveBinary('/nope/claude', { env: posix, exists: () => false }), null);
});

test('an empty or missing PATH resolves nothing rather than throwing', () => {
  assert.equal(resolveBinary('claude', { env: {}, exists: () => true }), null);
  assert.equal(resolveBinary('', { env: posix, exists: () => true }), null);
});
