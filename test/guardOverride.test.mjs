/**
 * THE OVERRIDE CHANNEL. A guard nobody can repair gets repaired by evasion.
 *
 * Measured 2026-09-18 against the shipped hook: every guarded session was
 * refused on src/guardSession.mjs and src/shellAllowlist.mjs with
 * protected-control. So the only parties who could fix the guard were the
 * operator's own terminal and sessions where the hook had never loaded -- and
 * the second is a BUG being spent as a permission. Four guard commits landed
 * that way in one night because nothing was watching the session that made them.
 *
 * Every test here sets AGENTBRIDGE_HOME to a temp directory FIRST. The grant
 * lives beside the snapshots, and a test that forgets this writes into the
 * operator's real store -- which is exactly the defect that put 63 fixture
 * snapshots there, found the same day.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FUTURE = () => new Date(Date.now() + 3600e3).toISOString();
const PAST = () => new Date(Date.now() - 1000).toISOString();

/** An isolated home plus a repo root, and the grant writer for that pair. */
async function sandbox(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'override-home-'));
  const root = mkdtempSync(path.join(tmpdir(), 'override-repo-'));
  const prev = process.env.AGENTBRIDGE_HOME;
  process.env.AGENTBRIDGE_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.AGENTBRIDGE_HOME;
    else process.env.AGENTBRIDGE_HOME = prev;
    for (const d of [home, root]) rmSync(d, { recursive: true, force: true });
  });
  const g = await import('../src/guardSession.mjs');
  const { evaluateClaudeTool } = await import('../src/claudeGuard.mjs');
  const file = g.overridePath(root, home);
  mkdirSync(path.dirname(file), { recursive: true });
  return {
    root,
    grant: (o) => writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o)),
    judge: () => evaluateClaudeTool({
      tool_name: 'Edit',
      tool_input: { file_path: 'src/guardSession.mjs', old_string: 'a', new_string: 'b' },
      cwd: root,
      session_id: 's',
    }),
  };
}

test('CONTROL: with no grant a protected control is refused', async (t) => {
  const s = await sandbox(t);
  const r = s.judge();
  assert.equal(r.allowed, false);
  assert.equal(r.id, 'protected-control');
});

test('an active grant naming the path permits it, and SAYS SO', async (t) => {
  const s = await sandbox(t);
  s.grant({ paths: ['src/guardSession.mjs'], reason: 'repair the guard', granted_by: 'danny', expires_at: FUTURE() });
  const r = s.judge();
  assert.equal(r.allowed, true);
  /*
   * The announcement is load-bearing, not decoration. A permit that looks like
   * an ordinary allow makes a forged grant indistinguishable from a clean run;
   * the notice is what turns it into a question somebody can ask.
   */
  assert.match(r.notice ?? '', /protected-control-overridden/);
  assert.match(r.notice ?? '', /danny/, 'names who granted it');
  assert.match(r.notice ?? '', /repair the guard/, 'and why');
});

test('an EXPIRED grant is no grant', async (t) => {
  const s = await sandbox(t);
  s.grant({ paths: ['src/guardSession.mjs'], reason: 'x', granted_by: 'd', expires_at: PAST() });
  assert.equal(s.judge().allowed, false);
});

test('a grant with no usable expiry is refused rather than treated as permanent', async (t) => {
  const s = await sandbox(t);
  s.grant({ paths: ['src/guardSession.mjs'], reason: 'x', granted_by: 'd' });
  assert.equal(s.judge().allowed, false, 'a forgotten override must fail closed');
  s.grant({ paths: ['src/guardSession.mjs'], reason: 'x', granted_by: 'd', expires_at: 'whenever' });
  assert.equal(s.judge().allowed, false);
});

test('a grant for a different path does not cover this one', async (t) => {
  const s = await sandbox(t);
  s.grant({ paths: ['src/somethingElse.mjs'], reason: 'x', granted_by: 'd', expires_at: FUTURE() });
  assert.equal(s.judge().allowed, false);
});

