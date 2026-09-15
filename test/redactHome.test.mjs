import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactHome, redactPath } from '../src/redact.mjs';

/**
 * Identity redaction, both directions.
 *
 * THE REAL LEAK, found while preparing to expose the MCP surface. A heartbeat
 * reported each worktree as
 *
 *   C:\Users\DANNY GARCIA\Documents\social-sparks-code-c
 *
 * twice per session -- once as `worktree`, once inside `git.worktree` -- and
 * that payload is bound for a hosted database and from there to whatever model
 * reads the tools. A real person's full name, disclosed as a side effect of
 * saying where a directory is. Nobody decided that.
 *
 * It hid behind a similar name: redactSensitivePaths governs secret-bearing
 * FILENAMES and does that correctly, so the config read as though identity was
 * already handled.
 */

const WIN_HOME = 'C:\\Users\\DANNY GARCIA';
const NIX_HOME = '/home/danny';

test('redactHome: strips the home directory, both separator spellings', () => {
  // git spells a worktree with forward slashes while the OS spells it with
  // backslashes, and BOTH appeared in one payload. Handling one would redact
  // half the occurrences and look exactly like working redaction.
  assert.equal(redactHome('C:\\Users\\DANNY GARCIA\\Documents\\x', WIN_HOME), '~\\Documents\\x');
  assert.equal(redactHome('C:/Users/DANNY GARCIA/Documents/x', WIN_HOME), '~/Documents/x');
  assert.equal(redactHome('/home/danny/work/x', NIX_HOME), '~/work/x');
});

test('redactHome: the home directory itself becomes ~', () => {
  assert.equal(redactHome('C:\\Users\\DANNY GARCIA', WIN_HOME), '~');
  assert.equal(redactHome('/home/danny', NIX_HOME), '~');
});

test('redactHome: keeps every bit of coordination signal', () => {
  // The worktree basename is what a lane declares and what a collision message
  // names. Redaction must not cost that, or it will be turned off.
  const out = redactHome('C:\\Users\\DANNY GARCIA\\Documents\\social-sparks-code-c', WIN_HOME);
  assert.match(out, /social-sparks-code-c$/);
  assert.equal(out.includes('DANNY'), false);
});

test('redactHome: a path outside the home directory is untouched', () => {
  // The silent half. A function returning "~" for everything passes every
  // assertion above.
  assert.equal(redactHome('D:\\repos\\thing', WIN_HOME), 'D:\\repos\\thing');
  assert.equal(redactHome('/srv/git/thing', NIX_HOME), '/srv/git/thing');
  assert.equal(redactHome('C:\\Windows\\System32', WIN_HOME), 'C:\\Windows\\System32');
});

test('redactHome: a sibling directory that merely starts with the same text is untouched', () => {
  // "C:\Users\DANNY GARCIA2" is a different user. Prefix matching without a
  // separator check would rewrite it and claim it as this operator's.
  assert.equal(redactHome('C:\\Users\\DANNY GARCIA2\\x', WIN_HOME), 'C:\\Users\\DANNY GARCIA2\\x');
  assert.equal(redactHome('/home/danny2/x', NIX_HOME), '/home/danny2/x');
});

test('redactHome: disabled returns the path verbatim', () => {
  // Local output must keep real paths: an operator looking at their own machine
  // should see their own machine, and a path they cannot paste is a worse tool.
  assert.equal(
    redactHome('C:\\Users\\DANNY GARCIA\\Documents\\x', WIN_HOME, false),
    'C:\\Users\\DANNY GARCIA\\Documents\\x',
  );
});

test('redactHome: missing or non-string input is handled rather than thrown', () => {
  assert.equal(redactHome(null, WIN_HOME), null);
  assert.equal(redactHome('C:\\Users\\DANNY GARCIA\\x', ''), 'C:\\Users\\DANNY GARCIA\\x');
  assert.equal(redactHome('C:\\Users\\DANNY GARCIA\\x', null), 'C:\\Users\\DANNY GARCIA\\x');
});

test('redactHome: a trailing separator on the home value still matches', () => {
  assert.equal(redactHome('C:\\Users\\DANNY GARCIA\\Documents\\x', 'C:\\Users\\DANNY GARCIA\\'), '~\\Documents\\x');
});

test('redactHome: is independent of the sensitive-filename redactor', () => {
  // Two different jobs. Proven so a future change to one cannot be assumed to
  // cover the other -- which is the assumption that produced the leak.
  assert.equal(redactPath('src/app.ts').sensitive, false);
  assert.equal(redactPath('.env').sensitive, true);
  assert.equal(redactHome('C:\\Users\\DANNY GARCIA\\.env', WIN_HOME), '~\\.env');
});
