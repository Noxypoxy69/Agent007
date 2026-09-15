import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

import { portableWorktree, isAbsoluteLike, redactHome } from '../src/redact.mjs';
import { collect } from '../src/collect.mjs';

/**
 * NO ABSOLUTE WORKTREE PATH LEAVES THE MACHINE.
 *
 * Written after publish() started refusing its own heartbeat. The payload
 * carried `C:\Users\DANNYG~1\AppData\Local\Temp\...` -- the 8.3 short form of
 * the home directory, which a prefix match against the long form never fires
 * on. It shipped absolute, with the operator's name in it, merely abbreviated.
 *
 * Both directions, throughout: a path that SHOULD be relativised is, and a
 * path that cannot be is reduced rather than passed through. A redactor that
 * only ever returns its input is indistinguishable from a working one in every
 * payload anyone reads.
 */

const WIN = 'C:\\Users\\DANNY GARCIA';
const SHORT = 'C:\\Users\\DANNYG~1';

test('8.3 short home is the same identity surface as the long one', () => {
  // The exact shape that shipped.
  const p = `${SHORT}\\AppData\\Local\\Temp\\ab-x\\code-b`;
  const got = portableWorktree(p, [WIN, SHORT]);
  assert.equal(isAbsoluteLike(got), false, `still absolute: ${got}`);
  assert.doesNotMatch(got, /DANNYG~1/i, 'the short name is still in the payload');
  assert.doesNotMatch(got, /DANNY GARCIA/i);
});

test('the long spelling still relativises, as it always did', () => {
  const got = portableWorktree(`${WIN}\\Documents\\social-sparks-code-c`, [WIN, SHORT]);
  assert.equal(got, '~\\Documents\\social-sparks-code-c');
});

test('a worktree outside home is reduced to its name, not passed through', () => {
  // No home prefix to strip. Before this, it shipped whole.
  const got = portableWorktree('D:\\work\\secret-project\\repo', [WIN, SHORT]);
  assert.equal(got, 'repo');
  assert.equal(isAbsoluteLike(got), false);
});

test('posix absolute paths are handled too — payloads are scanned anywhere', () => {
  assert.equal(portableWorktree('/home/danny/src/app', ['/home/danny']), '~/src/app');
  assert.equal(portableWorktree('/opt/elsewhere/repo', ['/home/danny']), 'repo');
});

test('a UNC path is absolute and is reduced', () => {
  const got = portableWorktree('\\\\server\\share\\repo', [WIN]);
  assert.equal(isAbsoluteLike(got), false, `UNC survived: ${got}`);
  assert.equal(got, 'repo');
});

test('an already-relative path is left alone', () => {
  // The silent half: over-reduction would destroy coordination signal.
  assert.equal(portableWorktree('~\\Documents\\x', [WIN]), '~\\Documents\\x');
  assert.equal(portableWorktree('code-b', [WIN]), 'code-b');
});

test('disabled means disabled — local output keeps real paths', () => {
  const p = `${WIN}\\Documents\\x`;
  assert.equal(portableWorktree(p, [WIN], false), p);
});

test('isAbsoluteLike recognises all three flavours regardless of platform', () => {
  for (const p of ['C:\\x', 'c:/x', '\\\\srv\\share', '/usr/x']) {
    assert.equal(isAbsoluteLike(p), true, `${p} not seen as absolute`);
  }
  for (const p of ['~\\x', '~/x', 'x/y', '', 'repo']) {
    assert.equal(isAbsoluteLike(p), false, `${p} wrongly seen as absolute`);
  }
});

test('redactHome itself is unchanged — the fix did not move its goalposts', () => {
  assert.equal(redactHome(`${WIN}\\Documents\\x`, WIN), '~\\Documents\\x');
  assert.equal(redactHome('D:\\work\\x', WIN), 'D:\\work\\x', 'redactHome must still pass non-home through');
});

test('END TO END: a real collect() under an 8.3 temp path emits nothing absolute', async (t) => {
  // The regression itself. tmpdir() on Windows is spelled with the short name,
  // which is exactly how this reached production.
  const root = await mkdtemp(path.join(tmpdir(), 'ab-wt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wt = path.join(root, 'code-b');
  await mkdir(wt, { recursive: true });

  const cfg = { machineId: 'm', label: 'l', bridgeUrl: 'http://127.0.0.1:1', secret: 'a'.repeat(64) };
  const payload = await collect(cfg, { agents: [{ agentId: 'code-b', lane: 'x', worktree: wt }] });

  const wire = JSON.stringify(payload);
  assert.doesNotMatch(wire, /DANNYG~1/i, 'an 8.3 home spelling reached the wire');

  const home = homedir();
  let longHome = home;
  try { longHome = realpathSync.native(home); } catch { /* keep home */ }
  for (const h of new Set([home, longHome])) {
    const leaf = h.split(/[\\/]/).pop();
    if (leaf) assert.equal(wire.includes(leaf), false, `home leaf "${leaf}" reached the wire`);
  }

  for (const s of payload.sessions ?? []) {
    assert.equal(isAbsoluteLike(s.worktree), false, `session.worktree absolute: ${s.worktree}`);
    if (s.git?.worktree) {
      assert.equal(isAbsoluteLike(s.git.worktree), false, `git.worktree absolute: ${s.git.worktree}`);
    }
  }
});
