import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanPayload, machineIdentity, USERNAME, HOME_DIRECTORY, HOSTNAME, ABSOLUTE_PATH, SECRET } from '../src/payloadGuard.mjs';

/**
 * EVERY DETECTOR HERE HAS A SILENT TWIN, AND THE SILENT HALF MATTERS MORE.
 *
 * A scanner that flags every string passes every fires-test perfectly and is
 * useless — worse than useless, because a preflight that always refuses gets
 * removed from the publish path and then nothing is checked at all. So each
 * detector is paired with the nearest input that must scan clean.
 *
 * That is not hypothetical here. The first version of this scanner produced
 * three hits on the real heartbeat and two were its own false positives:
 *
 *   - an unanchored drive-letter pattern matched the "s:/" inside "https://",
 *     so every git remote URL was reported as an absolute path
 *   - looksSecret matched machine.id, a random v4 uuid whose entire purpose is
 *     to identify the machine WITHOUT naming it — the scanner flagged the fix
 *     for leak 3 as a credential
 *
 * Both are pinned below. A guard that cries wolf about the anonymising
 * identifier is the fastest possible way to teach somebody to ignore it.
 */

/*
 * THE INVENTED OPERATOR. Never the real one: a fixture carrying the machine's
 * actual username, committed to a repository, would BE the leak this guard
 * exists to prevent — and it would be permanent.
 */
const JANE = {
  username: 'Jane Doe',
  homedir: 'C:\\Users\\Jane Doe',
  hostname: 'DESKTOP-ABC123',
};

const scan = (payload, identity = JANE) => scanPayload(payload, identity);
const kinds = (r) => r.leaks.map((l) => l.kind).sort();
const paths = (r) => r.leaks.map((l) => l.path).sort();

/* ── THE REGRESSION FIXTURE: the real pre-fix payload shape ──────────── */

/**
 * All four leaks that actually shipped, in one payload, in their real fields.
 *
 * Leaks 1 and 2 are the same directory written two ways. That is the specific
 * mechanism that hid this bug: handling one spelling catches half the
 * occurrences and looks exactly like working redaction.
 */
const PRE_FIX_PAYLOAD = {
  schema: 'heartbeat/1',
  machine: { label: 'jane-win', hostname: 'DESKTOP-ABC123', platform: 'win32' },
  sessions: [
    {
      agentId: 'code-b',
      lane: 'onboarding',
      worktree: 'C:\\Users\\Jane Doe\\Documents\\x',
      git: { worktree: 'C:/Users/Jane Doe/Documents/x', head: 'ad4fc1a', branch: 'b/payload-guard' },
    },
  ],
};

test('REGRESSION: all four shipped leaks are caught in one pass', () => {
  const r = scan(PRE_FIX_PAYLOAD);
  assert.equal(r.ok, false);
  // Deduplicated by FIELD: each worktree trips username, home and absolute-path,
  // which are three distinct findings about one string and all worth reporting.
  const worktreeFields = [...new Set(paths(r).filter((p) => p.includes('worktree')))].sort();
  assert.deepEqual(worktreeFields, ['/sessions/0/git/worktree', '/sessions/0/worktree']);
  assert.ok(paths(r).includes('/machine/hostname'), 'hostname must be caught');
  assert.ok(paths(r).includes('/machine/label'), 'the label carrying a first name must be caught');
});

test('BOTH SEPARATOR SPELLINGS are caught — catching one looks like working redaction', () => {
  const back = scan({ a: 'C:\\Users\\Jane Doe\\Documents\\x' });
  const fwd = scan({ a: 'C:/Users/Jane Doe/Documents/x' });
  assert.ok(back.leaks.some((l) => l.kind === HOME_DIRECTORY), 'backslash spelling');
  assert.ok(fwd.leaks.some((l) => l.kind === HOME_DIRECTORY), 'forward slash spelling');
});

/* ── username ────────────────────────────────────────────────────────── */

test('username is caught anywhere, at any depth, in any case', () => {
  const r = scan({ deep: { list: [{ note: 'built by jane doe' }] } });
  assert.ok(kinds(r).includes(USERNAME));
  assert.equal(paths(r)[0], '/deep/list/0/note');
});

