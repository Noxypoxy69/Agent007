/**
 * THE EXECUTABLE GATE FOR THE NULL-SESSION FAIL-OPEN (guardSession.mjs, c23ff2e).
 *
 * snapshotPath folds a missing/empty session id to the shared literal
 * 'no-session-id', so before the fix a sessionless payload READ whatever baseline
 * was last minted at that shared key -- one session adopting another's -- and a
 * sessionless mint SEEDED it. readSnapshot and writeSnapshot each gained a clause
 * refusing a sessionless id.
 *
 * A blind audit found the fix correct but UNTESTED: 37 insertions, no test, so
 * DELETING either clause was a no-op to the suite -- CLAUDE.md rules 11 and 16,
 * the exact "no-op mutation goes green because nothing tests the mechanism" trap
 * this whole repository exists to stop. This file is that missing gate, written
 * so each test turns RED if the clause it covers is removed:
 *   - the read test plants a valid snapshot at the shared key, so a sessionless
 *     read WITHOUT the clause would fold to that key and return it;
 *   - the write test asserts the distinct 'no-session' cause the clause returns
 *     BEFORE the drift check, which no other refusal path produces.
 *
 * NOT YET RUN BY THE AUTHOR: the rail executes only files whose content matches
 * the session's inherited HEAD, and this session wrote this file, so it cannot
 * run it here. Per rule 16, a fresh session must show it goes green now AND red
 * with either clause deleted before it is trusted as a ratchet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSnapshot, writeSnapshot, snapshotPath, SNAPSHOT_VERSION } from '../src/guardSession.mjs';

/* undefined, null, empty and whitespace all fold to the same shared key. */
const SESSIONLESS = [undefined, null, '', '   '];

/*
 * readSnapshot/writeSnapshot resolve the snapshot directory from
 * process.env.AGENTBRIDGE_HOME (their snapshotPath default), so a test points it
 * at a throwaway dir and restores it after. Tests in one file run sequentially,
 * so the shared env var is not clobbered between them.
 */
function tmpHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'nullsess-home-'));
  const root = mkdtempSync(path.join(tmpdir(), 'nullsess-root-'));
  const prev = process.env.AGENTBRIDGE_HOME;
  process.env.AGENTBRIDGE_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.AGENTBRIDGE_HOME;
    else process.env.AGENTBRIDGE_HOME = prev;
    for (const d of [home, root]) rmSync(d, { recursive: true, force: true });
  });
  return { home, root };
}

/** A valid snapshot planted directly at the shared 'no-session-id' key. */
function plantSharedSnapshot(root, home) {
  const file = snapshotPath(root, '', home); // '' folds to 'no-session-id'
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    version: SNAPSHOT_VERSION,
    repoRoot: path.resolve(root),
    at: new Date().toISOString(),
    files: {},
    tests: {},
    sessionId: null,
  }));
  return file;
}

test('readSnapshot REFUSES a sessionless id even when a snapshot sits at the shared key', (t) => {
  const { home, root } = tmpHome(t);
  plantSharedSnapshot(root, home);
  // WITH the clause each returns null. WITHOUT it, the sessionless id folds to
  // the shared key, the planted snapshot is found, want=null === stored null,
  // and it is returned -- so removing the clause turns each assertion red.
  for (const id of SESSIONLESS) {
    assert.equal(
      readSnapshot(root, id), null,
      `sessionless id ${JSON.stringify(id)} must not adopt the shared-key snapshot`,
    );
  }
});

test('readSnapshot still returns a real session its OWN snapshot (not a blanket deny)', (t) => {
  const { home, root } = tmpHome(t);
  const id = 'sess-real-1';
  const file = snapshotPath(root, id, home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    version: SNAPSHOT_VERSION,
    repoRoot: path.resolve(root),
    at: new Date().toISOString(),
    files: {},
    tests: {},
    sessionId: id,
  }));
  const got = readSnapshot(root, id);
  assert.ok(got && got.sessionId === id, 'a real session id must still read its own snapshot');
});

test('writeSnapshot REFUSES to mint for a sessionless id, cause no-session', (t) => {
  const { root } = tmpHome(t);
  for (const id of SESSIONLESS) {
    const r = writeSnapshot(root, id);
    assert.equal(r.ok, false, `sessionless mint ${JSON.stringify(id)} must be refused`);
    assert.equal(r.cause, 'no-session', `refusal cause must be no-session, got ${JSON.stringify(r.cause)}`);
  }
});

test('writeSnapshot refusal is SPECIFIC to sessionless, not a blanket refuse', (t) => {
  const { root } = tmpHome(t);
  // A real id skips the no-session clause and reaches the drift/mint path. root
  // is a non-git temp dir, so the result is 'unmeasurable' (git unconsultable)
  // or a clean mint -- either way NOT 'no-session'. Deleting the sessionless
  // clause would route the sessionless ids here too and break the test above.
  const r = writeSnapshot(root, 'sess-real-2');
  assert.notEqual(r.cause, 'no-session', 'a real id must not hit the no-session refusal');
});