test('a PREFIX is not a grant -- naming paths is still the point', async (t) => {
  const s = await sandbox(t);
  /*
   * `src/` would be a general off switch wearing a path. Somebody has to have
   * named the file, or the override becomes permanent by convenience.
   *
   * `['*']` USED TO BE IN THIS LIST AND IS NOW DELIBERATELY OUT OF IT. That is
   * an owner decision, not a regression: a3e84bf, 2026-09-18. Danny asked for
   * full access roughly ten times and kept being handed four-path grants,
   * because under no-globs the only expressible full grant is an enumeration of
   * twenty protected paths plus every test file, which nobody writes by hand.
   * His words: "there's only 3 of you, I can't make 200 agents so they can all
   * have small access." The rule was written for many narrow actors and this
   * machine has three generalists, so it produced idle agents rather than least
   * privilege.
   *
   * The distinction the test still enforces is the one that survived: the EXACT
   * token is a wildcard, and nothing else is. `src/`, `src`, `''`, `src/*` and
   * `*.mjs` remain nothing at all, so no reader ever has to work out what a
   * pattern covers.
   */
  for (const paths of [['src/'], ['src'], [''], ['src/*'], ['*.mjs'], ['src/**'], ['.claude/*']]) {
    s.grant({ paths, reason: 'x', granted_by: 'd', expires_at: FUTURE() });
    assert.equal(s.judge().allowed, false, `${JSON.stringify(paths)} must not act as a wildcard`);
  }
});

test('the exact token "*" IS a wildcard, and that is deliberate', async (t) => {
  /*
   * RULE 5 for the test above. Without this, the list of things that are not
   * wildcards would pass just as well if NOTHING were a wildcard -- including
   * the case the owner actually asked for, which would then be silently broken
   * while the suite stayed green.
   */
  const s = await sandbox(t);
  s.grant({ paths: ['*'], reason: 'full access, directed by the owner', granted_by: 'danny', expires_at: FUTURE() });
  assert.equal(s.judge().allowed, true,
    'a3e84bf made the exact token a wildcard on the owner\'s instruction; if this fails, that '
    + 'decision has been reverted and the operator is back to enumerating every path by hand');
});

test('a malformed or empty grant opens nothing', async (t) => {
  const s = await sandbox(t);
  for (const bad of ['{ not json', '{}', '[]', 'null', JSON.stringify({ paths: [], reason: 'x', expires_at: FUTURE() })]) {
    s.grant(bad);
    assert.equal(s.judge().allowed, false, `${bad} must not be read as a grant`);
  }
});

test('a grant with no reason is refused, because the reason is the audit trail', async (t) => {
  const s = await sandbox(t);
  s.grant({ paths: ['src/guardSession.mjs'], granted_by: 'd', expires_at: FUTURE() });
  assert.equal(s.judge().allowed, false);
  s.grant({ paths: ['src/guardSession.mjs'], reason: '   ', granted_by: 'd', expires_at: FUTURE() });
  assert.equal(s.judge().allowed, false, 'and whitespace is not a reason');
});


test('THE PERMIT IS VISIBLE THROUGH hookDecision, not just on the return value', async (t) => {
  /*
   * THIS IS THE ASSERTION WHOSE ABSENCE HID A SHIPPED FALSEHOOD. The original
   * tests checked `notice` on evaluateClaudeTool's return and never called
   * hookDecision -- which discarded it and emitted a bare {} for every allow.
   * So the override was byte-identical to an ordinary approval on stdout while
   * the commit message and the source both claimed it "ANNOUNCES itself".
   *
   * The channel's safety argument is that a forged grant "does not vanish into
   * a clean run". A silent permit IS a clean run, so this assertion is the
   * property, not a formatting detail. Test the boundary the hook actually
   * emits, not the function underneath it.
   */
  const { hookDecision } = await import('../src/claudeGuard.mjs');
  const s = await sandbox(t);

  assert.deepEqual(hookDecision({ allowed: true }), {}, 'an ordinary allow stays silent');

  s.grant({ paths: ['src/guardSession.mjs'], reason: 'repair the guard', granted_by: 'danny', expires_at: FUTURE() });
  const emitted = hookDecision(s.judge());
  assert.match(emitted.systemMessage ?? '', /protected-control-overridden/);
  assert.match(emitted.systemMessage ?? '', /danny/);
  assert.match(emitted.systemMessage ?? '', /repair the guard/);
  assert.notDeepEqual(emitted, {}, 'an overridden permit must not look like an ordinary allow');
});