test('NEAREST CLEAN: a payload with no name scans clean', () => {
  const r = scan({ deep: { list: [{ note: 'built by the runner' }] } });
  assert.deepEqual(r.leaks, []);
  assert.equal(r.ok, true);
});

test('the WHOLE name is matched even where no part has a boundary', () => {
  /*
   * Mutation found this: deleting the full-name branch left every other test
   * green, because the name-part fallback caught them all. The branch is not
   * redundant, and this is the case that proves it — the name is buried inside
   * a longer token, so "jane" is preceded by a letter and "doe" is followed by
   * one. Neither part is bounded; the full string still is.
   */
  const r = scan({ a: 'abcJane Doexyz' });
  assert.deepEqual(kinds(r), [USERNAME]);
});

test('NEAREST CLEAN: a name part inside an ordinary word is NOT a match', () => {
  /*
   * The control for the part matcher, and mutation proved it was missing:
   * removing the boundary check entirely left the whole suite green.
   *
   * "doe" sits inside "doesn't", which is not a rare word in an error message
   * or a commit subject. Without a boundary this guard would report a leak
   * every time somebody wrote "it doesn't build", and a guard that cries wolf
   * on ordinary English is one nobody keeps.
   */
  const r = scan({ a: "it doesn't matter", b: 'janitorial', c: 'jandex' });
  assert.deepEqual(r.leaks, []);
});

test('a username under three characters is NOT searched for', () => {
  // "pi" would match "pipeline"; a guard that fires on everything is removed.
  const r = scan({ a: 'pipeline ok' }, { username: 'pi', homedir: '', hostname: '' });
  assert.deepEqual(r.leaks, []);
});

/* ── home directory ──────────────────────────────────────────────────── */

test('the home directory is caught even when the username case differs', () => {
  const r = scan({ a: 'c:\\users\\jane doe\\documents\\x' });
  assert.ok(kinds(r).includes(HOME_DIRECTORY));
});

test('NEAREST CLEAN: a tilde-relative path is NOT a leak', () => {
  // ~\Documents\x names no person and no disk layout.
  const r = scan({ a: '~\\Documents\\x', b: '~/Documents/x' });
  assert.deepEqual(r.leaks, []);
});

/* ── hostname ────────────────────────────────────────────────────────── */

test('the hostname is caught', () => {
  assert.ok(kinds(scan({ h: 'DESKTOP-ABC123' })).includes(HOSTNAME));
});

test('NEAREST CLEAN: an opaque machine name is not a hostname', () => {
  assert.deepEqual(scan({ h: 'machine-62710e' }).leaks, []);
});

/* ── absolute paths: any of them, name or no name ────────────────────── */

test('an absolute path with no name in it is still a leak', () => {
  const r = scan({ p: 'D:\\build\\out' });
  assert.deepEqual(kinds(r), [ABSOLUTE_PATH]);
});

test('posix absolute home paths are leaks in both flavours', () => {
  assert.ok(kinds(scan({ p: '/home/somebody/x' })).includes(ABSOLUTE_PATH));
  assert.ok(kinds(scan({ p: '/Users/somebody/x' })).includes(ABSOLUTE_PATH));
});

test('an absolute path EMBEDDED in a message is caught', () => {
  // Stack traces and error strings are exactly where a path arrives unintended.
  assert.ok(kinds(scan({ e: 'failed at C:\\Users\\x\\y line 3' })).includes(ABSOLUTE_PATH));
});

test('FALSE POSITIVE PINNED: a git remote URL is not an absolute path', () => {
  // An unanchored drive-letter pattern matches the "s:/" inside "https://".
  // That flagged every remote URL in the real payload on this scanner's first run.
  const r = scan({ u: 'https://github.com/owner/repo.git' });
  assert.deepEqual(r.leaks, [], 'a guard that flags every URL is noise');
});

test('NEAREST CLEAN: relative paths are not leaks', () => {
  assert.deepEqual(scan({ a: 'src/lib/x.ts', b: 'scripts\\check.mjs', c: './out' }).leaks, []);
});

/* ── secrets: one engine, and its two deliberate exemptions ──────────── */

test('a credential shape is caught', () => {
  assert.ok(kinds(scan({ t: 'ghp_' + 'a'.repeat(24) })).includes(SECRET));
});

test('a credential embedded in a command line is caught', () => {
  const r = scan({ cmd: 'curl -H "Authorization: Bearer ' + 'x'.repeat(40) + '"' });
  assert.ok(kinds(r).includes(SECRET));
});

test('FALSE POSITIVE PINNED: a v4 uuid is the anonymising id, not a secret', () => {
  // machine.id exists precisely so the payload names no one. Flagging the fix
  // for leak 3 as a credential is how a guard loses its reader.
  assert.deepEqual(scan({ id: '62710e7e-09b5-48f8-b15c-f790be308b86' }).leaks, []);
});

test('a git SHA is not a secret, at either length', () => {
  assert.deepEqual(scan({ head: 'ad4fc1af5d00ab3d5a2895e69476472daa8dd9c8' }).leaks, []);
  assert.deepEqual(scan({ head: 'b9623ac' }).leaks, []);
});

test('branch names, lane ids and versions scan clean', () => {
  const r = scan({
    branch: 'b/payload-guard',
    lane: 'onboarding',
    version: '0.2.0',
    schema: 'heartbeat/1',
    sentAt: '2026-09-15T04:02:24.000Z',
  });
  assert.deepEqual(r.leaks, []);
});

/* ── the walk itself ─────────────────────────────────────────────────── */

test('it walks arrays and nested objects, not just top-level fields', () => {
  // The three real leaks were all in fields nobody thought to check.
  const r = scan({ a: [{ b: [{ c: 'DESKTOP-ABC123' }] }] });
  assert.deepEqual(paths(r), ['/a/0/b/0/c']);
});

test('non-string values carry no identity and are skipped', () => {
  assert.deepEqual(scan({ n: 42, b: true, z: null, arr: [1, 2, 3] }).leaks, []);
});

test('a JSON pointer escapes ~ and / in keys', () => {
  const r = scan({ 'a/b': 'DESKTOP-ABC123' });
  assert.deepEqual(paths(r), ['/a~1b']);
});

test('the same field is reported once per kind, not once per match', () => {
  const r = scan({ p: 'C:\\Users\\Jane Doe\\x' });
  assert.equal(new Set(r.leaks.map((l) => l.path)).size, 1);
  assert.ok(r.leaks.length >= 2, 'username and home are distinct findings on one field');
});

/* ── the sample must not be a second copy of the leak ────────────────── */

test('the sample is masked — the report gets pasted into chat', () => {
  const r = scan({ p: 'C:\\Users\\Jane Doe\\Documents\\x' });
  for (const l of r.leaks) {
    assert.doesNotMatch(l.sample, /Jane Doe/, 'a leak report must not republish the leak');
    assert.match(l.sample, /\*/);
  }
});

/* ── identity as a parameter ─────────────────────────────────────────── */

test('it scans for a name that is not this machine\'s', () => {
  // Without this the fixture above could only ever run on one machine.
  const r = scanPayload({ a: 'hello Zaphod' }, { username: 'Zaphod', homedir: '', hostname: '' });
  assert.deepEqual(kinds(r), [USERNAME]);
});

test('machineIdentity returns the three fields and never throws', () => {
  const id = machineIdentity();
  assert.equal(typeof id.username, 'string');
  assert.equal(typeof id.homedir, 'string');
  assert.equal(typeof id.hostname, 'string');
});

test('an empty identity searches for nothing rather than everything', () => {
  // The guard against a scanner that matches '' in every string.
  const r = scanPayload({ a: 'anything at all' }, { username: '', homedir: '', hostname: '' });
  assert.deepEqual(r.leaks, []);
});

test('an empty payload and odd inputs do not crash', () => {
  assert.deepEqual(scan({}).leaks, []);
  assert.deepEqual(scan([]).leaks, []);
  assert.deepEqual(scan(null).leaks, []);
  assert.deepEqual(scan('').leaks, []);
});
